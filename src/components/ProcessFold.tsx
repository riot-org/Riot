import { memo, useEffect, useRef, useState } from "react";

import type { Item } from "../hooks/useSession";
import { t, tn, useT } from "../i18n";
import { PLAN_TOOL } from "../lib/plan";
import { Chevron } from "./Chevron";
import { Markdown } from "./Markdown";
import { SmoothFold } from "./SmoothFold";
import { hasImage, summarize, ToolCard, ToolThumb } from "./ToolCard";

/** 正在流的那段思考的计时（见 useSession 的 thinkingClock）。`end` = 已转去写正文。 */
export type ThinkClock = { start: number; end?: number };

/** 思考时长的读法：「12 秒」「1 分 5 秒」。不足一秒按一秒说。 */
export function formatDuration(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  if (total < 60) return t("common.durSec", { s: total });
  return t("common.durMinSec", { m: Math.floor(total / 60), s: total % 60 });
}

/**
 * 直播思考的计时，自己每秒刷新。单独成组件：时长每秒变，不该拖着整个
 * 思考块（和外面 memo 住的过程组）一起重渲染。clock 是 useSession 里那张
 * 表的同一个对象，`end` 是原地写上的 —— 这里每次刷新都现读。
 */
function LiveElapsed({ clock }: { clock: ThinkClock }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (clock.end !== undefined) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [clock, clock.end]);
  return <span className="think-time">{formatDuration((clock.end ?? Date.now()) - clock.start)}</span>;
}

/** 能折进过程组的条目：思考和工具调用。 */
export type FoldItem = Extract<Item, { kind: "thinking" | "tool" }>;

/** 时间线的渲染块：普通条目原样一行，连续的过程条目折成一组。 */
export type Block =
  | { kind: "row"; item: Item }
  | { kind: "fold"; id: string; items: FoldItem[]; live: boolean };

/**
 * 不折叠的工具：编辑类卡片是用户要看的工作产物 —— 折进组里等于把
 * 成果藏起来。卡片本身默认收着，摘要行带「+N −M」（见 ToolCard）。
 */
/**
 * Task 也不折：子 agent 的卡片是一条"标题 · 模型 · 正在做什么"的直播行，
 * 还是打开它会话的入口（照 Cursor，子 agent 列表始终可见）。折进
 * "N 步"里用户就找不到它了。
 *
 * CreatePlan 同理：计划卡是打开计划面板的入口，也是"这一轮产出了什么"
 * 的答案 —— 规划轮里它前面往往是几十步只读侦察，折进去就没了。
 */
const KEEP_VISIBLE = new Set([
  "Edit",
  "Write",
  "Delete",
  "MultiEdit",
  "NotebookEdit",
  "Task",
  PLAN_TOOL,
]);

function foldable(it: Item): it is FoldItem {
  if (it.kind === "thinking") return true;
  if (it.kind !== "tool") return false;
  if (KEEP_VISIBLE.has(it.name)) return false;
  // 截图 / 读图也折：组头右侧挂着组里那几张图的缩略图（见 GroupThumbs），
  // 用户知道图在这，悬停就能看。早先带图的工具单独成卡、整图铺开，连读
  // 几张图就把回答冲出屏幕。
  // 注意：运行中的工具**也折**。早先不折、单独成卡直播，跑完再收进
  // 组 —— 那一收一增的行数变化让生成期的底部随每个工具弹跳一次。
  // 直播职责移到了组头（见 ProcessGroup 的 live 形态），高度恒为一行。
  return true;
}

/**
 * 把时间线切成渲染块：连续 ≥2 条思考 / 工具折成一组。
 *
 * 长探索是"思考、Read、思考、Grep…"几十行连排，把回答挤出屏幕 ——
 * 折成一行摘要后，对话流里剩下的才是内容本身。单独一条不折：
 * 一行折成一行没省地方，反而多一次点击。
 *
 * `liveTail`（正在生成且没在流正文时为真）让尾部那段过程**即使只有
 * 一条也成组**，并标记 live：组从第一步就存在，之后每一步都是并入 ——
 * 组头恒为一行，工具完成只换行内文字，不再有"独立行收进组"的增删。
 * 单条的段落等轮到正文或轮次结束时自然还原成普通一行（组头和单行
 * 都是一行高，这次还原不跳）。
 */
