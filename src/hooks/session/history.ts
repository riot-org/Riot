import type { AgentEvent, Message, PendingAsk, PermissionAsk } from "../../bridge";
import { t } from "../../i18n";
import { describeError } from "./errors";
import {
  buildOf,
  dropErrors,
  findLast,
  finalizeIdleItems,
  resultView,
  stampOf,
  sumUsage,
  systemItem,
  taskNoticeItem,
  withdrawnOf,
} from "./items";
import type { HistorySnap, Item, SessionState, TextItem, UserItem } from "./types";

/** 刚发送的那几秒不要用快照盖界面：乐观气泡还没进宿主历史。 */
export const SEND_GRACE_MS = 8_000;

/**
 * 上下文修改（编辑/删除）成功后的对账：快照就是真相，整份重建。
 *
 * 不走 applyHistorySnap —— 那是"切回活会话"的对齐语义，带两个照顾：
 * 空历史时保留旧条目、把不在快照里的乐观气泡（`local-*`）拼回来。
 * 这两个照顾在"刚刚确定性地删掉/改掉了什么"的场景里恰好是反效果：
 * 删掉唯一一轮后界面纹丝不动（看起来像没删，再点一次就报"消息不在
 * 上下文里"），编辑乐观气泡后旧文本又被拼回来显示成两条。
 */
export function rebuildFromSnap(s: SessionState, hist: HistorySnap): SessionState {
  const messages = hist.messages;
  const archived = hist.archived;
  return {
    ...s,
    busy: hist.busy,
    compacting: hist.compacting,
    items: [...historyToItems(messages, archived, false), ...lastErrorItem(hist)],
    tokens: sumUsage([...archived, ...messages]),
    streaming: "",
    thinking: "",
    streamingPlan: null,
    asks: [],
    checkpointIds: hist.checkpointIds ?? s.checkpointIds,
    redoAvailable: hist.redoAvailable ?? s.redoAvailable,
  };
}

/**
 * 界面条目 → 内核消息 id。
 *
 * 历史水合的条目 id 是 `msg_x-t3` / `msg_x-u1` / `msg_x-k2`，剥掉后缀就是
 * 消息 id；实时路径还有两种带不了消息 id 的形态 —— 乐观用户气泡
 * （`local-*`）和工具卡出现时就地落定的块（前缀是 tool_use id）——
 * 按角色 + 原文在快照里倒序找（同文出现多次时取最近那条）。
 */
export function locateMessage(messages: Message[], item: TextItem): string | null {
  const bare = item.id.replace(/-[tuk]\d*$/, "");
  if (messages.some((m) => m.id === bare)) return bare;
  const role = item.kind === "user" ? "user" : "assistant";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== role) continue;
    if (m.content.some((c) => c.type === "text" && c.text === item.text)) return m.id;
  }
  return null;
}

/** 活历史 + 压缩前归档 → 界面条目。归档画在分割线上面。 */
export function historyToItems(live: Message[], archived: Message[], liveTurn = false): Item[] {
  const past = messagesToItems(archived, true);
  const now = messagesToItems(live, true);
  const items: Item[] =
    past.length === 0 ? now : [...past, { kind: "compact", id: "compact-boundary" }, ...now];
  if (liveTurn) return items;
  // 历史里不该有还在转圈的工具。有就是这一轮被中断了，如实说。
  // 轮子还在跑时（liveTurn）不能标 —— 切到正在跑的会话会把活工具
  // 画成「未完成」，下一秒事件又改回来，闪一下像出错了。
  return finalizeIdleItems(items, t("transcript.session.unfinishedInterrupted"));
}

/**
 * 用宿主快照对齐界面。
 *
 * 空闲：整份替换并清掉忙碌残留（这就是下午回来还在「正在生成」的修复）。
 * 忙碌：条目追上已落盘的消息，但保留还没进历史的流式正文和工具输出。
 */
