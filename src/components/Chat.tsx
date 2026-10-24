import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  type ConfigStatus,
  type ImageInput,
  notify,
  type Nudge,
  type PermissionMode,
  type PermissionResponse,
  type ThinkingPolicy,
} from "../bridge";
import { SessionChangesBar } from "./SessionChangesBar";
import { hasActiveTodos, TodoPanel } from "./TodoPanel";
import { thinkingClock, useSession, waitStartedAt } from "../hooks/useSession";
import { t, useT } from "../i18n";
import { createLiveTextStore } from "../lib/liveText";
import { latestPlan, planTodos, type PlanState, SWITCH_MODE_TOOL } from "../lib/plan";
import { SubagentsContext } from "../lib/subagentLink";
import { Transcript } from "./Transcript";
import { Composer, type PermissionPick } from "./Composer";
import { FolderIcon, RiotMark } from "./icons";

/** 跑完之后改动条要重算的工具。三个文件工具落基线；Bash 也算 —— 它能
 *  按字面记基线（`cp` / `mv` / `rm`），更要紧的是能把已在改动栏里的文件
 *  删掉：Write 新建、再 `rm -f`，不重算的话那条「A」会一直挂着。 */
function touchesFiles(name: unknown): boolean {
  return name === "Edit" || name === "Write" || name === "Delete" || name === "Bash";
}

/* ── 对话 ───────────────────────────────────── */

/**
 * 长任务在后台跑完时发系统通知。权限与失败处理见 bridge 的 `notify`。
 * 标题不写「Riot」：横幅自己会标出发通知的应用，标题留给事情本身。
 */
function notifyTurnDone() {
  void notify(t("app.notify.turnDone.title"), t("app.notify.turnDone.body"));
}

/** 回合停在等用户决定：和"跑完了"分开说，用户要回来点的是卡片。 */
function notifyAwaiting() {
  void notify(t("app.notify.awaiting.title"), t("app.notify.awaiting.body"));
}

