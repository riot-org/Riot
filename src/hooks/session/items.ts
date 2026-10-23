import type { DecisionReason, MessageMeta, ToolResultContent, Usage } from "../../bridge/generated";
import { type AgentEvent, type BackgroundTaskView, type ImageInput, type Message, type Nudge, renderUiText } from "../../bridge";
import { t } from "../../i18n";
import { PLAN_TOOL } from "../../lib/plan";
import { describeError } from "./errors";
import type { Item, SessionState, UserItem, WithdrawnPrompt } from "./types";

/** 工具卡片最多留这么多行实时输出（见 appendToolOutput）。 */
export const MAX_TOOL_LINES = 200;

/** 截到这条用户气泡（含）并换掉它的文字（以及可选的图），之后的一切丢掉。找不到就原样返回。 */
export function trimThroughEdited(
  items: Item[],
  userItemId: string,
  text: string,
  images?: ImageInput[],
  sentAt?: number,
): Item[] {
  const idx = items.findIndex((it) => it.id === userItemId);
  if (idx < 0) return items;
  const kept = items.slice(0, idx + 1);
  const target = kept[idx];
  if (target?.kind === "user") {
    const at = sentAt ?? target.at;
    if (images === undefined) {
      kept[idx] = { ...target, text, ...(at !== undefined ? { at } : {}) };
    } else {
      const { images: _was, ...rest } = target;
      kept[idx] = {
        ...rest,
        text,
        ...(at !== undefined ? { at } : {}),
        ...(images.length
          ? { images: images.map((img) => `data:${img.mediaType};base64,${img.data}`) }
          : {}),
      };
    }
  }
  return kept;
}

/** 丢掉这条助手回复及之后的一切，保留到它前面那条用户气泡。 */
export function trimAfterUserPrompt(items: Item[], assistantItemId: string): Item[] {
  const ast = items.findIndex((it) => it.id === assistantItemId);
  if (ast < 0) return items;
  for (let i = ast - 1; i >= 0; i--) {
    if (items[i]?.kind === "user") return items.slice(0, i + 1);
  }
  return items.slice(0, ast);
}

export function finalizeIdleItems(items: Item[], result: string): Item[] {
  let hit = false;
  const out = items.map((it) => {
    if (it.kind !== "tool" || it.status !== "running") return it;
    hit = true;
    return { ...it, status: "error" as const, result: it.result ?? result };
  });
  return hit ? out : items;
}

/**
 * 消息上的时刻，摊成一段可展开的属性。
 *
 * 老 transcript 没有这个字段（也不该编一个出来），展开成空 —— 气泡上
 * 就没有时间，而不是标成"刚刚"。
 */
export function stampOf(meta: MessageMeta | null | undefined): { at?: number } {
  const at = meta?.created_at_ms;
  return at ? { at } : {};
}

/**
 * 按钮发的消息（「构建」/「并行构建」）→ 构建卡要的两个字段，摊成一段可
 * 展开的属性。计划标题取这条消息**之前**最近一份计划 —— 卡说的是"构建
 * 哪份"，同一会话第二次规划再构建时不能指到旧的那份。「转到后台」不是
 * 开轮消息，走不到这里；真走到了也按普通气泡画。
 */
export function buildOf(
  nudge: Nudge | null | undefined,
  itemsBefore: Item[],
): { nudge?: Nudge; planName?: string } {
  if (nudge !== "build_plan" && nudge !== "build_in_parallel") return {};
  const planName = latestPlanName(itemsBefore);
  return { nudge, ...(planName ? { planName } : {}) };
}

/** 条目里最近一次 CreatePlan 的标题；没有就是 undefined。 */
export function latestPlanName(items: Item[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it?.kind !== "tool" || it.name !== PLAN_TOOL) continue;
    const name = (it.input as { name?: unknown } | null)?.name;
    return typeof name === "string" && name.trim() ? name.trim() : undefined;
  }
  return undefined;
}

/**
 * 历史里的 System 消息 → 界面条目。
 *
 * error 级的不画：失败现在是会话状态（快照的 `lastError`），不再写进历史；
 * 老 transcript 里残留的那些描述的都是早已过去的某次尝试，画出来只是
 * 一排永远消不掉的红卡。其余级别（Stop hook 拦住收尾之类）记录的是轮内
 * 真实发生的干预，画成中性提示 —— 它不是出错。带词典键的按当前语言翻，
 * 老记录只有原话就用原话。
 */