export function applyHistorySnap(s: SessionState, hist: HistorySnap): SessionState {
  const messages = hist.messages;
  const archived = hist.archived;
  const busy = hist.busy;
  const compacting = hist.compacting;
  // 后台任务以快照为准：事件只在变化时推，切走期间的变化只有快照里有。
  // 老宿主没这个字段时保留本地那份。
  const tasks = hist.tasks ?? s.tasks;
  const checkpointIds = hist.checkpointIds ?? s.checkpointIds;
  const redoAvailable = hist.redoAvailable ?? s.redoAvailable;

  if (messages.length === 0 && archived.length === 0) {
    return {
      ...s,
      busy,
      compacting,
      tasks,
      checkpointIds,
      redoAvailable,
      ...(!busy
        ? {
            streaming: "",
            thinking: "",
            streamingPlan: null,
            // 空闲也按快照对账而不是清空：后台子 agent 的询问不属于任何
            // 一轮，前台空闲时它可能正等着人答。快照为准。
            asks: reconcileAsks(s.asks, hist.pendingAsks),
            // 历史为空但上一轮失败了（第一句就没发出去）：红卡从快照来。
            // 撤回事件丢了的那条第一句话也在这里收掉（见 phantomBubbles）。
            ...(() => {
              const kept = dropPhantoms(
                s,
                finalizeIdleItems(dropErrors(s.items), t("transcript.session.unfinished")),
                phantomBubbles(s.items, []),
                true,
              );
              return { ...kept, items: [...kept.items, ...lastErrorItem(hist)] };
            })(),
          }
        : {
            asks: reconcileAsks(s.asks, hist.pendingAsks),
            streaming: mergeLive(
              hist.liveText,
              keepIfNotSettled(s.streaming, s.items, "assistant"),
            ),
            thinking: mergeLive(
              hist.liveThinking,
              keepIfNotSettled(s.thinking, s.items, "thinking"),
            ),
          }),
    };
  }

  const fromHist = historyToItems(messages, archived, busy);
  // 空闲时历史里没有、也不会再来的乐观气泡先摘出来（见 phantomBubbles），
  // 别让下面的合并把它当成"还没进历史"保下来。
  const phantoms = busy ? [] : phantomBubbles(s.items, fromHist);
  const current = phantoms.length ? dropPhantoms(s, s.items, phantoms, false).items : s.items;
  // 错误卡以快照为准：历史里没有它（失败不进历史），本地画着的那张要么
  // 就是快照里这条，要么是宿主已经开了新一轮之后过时的旧卡。
  const items = [
    ...mergeLiveTools(mergeOptimisticUser(fromHist, current), current),
    ...lastErrorItem(hist),
  ];
  const tokens = sumUsage([...archived, ...messages]);
  if (busy) {
    return {
      ...s,
      busy: true,
      compacting,
      items,
      tokens,
      tasks,
      checkpointIds,
      redoAvailable,
      // 半截流以快照为准：内核收齐了每一条增量，本地这份在切走/通道
      // 断开期间是缺头的。快照为空（老内核或刚好没在流）才退回本地。
      streaming: mergeLive(
        hist.liveText,
        keepIfNotSettled(s.streaming, items, "assistant"),
      ),
      thinking: mergeLive(
        hist.liveThinking,
        keepIfNotSettled(s.thinking, items, "thinking"),
      ),
      asks: reconcileAsks(s.asks, hist.pendingAsks),
    };
  }
  return {
    ...s,
    busy: false,
    compacting,
    items,
    tokens,
    tasks,
    checkpointIds,
    redoAvailable,
    streaming: "",
    thinking: "",
    streamingPlan: null,
    asks: reconcileAsks(s.asks, hist.pendingAsks),
    withdrawn: dropPhantoms(s, items, phantoms, false).withdrawn,
  };
}

/** 还没进历史的乐观气泡留下，已经在快照里的丢掉。 */
export function mergeOptimisticUser(fromHist: Item[], current: Item[]): Item[] {
  const extras = current.filter((it) => {
    if (it.kind !== "user" || !it.id.startsWith("local-")) return false;
    return !fromHist.some((h) => h.kind === "user" && h.text === it.text);
  });
  return extras.length === 0 ? fromHist : [...fromHist, ...extras];
}

/**
 * 用快照里的挂起询问重建弹窗队列。
 *
 * `permission_request` 事件只发一次：切走再切回（组件重挂载）、睡眠唤醒
 * 后换通道，事件都已经发进没人听的旧出口，弹窗全靠快照重建。快照为准 ——
 * 不在快照里的已经被解决（超时/分类器），留着就是一个点了没反应的僵尸
 * 弹窗；已在队列里的保住原对象，正在看的弹窗不因为一次对账重建。快照
 * 之后新到的询问由事件流补上（permission_request 的处理按 request_id
 * 去重，晚到的重复无害）。
 */
export function reconcileAsks(
  current: { requestId: string; detail: PermissionAsk }[],
  snap: PendingAsk[],
): { requestId: string; detail: PermissionAsk }[] {
  return snap.map(
    (p) =>
      current.find((a) => a.requestId === p.request_id) ?? {
        requestId: p.request_id,
        detail: p.detail,
      },
  );
}

/**
 * 把内核快照里的半截流和本地/缓冲里的增量拼起来。
 *
 * 订阅之后到快照落地之间，同一段 delta 会同时出现在两边。哪边是前缀
 * 就取长的；有重叠就按后缀对齐再接上快照之后才到的那截。对不上就
 * 以快照为准再追加 —— 总比从 0 重数、缺一截头好。
 */
