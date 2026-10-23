import { useCallback, useEffect, useRef, useState } from "react";

import {
  type AgentEvent,
  type BackgroundTaskView,
  type ImageInput,
  type Nudge,
  type PermissionResponse,
  deleteMessage as deleteMessageBridge,
  editMessage as editMessageBridge,
  getHistory,
  interrupt as interruptSession,
  onHostReconnect,
  queueList,
  queueRemove,
  queueTake,
  redoCheckpoint,
  regenerateTurn,
  renderUiText,
  resendTurn,
  restoreCheckpoint,
  respondPermission,
  sendTurn,
  subscribeSession,
  subscribeWindowFocus,
  taskCancel,
} from "../bridge";
import { t } from "../i18n";
import { PartialJsonObject, firstStringField } from "../lib/partialJson";
import { PLAN_TOOL } from "../lib/plan";
import { errorItem, restoreFailNotice, sendFailureItem } from "./session/errors";
import {
  SEND_GRACE_MS,
  applyHistorySnap,
  assistantMessageId,
  isLiveDelta,
  liveDeltasOf,
  locateMessage,
  mergeLive,
  rebuildFromSnap,
  reconcileAsks,
} from "./session/history";
import {
  appendToolOutput,
  applyDone,
  applyMessage,
  applyResolved,
  applyWithdrawn,
  buildOf,
  dropErrors,
  dropSettled,
  fillToolInput,
  rememberCheckpoint,
  stampOf,
  trimAfterUserPrompt,
  trimThroughEdited,
  upsertTask,
  withdrawnOf,
} from "./session/items";
import { PACE_FRAME_MS, paceTake } from "./session/pacing";
import {
  EMPTY_STATE,
  type HistorySnap,
  type Item,
  type QueuedItem,
  type SessionState,
  type TextItem,
  type UserItem,
} from "./session/types";

// 对外的类型和水合函数从这里转出，调用方不用知道内部怎么分的文件。
export type { Item, QueuedItem, SessionState, TextItem, WithdrawnPrompt } from "./session/types";
export { messagesToItems } from "./session/history";

/**
 * Channel 沉默超过此时长，视为 IPC 已经死了。
 *
 * `[约束]` Tauri `Channel::send` 在 JS 那头已经不听时**不会失败**
 * （见 `AppState::attach_sink`）。笔记本睡眠、下午再打开、WKWebView
 * 把后台页掐掉，都是同一件事：内核照常跑完、历史照常落盘，界面却永远
 * 停在「正在生成」。切走再切回来能看见完整回复，是因为换会话会重新
 * 订阅并拉历史 —— 不换会话就没人做这两步。
 */
const SINK_STALE_MS = 30_000;
/** 忙碌/压缩中这么久收不到事件，主动换出口并对一下历史。 */
const BUSY_SILENCE_MS = 12_000;
/**
 * 主 agent 空闲、但还有子 agent 在跑：这么久收不到事件就换出口对账。
 *
 * 多任务模式下主 agent 委派完就闲着，之后发生的一切 —— 子 agent 的活动
 * 行、它跑完的状态、完成通知唤起的新一轮 —— 全靠事件流送过来。通道要是
 * 在这段时间死了，界面上看到的就是：子 agent 会话（走 RPC 轮询）早已
 * 显示完成，主对话里的卡片却一直转圈、主 agent 也不接手，直到用户切个
 * 窗口或发句话才对上账。上面那条看门狗只在 busy 时工作，管不到这里。
 *
 * 比忙碌时的阈值长：跑着的子 agent 每调一次工具就推一条活动行，安静
 * 半分钟多半是在跑一条长命令 —— 这种情况下的对账是白拉一份历史，别太勤。
 */
const TASK_SILENCE_MS = 30_000;
/** 切到别的 app 不到这么久、事件还在流，不要重订阅（避免把正在流的正文闪掉）。 */
const AWAY_RESYNC_MS = 30_000;
/**
 * 一次"换出口并对历史"最多占住多久。
 *
 * 比 bridge 给单条命令的期限短：那边是"这条命令算不算失败"，这里是
 * "还要不要挡着别人重连"。等待期间发消息的用户被这条挡在乐观气泡
 * 之前 —— 他打的字既没上屏也没报错，那是最不该出现的一种失败。
 */
const ENSURE_LIVE_DEADLINE_MS = 20_000;

/**
 * 等 `p`，但最多等 `ms`。到点就当它完成了（不抛）—— 调用方要的是
 * "别再等下去"，不是"报个错"。
 *
 * 定时器在 `p` 先落地时清掉：这个函数每次重连都调一次，留着就是一串
 * 挂到会话关闭的空转。
 */
function settleWithin(p: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = window.setTimeout(resolve, ms);
    const done = () => {
      window.clearTimeout(timer);
      resolve();
    };
    p.then(done, done);
  });
}

/**
 * 每个会话当前这轮等待的起点（epoch ms）。
 *
 * 挂在模块级：Chat 按会话 id 重挂载，组件内的计时起点活不过切换 ——
 * 切走再切回，状态行的秒数从 0 重数，明明已经等了两分钟却显示 3s。
 * 协议消息不带时间戳，历史水合恢复不出真实起点，只能在"等待开始"的
 * 时刻由前端记下来。应用重启后拿不回起点，从水合时刻起数（诚实的下界）。
 */
const waitStartAt = new Map<string, number>();

/**
 * 切走会话后界面树可能被卸掉，条目先记在这里。下一次挂上这个 id
 * 时立刻还原，不用干等 getHistory —— 等的那段时间主区是空的，长
 * 会话看起来就是白屏。
 *
 * `[约束]` 必须有上限。`items` 里的图片是 base64 data URL（一张 Retina
 * 截图 base64 之后一兆多），不淘汰的话，今天切过的每个会话都把自己
 * 的整份对话连图留在内存里，直到用户显式删除它 —— 而正常使用根本
 * 不会去删会话。挂载中的界面树由 App 的 KEEP_CHATS 管，这里放宽一档：
 * 淘汰的代价只是下次切回要等一次 getHistory，不是白屏。
 */
const SESSION_CACHE_MAX = 8;
const sessionCache = new Map<string, SessionState>();

/** 写缓存，并把这个会话顶到最近使用的一端。超限时淘汰最久没碰的。 */
function cacheSession(id: string, state: SessionState) {
  // Map 保持插入顺序：先删再插就是"移到队尾"。
  sessionCache.delete(id);
  sessionCache.set(id, state);
  if (sessionCache.size > SESSION_CACHE_MAX) {
    const oldest = sessionCache.keys().next();
    if (!oldest.done) sessionCache.delete(oldest.value);
  }
}

/** 读缓存并顺手续命。只读不续的话，一直空闲的会话会被自己的邻居挤掉。 */
function touchSession(id: string): SessionState | undefined {
  const hit = sessionCache.get(id);
  if (hit) cacheSession(id, hit);
  return hit;
}

/**
 * 每个会话正在流的那段思考从什么时候开始、什么时候停（转去写正文那一刻）。
 *
 * 和 waitStartAt 同一个理由挂在模块级：思考块随会话切换重挂载，组件内
 * 计时活不过去。落定后的时长以内核盖在消息上的 `duration_ms` 为准，这里
 * 只管直播那一段的计时。
 */
const thinkClocks = new Map<string, { start: number; end?: number }>();

/**
 * 直播思考的计时。`thinking` 为空说明这段已经落定，顺手清掉；水合进来的
 * 半截思考没有真实起点，从此刻起数（诚实的下界）。
 */
export function thinkingClock(
  sessionId: string,
  thinking: string,
): { start: number; end?: number } | null {
  if (!thinking) {
    thinkClocks.delete(sessionId);
    return null;
  }
  let c = thinkClocks.get(sessionId);
  if (!c) {
    c = { start: Date.now() };
    thinkClocks.set(sessionId, c);
  }
  return c;
}

/** 状态行计时的起点。null = 此刻没有在等的东西。 */
export function waitStartedAt(sessionId: string): number | null {
  return waitStartAt.get(sessionId) ?? null;
}