export function systemItem(msg: Extract<Message, { role: "system" }>): Item | null {
  if (msg.level === "error") return null;
  const text = msg.ui ? renderUiText({ key: msg.ui.key, args: msg.ui.args ?? {} }) : msg.text;
  return { kind: "notice", id: msg.id, text };
}

/** 错误卡是会话状态：新一轮一开，上一轮的失败就过时了，整批收掉。 */
export function dropErrors(items: Item[]): Item[] {
  return items.some((it) => it.kind === "error") ? items.filter((it) => it.kind !== "error") : items;
}

/**
 * 把流式到达的工具参数填进对应卡片。
 *
 * 参数还没齐，能显示多少显示多少 —— Write 的正文就是这样一行行长出来的。
 * 解析只认顶层字符串字段，数字和布尔参数要等完整的 tool_use 才补上。
 */
export function fillToolInput(items: Item[], partial: Map<string, Record<string, string>>): Item[] {
  let hit = false;
  const out = items.map((it) => {
    if (it.kind !== "tool") return it;
    const fields = partial.get(it.id);
    // 解析器没变化时给的是同一个对象：卡片原样保留，memo 挡得住。
    if (!fields || it.input === fields) return it;
    hit = true;
    return { ...it, input: fields };
  });
  return hit ? out : items;
}

/**
 * 去掉工具卡片出现时已经就地落定的那些块。
 *
 * 完整消息会把同一段话再给一遍，不去掉的话界面上出现两次。按内容配对
 * 而不是按位置 —— 一条消息里可能有好几个文本块，只有落定过的那些要走。
 */
export function dropSettled(
  event: Extract<AgentEvent, { type: "message" }>,
  settled: { text: string[]; thinking: string[] },
): Extract<AgentEvent, { type: "message" }> {
  if (event.role !== "assistant") return event;
  if (settled.text.length === 0 && settled.thinking.length === 0) return event;
  const content = event.content.filter((c) => {
    if (c.type !== "text" && c.type !== "thinking") return true;
    const pool = c.type === "text" ? settled.text : settled.thinking;
    const at = pool.indexOf(c.text);
    if (at < 0) return true;
    pool.splice(at, 1);
    return false;
  });
  return { ...event, content };
}

/**
 * 后台子 agent 的完成通知 → 卡片。
 *
 * 正文在 SystemReminder 附件里（模型读的那份）；这里原样拿来给人看。
 * 不是通知的消息返回 null。
 */
export function taskNoticeItem(msg: Extract<Message, { role: "user" }>): Item | null {
  const notice = msg.meta?.task_notice;
  if (!notice) return null;
  const text = msg.content
    .flatMap((c) => (c.type === "attachment" && c.kind === "system_reminder" ? [c.text] : []))
    .join("\n");
  return {
    kind: "task_notice",
    id: msg.id,
    agentId: notice.agent_id,
    title: notice.title,
    status: notice.status,
    ...(notice.kind ? { taskKind: notice.kind } : {}),
    text: stripNoticePreamble(text),
    ...stampOf(msg.meta),
  };
}

/**
 * 通知正文里前奏和汇报本体之间的分隔符。与内核 `tasks.rs` 拼通知时写的
 * 那一行对齐 —— 它是协议标记，不是界面文案，不进词典。
 */
export const NOTICE_REPORT_MARK = /--- 汇报 ---/;

/**
 * 通知正文前面是给模型的行为说明（"不要复述……"），对人没有信息量；
 * 卡片只显示分隔符之后的部分。找不到分隔符就全显示。
 */
export function stripNoticePreamble(text: string): string {
  const m = NOTICE_REPORT_MARK.exec(text);
  return m ? text.slice(m.index + m[0].length).trim() : text;
}

/** 提问落盘时内核会拍切片。事件到了先记上，不等下次拉历史。 */
export function rememberCheckpoint(ids: string[], messageId: string): string[] {
  return ids.includes(messageId) ? ids : [...ids, messageId];
}

/** 按 id 覆盖；没有就追加到末尾。 */
export function upsertTask(tasks: BackgroundTaskView[], task: BackgroundTaskView): BackgroundTaskView[] {
  const at = tasks.findIndex((t) => t.id === task.id);
  if (at < 0) return [...tasks, task];
  const out = [...tasks];
  out[at] = task;
  return out;
}