export function mergeLive(snap: string | undefined, extra: string): string {
  const a = snap ?? "";
  if (!extra) return a;
  if (!a) return extra;
  if (extra.startsWith(a)) return extra;
  if (a.startsWith(extra)) return a;
  const max = Math.min(a.length, extra.length);
  for (let k = max; k >= 0; k--) {
    if (a.endsWith(extra.slice(0, k))) return a + extra.slice(k);
  }
  return a + extra;
}

export function isLiveDelta(event: AgentEvent): boolean {
  return event.type === "delta" && (event.kind === "text" || event.kind === "thinking");
}

export function liveDeltasOf(events: AgentEvent[]): { text: string; thinking: string } {
  let text = "";
  let thinking = "";
  for (const e of events) {
    if (e.type !== "delta") continue;
    if (e.kind === "text") text += e.text;
    else if (e.kind === "thinking") thinking += e.text;
  }
  return { text, thinking };
}

/** 历史没有进度行，把界面上还在跑的那张卡的输出接回去。 */
export function mergeLiveTools(fromHist: Item[], current: Item[]): Item[] {
  return fromHist.map((it) => {
    if (it.kind !== "tool" || it.status !== "running") return it;
    const prev = current.find((c) => c.kind === "tool" && c.id === it.id);
    if (!prev || prev.kind !== "tool") return it;
    return {
      ...it,
      output: prev.output.length > 0 ? prev.output : it.output,
      input: hasToolInput(it.input) ? it.input : prev.input,
      ...(prev.resultImage ? { resultImage: prev.resultImage } : {}),
      ...(prev.resultImagePath ? { resultImagePath: prev.resultImagePath } : {}),
    };
  });
}

export function hasToolInput(input: unknown): boolean {
  return !!input && typeof input === "object" && Object.keys(input as object).length > 0;
}

export function keepIfNotSettled(
  live: string,
  items: Item[],
  kind: "assistant" | "thinking",
): string {
  if (!live.trim()) return "";
  if (items.some((it) => it.kind === kind && textsOverlap(it.text, live))) return "";
  return live;
}

export function textsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/** 界面条目 id（`msg_xxx-t` / `msg_xxx-t3`）→ 内核消息 id。 */
export function assistantMessageId(itemId: string): string {
  return itemId.replace(/-t\d*$/, "");
}

/**
 * 消息 → 界面条目。导出给子 agent 会话视图复用：那边拿到的是同一种
 * `Message[]`，画法也该和主对话一样（工具卡、思考块、回答）。
 */
export function messagesToItems(msgs: Message[], skipSynthetic = false): Item[] {
  const items: Item[] = [];

  for (const msg of msgs) {
    if (msg.role === "user") {
      // 后台子 agent 的完成通知：卡片，不是用户气泡。先于 synthetic 判定 ——
      // 它也是合成的，但有自己的画法。
      const notice = taskNoticeItem(msg);
      if (notice) {
        items.push(notice);
        continue;
      }
      // 带文本的合成用户消息（压缩后的续接摘要）不是用户说的话。
      // 分割线已经说明"上面被压缩了"，这里不再画一块提示把记录盖住。
      // 只拦带文本的：中断时合成的"已取消"消息只有 tool_result，必须
      // 走下面的正常流程去把工具卡片标成中断。
      if (msg.meta?.synthetic && msg.content.some((c) => c.type === "text")) {
        if (!skipSynthetic) {
          items.push({ kind: "compact", id: `${msg.id}-synthetic` });
        }
        continue;
      }
      // 历史里用户附的图。不回显的话，切回会话后"自己发过哪张图"就再也
      // 看不到了。挂在同一条消息的第一个文本气泡上 —— user_content 保证
      // 每条用户消息都有文本。
      //
      // 两种附件都是图：`image` 是模型自己能看图时存的原图，
      // `described_image` 是走视觉兼容时存的（模型读里面的转述，图给界面）。
      // 只认前者的话，纯文本模型下的图片全都不显示。
      const images = msg.content.flatMap((c) =>
        c.type === "attachment" && (c.kind === "image" || c.kind === "described_image")
          ? [`data:${c.media_type};base64,${c.data}`]
          : [],
      );
      // `@` 引用过的文件。内容进了模型，界面只列路径 —— 把整份文件
      // 铺在气泡里，一次引用就能把对话流淹掉。
      const files = msg.content.flatMap((c) =>
        c.type === "attachment" && c.kind === "user_file" ? [c.path] : [],
      );
      let imagesShown = false;
      for (const c of msg.content) {
        if (c.type === "text") {
          items.push({
            kind: "user",
            id: `${msg.id}-u${items.length}`,
            text: c.text,
            ...(images.length && !imagesShown ? { images } : {}),
            ...(files.length && !imagesShown ? { files } : {}),
            ...stampOf(msg.meta),
            ...buildOf(msg.meta?.nudge, items),
          });
          imagesShown = true;
        } else if (c.type === "tool_result") {
          const i = findLast(items, (it) => it.kind === "tool" && it.id === c.tool_use_id);
          if (i >= 0) {
            const card = items[i] as Extract<Item, { kind: "tool" }>;
            const view = resultView(c.content);
            items[i] = {
              ...card,
              status: c.is_error ? "error" : "ok",
              ...(view.text !== undefined ? { result: view.text } : {}),
              ...(view.image !== undefined ? { resultImage: view.image } : {}),
              ...(view.imagePath !== undefined ? { resultImagePath: view.imagePath } : {}),
            };
          }
        }
      }
    } else if (msg.role === "assistant") {
      for (const c of msg.content) {
        if (c.type === "text" && c.text.trim()) {
          items.push({
            kind: "assistant",
            id: `${msg.id}-t${items.length}`,
            text: c.text,
            ...(msg.meta?.interrupted ? { stopped: true as const } : {}),
            ...stampOf(msg.meta),
          });
        } else if (c.type === "thinking" && c.text.trim()) {
          items.push({
            kind: "thinking",
            id: `${msg.id}-k${items.length}`,
            text: c.text,
            ...(c.duration_ms ? { durationMs: c.duration_ms } : {}),
          });
        } else if (c.type === "tool_use") {
          items.push({
            kind: "tool",
            id: c.id,
            name: c.name,
            input: c.input,
            status: "running",
            output: [],
          });
        }
      }
    } else {
      const it = systemItem(msg);
      if (it) items.push(it);
    }
  }

  return items;
}