export function groupBlocks(items: Item[], liveTail = false): Block[] {
  const blocks: Block[] = [];
  let run: FoldItem[] = [];
  const flush = (tail: boolean) => {
    const first = run[0];
    if (!first) return;
    const live = tail && liveTail;
    if (run.length >= 2 || live) blocks.push({ kind: "fold", id: first.id, items: run, live });
    else blocks.push({ kind: "row", item: first });
    run = [];
  };
  for (const it of items) {
    if (foldable(it)) {
      run.push(it);
    } else {
      flush(false);
      blocks.push({ kind: "row", item: it });
    }
  }
  flush(true);
  return blocks;
}

/**
 * 折叠头的一句话摘要：按类别数数，读过的文件点名。
 * 只写"14 步"没有信息量 —— 用户扫一眼要能知道这段过程干了什么。
 */
function foldSummary(items: FoldItem[]): string {
  const readNames: string[] = [];
  let reads = 0;
  let searches = 0;
  let cmds = 0;
  let tasks = 0;
  let web = 0;
  let browser = 0;
  let other = 0;
  let thinkMs = 0;

  for (const it of items) {
    if (it.kind === "thinking") {
      thinkMs += it.durationMs ?? 0;
      continue;
    }
    const input = it.input as Record<string, unknown>;
    const str = (k: string) => (typeof input?.[k] === "string" ? (input[k] as string) : "");
    switch (it.name) {
      case "Read": {
        reads++;
        const base = (str("path") || str("file_path")).split("/").pop() ?? "";
        if (base && !readNames.includes(base)) readNames.push(base);
        break;
      }
      case "Grep":
      case "Glob":
      case "LS":
        searches++;
        break;
      case "Bash":
        cmds++;
        break;
      case "Task":
        tasks++;
        break;
      case "WebSearch":
      case "WebFetch":
        web++;
        break;
      default:
        // ShowBrowser 名字上没有 Browser 前缀，但它就是浏览器那一路的一步。
        if (it.name.startsWith("Browser") || it.name === "ShowBrowser") browser++;
        else other++;
    }
  }

  const parts: string[] = [];
  const first = readNames[0];
  if (reads > 0) {
    if (!first) parts.push(tn("transcript.fold.readFiles", reads));
    else if (readNames.length === 1) parts.push(t("transcript.fold.readOne", { name: first }));
    else parts.push(tn("transcript.fold.readMore", readNames.length, { name: first }));
  }
  if (searches) parts.push(tn("transcript.fold.searches", searches));
  if (cmds) parts.push(tn("transcript.fold.commands", cmds));
  if (tasks) parts.push(tn("transcript.fold.subtasks", tasks));
  if (web) parts.push(tn("transcript.fold.web", web));
  if (browser) parts.push(tn("transcript.fold.browser", browser));
  if (other) parts.push(tn("transcript.fold.other", other));
  // 全是思考没有工具时，摘要落到思考本身：想了多久。量不到时长（旧会话）
  // 就只说是思考。
  if (parts.length === 0) {
    return thinkMs > 0
      ? t("transcript.fold.thinkingOnly", { dur: formatDuration(thinkMs) })
      : t("transcript.thinking.label");
  }
  return parts.join(" · ");
}

/**
 * 组头直播的"当前动作"：正在跑的工具优先，没有就落到正在流的思考。都
 * 没有（比如模型在生成下一个工具的参数）返回 null，组头回落到静态摘要
 * —— 流光还在扫，看得出没停。
 *
 * 工具后面跟的是它的**参数摘要**（命令、文件名），不是最新输出尾行：
 * 尾行每来一行就换，右对齐着往左推，看着像跑马灯，眼睛一直被拽过去。
 * 参数摘要一个工具只换一次。
 */
function liveActivity(
  items: FoldItem[],
  thinkingText?: string,
): { label: string; detail: string; thinking: boolean } | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it && it.kind === "tool" && it.status === "running") {
      return { label: it.name, detail: summarize(it).replace(/\s+/g, " ").trim(), thinking: false };
    }
  }
  if (thinkingText) return { label: t("transcript.thinking.live"), detail: "", thinking: true };
  return null;
}

/** 组头最多挂几张缩略图，再多的收成「+N」。 */
const GROUP_THUMBS = 3;

/**
 * 组头右侧：组里带图工具的缩略图（照 Claude）。挂最近的几张 —— 最新的
 * 图最可能是用户想看的那张；更早的数成「+N」，点开组逐条都有。
 */