/** 会话删掉时清掉缓存，免得占着一份已经没了的对话。 */
export function forgetSession(id: string) {
  sessionCache.delete(id);
  waitStartAt.delete(id);
  thinkClocks.delete(id);
}

export function useSession(
  sessionId: string,
  opts?: {
    /**
     * 把浏览器面板打开给用户看。
     *
     * `[约束]` 只有模型**明说**要给用户看时才走这条：`ShowBrowser`、
     * `show: true` 的 `BrowserNavigate`，以及请用户在面板里亲自操作的
     * `BrowserHandoff`。别的 `Browser*` 工具一律
     * 不弹 —— 早先按名字前缀猜，结果抓包、扫描这类纯后台分析也在抢屏幕。
     *
     * 历史回放不会走这条 —— 只在实时事件上触发。
     */
    onBrowserOpen?: () => void;
    /**
     * 模型的 PreviewFile 工具**成功**后，把这个文件在预览面板里展示给
     * 用户。路径是模型传的原文（可能是相对路径），由调用方解析。
     * 同 onBrowserOpen：历史回放不走，只在实时事件上触发。
     */
    onPreviewFile?: (path: string) => void;
  },
) {
  const [state, setState] = useState<SessionState>(() => touchSession(sessionId) ?? EMPTY_STATE);
  /** 历史快照到过（或缓存里已有）。没到之前不要把长会话画成空招呼页。 */
  const [ready, setReady] = useState(() => sessionCache.has(sessionId));

  // 缓存跟着**提交后**的状态走，不写在 updater 里。
  //
  // `[约束]` updater 必须是纯函数。React 19 的并发渲染允许重复调用甚至
  // 整个丢弃一次 updater —— 在里面写外部缓存，等于让一份跨会话存活的
  // 数据跟着渲染的中间态跑。这里以前那样写没出事，靠的是"每次渲染都从
  // base state 重放整个队列、最后一次调用的值恰好是对的"，同一个文件在
  // tool_start 和 send 两处已经为 StrictMode 双跑各留过一个坑。
  useEffect(() => {
    cacheSession(sessionId, state);
  }, [sessionId, state]);

  // delta 先攒在 ref，由 rAF 决定何时 setState。逐条 setState 会让 React
  // 在快速流式输出时掉帧。页面不可见时 WebKit 会节流 rAF，那时直接刷 ——
  // 没人在看，掉帧无所谓，但数据不能积压。
  const pendingText = useRef("");
  const pendingThinking = useRef("");
  const pendingToolJson = useRef<{ id: string; chunk: string }[]>([]);
  /** 工具进度行也要合批：`cargo build` 一秒能吐几百行，逐条 setState
   *  等于逐行重渲染整棵树。走和 delta 同一个 rAF 出口。 */
  const pendingProgress = useRef<{ id: string; text: string }[]>([]);
  /** 子 agent 的视图更新同样合批：一个侦察子 agent 一批并发十个 Grep 就
   *  推十条，几个并行就是几十条挤在同一瞬间，逐条 setState 等于逐条重渲染
   *  整个对话。按到达顺序攒着，一帧内同一个子 agent 只留最后一条的效果。 */
  const pendingTasks = useRef<BackgroundTaskView[]>([]);
  /** 每个正在流参数的工具一个增量解析器（见 PartialJsonObject）。 */
  const toolJsonById = useRef(new Map<string, PartialJsonObject>());
  /**
   * 工具卡片出现时就地落定的流式内容。
   *
   * 卡片必须排在模型那句话的**下面**（"先写文件："在上，卡片在下），所以
   * 工具一开始就把当时的流式文本/思考落成条目。完整消息随后会把同样的块
   * 再给一遍 —— 靠这里去重，否则同一句话在界面上出现两次。
   */
  const settled = useRef<{ text: string[]; thinking: string[] }>({ text: [], thinking: [] });
  const rafId = useRef(0);
  const onBrowserOpenRef = useRef(opts?.onBrowserOpen);
  onBrowserOpenRef.current = opts?.onBrowserOpen;
  const onPreviewFileRef = useRef(opts?.onPreviewFile);
  onPreviewFileRef.current = opts?.onPreviewFile;
  /** 等结果的 PreviewFile 调用：tool_use id → 路径。成功的结果一到才开
   *  预览 —— 在调用时就开的话，同一批里"先 Write 再 Preview"会抢在文件
   *  落盘之前打开一个报错的标签；失败的调用（文件不存在）则根本不该开。 */
  const pendingPreviews = useRef(new Map<string, string>());
  /** 等结果的 ShowBrowser 调用（含 `show: true` 的 BrowserNavigate）。同
   *  pendingPreviews 的理由：浏览器里一页都没有、或者导航失败时弹出来的
   *  是一个空面板。 */
  const pendingShowBrowser = useRef(new Set<string>());
  /** 等结果的 CreatePlan 调用。结果一到，边流边显示的计划草稿就该撤 ——
   *  之后侧栏面板读的是磁盘上那份文件。 */
  const pendingPlans = useRef(new Set<string>());

  // 排队面板的权威镜像放 ref 而不是只放 state：事件回调（注入匹配、
  // Done 后接力）跑在 React 渲染周期之外，读 state 拿到的是一拍之前的
  // 值 —— 表现为"刚注入的条目又被接力重发了一遍"。所有修改都过
  // mutateQueued，state 只是它的投影。
  const queuedRef = useRef<QueuedItem[]>([]);
  // 事件回调里要判断"此刻在不在跑"（queueSendNow 分流），同样不能读 state。
  const busyRef = useRef(false);
  const compactingRef = useRef(false);
  useEffect(() => {
    busyRef.current = state.busy;
    compactingRef.current = state.compacting;
  }, [state.busy, state.compacting]);
  /** 有没有子 agent 在跑（看门狗用，见 TASK_SILENCE_MS）。 */
  const tasksRunningRef = useRef(false);
  useEffect(() => {
    tasksRunningRef.current = state.tasks.some((x) => x.status === "running");
  }, [state.tasks]);
  // send 在订阅 effect 之后才定义，Done 接力经 ref 调它。
  const sendRef = useRef<
    ((text: string, images?: ImageInput[], refs?: string[]) => Promise<boolean>) | null
  >(null);
  /** 最近一次从这条会话的 Channel 收到事件（或刚挂上新出口）。 */
  const lastHeardAt = useRef(Date.now());
  const lastSendAt = useRef(0);
  /** 发送前的重连闸（见 send）。所有发送按顺序排在它后面。 */
  const sendGate = useRef<Promise<void>>(Promise.resolve());
  /** 换一条活 Channel，并在宿主已空闲时用历史把界面追上。 */
  const ensureLiveRef = useRef<(() => Promise<void>) | null>(null);

  const mutateQueued = useCallback(
    (fn: (q: QueuedItem[]) => QueuedItem[]) => {
      queuedRef.current = fn(queuedRef.current);
      const next = queuedRef.current;
      setState((s) => ({ ...s, queued: next }));
    },
    [setState],
  );

  useEffect(() => {
    /** `paced`：rAF 那一路，正文和思考按 paceTake 限速放出，剩下的下一帧接着放。 */
    let pacedAt = 0;
    const flush = (paced = false) => {
      rafId.current = 0;
      const allTxt = pendingText.current;
      const allK = pendingThinking.current;
      const now = performance.now();
      // 上一次已经放空（pacedAt = 0）：这是新到的一撮，按一帧起步。
      const dt = pacedAt ? now - pacedAt : PACE_FRAME_MS;
      const txt = paced ? allTxt.slice(0, paceTake(allTxt, dt)) : allTxt;
      const k = paced ? allK.slice(0, paceTake(allK, dt)) : allK;
      const chunks = pendingToolJson.current;
      const lines = pendingProgress.current;
      const taskViews = pendingTasks.current;
      if (!txt && !k && chunks.length === 0 && lines.length === 0 && taskViews.length === 0) {
        return;
      }
      pendingText.current = allTxt.slice(txt.length);
      pendingThinking.current = allK.slice(k.length);
      pendingToolJson.current = [];
      pendingProgress.current = [];
      pendingTasks.current = [];

      let plan: string | undefined;
      // 工具参数边流边填进卡片：id → 此刻已经到齐的那些字段。
      const partial = new Map<string, Record<string, string>>();
      // 解析器只吃新到的这几段，不再把累积的整段 JSON 从头扫一遍。
      for (const { id, chunk } of chunks) {
        let parser = toolJsonById.current.get(id);
        if (!parser) {
          parser = new PartialJsonObject();
          toolJsonById.current.set(id, parser);
        }
        parser.push(chunk);
        const extracted = firstStringField(parser, "plan");
        if (extracted !== null) plan = extracted;
        partial.set(id, parser.snapshot());
      }

      setState((s) => {
        // 两处都改 items，必须串起来改：各自从 s.items 出发的话，
        // 后写的那份会把先写的覆盖掉。
        let items = s.items;
        if (partial.size) items = fillToolInput(items, partial);
        if (lines.length) items = appendToolOutput(items, lines);
        // 每条都是全量视图，按 id 覆盖；同一帧里同一个子 agent 来了几条，
        // 最后一条赢 —— 和逐条 setState 的终态一样，只是少渲染几次。
        let tasks = s.tasks;
        for (const v of taskViews) tasks = upsertTask(tasks, v);
        return {
          ...s,
          streaming: s.streaming + txt,
          thinking: s.thinking + k,
          ...(plan !== undefined ? { streamingPlan: plan } : {}),
          ...(items !== s.items ? { items } : {}),
          ...(tasks !== s.tasks ? { tasks } : {}),
        };
      });
      // 还有没放完的：下一帧接着放。排在 setState 之后 —— 页面隐藏时
      // schedule 会同步再 flush 一次，后放的那截必须排在这一截后面。
      if (pendingText.current || pendingThinking.current) {
        pacedAt = now;
        schedule();
      } else {
        pacedAt = 0;
      }
    };

    function schedule() {
      if (document.hidden) {
        flush();
        return;
      }
      if (!rafId.current) rafId.current = requestAnimationFrame(() => flush(true));
    }

    const onSubscribeError = (message: string) => {
      waitStartAt.delete(sessionId);
      setState((s) => ({
        ...s,
        busy: false,
        // 收不到事件了，那个"压缩中"再也不会有人来清。
        compacting: false,
        items: [
          ...s.items,
          {
            kind: "error",
            id: `sub-${Date.now()}`,
            text: t("transcript.session.subscribeFailed", { message }),
          },
        ],
      }));
    };

    const handle = (event: AgentEvent) => {
      lastHeardAt.current = Date.now();
      switch (event.type) {
        case "delta":
          if (event.kind === "text") {
            // 开始写正文 = 这段思考结束，计时停在这里。
            const c = thinkClocks.get(sessionId);
            if (c && c.end === undefined) c.end = Date.now();
            pendingText.current += event.text;
            schedule();
          } else if (event.kind === "thinking") {
            const c = thinkClocks.get(sessionId);
            // 停过之后又思考 = 新的一段（交错思考），重新起表。
            if (!c || c.end !== undefined) thinkClocks.set(sessionId, { start: Date.now() });
            pendingThinking.current += event.text;
            schedule();
          } else if (event.kind === "tool_start") {
            // 卡片立刻出现，不等参数流完。Write 的整份文件在参数里，
            // 生成要几十秒 —— 那段时间屏幕上不能什么都没有。
            flush();
            // 前面那段思考要落定了，先用前端量的时长顶着（整条消息到了会换成
            // 内核量的）。在 updater 外面读：StrictMode 会把 updater 跑两遍，
            // 里面删表的话第二遍就读不到了。
            const clock = thinkClocks.get(sessionId);
            const thinkMs = clock ? (clock.end ?? Date.now()) - clock.start : 0;
            thinkClocks.delete(sessionId);
            setState((s) => {
              if (s.items.some((it) => it.kind === "tool" && it.id === event.tool_use_id)) {
                return s;
              }
              const items = [...s.items];
              // 工具块开始 = 前面那段话已经说完了。就地落定，卡片才能
              // 排在它下面 —— 反过来是"卡片在前、话在后"。
              // `[约束]` 记 settled 用 includes 判重:StrictMode 把 updater
              // 跑两遍，直接 push 会攒下两份同样的文本。
              if (s.thinking.trim()) {
                items.push({
                  kind: "thinking",
                  id: `${event.tool_use_id}-k`,
                  text: s.thinking,
                  ...(thinkMs > 0 ? { durationMs: thinkMs } : {}),
                });
                if (!settled.current.thinking.includes(s.thinking)) {
                  settled.current.thinking.push(s.thinking);
                }
              }
              if (s.streaming.trim()) {
                items.push({
                  kind: "assistant",
                  id: `${event.tool_use_id}-t`,
                  text: s.streaming,
                  // 这段话没有对应的完整消息（它会从消息里被 dropSettled
                  // 摘掉），拿不到内核的戳 —— 就地记一个。切回会话时整份
                  // 重建，那时用的是内核那份。
                  at: Date.now(),
                });
                if (!settled.current.text.includes(s.streaming)) {
                  settled.current.text.push(s.streaming);
                }
              }
              items.push({
                kind: "tool",
                id: event.tool_use_id,
                name: event.name,
                input: {},
                status: "running",
                output: [],
              });
              return { ...s, items, streaming: "", thinking: "" };
            });
          } else if (event.kind === "tool_input") {
            pendingToolJson.current.push({
              id: event.tool_use_id,
              chunk: event.partial_json,
            });
            schedule();
          }
          break;

        case "request_start":
          toolJsonById.current.clear();
          // 上一轮的残留会让这一轮的同样一句话被误删。
          settled.current = { text: [], thinking: [] };
          busyRef.current = true;
          // 只补缺不重置：一轮里每次模型调用都发 request_start，
          // 中途重置会让状态行的秒数在轮内清零。
          if (!waitStartAt.has(sessionId)) waitStartAt.set(sessionId, Date.now());
          // 请求开始意味着压缩这一段结束了 —— 成功如此，失败也如此
          // （失败没有事件，只有日志，但轮次照常用完整历史往下走）。
          //
          // 一轮的第一次请求（turn 0）还意味着上一轮的失败过时了：不论这轮
          // 是用户发的还是内核自己起的（后台任务唤醒），旧红卡都该收掉。
          // 轮内后续的请求不算 —— 中途的「等待授权超时」还没过时。
          setState((s) => ({
            ...s,
            busy: true,
            streamingPlan: null,
            compacting: false,
            items: event.turn === 0 ? dropErrors(s.items) : s.items,
          }));
          break;

        case "message": {
          flush();
          if (event.role === "assistant") {
            for (const c of event.content) {
              if (c.type !== "tool_use") continue;
              if (
                c.name === "ShowBrowser" ||
                (c.name === "BrowserNavigate" &&
                  (c.input as { show?: unknown } | null)?.show === true)
              ) {
                pendingShowBrowser.current.add(c.id);
              } else if (c.name === PLAN_TOOL) {
                pendingPlans.current.add(c.id);
              } else if (c.name === "BrowserHandoff") {
                // 唯一在**调用时**就弹的工具。它请用户在面板里亲自做一件事
                // （登录、过验证码），而它的结果要等他做完才回来 —— 等结果
                // 再弹，等于让他先对着一个看不见的页面动手。
                onBrowserOpenRef.current?.();
              } else if (c.name === "PreviewFile") {
                const p = (c.input as { path?: unknown } | null)?.path;
                if (typeof p === "string" && p.trim()) {
                  pendingPreviews.current.set(c.id, p);
                }
              }
            }
          }
          // 成功的结果到了才开面板 —— 这时内核已经确认过文件真的存在、
          // 浏览器里真的有一页，开出来的不会是报错标签或空面板。
          if (event.role === "user") {
            for (const c of event.content) {
              if (c.type !== "tool_result") continue;
              const p = pendingPreviews.current.get(c.tool_use_id);
              if (p !== undefined) {
                pendingPreviews.current.delete(c.tool_use_id);
                if (!c.is_error) onPreviewFileRef.current?.(p);
              }
              if (pendingShowBrowser.current.delete(c.tool_use_id) && !c.is_error) {
                onBrowserOpenRef.current?.();
              }
            }
            // 计划工具落定了：草稿撤掉，侧栏面板改读磁盘上的文件。
            const planDone = event.content.some(
              (c) =>
                c.type === "tool_result" &&
                pendingPlans.current.delete(c.tool_use_id),
            );
            if (planDone) setState((s) => ({ ...s, streamingPlan: null }));
          }
          // 排队的插话被内核注入了 —— 面板条目转成对话气泡。先按 id 配
          //（宿主入队时定的、注入原样带回），配不上再按原文兜底（sendTurn
          // 返回和注入事件跨两条通道，极端时序下 id 还没换成宿主的）。
          if (event.role === "user") {
            const text = event.content.find((c) => c.type === "text")?.text;
            const hit =
              queuedRef.current.find((q) => q.id === event.id) ??
              (text !== undefined ? queuedRef.current.find((q) => q.text === text) : undefined);
            if (hit) {
              mutateQueued((q) => q.filter((x) => x !== hit));
              setState((s) => ({
                ...s,
                items: [
                  ...s.items,
                  {
                    kind: "user",
                    id: event.id,
                    text: hit.text,
                    images: hit.images.map((i) => `data:${i.mediaType};base64,${i.data}`),
                    ...(hit.refs.length ? { files: hit.refs } : {}),
                    ...stampOf(event.meta),
                  },
                ],
                // 内核在提问落盘时拍切片。快照里的名单要等下次
                // getHistory，这里先记上，不然最新一条气泡没有回退。
                checkpointIds: rememberCheckpoint(s.checkpointIds, event.id),
              }));
              break;
            }
          }
          // 去重在 updater 外面做：StrictMode 会把 updater 跑两遍，
          // 而 settled 的消费是一次性的。
          const deduped = dropSettled(event, settled.current);
          setState((s) => applyMessage(s, deduped));
          break;
        }

        case "progress":
          // `line` 是工具的原始输出；`message` 是内核说的一句话（词典键），
          // 比如子 agent 的"[kind·model] 标题 启动"，按当前语言翻了再进同一条流。
          if (event.payload.kind === "line" || event.payload.kind === "message") {
            pendingProgress.current.push({
              id: event.tool_use_id,
              text:
                event.payload.kind === "line"
                  ? event.payload.text
                  : renderUiText(event.payload.text),
            });
            schedule();
          }
          break;

        case "permission_request":
          flush();
          setState((s) => {
            // 同一个 request_id 重复到达就不排两次 —— 事件重放（切回
            // 会话）不该让用户连答两遍同一个问题。
            if (s.asks.some((a) => a.requestId === event.request_id)) return s;
            return {
              ...s,
              asks: [...s.asks, { requestId: event.request_id, detail: event.detail }],
            };
          });
          break;

        case "permission_resolved":
          // 宿主那边这个请求已经作废（超时或被中断）。不撤掉弹窗的话，
          // 它会一直挂着，用户点"允许"也毫无反应 —— 操作早就被拒了。
          setState((s) => applyResolved(s, event.request_id, event.reason));
          break;

        case "mode_changed":
          setState((s) => ({ ...s, hostMode: { mode: event.mode, seq: (s.hostMode?.seq ?? 0) + 1 } }));
          break;

        case "background_task":
          // 每次推全量视图，按 id 覆盖；新来的排在末尾（启动顺序）。
          // 走 rAF 合批（见 pendingTasks）—— 面板和卡片晚一帧无所谓。
          pendingTasks.current.push(event.task);
          schedule();
          break;

        case "compacting":
          // 这段时间界面上只有那三个点在动。不说的话用户以为是模型变慢了，
          // 而实际上系统在做一件必要的事。
          // 手动 /compact 不开轮次、没有 request_start，等待起点在这里补。
          if (!waitStartAt.has(sessionId)) waitStartAt.set(sessionId, Date.now());
          setState((s) => ({ ...s, compacting: true }));
          break;

        case "compacted":
          // 手动压缩（不在轮内）到此等待结束；轮内自动压缩则轮子还在跑。
          if (!busyRef.current) waitStartAt.delete(sessionId);
          // 旧消息还在界面上，划一条线就够了。再出一块提示等于把记录盖住。
          flush();
          setState((s) => ({
            ...s,
            compacting: false,
            items: [...s.items, { kind: "compact", id: `compact-${Date.now()}` }],
          }));
          // 和宿主对一次账。长压缩（>12s 静默）期间看门狗拉过快照，把
          // running 被占的 busy=true 吸了进来 —— 而手动压缩结束没有 Done，
          // 这个 busy 没有别的事件会来清，状态行卡在假的"正在生成"直到下
          // 一个看门狗周期。内核保证发这个事件时 running 已释放（见
          // compact_now），所以空闲场景快照回 busy=false、这里立刻清干净；
          // 轮内场景快照回 busy=true，catchUp=false 只换出口不盖正在流的
          // 内容 —— 两种场景以宿主为准，前端不猜。
          void ensureLive({ catchUp: false });
          break;

        case "prompt_withdrawn":
          // 模型一个字都没给出就被停了，内核把这条提问从历史里删了。
          // 界面跟着撤气泡，并把原文交给输入框（Composer 消费 withdrawn）。
          flush();
          setState((s) => applyWithdrawn(s, event.message_id, event.session_empty));
          break;

        case "done": {
          flush();
          toolJsonById.current.clear();
          waitStartAt.delete(sessionId);
          // 立刻同步 ref —— 下面的接力在 React 提交之前就要按"已空闲"
          // 决定开新轮还是排队。
          busyRef.current = false;
          setState((s) => applyDone(s, event));
          // 接力：轮子停了（中断/满轮/竞态漏网）面板里还排着插话 ——
          // 自动按顺序重发，第一条开新轮、其余重新排队。这正是 CC/Cursor
          // 的语义：排队的消息是用户明确说过的话，不该因为一次停止而
          // 人间蒸发。出错例外：provider 都坏了，自动重发只会连环报错，
          // 条目留在面板里等用户处置。
          if (event.reason.reason !== "error" && queuedRef.current.length > 0) {
            const pending = [...queuedRef.current];
            mutateQueued(() => []);
            void (async () => {
              for (const it of pending) {
                // 每条之间都要重查：逐条 await 期间用户可能切走会话
                // （超出 KEEP_CHATS 就卸载了），剩下的不该继续发出去。
                if (cancelled) {
                  mutateQueued((q) => [...q, it]);
                  continue;
                }
                // 重发被拒（hook 拦了、模型没配好）就放回面板 ——
                // 接力的前提是"这些话用户还想说"，发不出去更不该丢。
                const ok = await sendRef.current?.(it.text, it.images, it.refs);
                if (!ok) mutateQueued((q) => [...q, it]);
              }
            })();
          }
          break;
        }

        default:
          break;
      }
    };

    // 历史和实时事件的衔接：订阅先建立（不能丢事件），事件先进缓冲；
    // 历史落位之后再回放缓冲。反过来做（先拉历史再订阅）会在两次调用
    // 的间隙丢事件，表现为切回会话时最后半句话不见了。
    let cancelled = false;
    let historyReady = false;
    const buffered: AgentEvent[] = [];

    /**
     * `[约束]` 处理一条事件时抛出的异常不能漏出去。
     *
     * Tauri 的 Channel 在 JS 这头按序号排队交付：回调抛了，它就不会把
     * "下一条该是几号"往前推，之后到的每一条都被当成"还没轮到"攒在缓冲里
     * —— 通道从那一刻起悄悄死掉，宿主那边 `send` 照样成功，界面上是流式
     * 正文停住、卡片不再更新，直到看门狗换出口。一条事件处理坏了只该丢
     * 这一条。
     */
    const guarded = (event: AgentEvent) => {
      try {
        handle(event);
      } catch (e) {
        console.error("[session] event handler threw; dropping this event", event.type, e);
      }
    };

    const listen = (event: AgentEvent) => {
      if (!historyReady) {
        buffered.push(event);
        return;
      }
      guarded(event);
    };

    const restoreQueue = () => {
      void queueList(sessionId)
        .then((list) => {
          if (cancelled || list.length === 0) return;
          mutateQueued((q) => [
            ...list
              .filter((x) => !q.some((y) => y.id === x.id))
              .map((x) => ({
                id: x.id,
                text: x.text,
                images: [] as ImageInput[],
                refs: x.refs,
              })),
            ...q,
          ]);
        })
        .catch(() => {
          // 会话可能刚被删。面板空着就空着，不值得报错。
        });
    };

    // 切回会话时重建排队面板：镜像随组件卸载丢了，宿主队列还在。
    // 图片拿不回全量（快照只带张数），但编辑撤回时会从宿主取回原图。
    mutateQueued(() => []);
    restoreQueue();

    let sub = subscribeSession(sessionId, listen, onSubscribeError);

    const applySnap = (hist: HistorySnap) => {
      // 限速放出的积压先落进 state，快照按重叠去拼（mergeLive）。留在
      // 积压里的话，快照之后它再被放出来，同一截字就出现两遍。
      flush();
      const busy = hist.busy;
      const compacting = hist.compacting;
      // 等待起点跟着快照对齐：还在等而起点丢了（应用重启）就从现在
      // 起数；已经空闲就清掉，免得下一轮从陈旧起点开始。
      if (busy || compacting) {
        if (!waitStartAt.has(sessionId)) waitStartAt.set(sessionId, Date.now());
      } else {
        waitStartAt.delete(sessionId);
      }
      busyRef.current = busy;
      compactingRef.current = compacting;
      // 快照里的子 agent 视图是此刻的权威。还没刷出去的旧视图不能在它
      // 之后再落地 —— 换出口期间丢掉的那条"完成"要是恰好夹在中间，
      // 卡片就会被一条更早的"运行中"盖回去，然后再没有事件来纠正它。
      pendingTasks.current = [];
      setState((s) => applyHistorySnap(s, hist));
    };

    // 先等出口挂上再拉历史。并行的话，结束事件可能还打在已经没人听的
    // 旧 channel 上，而快照里 busy 仍是 true —— 停止键就摘不掉。
    void sub.ready
      .then(() => {
        if (cancelled) return undefined;
        return getHistory(sessionId);
      })
      .then((hist) => {
        if (cancelled || !hist) return;
        // 订阅之后、快照落地之前的 text/thinking delta 已经在内核缓冲里
        // 一份，也在这里的 buffer 里一份。两头都用会把前缀拼两遍，字数
        // 翻倍；丢掉 buffer 又会丢快照之后才到的那几个 token。按重叠
        // 拼接（见 mergeLive）。
        const extra = liveDeltasOf(buffered);
        applySnap({
          ...hist,
          liveText: mergeLive(hist.liveText, extra.text),
          liveThinking: mergeLive(hist.liveThinking, extra.thinking),
        });
      })
      .catch(() => {
        // 新会话没有历史，拿不到不算错。真正的通信故障会在订阅那边报。
      })
      .finally(() => {
        if (cancelled) return;
        historyReady = true;
        setReady(true);
        for (const e of buffered) {
          // text/thinking 已经折进 liveText/liveThinking，再 handle 会重拼。
          if (isLiveDelta(e)) continue;
          guarded(e);
        }
        buffered.length = 0;
      });

    lastHeardAt.current = Date.now();
    let ensureInflight: Promise<void> | null = null;
    /**
     * `catchUp`：用历史覆盖条目。看门狗在轮子还在跑时只换出口，
     * 不要每十几秒把正在流的正文和工具输出盖掉。
     */
    const ensureLive = (opts?: { catchUp?: boolean }): Promise<void> => {
      if (cancelled || !historyReady) return Promise.resolve();
      if (ensureInflight) return ensureInflight;
      const catchUp = opts?.catchUp !== false;
      lastHeardAt.current = Date.now();
      const run = (async () => {
        try {
          sub.unsubscribe();
          sub = subscribeSession(sessionId, listen, onSubscribeError);
          await sub.ready;
          if (cancelled) return;
          const hist = await getHistory(sessionId);
          if (cancelled || !hist) return;
          if (!hist.busy || catchUp) {
            applySnap(hist);
          } else {
            flush();
            busyRef.current = true;
            compactingRef.current = hist.compacting;
            // 同 applySnap：快照里的子 agent 视图为准，攒着的旧视图作废。
            pendingTasks.current = [];
            setState((s) => ({
              ...s,
              busy: true,
              compacting: hist.compacting,
              // 弹窗也要对账：睡眠期间到的询问，事件早发进死通道了，
              // 只有快照里有它。
              asks: reconcileAsks(s.asks, hist.pendingAsks),
              // 子 agent 的状态同理：换出口期间丢掉的那条"完成"只有快照
              // 里有，不吸进来卡片就一直转圈。它不碰条目，和正在流的内容
              // 没有冲突。
              tasks: hist.tasks ?? s.tasks,
              // 通道死掉的那段思考/正文只在内核缓冲里。不 catchUp 条目
              // 以免盖掉正在流的工具输出，但半截流要接上，否则字数停住。
              streaming: mergeLive(hist.liveText, s.streaming),
              thinking: mergeLive(hist.liveThinking, s.thinking),
            }));
          }
          restoreQueue();
        } catch {
          // 订阅/历史失败：onSubscribeError 已经报过，这里别再铺一条。
        }
      })();
      // 这把锁必须自己会开。bridge 已经给每条命令上了期限，但那道保险
      // 管不了"宿主回了、这里的某个 await 却没往下走"的形态 —— 而锁一旦
      // 卡住，看门狗、切回前台、窗口聚焦三条重连路径**同时**失效，界面
      // 从此停在「正在生成」，且不报任何错。宁可放一次重复的重连进来
      // （重连本身幂等：换出口 + 拉快照），也不能永久上锁。
      const guarded = settleWithin(run, ENSURE_LIVE_DEADLINE_MS);
      ensureInflight = guarded;
      void guarded.then(() => {
        // 只清自己那一把 —— 期限到时早退的话，后面可能已经换了新的。
        if (ensureInflight === guarded) ensureInflight = null;
      });
      return guarded;
    };
    ensureLiveRef.current = () => ensureLive({ catchUp: true });

    let hiddenAt = 0;
    const onVisibility = () => {
      if (document.hidden) {
        hiddenAt = Date.now();
        return;
      }
      const away = hiddenAt ? Date.now() - hiddenAt : 0;
      hiddenAt = 0;
      if (away < AWAY_RESYNC_MS && Date.now() - lastHeardAt.current < SINK_STALE_MS) {
        return;
      }
      void ensureLive({ catchUp: true });
    };
    document.addEventListener("visibilitychange", onVisibility);

    const onWindowFocus = () => {
      // 睡眠唤醒有时不翻 visibility（窗口一直"可见"），只给一个 focus。
      if (Date.now() - lastHeardAt.current < SINK_STALE_MS) return;
      void ensureLive({ catchUp: true });
    };
    window.addEventListener("focus", onWindowFocus);

    const unlistenFocus = subscribeWindowFocus((focused) => {
      if (!focused || cancelled) return;
      if (Date.now() - lastHeardAt.current < SINK_STALE_MS) return;
      void ensureLive({ catchUp: true });
    });

    // 网页版：WebSocket 重连之后，宿主那头绑在旧连接上的出口已经作废，
    // 而断线期间的事件一条都没收到 —— 必须重订阅并按快照对账。桌面
    // 永不触发。不看 lastHeardAt：断线本身就是"该对账"的充分理由。
    const unlistenReconnect = onHostReconnect(() => {
      if (cancelled) return;
      void ensureLive({ catchUp: true });
    });

    const watchdog = window.setInterval(() => {
      if (cancelled) return;
      if (Date.now() - lastSendAt.current < SEND_GRACE_MS) return;
      const silence = Date.now() - lastHeardAt.current;
      if (busyRef.current || compactingRef.current) {
        // 轮子在跑时只换出口不盖条目：正在流的正文和工具输出别被快照冲掉。
        if (silence >= BUSY_SILENCE_MS) {
          console.warn(`[session] busy but silent for ${Math.round(silence / 1000)}s; resyncing`);
          void ensureLive({ catchUp: false });
        }
        return;
      }
      // 主 agent 空闲、子 agent 在跑（见 TASK_SILENCE_MS）。这时本地没有
      // 正在流的东西，整份按快照对齐：子 agent 的最新状态、完成通知唤起的
      // 那一轮说了什么，都在快照里。
      if (tasksRunningRef.current && silence >= TASK_SILENCE_MS) {
        console.warn(
          `[session] subagents running but silent for ${Math.round(silence / 1000)}s; resyncing`,
        );
        void ensureLive({ catchUp: true });
      }
    }, 4_000);

    return () => {
      cancelled = true;
      ensureLiveRef.current = null;
      sub.unsubscribe();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onWindowFocus);
      unlistenFocus();
      unlistenReconnect();
      window.clearInterval(watchdog);
      if (rafId.current) cancelAnimationFrame(rafId.current);
    };
  }, [sessionId, mutateQueued, setState]);

  /**
   * 发一条消息。返回 false = 宿主没收下（UserPromptSubmit hook 拦了、
   * 模型没配好、会话没了），调用方应该把用户打的字放回输入框 ——
   * 失败时这里会撤掉乐观气泡，不放回的话那段文字就彻底没了。
   */
  const send = useCallback(
    async (
      text: string,
      images: ImageInput[] = [],
      refs: string[] = [],
      /** 哪个按钮发的（「构建」/「并行构建」）。普通发送不传。 */
      nudge?: Nudge,
    ): Promise<boolean> => {
      lastSendAt.current = Date.now();
      // 上午聊完、下午再发：Channel 往往已经死了。先换出口并对历史，
      // 否则这一轮的事件（包括 Done）继续丢进没人听的旧通道，界面
      // 永远停在「正在生成」，切走再切回来却能看见完整回复。
      //
      // `[约束]` 这一步只能延后发送，不能挡死它。它排在乐观气泡**之前**，
      // 卡在这里的表现是用户打的字凭空消失 —— 没有气泡、没有排队项、
      // 也没有报错。ensureLive 自带期限且从不抛（见 settleWithin），
      // 换出口失败就带着一条可能已经死掉的通道往下走：消息照发，最坏
      // 情况是这一轮的事件收不到，而那个有看门狗兜。
      //
      // `[约束]` 每次发送都排在同一道闸后面，不只是触发重连的那一次。
      // 否则：第一句在等重连，紧跟着敲的第二句不用等（重连已把
      // lastHeardAt 刷新了），抢先读到 busy=false —— 被当成开轮的
      // 气泡乐观放上去、命令也可能先到宿主，宿主回"排队"后再被挪到
      // 排队面板**末尾**，顺序全乱。等同一个 Promise 的续体按登记顺序
      // 恢复，先发的先放置、先置忙。
      if (Date.now() - lastHeardAt.current >= SINK_STALE_MS) {
        sendGate.current = ensureLiveRef.current?.() ?? Promise.resolve();
      }
      await sendGate.current;
      // 乐观气泡上的时刻。内核那份（MessageMeta.created_at_ms）要等消息
      // 定稿才回来，而气泡现在就要显示 —— 差的只是一次 IPC 往返。
      const sentAt = Date.now();
      const localId = `local-${sentAt}-${Math.random().toString(36).slice(2, 8)}`;
      const dataUrls = images.map((i) => `data:${i.mediaType};base64,${i.data}`);
      // 立刻放上去（等宿主回声的话，用户会看到自己输入的内容凭空消失
      // 几百毫秒）：空闲 → 对话气泡；忙 → 排队面板。排队的插话在被
      // 内核注入之前**不进对话流** —— 气泡的位置意味着"模型看到了这句
      // 话"，而它此刻还没看到。
      //
      // `[约束]` queuedRef 的修改都在 setState 外面：StrictMode 会把
      // reducer 跑两遍，塞在里面的追加会翻倍。
      const wasBusy = busyRef.current;
      // 乐观气泡。按钮发的那条从一开始就画成构建卡 —— 等宿主回声再换，
      // 用户会看到一句占位话闪成卡片。
      const optimistic = (items: Item[]): Item => ({
        kind: "user",
        id: localId,
        text,
        images: dataUrls,
        ...(refs.length ? { files: refs } : {}),
        at: sentAt,
        ...buildOf(nudge, items),
      });
      if (wasBusy) {
        mutateQueued((q) => [...q, { id: localId, text, images, refs }]);
      } else {
        busyRef.current = true;
        waitStartAt.set(sessionId, Date.now());
        // 用户又发了一句 = 上一轮的失败处理过了（或者想再试），红卡当场收掉，
        // 不等 request_start 回来。
        setState((s) => ({
          ...s,
          busy: true,
          redoAvailable: false,
          items: [...dropErrors(s.items), optimistic(s.items)],
        }));
      }
      try {
        const queuedId = await sendTurn(sessionId, text, images, refs, nudge);
        const inPanel = queuedRef.current.some((q) => q.id === localId);
        // 宿主的裁决可能和乐观放置相反（提交瞬间轮子恰好结束/恰好开跑），
        // 以返回值为准挪位置。
        if (queuedId != null) {
          if (inPanel) {
            // 面板条目换成宿主 id —— 注入回流的消息按它配对。
            mutateQueued((q) => q.map((x) => (x.id === localId ? { ...x, id: queuedId } : x)));
          } else if (!wasBusy) {
            // 乐观放的是气泡，宿主却说排队了（并发发送的竞态）：挪去面板。
            mutateQueued((q) => [...q, { id: queuedId, text, images, refs }]);
            setState((s) => ({ ...s, items: s.items.filter((it) => it.id !== localId) }));
          } else {
            // 面板条目已经没了。两种可能：注入事件抢在返回之前按原文配上
            // 了（remove 落空，无害）；或者用户趁宿主 id 没就位时把它删了/
            // 编辑撤走了 —— 这时必须把宿主队列里的那份也清掉，否则用户
            // 刚删的消息过会儿又被注入进对话。
            void queueRemove(sessionId, queuedId).catch(() => {});
          }
        } else if (inPanel) {
          // 乐观放进了面板，宿主却直接开轮了：转成对话气泡。
          mutateQueued((q) => q.filter((x) => x.id !== localId));
          busyRef.current = true;
          waitStartAt.set(sessionId, Date.now());
          setState((s) => ({
            ...s,
            busy: true,
            items: [...dropErrors(s.items), optimistic(s.items)],
          }));
        }
        return true;
      } catch (e) {
        mutateQueued((q) => q.filter((x) => x.id !== localId));
        // 乐观记下的等待起点一并回滚（轮子没开起来）。
        if (!wasBusy) waitStartAt.delete(sessionId);
        setState((s) => ({
          ...s,
          // 排队发送失败时上一轮还在跑，不能把它标成空闲 ——
          // 否则停止键消失了，输出却还在滚。
          busy: wasBusy,
          items: [...s.items.filter((it) => it.id !== localId), sendFailureItem(e)],
        }));
        return false;
      }
    },
    [sessionId, mutateQueued, setState],
  );
  sendRef.current = send;

  /** 删一条排队插话（面板的垃圾桶）。 */
  const queueDelete = useCallback(
    (id: string) => {
      mutateQueued((q) => q.filter((x) => x.id !== id));
      // 宿主那边也删。false（已注入/已删）无妨 —— 面板以事件流为准。
      void queueRemove(sessionId, id).catch(() => {});
    },
    [sessionId, mutateQueued],
  );

  /**
   * 撤回一条排队插话去编辑：从宿主队列拿回原始输入（含图），面板条目
   * 消掉。返回 null = 条目已经不在（刚被注入），没东西可编。
   *
   * 条目还是本地 id（sendTurn 没返回，宿主必然说没有）时用镜像内容 ——
   * 在途的那份由 send 的对账兜底清掉，不会双份。
   */
  const queueEdit = useCallback(
    async (id: string): Promise<{ text: string; images: ImageInput[]; refs: string[] } | null> => {
      const local = queuedRef.current.find((q) => q.id === id);
      if (!local) return null;
      let took: { text: string; images: ImageInput[]; refs: string[] } | null = null;
      let takeFailed = false;
      try {
        took = await queueTake(sessionId, id);
      } catch {
        takeFailed = true; // IPC 抖了，用镜像内容兜底
      }
      if (!took && !takeFailed && !id.startsWith("local-")) {
        // 宿主明确说没有：它已经被注入进对话了，再放回输入框就是重复。
        return null;
      }
      mutateQueued((q) => q.filter((x) => x.id !== id));
      return took ?? { text: local.text, images: local.images, refs: local.refs };
    },
    [sessionId, mutateQueued],
  );

  /**
   * 立即发送一条排队插话（面板的 ↑）：不等安全点。
   *
   * 在跑 → 先从宿主队列撤下（防止停止前的最后一个安全点把它注入，
   * 出现"注入 + 接力"两条），挪到面板最前，停掉当前轮 —— Done 后的
   * 接力会让它第一个发出去。空闲（出错残留）→ 直接重发。
   */
  const queueSendNow = useCallback(
    async (id: string) => {
      const local = queuedRef.current.find((q) => q.id === id);
      if (!local) return;
      let took: { text: string; images: ImageInput[]; refs: string[] } | null = null;
      let takeFailed = false;
      try {
        took = await queueTake(sessionId, id);
      } catch {
        takeFailed = true;
      }
      if (!took && !takeFailed && !id.startsWith("local-")) {
        // 宿主明确说没有：刚被注入，消息已经在对话里了，别再发一遍。
        mutateQueued((q) => q.filter((x) => x.id !== id));
        return;
      }
      const item: QueuedItem = took ? { ...local, ...took } : local;
      if (busyRef.current) {
        mutateQueued((q) => [item, ...q.filter((x) => x.id !== id)]);
        void interruptSession(sessionId).then(
          (cancelled) => {
            if (cancelled) return;
            // 宿主已经闲着，忙碌是残留。直接发，别等一个永远不来的 Done。
            busyRef.current = false;
            mutateQueued((q) => q.filter((x) => x.id !== id));
            void send(item.text, item.images, item.refs);
          },
          // 停不下来：条目已经从宿主队列撤下、停在面板最前，等这一轮自然
          // 结束后由 Done 的接力发出去。只是要让用户知道"立即"没生效。
          (e) => setState((s) => ({ ...s, items: [...s.items, errorItem(e)] })),
        );
      } else {
        mutateQueued((q) => q.filter((x) => x.id !== id));
        void send(item.text, item.images, item.refs);
      }
    },
    [sessionId, mutateQueued, send, setState],
  );

  /**
   * 重新生成一条助手回复：丢掉它及之后的条目，从前面那条用户消息再跑。
   * 忙着的时候不做事 —— 按钮那时是禁用的。
   */
  const regenerate = useCallback(
    async (itemId: string) => {
      if (busyRef.current) return;
      const messageId = assistantMessageId(itemId);
      busyRef.current = true;
      waitStartAt.set(sessionId, Date.now());
      mutateQueued(() => []);
      setState((s) => ({
        ...s,
        items: trimAfterUserPrompt(s.items, itemId),
        streaming: "",
        thinking: "",
        streamingPlan: null,
        busy: true,
        asks: [],
        queued: [],
        redoAvailable: false,
        filesRev: s.filesRev + 1,
      }));
      try {
        await regenerateTurn(sessionId, messageId);
      } catch (e) {
        waitStartAt.delete(sessionId);
        busyRef.current = false;
        try {
          const hist = await getHistory(sessionId);
          setState((s) => {
            const restored = applyHistorySnap(s, hist);
            return {
              ...restored,
              busy: false,
              items: [...restored.items, errorItem(e)],
            };
          });
        } catch {
          setState((s) => ({
            ...s,
            busy: false,
            items: [...s.items, errorItem(e)],
          }));
        }
      }
    },
    [sessionId, mutateQueued, setState],
  );

  /**
   * 上下文修改（编辑/删除）的共用骨架：定位消息 → 执行 → 用快照对账。
   *
   * 操作前先拉一次快照，两个理由：
   * - 确认宿主真的空闲。本地 busy 只是镜像，忙时内核也会拒绝，
   *   提前拦下省一次注定失败的往返；
   * - 把界面条目换算成内核消息 id —— 乐观气泡（`local-*`）和流式期间
   *   就地落定的块（前缀是 tool_use id）带的都不是消息 id，得按
   *   角色 + 原文在快照里找到真身。
   *
   * 成功后再拉一次快照整份对齐（空心消息整条消失、多段文本合并成一段，
   * 这些边界自己在前端模拟一遍，等于把内核逻辑抄一份）。
   */
  /**
   * 气泡在宿主那边根本不存在：宿主空闲，活历史和压缩归档里都找不到
   * —— 撤回事件丢了留下的幽灵（见 phantomBubbles）。对它做什么都没有
   * 内核那一半可做，界面按撤回收场：气泡撤掉；`giveBack` 给了就把那份
   * 内容交还输入框。返回 false = 不是幽灵，照常走。
   */
  const settlePhantom = useCallback(
    (item: TextItem, hist: HistorySnap, giveBack: UserItem | null): boolean => {
      if (item.kind !== "user" || hist.busy) return false;
      // 在压缩归档里 = 真的被压进了摘要，那条报错是对的。
      if (locateMessage(hist.archived, item)) return false;
      const empty = hist.messages.length === 0 && hist.archived.length === 0;
      setState((s) => ({
        ...s,
        items: s.items.filter((it) => it.id !== item.id),
        withdrawn: giveBack ? (s.withdrawn ?? withdrawnOf(giveBack, item.id, empty)) : s.withdrawn,
      }));
      return true;
    },
    [setState],
  );

  const mutateHistory = useCallback(
    async (
      item: TextItem,
      op: (messageId: string) => Promise<void>,
      /** 幽灵气泡交还输入框的内容；null = 直接扔（删除）。 */
      phantomGiveBack: UserItem | null,
    ): Promise<boolean> => {
      if (busyRef.current) return false;
      try {
        const hist = await getHistory(sessionId);
        if (hist.busy) return false;
        const messageId = locateMessage(hist.messages, item);
        if (!messageId) {
          if (settlePhantom(item, hist, phantomGiveBack)) return true;
          throw new Error(t("transcript.session.messageGone"));
        }
        await op(messageId);
        const after = await getHistory(sessionId);
        setState((s) => rebuildFromSnap(s, after));
        return true;
      } catch (e) {
        setState((s) => ({ ...s, items: [...s.items, errorItem(e)] }));
        return false;
      }
    },
    [sessionId, setState, settlePhantom],
  );

  /**
   * 上下文编辑：把这条气泡对应消息的文本换掉。之后的轮次模型看到的
   * 就是改过的历史。返回 false = 没改成（忙、消息没了、内核拒绝），
   * 编辑框应保留草稿。
   */
  const editEntry = useCallback(
    (item: TextItem, text: string, images?: ImageInput[]) =>
      mutateHistory(
        item,
        (messageId) => editMessageBridge(sessionId, messageId, text, images),
        // 幽灵气泡：改好的那份回输入框，用户自己决定要不要发。
        item.kind === "user"
          ? {
              ...item,
              text,
              images: (images ?? []).map((i) => `data:${i.mediaType};base64,${i.data}`),
            }
          : null,
      ),
    [sessionId, mutateHistory],
  );

  /**
   * 编辑后重发（Cursor 编辑气泡后发送的同款）：换掉这条提问的文字，丢掉
   * 它之后的一切，从它再跑一轮。返回 false = 没发出去（忙、消息没了、
   * 内核拒绝），编辑框应保留草稿。
   *
   * 界面先按乐观结果画：截到这条、换字、进入忙碌 —— 和 `regenerate` 同一
   * 套；失败拉快照回滚。
   */
  const resendEntry = useCallback(
    async (item: TextItem, text: string, images?: ImageInput[]): Promise<boolean> => {
      if (busyRef.current) return false;
      let messageId: string;
      try {
        const hist = await getHistory(sessionId);
        if (hist.busy) return false;
        const found = locateMessage(hist.messages, item);
        if (!found) {
          // 幽灵气泡：没有"从它重来"可言 —— 它从没进过历史。改好的话
          // 就是一句新话，撤掉气泡、照常发出去。
          if (settlePhantom(item, hist, null)) return send(text, images ?? []);
          throw new Error(t("transcript.session.messageGone"));
        }
        messageId = found;
      } catch (e) {
        setState((s) => ({ ...s, items: [...s.items, errorItem(e)] }));
        return false;
      }
      busyRef.current = true;
      waitStartAt.set(sessionId, Date.now());
      mutateQueued(() => []);
      setState((s) => ({
        ...s,
        items: trimThroughEdited(s.items, item.id, text, images, Date.now()),
        streaming: "",
        thinking: "",
        streamingPlan: null,
        busy: true,
        asks: [],
        queued: [],
        redoAvailable: false,
        filesRev: s.filesRev + 1,
      }));
      try {
        await resendTurn(sessionId, messageId, text, images);
        return true;
      } catch (e) {
        waitStartAt.delete(sessionId);
        busyRef.current = false;
        try {
          const hist = await getHistory(sessionId);
          setState((s) => {
            const restored = applyHistorySnap(s, hist);
            return {
              ...restored,
              busy: false,
              items: [...restored.items, errorItem(e)],
            };
          });
        } catch {
          setState((s) => ({
            ...s,
            busy: false,
            items: [...s.items, errorItem(e)],
          }));
        }
        return false;
      }
    },
    [sessionId, mutateQueued, setState, settlePhantom, send],
  );

  /**
   * 回退到这条用户提问发出时：丢掉它的回复和之后的对话，文件回到当时。
   * 提问留下。失败拉快照回滚。
   */
  const restoreEntry = useCallback(
    async (item: TextItem): Promise<boolean> => {
      if (busyRef.current) return false;
      let messageId: string;
      try {
        const hist = await getHistory(sessionId);
        if (hist.busy) return false;
        const found = locateMessage(hist.messages, item);
        if (!found) {
          // 幽灵气泡：回退到它发出时 = 它从没被回答过，原文回输入框。
          if (settlePhantom(item, hist, item.kind === "user" ? item : null)) return true;
          throw new Error(t("transcript.session.messageGone"));
        }
        messageId = found;
      } catch (e) {
        setState((s) => ({ ...s, items: [...s.items, errorItem(e)] }));
        return false;
      }
      setState((s) => ({
        ...s,
        items: trimThroughEdited(s.items, item.id, item.kind === "user" ? item.text : ""),
        streaming: "",
        thinking: "",
        streamingPlan: null,
        asks: [],
        queued: [],
        redoAvailable: true,
        filesRev: s.filesRev + 1,
      }));
      try {
        const result = await restoreCheckpoint(sessionId, messageId);
        setState((s) => ({
          ...s,
          redoAvailable: result.redoAvailable,
          filesRev: s.filesRev + 1,
          items: result.failed.length
            ? [...s.items, restoreFailNotice(result.failed)]
            : s.items,
        }));
        return true;
      } catch (e) {
        try {
          const hist = await getHistory(sessionId);
          setState((s) => {
            const restored = applyHistorySnap(s, hist);
            return { ...restored, items: [...restored.items, errorItem(e)] };
          });
        } catch {
          setState((s) => ({ ...s, items: [...s.items, errorItem(e)] }));
        }
        return false;
      }
    },
    [sessionId, setState, settlePhantom],
  );

  /** 把最近一次 Restore 撤回去。对话只能靠快照接回。 */
  const redoRestore = useCallback(async (): Promise<boolean> => {
    if (busyRef.current) return false;
    try {
      const result = await redoCheckpoint(sessionId);
      const hist = await getHistory(sessionId);
      setState((s) => {
        const restored = applyHistorySnap(s, hist);
        return {
          ...restored,
          redoAvailable: result.redoAvailable,
          filesRev: s.filesRev + 1,
          items: result.failed.length
            ? [...restored.items, restoreFailNotice(result.failed)]
            : restored.items,
        };
      });
      return true;
    } catch (e) {
      setState((s) => ({ ...s, items: [...s.items, errorItem(e)] }));
      return false;
    }
  }, [sessionId, setState]);

  /** 上下文删除：按轮成对删（这条气泡所属的提问连同全部回应）。 */
  const deleteEntry = useCallback(
    (item: TextItem) =>
      mutateHistory(item, (messageId) => deleteMessageBridge(sessionId, messageId), null),
    [sessionId, mutateHistory],
  );

  const stop = useCallback(() => {
    void interruptSession(sessionId).then(
      (cancelled) => {
        if (cancelled) return;
        // 宿主已经闲着。结束事件在换订阅时丢过，界面还转圈 ——
        // 再点停止必须把残留忙碌清掉，否则停止键永远摘不下来。
        waitStartAt.delete(sessionId);
        busyRef.current = false;
        // 限速放出的积压一并作废，否则它下一帧又把流式正文填回来。
        pendingText.current = "";
        pendingThinking.current = "";
        setState((s) => ({
          ...s,
          busy: false,
          compacting: false,
          streaming: "",
          thinking: "",
          streamingPlan: null,
          items: s.items.map((it) =>
            it.kind === "tool" && it.status === "running"
              ? { ...it, status: "error" as const, result: t("transcript.session.unfinished") }
              : it,
          ),
        }));
      },
      // 停止没送到（IPC 断了、超时）：要说出来。默不作声的话，用户以为
      // 停下了，模型其实还在跑、还在改文件。
      (e) => setState((s) => ({ ...s, items: [...s.items, errorItem(e)] })),
    );
  }, [sessionId, setState]);

  /** 输入框收下了撤回的那条提问。不清的话切走再回来它会被再放一次。 */
  const clearWithdrawn = useCallback(() => {
    setState((s) => (s.withdrawn ? { ...s, withdrawn: null } : s));
  }, [setState]);

  /**
   * 停掉一个后台子 agent。只停它，前台轮次不动。
   *
   * 不乐观改状态：内核停下来会推一条 `background_task`（cancelled），
   * 面板跟着那条走 —— 这里先改的话，万一它已经结束（内核回 false），
   * 面板会先显示"已停止"再跳回"完成"。
   */
  const cancelTask = useCallback(
    (agentId: string) => {
      void taskCancel(sessionId, agentId).catch(() => {});
    },
    [sessionId],
  );

  const answer = useCallback(
    async (response: PermissionResponse, requestId?: string) => {
      // 计划卡、选择题卡和权限弹窗可能同时在场（并发工具各自征求授权），
      // 必须按 id 应答 —— 拿队首猜的话，点计划卡的"批准"可能答给了
      // 旁边排队的某次 Bash 确认。
      const ask = requestId
        ? state.asks.find((a) => a.requestId === requestId)
        : state.asks[0];
      if (!ask) return;
      // 先出队，界面立刻切到下一个。等 IPC 往返会让按钮看起来没反应，
      // 用户会连点。按 id 移除而不是 slice(1)：万一同一个请求被答了
      // 两次，也只会移除它自己，不会顶掉后面排队的那个。
      setState((s) => ({
        ...s,
        asks: s.asks.filter((a) => a.requestId !== ask.requestId),
      }));
      try {
        await respondPermission(sessionId, ask.requestId, response);
      } catch (e) {
        // 应答没送到，宿主那边还在等。弹窗必须放回去 —— 不然工具卡一直
        // 转圈、界面上没有任何可点的东西，干等到宿主超时按拒绝收场。
        // 期间宿主已经作废了它（permission_resolved）就不放。
        console.warn("[session] permission reply failed; re-queueing", e);
        setState((s) =>
          s.asks.some((a) => a.requestId === ask.requestId)
            ? s
            : { ...s, asks: [ask, ...s.asks], items: [...s.items, errorItem(e)] },
        );
      }
    },
    [sessionId, state.asks, setState],
  );

  return {
    ...state,
    ready,
    send,
    stop,
    answer,
    regenerate,
    editEntry,
    resendEntry,
    deleteEntry,
    restoreEntry,
    redoRestore,
    queueDelete,
    queueEdit,
    queueSendNow,
    clearWithdrawn,
    cancelTask,
  };
}

/** 能做上下文修改的条目：用户气泡和助手文本气泡。 */