/** 快照里带着的"最近一轮失败"→ 画在末尾的那张错误卡。 */
export function lastErrorItem(hist: HistorySnap): Item[] {
  if (!hist.lastError || hist.busy) return [];
  return [{ kind: "error", id: "last-error", ...describeError(hist.lastError) }];
}

/**
 * 乐观气泡发出去超过这么久、宿主空闲、历史里却没有它 —— 它不会再来了。
 * 和看门狗的发送宽限同一个数：宽限之内的快照可能拍在内核收到之前。
 */
export const PHANTOM_AFTER_MS = SEND_GRACE_MS;

/**
 * 宿主空闲时历史里没有、也不会再有的那条提问气泡。
 *
 * 来路是丢了 `prompt_withdrawn`：按了停止、模型一个字没给出，内核把提问
 * 撤了，可撤回事件落进了一条正在换的 / 已经死掉的通道（长时间空闲后
 * 第一句话最容易撞上）。气泡留在界面上，对它删除、编辑、回退都报
 * "不在上下文里"。气泡此时多半已经换成了内核的 id（轮首回声），还是
 * 乐观的 `local-*` 则另有一层：快照对账会按"还没进历史"把它保下来。
 *
 * 只认**最后一条**提问、且它后面没有任何回答：撤回只会发生在那里。
 * 放宽了的话，另一个观看者删掉的一轮会被这里当成撤回，把原文塞进
 * 这边的输入框。乐观气泡还在发送宽限内的不算 —— 快照可能拍在内核
 * 收到它之前。
 */
export function phantomBubbles(items: Item[], fromHist: Item[], now = Date.now()): UserItem[] {
  let at = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    const k = items[i]?.kind;
    if (k === "user") {
      at = i;
      break;
    }
    if (k === "assistant" || k === "thinking" || k === "tool") return [];
  }
  const it = items[at];
  if (!it || it.kind !== "user") return [];
  if (it.id.startsWith("local-") && now - (it.at ?? 0) < PHANTOM_AFTER_MS) return [];
  if (fromHist.some((h) => h.kind === "user" && (h.id === it.id || h.text === it.text))) return [];
  return [it];
}

/**
 * 撤掉幽灵气泡，并像撤回那样把最后一条交还输入框 —— 撤回事件本该做的
 * 事。输入框已经有一份待收的撤回时不覆盖。
 */
export function dropPhantoms(
  s: SessionState,
  items: Item[],
  phantoms: UserItem[],
  sessionEmpty: boolean,
): Pick<SessionState, "items" | "withdrawn"> {
  const last = phantoms[phantoms.length - 1];
  if (!last) return { items, withdrawn: s.withdrawn };
  const gone = new Set(phantoms.map((p) => p.id));
  return {
    items: items.filter((it) => !gone.has(it.id)),
    withdrawn: s.withdrawn ?? withdrawnOf(last, last.id, sessionEmpty),
  };
}