function GroupThumbs({ items }: { items: FoldItem[] }) {
  const tools = items.filter(
    (it): it is Extract<FoldItem, { kind: "tool" }> => it.kind === "tool" && hasImage(it),
  );
  if (tools.length === 0) return null;
  const shown = tools.slice(-GROUP_THUMBS);
  const more = tools.length - shown.length;
  return (
    <span className="group-thumbs">
      {more > 0 ? <span className="group-thumbs-more">+{more}</span> : null}
      {shown.map((it) => (
        <ToolThumb key={it.id} tool={it} />
      ))}
    </span>
  );
}

/**
 * 一段探索过程，折成一行摘要（学 Cursor 的 "Explored …"）。
 *
 * 生成期间（live）正在跑的工具、正在流的思考都并在组里，组头单行
 * 直播当前动作：转圈 + 工具名 + 最新输出（或思考尾巴）滚过。这段
 * 过程从头到尾只占一行，步骤完成只换行内文字 —— 早先"运行中独立
 * 成卡、完成收进组"的形态切换让底部随每个工具弹跳一次。落定后组头
 * 原地换成静态摘要。默认收着，点开还原成逐条卡片（正在跑的那张
 * 也在里面，实时输出照旧看得到）；组在长大时（key 是首条 id，稳定）
 * 展开状态不会丢。
 */
export const ProcessGroup = memo(
  function ProcessGroup({
    items,
    live = false,
    thinkingText,
    thinkingClock,
  }: {
    items: FoldItem[];
    /** 尾部直播组：这段过程还在进行，组头显示当前动作。 */
    live?: boolean;
    /** 正在流式输出、还没落成条目的思考。直播在组头，展开时排在组尾。 */
    thinkingText?: string;
    /** 那段思考的计时，组头显示「思考中… 12 秒」。 */
    thinkingClock?: ThinkClock | null;
  }) {
    const { tn } = useT();
    const [open, setOpen] = useState(false);
    const summary = foldSummary(items);
    // 失败数常驻头部但**弱化** —— 探索里的中途失败（grep 没命中、
    // 试错命令）大多被后续步骤自愈，不值得一块刺眼的红。真要紧的
    // 是"以失败收尾"：最后一步炸了，多半意味着模型接下来要认输，
    // 这种才升警示色。逐条的红色"失败"在展开层，要追查点开就有。
    const fails = items.filter((it) => it.kind === "tool" && it.status === "error").length;
    const last = items[items.length - 1];
    const endedFail = !live && last?.kind === "tool" && last.status === "error";
    const act = live ? liveActivity(items, thinkingText) : null;

    return (
      <div className={live ? "fold-block live" : "fold-block"}>
        {/* 缩略图是自己的按钮，不能嵌在组头的 button 里，所以并排放。 */}
        <div className="fold-head-row">
          <button
            type="button"
            className="fold-head"
            // 同 think-head：点击只为开合，不拿焦点 —— WKWebView 会把
            // focused button 滚进视野，正好滚离底部。
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setOpen(!open)}
            aria-expanded={open}
          >
            <Chevron open={open} />
            {live ? (
              <span className="fold-live-icon" aria-hidden>
                ◐
              </span>
            ) : null}
            {act ? (
              <>
                <span className="fold-live-label shimmer">{act.label}</span>
                {act.detail ? (
                  <span className="fold-live-detail shimmer" title={act.detail}>
                    {act.detail}
                  </span>
                ) : null}
                {act.thinking && thinkingClock ? <LiveElapsed clock={thinkingClock} /> : null}
              </>
            ) : (
              <span className="fold-label" title={summary}>
                {summary}
              </span>
            )}
            <span className="fold-count">{tn("transcript.steps", items.length)}</span>
            {fails > 0 ? (
              <span className={endedFail ? "fold-fail fold-fail-final" : "fold-fail"}>
                {tn("transcript.fold.failed", fails)}
              </span>
            ) : null}
          </button>
          <GroupThumbs items={items} />
        </div>
        <SmoothFold open={open}>
          <div className="fold-body">
            {items.map((it) =>
              it.kind === "thinking" ? (
                <ThinkingBlock key={it.id} text={it.text} durationMs={it.durationMs} />
              ) : (
                <ToolCard key={it.id} tool={it} />
              ),
            )}
            {thinkingText ? (
              <ThinkingBlock text={thinkingText} live clock={thinkingClock ?? null} />
            ) : null}
          </div>
        </SmoothFold>
      </div>
    );
  },
  // items 每次分组都是新数组，浅比较必然失败；逐元素比引用 ——
  // useSession 更新条目走的是整条替换，引用相等就是没变。
  (a, b) =>
    a.live === b.live &&
    a.thinkingText === b.thinkingText &&
    a.thinkingClock === b.thinkingClock &&
    a.items.length === b.items.length &&
    a.items.every((it, i) => it === b.items[i]),
);