export function applyMessage(s: SessionState, event: Extract<AgentEvent, { type: "message" }>): SessionState {
  const items = [...s.items];
  const msg = event;

  if (msg.role === "user") {
    const notice = taskNoticeItem(msg);
    if (notice) {
      items.push(notice);
      return { ...s, items };
    }
    // 合成续接摘要：分割线已经说明"上面被压缩了"，不画成用户气泡。
    if (msg.meta?.synthetic && msg.content.some((c) => c.type === "text")) {
      return { ...s, items };
    }
    let sawPrompt = false;
    for (const c of msg.content) {
      if (c.type === "tool_result") {
        // 找到对应的工具卡片填结果。倒着找 —— 同一个工具在一次会话里
        // 会被调用很多次，最近那次才是它。
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
      } else if (c.type === "text") {
        // 用户正文。发送端已经乐观插过一条 `local-*`；其它观看者（网页版）
        // 没有那条，必须靠事件流补上 —— 以前这里整支跳过，另一端就只看
        // 得见助手回复。
        if (items.some((it) => it.kind === "user" && it.id === msg.id)) {
          continue;
        }
        const images = msg.content.flatMap((x) =>
          x.type === "attachment" && (x.kind === "image" || x.kind === "described_image")
            ? [`data:${x.media_type};base64,${x.data}`]
            : [],
        );
        const files = msg.content.flatMap((x) =>
          x.type === "attachment" && x.kind === "user_file" ? [x.path] : [],
        );
        // 乐观气泡：正文相同的 `local-*` 换成正式 id，避免同一句话两张卡。
        const localAt = items.findIndex(
          (it) => it.kind === "user" && it.id.startsWith("local-") && it.text === c.text,
        );
        const bubble: Extract<Item, { kind: "user" }> = {
          kind: "user",
          id: msg.id,
          text: c.text,
          ...(images.length ? { images } : {}),
          ...(files.length ? { files } : {}),
          ...stampOf(msg.meta),
          // 构建卡的计划标题按这条消息之前的条目找：乐观气泡已经占了位的
          // 话，它自己不能算"之前"。
          ...buildOf(msg.meta?.nudge, localAt >= 0 ? items.slice(0, localAt) : items),
        };
        if (localAt >= 0) {
          items[localAt] = bubble;
        } else {
          items.push(bubble);
        }
        sawPrompt = true;
      }
    }
    return sawPrompt
      ? { ...s, items, checkpointIds: rememberCheckpoint(s.checkpointIds, msg.id) }
      : { ...s, items };
  }

  if (msg.role === "assistant") {
    const stopped = msg.meta?.interrupted ? { stopped: true as const } : {};
    const at = stampOf(msg.meta);
    // 同一条消息里可以有好几段正文 / 思考（交错思考、工具前后各说一句）。
    // 第一段用裸后缀，之后的带序号 —— 同名 id 就是重复的 React key，
    // 两行会被当成一行复用、互相串内容。后缀仍匹配 `-t\d*` / `-k\d*`，
    // 剥后缀找消息 id 的地方不受影响。
    let nText = 0;
    let nThink = 0;
    for (const c of msg.content) {
      if (c.type === "text" && c.text.trim()) {
        const id = `${msg.id}-t${nText++ || ""}`;
        items.push({ kind: "assistant", id, text: c.text, ...stopped, ...at });
      } else if (c.type === "thinking" && c.text.trim()) {
        items.push({
          kind: "thinking",
          id: `${msg.id}-k${nThink++ || ""}`,
          text: c.text,
          ...(c.duration_ms ? { durationMs: c.duration_ms } : {}),
        });
      } else if (c.type === "tool_use") {
        // 卡片多半已经在了（tool_start 时就插好、参数边流边填）。这里补
        // 上完整参数 —— 再 push 一张的话，一次调用会显示成两张卡。
        const at = items.findIndex((it) => it.kind === "tool" && it.id === c.id);
        const card = {
          kind: "tool" as const,
          id: c.id,
          name: c.name,
          input: c.input,
          status: "running" as const,
          output: [] as string[],
        };
        if (at >= 0) {
          const prev = items[at] as Extract<Item, { kind: "tool" }>;
          items[at] = { ...card, status: prev.status, output: prev.output };
        } else {
          items.push(card);
        }
      }
    }
    // 流式文本已经落成正式消息，清掉临时区，否则同一段会显示两遍
    const u = msg.usage;
    const tokens = u
      ? {
          input: s.tokens.input + u.input_tokens + u.cache_read_tokens + u.cache_creation_tokens,
          output: s.tokens.output + u.output_tokens,
          context: contextOf(u),
        }
      : s.tokens;
    return { ...s, items, streaming: "", thinking: "", tokens };
  }

  if (msg.role === "system") {
    const it = systemItem(msg);
    if (it) items.push(it);
  }
  return { ...s, items };
}