export function Chat({
  sessionId,
  visible,
  expectHistory,
  config,
  workspace,
  workspaceMissing,
  onMissingWorkspace,
  initialMode,
  initialMultitask = false,
  sessionProvider,
  sessionModel,
  onSessionEndpoint,
  sessionThinking,
  onSessionThinking,
  onConfig,
  onOpenSettings,
  permissionPick,
  onPermissionChange,
  execMode,
  onFirstMessage,
  onSessionEmptied,
  onAgentBrowser,
  onAgentPreview,
  onTurnEnd,
  onFilesChanged,
  onBusy,
  onPlanChange,
  onPlanOpen,
  insertText,
  onInserted,
}: {
  sessionId: string;
  /** 在前台。隐藏的保活实例不接全局快捷键 / 粘贴 / 权限弹窗。 */
  visible: boolean;
  /** 侧栏已经有标题：历史还没到时别画成空招呼页。 */
  expectHistory: boolean;
  config: ConfigStatus;
  workspace: string;
  /** 绑定的项目目录已经不在磁盘上。 */
  workspaceMissing?: boolean;
  onMissingWorkspace?: () => void;
  initialMode: PermissionMode;
  /** 宿主侧这个会话的多任务开关。 */
  initialMultitask?: boolean;
  sessionProvider: string;
  sessionModel: string;
  onSessionEndpoint: (provider: string, model: string) => void;
  sessionThinking: ThinkingPolicy;
  onSessionThinking: (thinking: ThinkingPolicy) => void;
  onConfig: (s: ConfigStatus) => void;
  onOpenSettings: () => void;
  /** 会话设置弹窗选的权限档，透传给 Composer。 */
  permissionPick: PermissionPick | null;
  /** Composer 上报生效中的权限档。 */
  onPermissionChange: (m: PermissionMode) => void;
  /** 这个会话生效中的权限档（App 汇总的那份）。切换卡切回 agent 时落成它。 */
  execMode: PermissionMode;
  onFirstMessage: (sessionId: string, text: string) => void;
  /** 撤回把会话清空了。侧栏那句自动标题该跟着撤。 */
  onSessionEmptied?: (sessionId: string) => void;
  /** 模型明说要给用户看浏览器时（ShowBrowser / BrowserHandoff）打开右侧
   *  抽屉。其余 Browser* 工具是它自己在查，不弹 —— 见 useSession。 */
  onAgentBrowser?: () => void;
  /** 模型的 PreviewFile 工具成功后，把文件在预览面板展示给用户。
   *  路径是模型传的原文，可能是相对路径 —— 由外层按会话根目录解析。 */
  onAgentPreview?: (path: string) => void;
  /** 一轮跑完。改动面板据此再对一次 —— 抽屉是常驻的，模型改完文件
   *  不刷新的话，那里还停在上一轮的样子。 */
  onTurnEnd?: () => void;
  /** 磁盘变了：回退/重做，以及跑轮当中的 Edit / Write 落盘。
   *  预览抽屉挂着打开那一刻的字节，不推一下还是旧的。 */
  onFilesChanged?: () => void;
  /** 忙碌状态变化。侧栏的"正在跑"指示点靠它即时更新。 */
  onBusy?: (busy: boolean) => void;
  /** 这个会话的计划变了（新计划、正在流的正文、能不能构建）。右侧抽屉
   *  的计划面板画的就是这份 —— 计划是从对话条目派生的，只有 Chat 看得见。 */
  onPlanChange?: (sessionId: string, state: PlanState) => void;
  /** 模型开始写一份新计划：把右侧抽屉切到计划标签（只在前台时）。 */
  onPlanOpen?: () => void;
  /** 要塞进输入框的一段文字（终端选中的输出）。null = 没有。 */
  insertText?: string | null;
  onInserted?: () => void;
}) {
  const { t } = useT();
  const session = useSession(
    sessionId,
    onAgentBrowser || onAgentPreview
      ? {
          ...(onAgentBrowser ? { onBrowserOpen: onAgentBrowser } : {}),
          ...(onAgentPreview ? { onPreviewFile: onAgentPreview } : {}),
        }
      : undefined,
  );

  const busy = session.busy;
  const turnEndRef = useRef(onTurnEnd);
  turnEndRef.current = onTurnEnd;
  const filesChangedRef = useRef(onFilesChanged);
  filesChangedRef.current = onFilesChanged;
  const busyRef = useRef(onBusy);
  busyRef.current = onBusy;
  // 跳过挂载那次：挂载时的 busy 是历史快照，不是一次"变化"。
  //
  // `[约束]` onTurnEnd 也归这个 ref 守。它是"一轮跑完了"的通知，而挂载
  // 时的 `busy=false` 只是"这个会话现在闲着" —— 不守的话，KEEP_CHATS
  // 保活四个 Chat，切一次会话就连发几次 setChangesRev，Git 改动面板
  // 跟着做几次无谓的全量比对。
  const sawBusy = useRef(false);
  // 回合停在等用户决定：不在跑，卡片还在（见 applyDone 对 awaiting_user 的处理）。
  const awaiting = !busy && session.asks.length > 0;
  const awaitingRef = useRef(awaiting);
  awaitingRef.current = awaiting;
  useEffect(() => {
    busyRef.current?.(busy);
    if (busy) {
      sawBusy.current = true;
      return;
    }
    if (!sawBusy.current) return;
    turnEndRef.current?.();
    // 长任务跑完而窗口在后台：发一条系统通知，不然就错过了。
    // 窗口在前台时不发 —— 用户正看着呢。
    if (!document.hasFocus()) {
      if (awaitingRef.current) notifyAwaiting();
      else notifyTurnDone();
    }
  }, [busy]);
  // 回退不占 busy，上面那个 effect 看不到。filesRev 变了就通知外层重读
  // 预览 / 改动面板。跳过挂载：缓存里带回来的数字不是一次新的写盘。
  const filesRevSeen = useRef(session.filesRev);
  useEffect(() => {
    if (filesRevSeen.current === session.filesRev) return;
    filesRevSeen.current = session.filesRev;
    filesChangedRef.current?.();
  }, [session.filesRev]);
  const empty =
    session.items.length === 0 &&
    !session.streaming &&
    !session.thinking &&
    (session.ready || !expectHistory);

  // 撤回把会话清空了：那句话回到了输入框，侧栏不该再拿它当名字。
  // 只报一次 —— 输入框消费掉之后 withdrawn 就置回 null 了。
  const emptiedRef = useRef(onSessionEmptied);
  emptiedRef.current = onSessionEmptied;
  const withdrawn = session.withdrawn;
  useEffect(() => {
    if (withdrawn?.sessionEmpty) emptiedRef.current?.(sessionId);
  }, [withdrawn, sessionId]);

  // 每有一次会动文件的工具跑完就递增,改动条跟着重新比对 —— 跑轮当中改动
  // 也要实时长出来,不能等轮子结束才一次性冒出一排文件。Bash 失败也算：
  // `rm -f a && false` 退出码非零，文件照样已经没了。
  const editCount = useMemo(
    () =>
      session.items.filter((it) => it.kind === "tool" && it.status !== "running" && touchesFiles(it.name))
        .length,
    [session.items],
  );
  // 改动条的刷新键。主 agent 的编辑之外还要盯子 agent：它们改的文件也算
  // 这个会话的（内核把基线记到父会话头上），但它们的 Edit / Write / Delete /
  // Bash 不进主会话的 items —— 主会话只看得到 Task 卡片收尾、后台完成通知，
  // 以及任务面板里"正在调哪个工具"那一行。只在那一行是会动文件的工具时把
  // 调用计数掺进来：子 agent 翻代码时的几十次 Read 不值得每次都去重算 diff。
  const changesKey = useMemo(() => {
    let n = editCount;
    for (const it of session.items) {
      if (it.kind === "task_notice" || (it.kind === "tool" && it.name === "Task" && it.status === "ok")) n++;
    }
    let sub = "";
    for (const t of session.tasks) {
      const a = t.activity;
      const editing = a.key === "kernel.task.activity.tool" && touchesFiles(a.args?.name);
      sub += `${t.id}:${t.status}:${editing ? t.tool_uses : 0};`;
    }
    return `${n}|${sub}`;
  }, [editCount, session.items, session.tasks]);

  // 预览抽屉 / Git 面板跟改动条用同一条线索：Edit / Write 一落盘就重读，
  // 不能等轮子结束。跳过挂载；后台保活的会话不推 —— 切回来面板会整块
  // 重挂，那一次读的就是新的。
  const changesKeySeen = useRef(changesKey);
  useEffect(() => {
    if (changesKeySeen.current === changesKey) return;
    changesKeySeen.current = changesKey;
    if (!visible) return;
    filesChangedRef.current?.();
  }, [changesKey, visible]);

  // 输入框上方那一格的占位规则:跑轮期间有没做完的任务清单,就让
  // 任务临时顶掉改动条;清单全部完成、或轮子停了(含切回已结束的
  // 会话),任务自动让位 —— 它是进行时的进度,不是要留档的结果。
  const todoActive = busy && hasActiveTodos(session.items);

  // 所有询问都走对话流里的内联卡（照 Claude Code，不弹窗）：换模式的建议、
  // 选择题、环境变量表单，以及 Bash / Write 这类权限确认 —— 后者的卡片
  // 照样摆出将要执行的原文。
  const isModeAsk = (a: (typeof session.asks)[number]) =>
    a.detail.tool_name === SWITCH_MODE_TOOL;
  // 环境变量表单也走选择题这条内联路（见 Transcript 里按 kind 分卡）。
  const isChoiceAsk = (a: (typeof session.asks)[number]) =>
    a.detail.preview.kind === "choice" || a.detail.preview.kind === "env_vars";
  const modeAsk = session.asks.find(isModeAsk);
  const choiceAsk = session.asks.find(isChoiceAsk);
  // 并发工具会一次问好几个，按到达顺序全部排在对话末尾，各答各的。
  const permAsks = useMemo(
    () => session.asks.filter((a) => !isModeAsk(a) && !isChoiceAsk(a)),
    // isModeAsk / isChoiceAsk 是纯函数，只依赖 asks。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.asks],
  );
  // 内联卡片的回答走 ref 取当时的请求：给 Transcript 的回调要稳定（它是
  // memo 的，流式期间只在结构变了时才重渲染，见 lib/liveText）。
  const asksRef = useRef({ modeAsk, choiceAsk, answer: session.answer });
  asksRef.current = { modeAsk, choiceAsk, answer: session.answer };
  const onAnswerMode = useCallback((r: PermissionResponse) => {
    const { modeAsk: ask, answer } = asksRef.current;
    if (ask) void answer(r, ask.requestId);
  }, []);
  const onAnswerChoice = useCallback((r: PermissionResponse) => {
    const { choiceAsk: ask, answer } = asksRef.current;
    if (ask) void answer(r, ask.requestId);
  }, []);
  const onAnswerPermission = useCallback((requestId: string, r: PermissionResponse) => {
    void asksRef.current.answer(r, requestId);
  }, []);

  // 正在流的正文 / 思考不作为 prop 传给 Transcript，放进这个 store 由叶子
  // 订阅（见 lib/liveText）。提交前推进去：订阅的叶子在同一帧里同步重画。
  const [live] = useState(() =>
    createLiveTextStore({ text: session.streaming, thinking: session.thinking }),
  );
  useLayoutEffect(() => {
    live.set({ text: session.streaming, thinking: session.thinking });
  }, [live, session.streaming, session.thinking]);

  // 计划 = 对话里最近一次 CreatePlan 调用（见 lib/plan）。右侧抽屉的面板、
  // 标签上的标题、输入框的「构建」键都从这一份派生。
  const plan = useMemo(() => latestPlan(session.items), [session.items]);
  // 计划的待办进度：初稿在 CreatePlan 的参数里，构建后由模型的 TodoWrite
  // 接管（见 lib/plan 的 planTodos）。
  const todos = useMemo(() => planTodos(session.items, plan), [session.items, plan]);
  const [buildAvailable, setBuildAvailable] = useState(false);
  const planChangeRef = useRef(onPlanChange);
  planChangeRef.current = onPlanChange;
  const streamingPlan = session.streamingPlan;
  useEffect(() => {
    planChangeRef.current?.(sessionId, {
      plan,
      streaming: streamingPlan,
      canBuild: buildAvailable && plan?.status === "ok",
      edits: editCount,
      todos,
    });
  }, [sessionId, plan, streamingPlan, buildAvailable, editCount, todos]);
  // 模型开始写一份**新**计划（卡片刚以运行态出现）→ 抽屉切到计划标签。
  // 只认运行态：切回会话时水合出来的历史计划都是落定的，不该每次切回
  // 都把抽屉弹开。后台会话不抢前台的抽屉（和浏览器、预览同一个取舍）。
  const planOpenRef = useRef(onPlanOpen);
  planOpenRef.current = onPlanOpen;
  const openedPlan = useRef<string | null>(null);
  useEffect(() => {
    if (!plan || plan.status !== "running" || openedPlan.current === plan.id) return;
    openedPlan.current = plan.id;
    if (visible) planOpenRef.current?.();
  }, [plan, visible]);

  // 稳定引用：Composer 是 memo 的（见那边的说明），流式输出时 Chat 每帧
  // 重渲染，这里每次新建一个函数就等于每帧把整个输入框重画一遍。
  const firstMessageRef = useRef(onFirstMessage);
  firstMessageRef.current = onFirstMessage;
  const sessionSend = session.send;
  const send = useCallback(
    (text: string, images: ImageInput[] = [], refs: string[] = [], nudge?: Nudge): Promise<boolean> => {
      firstMessageRef.current(sessionId, text);
      return sessionSend(text, images, refs, nudge);
    },
    [sessionId, sessionSend],
  );
  const redoRestore = session.redoRestore;
  const onRedo = useCallback(() => void redoRestore(), [redoRestore]);

  const composer = (
    <Composer
      sessionId={sessionId}
      workspace={workspace}
      {...(workspaceMissing ? { workspaceMissing: true, onMissingWorkspace } : {})}
      busy={session.busy}
      awaiting={awaiting}
      config={config}
      onConfig={onConfig}
      sessionProvider={sessionProvider}
      sessionModel={sessionModel}
      onSessionEndpoint={onSessionEndpoint}
      sessionThinking={sessionThinking}
      onSessionThinking={onSessionThinking}
      initialMode={initialMode}
      initialMultitask={initialMultitask}
      hostMode={session.hostMode}
      planReady={plan?.status === "ok"}
      onBuildAvailable={setBuildAvailable}
      tokens={session.tokens}
      queued={session.queued}
      onQueueDelete={session.queueDelete}
      onQueueEdit={session.queueEdit}
      onQueueSendNow={session.queueSendNow}
      tasks={session.tasks}
      onTaskCancel={session.cancelTask}
      onSend={send}
      onStop={session.stop}
      withdrawn={session.withdrawn}
      onWithdrawnRestored={session.clearWithdrawn}
      onOpenSettings={onOpenSettings}
      permissionPick={permissionPick}
      onPermissionChange={onPermissionChange}
      insertText={insertText ?? null}
      armed={visible}
      {...(onInserted ? { onInserted } : {})}
    />
  );

  /**
   * 输入框那一格。空会话和有对话时是**同一个** dock —— 位置、结构、
   * DOM 顺序都不变，翻转的只是它上面那块（招呼语 ↔ 对话流）。
   *
   * `[约束]` 两个分支里 dock 的孩子必须逐位对应。React 按位置复用，
   * 形状一样才不会在发出第一条消息时把 Composer 整个重挂载 ——
   * 重挂载会丢掉草稿、待发的图和刚选好的权限模式。
   */
  const dock = (
    <div className="composer-dock">
      {/* 任务清单和改动条共用输入框上方这一格:跑轮时看进度,
          其余时间看改动(Cursor 同款)。两个都常驻会叠成两层横条,
          把输入框越垫越高。空会话时两者都渲染成空,不占位置。 */}
      {todoActive ? (
        <TodoPanel items={session.items} />
      ) : (
        <SessionChangesBar
          sessionId={sessionId}
          refreshKey={`${changesKey}/${session.filesRev}`}
          paused={!visible}
        />
      )}
      {composer}
    </div>
  );

  return (
    <div className={empty ? "chat chat-empty" : "chat"}>
      {empty ? (
        <div className="hero">
          <span className="hero-logo">
            <RiotMark />
          </span>
          <h1 className="hero-title">{t("app.hero.title")}</h1>
          <p className="hero-ws">
            {workspaceMissing ? (
              <button
                type="button"
                className="hero-ws-missing"
                onClick={onMissingWorkspace}
              >
                {t("app.hero.dirGone")}
              </button>
            ) : (
              <>
                <FolderIcon /> <span className="hero-ws-path">{workspace}</span>
              </>
            )}
          </p>
        </div>
      ) : (
        // 子 agent 视图给 Task 卡片认领（按 tool_use_id 直播标题/模型/动作）。
        <SubagentsContext.Provider value={session.tasks}>
          <Transcript
            sessionId={sessionId}
            items={session.items}
            live={live}
            streaming={!!session.streaming}
            thinking={!!session.thinking}
            thinkClock={thinkingClock(sessionId, session.thinking)}
            busy={session.busy}
            compacting={session.compacting}
            waitSince={waitStartedAt(sessionId)}
            armed={visible}
            onRegenerate={session.regenerate}
            onEditEntry={session.editEntry}
            onResendEntry={session.resendEntry}
            onDeleteEntry={session.deleteEntry}
            checkpointIds={session.checkpointIds}
            onRestoreEntry={session.restoreEntry}
            redoAvailable={session.redoAvailable}
            onRedo={onRedo}
            {...(modeAsk ? { modeAsk } : {})}
            {...(choiceAsk ? { choiceAsk } : {})}
            // 切回 agent 时落成这个会话进规划前那一档（Composer 上报的）。
            execMode={execMode}
            onAnswerMode={onAnswerMode}
            onAnswerChoice={onAnswerChoice}
            permAsks={permAsks}
            onAnswerPermission={onAnswerPermission}
          />
        </SubagentsContext.Provider>
      )}
      {dock}

    </div>
  );
}