/**
 * 手动展开过的思考块，键是正文前缀。
 *
 * `[约束]` 展开状态不能只存在组件里。直播中的那段思考和它落定后的
 * 条目是**两个不同的 React 实例** —— 直播的挂在列表尾部（见
 * ProcessGroup 和 Transcript 的 thinkingText 分支），落定的进 items.map，
 * key 也对不上。`open` 作为组件内 state 会随重挂载归零：用户正读到
 * 一半，轮次一结束整块就被收起来。
 *
 * 用正文前缀而不是条目 id 当身份：落定前根本没有 id（内核那边的
 * `msg_x-k` 到不了直播这一侧），而思考文本只追加不改写，同一段思考
 * 在落定前后前缀完全一致。
 */
const expandedThinks = new Map<string, true>();
/** 认人够用就行，键留太长白占内存。 */
const thinkKey = (text: string) => text.slice(0, 80);
/** 展开过的块不清会一直攒着。上限之外按最早展开的先丢。 */
const EXPANDED_MAX = 200;

function rememberThink(key: string, open: boolean) {
  if (!open) {
    expandedThinks.delete(key);
    return;
  }
  expandedThinks.set(key, true);
  if (expandedThinks.size > EXPANDED_MAX) {
    const oldest = expandedThinks.keys().next();
    if (!oldest.done) expandedThinks.delete(oldest.value);
  }
}

/**
 * 思考过程：默认折叠（过程不是结论，铺开会把回答挤走），但用户
 * 展开过就一直开着 —— 包括轮次结束、这块从直播实例换成落定条目。
 *
 * 标题右侧是这段思考的时长：直播时每秒走（流光扫着标题，看得出没卡住），
 * 落定后是内核量的总时长。早先这里滚过最新的思考文字，像跑马灯一样
 * 一直拽眼睛，去掉了；要看内容就展开。展开之后正文完整铺开、不限高
 * 也不套内层滚动条。
 *
 * 正文走和回答同一套 markdown：模型思考时照样写列表、代码块、`标记`，
 * 摊成纯文本就是满屏的星号和井号，比渲染过的更难读。收起时 SmoothFold
 * 不挂载孩子，历史里的思考不会白白 parse 一遍。
 */
export function ThinkingBlock({
  text,
  live,
  durationMs,
  clock,
}: {
  text: string;
  live?: boolean;
  /** 落定条目的思考时长（内核量的）。旧会话没有就不显示。 */
  durationMs?: number | undefined;
  /** 直播时的计时。 */
  clock?: ThinkClock | null;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(() => expandedThinks.has(thinkKey(text)));

  // 直播期间正文在长，短思考的前缀会跟着变（长到 80 字后才定）。
  // 展开状态得跟着搬家，否则落定时按最终文本去查，扑空。
  const keyRef = useRef(thinkKey(text));
  useEffect(() => {
    const next = thinkKey(text);
    const prev = keyRef.current;
    if (next === prev) return;
    keyRef.current = next;
    if (expandedThinks.delete(prev)) expandedThinks.set(next, true);
  }, [text]);

  // 已经转去写正文（计时停了）就不再是"思考中"：这段思考要等整条消息
  // 收尾才落定成条目，那之前块还挂着 live，但标题和流光得先撤。
  const thinkingNow = !!live && clock?.end === undefined;

  return (
    <div className={live ? "think-block live" : "think-block"}>
      <button
        type="button"
        className="think-head"
        // 点标题只为开合，不要把焦点吃过去 —— WKWebView 对 focused
        // button 会默认滚进视野，正好滚到这条思考、离开底部。
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          const next = !open;
          setOpen(next);
          rememberThink(keyRef.current, next);
        }}
      >
        <Chevron open={open} />
        <span className={thinkingNow ? "think-label shimmer" : "think-label"}>
          {thinkingNow ? t("transcript.thinking.live") : t("transcript.thinking.label")}
        </span>
        {live && clock ? (
          <LiveElapsed clock={clock} />
        ) : durationMs ? (
          <span className="think-time">{formatDuration(durationMs)}</span>
        ) : null}
      </button>
      <SmoothFold open={open}>
        <div className="think-body">
          {/* 展开着看直播的思考同样按块淡入，和正文一个待遇。 */}
          <Markdown text={text} breaks animated={!!live} />
        </div>
      </SmoothFold>
    </div>
  );
}