/**
 * 把一帧里攒下的进度行追加到各自的工具卡片。
 *
 * 按工具分组后每张卡只重建一次：同一个 build 一帧内来几十行是常态，
 * 逐行复制 items 数组等于把开销乘上行数。找不到卡片的行直接丢 ——
 * 那是 tool_start 还没到（或已经被历史覆盖）的进度，没有归宿。
 */
export function appendToolOutput(items: Item[], lines: { id: string; text: string }[]): Item[] {
  const byTool = new Map<string, string[]>();
  for (const { id, text } of lines) {
    const bucket = byTool.get(id);
    if (bucket) bucket.push(text);
    else byTool.set(id, [text]);
  }

  let out = items;
  for (const [id, texts] of byTool) {
    const i = findLast(out, (it) => it.kind === "tool" && it.id === id);
    if (i < 0) continue;
    // 第一次命中才复制，全都没命中时保持引用不变（memo 才挡得住）。
    if (out === items) out = [...items];
    const card = out[i] as Extract<Item, { kind: "tool" }>;
    // 只留尾部。一个 build 能吐几万行，全留着会让页面卡死，而有用的
    // 信息（错误摘要）总是在最后。
    out[i] = { ...card, output: [...card.output, ...texts].slice(-MAX_TOOL_LINES) };
  }
  return out;
}

export function applyDone(s: SessionState, event: Extract<AgentEvent, { type: "done" }>): SessionState {
  const items = [...s.items];
  const r = event.reason;

  // 回合停在等用户决定：卡片要留着等人答，那几个调用也确实还没结束（答完
  // 续跑才有结果），工具卡片保持原样。
  if (r.reason === "awaiting_user") {
    return { ...s, busy: false, compacting: false, streaming: "", thinking: "", streamingPlan: null };
  }

  // 收尾时把还挂着 running 的工具卡片改掉。否则界面上会永远转圈，
  // 而后台其实什么都没在跑了。
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it && it.kind === "tool" && it.status === "running") {
      items[i] = { ...it, status: "error", result: t("transcript.session.unfinished") };
    }
  }

  if (r.reason === "error") {
    // 失败只在 Done 里报一次（内核不再往历史写 System 消息），这里是它
    // 唯一的画法。宿主同时把它记成会话状态，切走再切回靠快照画回来。
    items.push({ kind: "error", id: `done-${Date.now()}`, ...describeError(r.error) });
  } else if (r.reason === "max_turns") {
    // 不是报错:模型这一轮自主跑满了步数上限，停下来等指示。用中性
    // 提示，别用红色 error 样式吓人。文案说清"没坏、接着说就行"。
    items.push({
      kind: "notice",
      id: `done-${Date.now()}`,
      text: t("transcript.session.maxTurns", { limit: r.limit }),
    });
  }

  // 这一轮结束了，还排着队的权限请求已经没有意义 —— 它们对应的工具
  // 调用要么被中断要么已超时。留着的话，用户下一轮开口前会先被一个
  // 属于上一轮的弹窗拦住。
  //
  // 例外：有后台子 agent 在跑。它们的权限询问不属于任何一轮，前台轮结束
  // 时还等着人答。这时只能信内核 —— 作废的询问内核会发 permission_resolved
  // （中断、超时都发），这里不再一把清空。
  const backgroundRunning = s.tasks.some((t) => t.background && t.status === "running");
  return {
    ...s,
    items,
    busy: false,
    compacting: false,
    streaming: "",
    thinking: "",
    streamingPlan: null,
    asks: backgroundRunning ? s.asks : [],
  };
}

/**
 * 撤掉最后那条用户气泡，把内容交给输入框。
 *
 * 按位置找而不是按 id：气泡通常还是发送时的乐观条目（`local-*`），内核
 * 的消息 id 从没到过界面这一侧。撤回只发生在"这一轮什么都没产出"的时候，
 * 所以往回数第一条用户消息必然就是它 —— 但它不一定是**最后一条条目**：
 * 主动压缩的分割线会排在它后面。
 */
export function applyWithdrawn(s: SessionState, id: string, sessionEmpty: boolean): SessionState {
  let at = -1;
  for (let i = s.items.length - 1; i >= 0; i--) {
    if (s.items[i]?.kind === "user") {
      at = i;
      break;
    }
  }
  const bubble = at < 0 ? undefined : s.items[at];
  // 没有气泡可撤（历史刚被别的路径重建过）：内核那边已经删了，界面
  // 保持现状就行，下一次快照会对齐。
  if (!bubble || bubble.kind !== "user") return s;

  const items = [...s.items];
  items.splice(at, 1);
  return { ...s, items, withdrawn: withdrawnOf(bubble, id, sessionEmpty) };
}

/** 把一条用户气泡交还输入框的那份内容。 */
export function withdrawnOf(bubble: UserItem, id: string, sessionEmpty: boolean): WithdrawnPrompt {
  return {
    id,
    text: bubble.text,
    images: (bubble.images ?? []).flatMap((u) => {
      const img = imageFromDataUrl(u);
      return img ? [img] : [];
    }),
    refs: bubble.files ?? [],
    sessionEmpty,
  };
}

/** `data:image/png;base64,……` → 重新发送时要的图片输入。认不出就丢掉。 */
export function imageFromDataUrl(url: string): ImageInput | null {
  const m = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url);
  return m?.[1] && m[2] ? { mediaType: m[1], data: m[2] } : null;
}

/**
 * 撤掉一个已经作废的权限请求。
 *
 * 超时会额外留一行。不说的话用户只会以为程序卡了 —— 而这一步确实
 * 没执行，后面的结果都建立在"少做了一件事"之上。
 */
export function applyResolved(s: SessionState, requestId: string, reason: DecisionReason): SessionState {
  if (!s.asks.some((a) => a.requestId === requestId)) return s;
  const asks = s.asks.filter((a) => a.requestId !== requestId);
  if (reason.kind !== "timeout") return { ...s, asks };
  return {
    ...s,
    asks,
    items: [
      ...s.items,
      {
        kind: "error",
        id: `ask-timeout-${requestId}`,
        text: t("transcript.session.askTimeout"),
      },
    ],
  };
}

/**
 * 工具结果 → 界面上显示什么。
 *
 * 图片类结果（截图、读图）显示图片本身。described_image 的 text 是写给
 * 模型的转述（带着"当作亲眼所见"之类的内部指示），**不能**摆到界面上 ——
 * 用户该看到的是那张图。marked_image 的 text 则是和图同属一个结果的
 * 正文（编号清单、MCP 结果的文本部分），图文都给用户看。
 *
 * `image` 是消息里的压缩图（data URL），`imagePath` 是落盘原图的路径。
 * 两个都给：压缩图立刻能显示，原图由组件按路径异步加载后替换。
 */
export function resultView(c: ToolResultContent): { text?: string; image?: string; imagePath?: string } {
  switch (c.type) {
    case "text":
      return { text: c.text };
    case "spilled": {
      const head = t("transcript.session.result.spilled", { bytes: c.total_bytes, path: c.path });
      return { text: `${head}\n\n${c.preview}` };
    }
    case "cleared":
      return { text: t("transcript.session.result.cleared") };
    case "marked_image":
      return {
        text: c.text,
        image: `data:${c.media_type};base64,${c.data}`,
        ...(c.path ? { imagePath: c.path } : {}),
      };
    case "image":
    case "described_image":
      return {
        image: `data:${c.media_type};base64,${c.data}`,
        ...(c.path ? { imagePath: c.path } : {}),
      };
    default:
      return {};
  }
}

export function findLast<T>(arr: T[], pred: (x: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i];
    if (v !== undefined && pred(v)) return i;
  }
  return -1;
}

/** 重建历史时恢复用量，和实时路径的口径一致。 */
export function sumUsage(msgs: Message[]): { input: number; output: number; context: number } {
  let input = 0;
  let output = 0;
  // 每遇到一条就整个覆盖，循环结束后剩的就是最后一条 —— 那一次请求发出去
  // 的量就是此刻上下文的真实大小（服务方报的数，不是估的）。
  let context = 0;
  for (const m of msgs) {
    if (m.role === "assistant" && m.usage) {
      input += m.usage.input_tokens + m.usage.cache_read_tokens + m.usage.cache_creation_tokens;
      output += m.usage.output_tokens;
      context = contextOf(m.usage);
    }
  }
  return { input, output, context };
}

/** 一次请求占了多少上下文：发进去的（含命中缓存的）加上吐出来的。 */
export function contextOf(u: Usage): number {
  return u.input_tokens + u.cache_read_tokens + u.cache_creation_tokens + u.output_tokens;
}
