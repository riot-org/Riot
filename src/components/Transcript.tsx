/**
 * 对话流：消息列表、会话内查找、贴底跟随，以及消息行的渲染。
 *
 * 从 App.tsx 拆出的独立职责。滚动语义（贴底跟随、按意图交出跟随、
 * 程序化滚动 pinning、锚点补偿、每会话位置缓存）全在这里 ——
 * 改贴底/恢复行为只动这个文件。
 *
 * 滚动容器是普通的正排容器（开源的 use-stick-to-bottom 和主流 AI 聊天
 * 界面观察到的行为都是这一种：翻上去时生成内容在下方追加、画面不动）。早先学 Codex 用过 column-reverse
 * 倒排：贴底免费、上方懒加载不动视口，代价是翻历史时**下方**每长一行
 * 都要写一次 scrollTop 把画面拉回 —— 生成中每帧都写，和 WKWebView
 * 滚动线程上的原生滚动（触控板惯性）打架，翻历史时画面一直抖，怎么
 * 修补时序都根治不了。正排把代价换了个方向：下方长高天然不动视口
 * （生成中翻历史零写入），贴底改成跟随时主动写到底；上方长高（懒加载
 * 换真身、估高落地）由锚点补偿兜着，那是偶发的，不是每帧。
 * 渲染预算的三层（懒解析 / memo / content-visibility）见
 * ARCHITECTURE §13.1。
 */

import {
  Fragment,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";

import {
  host,
  restorePreview,
  type ImageInput,
  type PermissionAsk,
  type PermissionMode,
  type PermissionResponse,
  type RestorePreview,
} from "../bridge";
import { useImeGuard } from "../hooks/useImeGuard";
import type { Item, TextItem } from "../hooks/useSession";
import { useTimedFlag } from "../hooks/useTimedFlag";
import { dateTimeFormat, type MessageKey, useT } from "../i18n";
import {
  SLASH_HEAD_RE,
  extractElemSpans,
  extractMentionSpans,
  mentionCovers,
} from "../lib/promptText";
import { findHits, findTextRanges } from "../lib/findHits";
import { type LiveTextStore, useLiveText } from "../lib/liveText";
import { ENTER_TRANSCRIPT_EVENT } from "../lib/transcriptNav";
import { estimateTurnHeight, isLongUserText, lastAssistantIndex } from "../lib/turnHeight";
import { openPlanPanel } from "../lib/plan";
import { Chevron } from "./Chevron";
import { Chip, FileChip } from "./Chip";
import { Composer } from "./Composer";
import { ConfirmDialog, type ConfirmRequest } from "./ConfirmDialog";
import { PlanModeIcon } from "./icons";
import { HYDRATE_EVENT, LazyMarkdown, Markdown } from "./Markdown";
import { AskChoiceCard, EnvVarsCard, ModeSwitchCard, PermissionCard } from "./PermissionDialog";
import {
  type Block,
  groupBlocks,
  LiveThinking,
  ProcessGroup,
  type ThinkClock,
  ThinkingBlock,
} from "./ProcessFold";
import { SmoothFold } from "./SmoothFold";
import { TaskNoticeCard } from "./TaskPanel";
import { ShotViewer, ToolCard } from "./ToolCard";

/**
 * 对话流滚到哪、跟不跟随底部。top 存原始 scrollTop（距顶）。
 *
 * 正式包 WKWebView 一给面板加 `visibility:hidden` / 改 `position`，
 * 会把 scrollTop 清成 0 并冒一次 scroll（症状是"切回来跳到顶"）。
 * dev 的 WebView 常常不这么做，所以只有打包后才复现。记的必须是用户
 * 还看得见时的位置，隐藏之后那次假滚动一律丢掉。
 */
const EMPTY_IDS: ReadonlySet<string> = new Set();

export const transcriptView = new Map<string, { top: number; stick: boolean }>();

/** 距底距离。clamp 到 0 —— 底部橡皮筋回弹时会短暂冲出可滚动范围。 */
const distFromBottom = (box: HTMLElement) =>
  Math.max(0, box.scrollHeight - box.clientHeight - box.scrollTop);

/** 贴底时的 scrollTop。 */
const bottomTop = (box: HTMLElement) => Math.max(0, box.scrollHeight - box.clientHeight);

/**
 * 一轮问答：一条用户消息开一轮，之后的过程组、回答、报错都归它，直到
 * 下一条用户消息为止。
 *
 * 这是**渲染预算的单位** —— 离屏的轮整个跳过排版和绘制（见 styles.css
 * 的 `.turn`，那里记着为什么粒度必须是轮、不能退回每块一份）。历史里
 * 第一条用户消息之前还可能有东西（压缩分隔线、上次的报错），它们自成
 * 第一轮。
 *
 * `from` 是这一轮首块在 blocks 里的下标。懒水合的窗口是按**块数**算的
 * （见 hydrateFrom），包这一层不该改变它，所以把下标一并带出来。
 */
type Turn = { key: string; from: number; blocks: Block[] };

function groupTurns(blocks: Block[], keyOf: (id: string) => string): Turn[] {
  const turns: Turn[] = [];
  blocks.forEach((b, i) => {
    const cur = turns[turns.length - 1];
    if (!cur || (b.kind === "row" && b.item.kind === "user")) {
      // key 取首块的 id（经 keyOf 换成稳定的那个，见 Transcript 的 keyAlias）。
      // 轮在长大（过程组并入、回答落定）时不换 key，里面的东西不会重挂载。
      turns.push({ key: b.kind === "row" ? keyOf(b.item.id) : b.id, from: i, blocks: [b] });
      return;
    }
    cur.blocks.push(b);
  });
  return turns;
}

/**
 * 在一组按文档序从上到下排列的兄弟里，二分找第一个底边越过 `boxTop`
 * 的元素。长会话逐个量 getBoundingClientRect 太贵 —— 这里每次滚动
 * 都要跑。
 */
function firstBelow(kids: HTMLCollection, boxTop: number): Element | null {
  let lo = 0;
  let hi = kids.length - 1;
  let first = kids.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const el = kids[mid];
    if (!el) break;
    if (el.getBoundingClientRect().bottom > boxTop) {
      first = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return kids[first] ?? null;
}

/** 这块正在尾部追加内容（直播思考、直播过程组、正在流的正文）。 */
function growsInPlace(el: Element): boolean {
  return el.matches(".think-block.live, .fold-block.live") || el.querySelector("[data-md-animated]") !== null;
}

/** 文档序里的下一个锚点候选：同轮内的下一块，没有就下一轮的首块。 */
function nextAnchor(el: Element, col: Element): Element | null {
  const sib = el.nextElementSibling;
  if (sib) return sib;
  const parent = el.parentElement;
  if (!parent || parent === col) return null;
  const next = parent.nextElementSibling;
  return next?.firstElementChild ?? next ?? null;
}

/**
 * 这次滚轮会不会被目标和对话流之间的子层截住。
 *
 * 只有这种时候才自己写 scrollTop：一律 preventDefault 会关掉系统
 * 平滑 / 触控板惯性，中间对话就一格一格跳，左边会话栏却是原生的。
 * overflow:clip 不是滚动容器，不必接手。overflow:auto 没竖向溢出
 * 时也不接手（overflow-x:auto 会把 overflow-y 算成 auto）。
 */
function wheelNeedsHijack(start: EventTarget | null, box: HTMLElement, deltaY: number): boolean {
  let el: HTMLElement | null =
    start instanceof HTMLElement ? start : start instanceof Element ? start.parentElement : null;
  while (el && el !== box) {
    const oy = getComputedStyle(el).overflowY;
    if (oy === "auto" || oy === "scroll" || oy === "overlay") {
      const max = el.scrollHeight - el.clientHeight;
      if (max > 1) {
        const goingUp = deltaY < 0;
        const atTop = el.scrollTop <= 1;
        const atBottom = el.scrollTop >= max - 1;
        if ((goingUp && atTop) || (!goingUp && atBottom)) return true;
        return false;
      }
    } else if (oy === "hidden") {
      return true;
    }
    el = el.parentElement;
  }
  return false;
}

/** 命中落的文本节点被换掉了（任一端脱离文档）。 */
function deadRange(r: Range): boolean {
  return !r.startContainer.isConnected || !r.endContainer.isConnected;
}

/** 命中所在的那一轮（`.turn`）。轮尾的流式正文不在任何轮里，返回 null。 */
function turnOf(r: Range | undefined): Element | null {
  return r?.startContainer.parentElement?.closest(".turn") ?? null;
}

/**
 * 从滚轮落点往上找，第一个此刻**还能往这个方向滚**的子层（代码块、
 * 工具输出、思考块……）。找不到返回 null —— 这一下该由对话流自己滚。
 */
function innerScroller(start: EventTarget | null, box: HTMLElement, deltaY: number): HTMLElement | null {
  let el: HTMLElement | null =
    start instanceof HTMLElement ? start : start instanceof Element ? start.parentElement : null;
  while (el && el !== box) {
    if (canScrollY(el, deltaY)) return el;
    el = el.parentElement;
  }
  return null;
}

/** 这个元素自己能不能再往 deltaY 的方向滚。 */
function canScrollY(el: HTMLElement, deltaY: number): boolean {
  const oy = getComputedStyle(el).overflowY;
  if (oy !== "auto" && oy !== "scroll" && oy !== "overlay") return false;
  const max = el.scrollHeight - el.clientHeight;
  if (max <= 1) return false;
  return deltaY < 0 ? el.scrollTop > 1 : el.scrollTop < max - 1;
}


/** 敲字停下多久才真去扫 DOM。见 FindBar 里那个防抖 effect。 */
const FIND_QUIET_MS = 80;

/**
 * 会话内查找（⌘F）。
 *
 * 高亮用 CSS Custom Highlight API：直接在文本节点上建 Range，不往
 * React 管理的 DOM 里塞 <mark> —— 塞了的话下一次渲染要么被抹掉、
 * 要么把 React 的 diff 弄糊涂。旧 WebView 没有这个 API 时退化成
 * 只滚动定位、不上色。
 *
 * 命中是一批 Range，只在敲字时扫一遍。它们**会**失效：流式输出还在往
 * 对话流里追加，React 换掉哪个文本节点，落在上面的 Range 就成了野的 ——
 * 由 `step` 在用之前滤掉（重扫一遍太贵，见那里的说明）。
 */
function FindBar({
  box,
  onNeedle,
  onJump,
  scrollTo,
  onClose,
}: {
  /** 对话流的滚动容器。 */
  box: React.RefObject<HTMLElement | null>;
  /**
   * 扫 DOM 之前先告诉外层在找什么：外层只把**含这个词**的懒加载行解析
   * 成真身（见 Transcript 的 findHits）。早先一打开查找就把整个会话全量
   * 水合 —— 长会话里几百条 markdown 一口气 parse，查找条还没弹稳界面
   * 先卡住一下。调用方必须同步提交（flushSync），扫描紧跟其后。
   */
  onNeedle: (q: string) => void;
  /**
   * 要滚去某个命中之前调用。跟随底部只认用户的滚动输入，scrollIntoView
   * 不算 —— 不先交出跟随的话，生成中跳过去的下一帧又被拽回底部。
   */
  onJump: () => void;
  /** 平滑滚到命中所在处（见 Transcript 的 glideToEl）。`flash` = 换了一条消息。 */
  scrollTo: (el: Element, align?: "center" | "start", flash?: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const [query, setQuery] = useState("");
  const [cur, setCur] = useState(0);
  const curRef = useRef(0);
  curRef.current = cur;
  const hitsRef = useRef<Range[]>([]);
  /**
   * 当前命中所在的轮和它在那一轮里是第几个。命中会失效（流式输出换掉了
   * 文本节点、懒加载行进了视野换成真身），重扫之后靠它找回"刚才看到哪"，
   * 而不是跳回第一个。记的是命中还活着时的位置 —— 死掉的 Range 已经
   * 脱离文档，那时再问它在哪一轮已经问不出来了。
   */
  const curPlace = useRef<{ turn: Element | null; ord: number }>({ turn: null, ord: 0 });
  const [total, setTotal] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const ime = useImeGuard();

  const highlights = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;

  // 这几个都要进下面那个 effect 的依赖，所以必须是稳定引用 —— 每次渲染
  // 新建一个函数的话，effect 每渲染一次就重跑一次，防抖等于没做。
  const clear = useCallback(() => {
    highlights?.delete("riot-find");
    highlights?.delete("riot-find-cur");
  }, [highlights]);

  /** 全量重扫。命中可以跨行内格式（见 findTextRanges）。 */
  const scan = useCallback(
    (q: string): Range[] => {
      const root = box.current;
      return root && q ? findTextRanges(root, q) : [];
    },
    [box],
  );

  const paint = useCallback(
    (ranges: Range[], current: number) => {
      if (!highlights) return;
      const H = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
      if (!H) return;
      clear();
      if (ranges.length) {
        highlights.set("riot-find", new H(...ranges));
        const c = ranges[current];
        if (c) highlights.set("riot-find-cur", new H(c));
      }
    },
    [clear, highlights],
  );

  /** 记下第 i 个命中在哪一轮、是那一轮里的第几个（见 curPlace）。 */
  const place = useCallback((ranges: Range[], i: number) => {
    const turn = turnOf(ranges[i]);
    let ord = 0;
    for (let k = i - 1; k >= 0 && turn && turnOf(ranges[k]) === turn; k--) ord++;
    curPlace.current = { turn, ord };
  }, []);

  const jump = useCallback(
    (ranges: Range[], i: number) => {
      const r = ranges[i];
      if (!r) return;
      const prevTurn = curPlace.current.turn;
      place(ranges, i);
      onJump();
      const el = r.startContainer.parentElement;
      // 跳到另一轮时把落点那条消息闪一下：远距离跳过去，眼睛得知道落在哪。
      // 同一条消息里逐个往下按就不闪，只有命中高亮在挪。
      if (el) scrollTo(el, "center", curPlace.current.turn !== prevTurn);
    },
    [place, onJump, scrollTo],
  );

  /**
   * 命中失效后重扫，并留在原来那个命中上（同一轮里的同一个序号）。只重画
   * 不滚动 —— 这是后台对账，用户没按"下一个"，视野不该被拽走。
   */
  const refresh = useCallback(
    (q: string): Range[] => {
      const ranges = scan(q);
      const { turn, ord } = curPlace.current;
      let at = Math.min(curRef.current, Math.max(0, ranges.length - 1));
      if (turn?.isConnected) {
        const first = ranges.findIndex((r) => turnOf(r) === turn);
        if (first >= 0) {
          let last = first;
          while (last + 1 < ranges.length && turnOf(ranges[last + 1]) === turn) last++;
          at = Math.min(first + ord, last);
        }
      }
      hitsRef.current = ranges;
      setTotal(ranges.length);
      setCur(at);
      paint(ranges, at);
      return ranges;
    },
    [scan, paint],
  );

  // 防抖之后再扫。scan 要 walk 一遍整个 `.transcript` 的文本节点（长会话
  // 是几万个），而输入是逐字来的 —— 同步扫等于每敲一个字全量遍历一次
  // DOM，而这条主线程同时还在出流式输出。范式同 Composer 的 `@` 补全。
  useEffect(() => {
    if (!query) {
      hitsRef.current = [];
      setTotal(0);
      setCur(0);
      clear();
      return;
    }
    const timer = window.setTimeout(() => {
      // 先让含这个词的行解析成真身、同步提交，再扫 —— 扫到的才是最终的文本节点。
      flushSync(() => onNeedle(query));
      const ranges = scan(query);
      hitsRef.current = ranges;
      setTotal(ranges.length);
      setCur(0);
      paint(ranges, 0);
      jump(ranges, 0);
    }, FIND_QUIET_MS);
    return () => window.clearTimeout(timer);
  }, [query, scan, paint, jump, clear, onNeedle]);

  // 命中会被换掉的节点带走：流式输出重解析正在长的那段、懒加载行滚进视野
  // 换成真身。DOM 一变（攒一下再看）就查有没有死掉的命中，有就重扫并留在
  // 原处 —— 不然高亮一块块消失、"3/12" 还挂着，点下一个没反应。
  useEffect(() => {
    const root = box.current;
    if (!root || !query) return;
    let timer = 0;
    const mo = new MutationObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (hitsRef.current.some(deadRange)) refresh(query);
      }, 150);
    });
    mo.observe(root, { subtree: true, childList: true, characterData: true });
    return () => {
      mo.disconnect();
      window.clearTimeout(timer);
    };
  }, [box, query, refresh]);

  const step = (dir: 1 | -1) => {
    // 有死掉的命中就先重扫（留在原处，见 refresh）。查找条开着的时候流式
    // 输出仍在往 DOM 里追加、懒加载行滚进视野会换成真身 —— 落在被换掉的
    // 节点上的 Range 已经脱离文档，高亮画不出来、scrollIntoView 也一声
    // 不响地什么都不做，看起来就是"点下一个没反应"。
    let alive = hitsRef.current;
    if (alive.some(deadRange)) alive = refresh(query);
    if (!alive.length) {
      clear();
      return;
    }
    const from = Math.min(curRef.current, alive.length - 1);
    const next = (from + dir + alive.length) % alive.length;
    setCur(next);
    paint(alive, next);
    jump(alive, next);
  };

  // 关闭（含卸载）时清掉高亮，别在页面上留一堆黄块。
  useEffect(() => clear, [clear]);

  return (
    <div className="find-wrap">
      <div className="find-bar" role="search">
        <input
          ref={inputRef}
          autoFocus
          value={query}
          placeholder={t("transcript.find.placeholder")}
          onChange={(e) => setQuery(e.target.value)}
          onCompositionStart={ime.onCompositionStart}
          onCompositionEnd={ime.onCompositionEnd}
          onKeyDown={(e) => {
            // 组字中的回车是确认候选、Esc 是收候选列表 —— 都不该动查找条，
            // 尤其 Esc：那会把整个查找关掉，用户只是想撤掉一个选词框。
            if (ime.isComposing(e)) return;
            if (e.key === "Enter") {
              e.preventDefault();
              step(e.shiftKey ? -1 : 1);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              clear();
              onClose();
            }
          }}
        />
        <span className="find-count">{total ? `${cur + 1}/${total}` : query ? "0/0" : ""}</span>
        <button
          type="button"
          className="find-btn"
          title={t("transcript.find.prevTitle")}
          aria-label={t("transcript.find.prev")}
          disabled={!total}
          onClick={() => step(-1)}
        >
          ▲
        </button>
        <button
          type="button"
          className="find-btn"
          title={t("transcript.find.nextTitle")}
          aria-label={t("transcript.find.next")}
          disabled={!total}
          onClick={() => step(1)}
        >
          ▼
        </button>
        <button
          type="button"
          className="find-btn"
          title={t("transcript.find.closeTitle")}
          aria-label={t("transcript.find.close")}
          onClick={() => {
            clear();
            onClose();
          }}
        >
          ✕
        </button>
      </div>
    </div>
  );
}

/**
 * 桌面里拦掉外壳 webview 在会话区弹的原生右键菜单。
 *
 * 那是 WKWebView / WebView2 自带的菜单，样式和应用完全不搭（浏览器面板那边
 * 同样拦了它，理由一样），而且里面的 "Open Link" 一类条目干的是**导航整个
 * 窗口**——宿主现在会把那次导航拦下转给系统浏览器（`nav_guard`），但菜单里
 * 摆着一个"看起来能用、点了却在别处生效"的入口，不如不摆。
 *
 * 两处例外：网页版里那是浏览器自己的菜单，用户在浏览器里就该有它；输入框
 * （编辑消息的 textarea、查找条）里留着原生菜单 —— 右键粘贴是很多人的
 * 肌肉记忆，拦了等于把粘贴藏起来。
 */
function suppressNativeMenu(e: React.MouseEvent) {
  if (host.kind !== "tauri") return;
  const el = e.target instanceof Element ? e.target : null;
  if (el?.closest("input, textarea, [contenteditable]:not([contenteditable='false'])")) {
    return;
  }
  e.preventDefault();
}

/**
 * 跳到某处之后，把落点那条消息闪一下（Claude 桌面版同款）：底色亮起再
 * 淡掉。远距离跳过去，眼睛得知道落在了哪。
 */
function flashRow(el: Element) {
  const row = el.closest(".turn > *, .thread-col > *") ?? el;
  row.classList.remove("row-flash");
  // 连按两次跳到同一条：先摘掉再强制一次样式计算，动画才会重新开始。
  void (row as HTMLElement).offsetWidth;
  row.classList.add("row-flash");
  row.addEventListener("animationend", () => row.classList.remove("row-flash"), { once: true });
}

/** 对话流里的一条（键盘逐条跳的单位，见 Transcript 的键盘导航）。 */
const ARTICLE = ".turn > *, .thread-col > .msg";

/** 按下去是"操作一个控件"而不是点在内容上（见 Transcript 的 onPointerDown）。 */
const PRESS_CONTROL =
  'button,a[href],input,select,textarea,summary,label,video,audio,[role="button"],[contenteditable="true"],[aria-expanded]';

/** 能拿键盘焦点的元素（见 Transcript 里焦点进对话流的处理）。 */
const FOCUSABLE =
  'a[href],button,input,select,textarea,summary,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';

export const Transcript = memo(function Transcript({
  sessionId,
  items,
  live,
  streaming,
  thinking,
  thinkClock,
  busy,
  compacting,
  waitSince,
  armed = true,
  modeAsk,
  execMode = "default",
  choiceAsk,
  onAnswerMode,
  onAnswerChoice,
  permAsks,
  onAnswerPermission,
  onRegenerate,
  onEditEntry,
  onResendEntry,
  onDeleteEntry,
  checkpointIds,
  onRestoreEntry,
  redoAvailable,
  onRedo,
}: {
  sessionId: string;
  items: Item[];
  /**
   * 正在流的正文 / 思考本身。Transcript 不读它渲染 —— 那样每帧整个对话
   * 重跑一遍 —— 交给订阅它的叶子（LiveMarkdown 等，见 lib/liveText）。
   */
  live: LiveTextStore;
  /** 有没有正文在流。只在开始 / 落定时翻转。 */
  streaming: boolean;
  /** 有没有思考在流。 */
  thinking: boolean;
  /** 正在流的思考的计时（见 useSession 的 thinkingClock）。 */
  thinkClock?: ThinkClock | null;
  busy: boolean;
  /** 前台才接 ⌘F。保活的隐藏实例不能跟前台抢查找。 */
  armed?: boolean;
  /** 宿主正在压缩上下文。见 useSession 里同名字段。 */
  compacting: boolean;
  /**
   * 当前这轮等待的起点（epoch ms）。挂在组件外（见 waitStartedAt），
   * 活得过切会话导致的重挂载 —— 状态行的秒数靠它接着数而不是清零。
   */
  waitSince: number | null;
  /** 模型建议换工作方式（SwitchMode 的询问）。内联在对话流末尾。 */
  modeAsk?: { requestId: string; detail: PermissionAsk };
  /** 这个会话进规划前用的权限档，切回 agent 时落成它。 */
  execMode?: PermissionMode;
  /** 模型主动提的选择题。同样内联，不弹窗。 */
  choiceAsk?: { requestId: string; detail: PermissionAsk };
  onAnswerMode?: (r: PermissionResponse) => void;
  onAnswerChoice?: (r: PermissionResponse) => void;
  /** 权限确认（Bash、写文件……）。按到达顺序全部内联在对话末尾，各答各的。 */
  permAsks?: { requestId: string; detail: PermissionAsk }[];
  onAnswerPermission?: (requestId: string, r: PermissionResponse) => void;
  onRegenerate?: (itemId: string) => void;
  /** 上下文编辑：把这条气泡的文本换掉。false = 没改成，编辑框保留草稿。 */
  onEditEntry?: (item: TextItem, text: string, images?: ImageInput[]) => Promise<boolean>;
  /**
   * 编辑后重发（只对用户气泡）：换字、丢掉之后的一切、从它再跑一轮。
   * false = 没发出去，编辑框保留草稿。
   */
  onResendEntry?: (item: TextItem, text: string, images?: ImageInput[]) => Promise<boolean>;
  /** 上下文删除：把这条气泡从历史里抹掉。 */
  onDeleteEntry?: (item: TextItem) => Promise<boolean>;
  /** 有文件切片的用户提问 id。只在这些气泡上画回退。 */
  checkpointIds?: string[];
  /** 回退到这条用户提问发出时。 */
  onRestoreEntry?: (item: TextItem) => Promise<boolean>;
  /** 最近一次回退还能前进回去。图标画在被留下的那条提问上。 */
  redoAvailable?: boolean;
  onRedo?: () => void;
}) {
  const { t } = useT();
  const boxRef = useRef<HTMLDivElement>(null);
  /** 跟随底部。用户往上翻就交出，自己滚回底部（或发了新消息）再接上。 */
  const stick = useRef(true);
  /**
   * 正在做的程序化滚动，挡掉它自己冒出来的 scroll。
   *
   * - `"restore"`：切回会话还原位置。这一拍里的 scroll 一律不算用户的 ——
   *   正式包揭开面板时 WKWebView 会把 scrollTop 清成 0 再冒一次。
   * - `"bottom"`：贴底。只挡**落在自己写下的位置**（pinnedTop）的那次
   *   scroll；落在别处说明用户同一帧里在往上翻，必须按用户算。
   */
  const pinning = useRef<null | "bottom" | "restore">(null);
  /**
   * 贴底写入后 scrollTop 的回读值。
   *
   * `[约束]` 认"自己那次 scroll"必须比写下的值，不能比"此刻的底"。scroll
   * 事件下一帧才派发，这期间内容可能又长了（生成中几乎每帧都在长），底
   * 已经不在写下的地方 —— 按位置认就会当成用户滚回了底部，把跟随接回去。
   * 用户恰好在这一帧之间点开一段思考的话，点击刚交出的跟随被当场收回，
   * 点开的内容随即被往上推走。
   */
  const pinnedTop = useRef(0);
  /**
   * 翻历史时的滚动锚点：视口里第一个顶边完整可见的块 + 它到视口顶的距离。
   *
   * 正排容器里，**下方**长高（流式输出在底部追加）天然不动视口 —— 这是
   * 生成中翻历史稳不稳的关键：那段时间这里一次 scrollTop 都不写。会动
   * 视口的只剩**上方**长高：懒加载的行换成真身、content-visibility 的估高
   * 落地、图片出图。WKWebView 没有原生滚动锚定（overflow-anchor 到
   * Safari 27 才有），自己记住"正看着哪个块"，高度变了把 scrollTop 补回去。
   *
   * 基线只在**用户**滚动时重记，补偿性滚动绝不重记 —— 引擎会把写入取整，
   * 补完重记等于把取整误差吸进新基线，越补越偏。
   */
  const anchor = useRef<{
    el: Element;
    top: number;
    /**
     * 锚点前面那个块（没有就是它所在的轮）和它当时的位置。锚点被换掉时用
     * 它补偿（见 ResizeObserver 那段）：正在长的块落定时会被**换成新元素**
     * —— 直播思考落成条目、直播过程组换真身、流着的正文落成一行 —— 旧
     * 节点没了，按它补偿无从算起；而它前面那块没动，新元素就接在原处。
     */
    prev: { el: Element; top: number } | null;
  } | null>(null);
  /**
   * 我们最后一次"知道"的 scrollTop（onScroll 处理过的、或自己写进去的）。
   * 对不上 = 用户刚滚过、scroll 事件还没派发（要等下一帧）。
   */
  const knownTop = useRef(0);
  /** 补偿写入后 scrollTop 的回读值。scroll 事件里等值命中 = 补偿滚动。 */
  const expectedTop = useRef<number | null>(null);
  /** 手指 / 滚动条拖拽进行中：这期间自动跟随一律不写 scrollTop。 */
  const touching = useRef(false);
  const draggingBar = useRef(false);
  /** 最近一次用户滚动输入（滚轮、触摸移动、翻页键、按住滚动条）的时刻。 */
  const lastInputAt = useRef(0);
  /** 最近一次"往上滚、这一下会滚对话流"的滚轮的时刻（见 pinBottom）。 */
  const upIntentAt = useRef(0);
  /**
   * 用户此刻正在亲手滚动。
   *
   * `[约束]` 跟随中，"视口往上挪了"只有在用户正在滚的时候才算他要离开。
   * 正排容器里 scrollTop 会因为很多别的原因变小：输入框发送后从多行缩回
   * 一行（对话区变高）、面板出现消失、内容重排时浏览器把 scrollTop 夹回
   * 新的底部 —— 这些都冒出向上的 scroll 事件。按位置推断的话，发一条
   * 多行消息跟随就断了，之后整轮生成停在那条消息上不动。
   */
  const userScrolling = () =>
    touching.current || draggingBar.current || performance.now() - lastInputAt.current < 300;
  /** 上一次看到的内容总高。下方长了东西（而视口没动）= 有新内容。 */
  const lastHeight = useRef(0);
  // 渲染期就写：正式包隐藏面板时 scroll 发生在 commit 里，
  // effect 还没跑，闭包里的 armed 仍是 true，会把清零后的 0 记进去。
  const armedRef = useRef(armed);
  armedRef.current = armed;

  const rememberView = (box: HTMLElement) => {
    if (!armedRef.current) return;
    transcriptView.set(sessionId, { top: box.scrollTop, stick: stick.current });
  };

  const captureAnchor = () => {
    const box = boxRef.current;
    const col = box?.querySelector<HTMLElement>(".thread-col");
    if (stick.current) {
      anchor.current = null;
      return;
    }
    if (!box || !col || !col.children.length) {
      anchor.current = null;
      return;
    }
    const boxTop = box.getBoundingClientRect().top;
    // 两级查找：先定位到轮，再进那一轮里定位到块。
    //
    // `[约束]` 第二级不能省。轮是渲染预算的单位（见 styles.css 的
    // `.turn`），一轮长起来能有好几屏高 —— 只锚到轮的话，基线粗到
    // 补偿肉眼可见地对不上。降一级之后精度和"每块一份"时代完全一样，
    // 代价只是多一轮二分（几次 rect 读取）。
    const turn = firstBelow(col.children, boxTop);
    if (!turn) {
      anchor.current = null;
      return;
    }
    // 只对轮降级。列尾那几个直接子元素（正在流的正文、状态行）不是轮，
    // 它们的孩子不是"按块排列的兄弟"，钻进去锚到的东西没有意义。
    let el = (turn.classList.contains("turn") ? firstBelow(turn.children, boxTop) : null) ?? turn;
    // 跨着视口顶边的块锚不住：它水合长高时顶边不动、内部整体重排，
    // 补偿无从算起。锚下一个块（顶边在视口内的）—— 除非它一块占满全屏。
    //
    // 例外：跨着顶边的正是**还在长**的那块（展开着的直播思考、正在流的
    // 正文、直播过程组）。它只在尾部追加，顶边不动 —— 锚它自己，补偿
    // 恒为 0。改锚它下面那块（多半是状态行）的话，那块每帧被往下顶，
    // 补偿就每帧把画面往上拽，正读的思考一行行往上漂。
    if (el.getBoundingClientRect().top < boxTop - 1 && !growsInPlace(el)) {
      const next = nextAnchor(el, col);
      if (next && next.getBoundingClientRect().top - boxTop < box.clientHeight) el = next;
    }
    const prevEl = el.previousElementSibling ?? (el.parentElement !== col ? el.parentElement : null);
    anchor.current = {
      el,
      top: el.getBoundingClientRect().top - boxTop,
      prev: prevEl ? { el: prevEl, top: prevEl.getBoundingClientRect().top - boxTop } : null,
    };
  };

  /** 离底超过一屏时浮现「回到底部」按钮。 */
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  /**
   * 翻着历史时下面又长出了新内容。「回到底部」上挂个点 —— 用户往上翻
   * 看东西的时候，不该靠盯着滚动条才知道模型又说了话。回到底部清掉。
   */
  const [hasNew, setHasNew] = useState(false);
  /** ⌘F 查找条。长对话找不到历史内容是真实痛点。 */
  const [findOpen, setFindOpen] = useState(false);
  /** 查找条里此刻在找的词（防抖之后的）。只有含它的懒加载行先解析。 */
  const [findNeedle, setFindNeedle] = useState("");
  const findHydrate = useMemo(
    () => (findOpen ? findHits(items, findNeedle) : EMPTY_IDS),
    [findOpen, items, findNeedle],
  );
  /** 待确认的上下文删除。删的是一整轮，动手前必须看得见后果。 */
  const [confirmDel, setConfirmDel] = useState<ConfirmRequest | null>(null);

  /** 点删除按钮 → 弹确认框，确认后才真删。 */
  const requestDelete = useCallback(
    (item: TextItem) => {
      if (!onDeleteEntry) return;
      setConfirmDel({
        title: t("transcript.msg.deleteTurn"),
        body: t("transcript.msg.deleteTurnBody"),
        confirmLabel: t("common.delete"),
        action: () => void onDeleteEntry(item),
      });
    },
    [onDeleteEntry, t],
  );

  const requestRestore = useCallback(
    (item: TextItem) => {
      if (!onRestoreEntry) return;
      const messageId = checkpointMessageId(item);
      void restorePreview(sessionId, messageId)
        .then((p) => {
          setConfirmDel({
            title: t("transcript.restore.title"),
            body: restoreConfirmBody(p, t),
            confirmLabel: t("transcript.restore.confirm"),
            action: () => void onRestoreEntry(item),
          });
        })
        .catch(() => {
          setConfirmDel({
            title: t("transcript.restore.title"),
            body: t("transcript.restore.previewFail"),
            confirmLabel: t("common.ok"),
            danger: false,
            action: () => {},
          });
        });
    },
    [onRestoreEntry, sessionId, t],
  );

  /**
   * 重发 / 重新生成之前：内核会按那条提问的检查点把文件写回去。
   * 真会改到磁盘才弹确认；没有切片、或磁盘已经一致，直接放行。
   * resolve(false) = 用户取消。
   */
  const confirmFileRestore = useCallback(
    (
      messageId: string,
      titleKey: MessageKey,
      bodyKey: MessageKey,
      confirmLabel: string,
    ): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          resolve(ok);
        };
        void restorePreview(sessionId, messageId)
          .then((p) => {
            if (p.files === 0) {
              finish(true);
              return;
            }
            setConfirmDel({
              title: t(titleKey),
              body: restoreConfirmBody(p, t, bodyKey),
              confirmLabel,
              action: () => finish(true),
              onCancel: () => finish(false),
            });
          })
          .catch(() => finish(true));
      }),
    [sessionId, t],
  );

  /** 编辑后点发送。 */
  const confirmResend = useCallback(
    (item: TextItem) => {
      if (item.id.startsWith("local-")) return Promise.resolve(true);
      return confirmFileRestore(
        checkpointMessageId(item),
        "transcript.resend.title",
        "transcript.resend.body",
        t("transcript.editor.send"),
      );
    },
    [confirmFileRestore, t],
  );

  /**
   * 重新生成和重发走同一条内核路径：先把磁盘回到那条提问发出时再跑。
   * 所以也要同样的确认 —— 用户上一轮结束后手改过的文件会被盖掉，
   * 不能因为按的是「重新生成」而不是「发送」就静默动手。
   */
  // 回调里现读 items，不进依赖：items 在跑轮时每帧都换（工具参数、
  // 进度行），进了依赖这个回调就每帧换一个，memo 过的 Row 全部白比 ——
  // 长会话里每帧几百行助手消息跟着重渲染。
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const requestRegenerate = useCallback(
    (assistantItemId: string) => {
      if (!onRegenerate) return;
      const prompt = userPromptBefore(itemsRef.current, assistantItemId);
      if (!prompt || prompt.id.startsWith("local-")) {
        onRegenerate(assistantItemId);
        return;
      }
      void confirmFileRestore(
        checkpointMessageId(prompt),
        "transcript.regenerate.title",
        "transcript.regenerate.body",
        t("transcript.msg.regenerate"),
      ).then((ok) => {
        if (ok) onRegenerate(assistantItemId);
      });
    },
    [confirmFileRestore, onRegenerate, t],
  );

  /** 回退后留下的那条提问：它上面的回退图标翻成前进。 */
  const redoId = redoAvailable && onRedo ? lastRestoredUserId(items) : undefined;

  /** 用户要离开底部：交出跟随，按此刻的位置记下锚点。 */
  const releaseStick = () => {
    const box = boxRef.current;
    if (!stick.current || !box) return;
    stick.current = false;
    knownTop.current = box.scrollTop;
    captureAnchor();
    rememberView(box);
  };

  // 给查找条的稳定引用（它进了 FindBar 里 effect 的依赖）。
  const releaseStickFn = useRef(releaseStick);
  releaseStickFn.current = releaseStick;
  const releaseStickRef = useCallback(() => releaseStickFn.current(), []);

  /**
   * 贴底。`force` = 用户明确要回到底部（点了回程按钮、刚发了消息、切回
   * 一个原本贴底的会话）。
   *
   * 非 force 的调用是内容长高时的自动跟随。`[约束]` 它必须让着用户：
   * - 手指按着、正拖滚动条时不写；
   * - 用户正在滚、视口又比我们上次知道的位置**靠上** —— 他刚往上滚过，
   *   scroll 事件要下一帧才派发。这时写回底部就是把用户拽回来。
   *   用户没在滚时视口靠上（对话区变高、内容重排被浏览器夹回）不算，
   *   照常贴回底部（见 userScrolling）。
   */
  const pinBottom = (force = false) => {
    const box = boxRef.current;
    if (!box) return;
    if (!force) {
      if (touching.current || draggingBar.current) return;
      // 用户刚往上滚了一下，原生滚动可能还没落到 scrollTop 上：这一帧不贴，
      // 等 scroll 事件来了 onScroll 会交出跟随。真没滚动（那一下被子层接走了）
      // 的话，过了这一小段照常贴。
      if (performance.now() - upIntentAt.current < 250) return;
      if (userScrolling() && box.scrollTop < knownTop.current - 1 && distFromBottom(box) > 1) {
        releaseStick();
        setAwayFromBottom(distFromBottom(box) > box.clientHeight);
        return;
      }
    }
    const target = bottomTop(box);
    if (Math.abs(box.scrollTop - target) > 0.5) {
      pinning.current = "bottom";
      box.scrollTop = target;
      pinnedTop.current = box.scrollTop;
      requestAnimationFrame(() => {
        if (pinning.current === "bottom") pinning.current = null;
      });
    }
    knownTop.current = box.scrollTop;
    stick.current = true;
    anchor.current = null;
    rememberView(box);
    // 程序化滚动被 pinning 挡掉 onScroll，这里自己收按钮 ——
    // 不收的话点了「回到底部」它还挂着。
    setAwayFromBottom(false);
    setHasNew(false);
  };
  const pinBottomFn = useRef(pinBottom);
  pinBottomFn.current = pinBottom;
  /**
   * 最后一轮（`data-tail`，始终完整渲染）量到的真实高度，按轮的 key 记。
   *
   * `[约束]` 一轮摘掉 `data-tail` 时从 content-visibility: visible 变回
   * auto。浏览器判定"它在屏幕上"之前，那一帧按占位高度
   * （contain-intrinsic-size）排 —— 而它从没以 auto 渲染过，没有"记住的
   * 尺寸"，用的是估值。估值按思考收着算，展开着在读的一轮实际几千像素：
   * 内容当场缩掉几千像素，离底不够远的阅读位置被浏览器夹到新的最大
   * scrollTop，下一帧轮长回来，位置却回不去了（这一下不是脚本写的）。
   * 所以一直记着它的真实高度，摘掉那一帧拿它当占位。
   */
  const liveTurnHeights = useRef(new Map<string, number>());
  /** 键盘导航正在把焦点放到某条消息上（见键盘导航和焦点进对话流的处理）。 */
  const navFocusing = useRef(false);

  /**
   * 正在进行的程序化平滑滚动（见 glideTo）。`last` 是上一帧自己写下的
   * scrollTop —— 下一帧位置对不上，就是有别人（用户）动了。
   */
  const glide = useRef<{ raf: number; last: number; startAt: number } | null>(null);
  const stopGlide = () => {
    if (glide.current) cancelAnimationFrame(glide.current.raf);
    glide.current = null;
  };

  /**
   * 平滑滚到 `target()`，到了调 `done`。
   *
   * 学 Claude 桌面版：每帧走剩余距离的一截（起步 6%，250ms 内加到 25%），
   * 目标每帧重算 —— 生成中底部还在长也追得上。用户一碰（滚轮、触摸、拖
   * 滚动条、键盘），或者 scrollTop 不是自己上一帧写的值，立刻放手，
   * 不和用户抢。太远的先瞬移到离目标一屏半处再滑：一路滑过去会把中间
   * 每一轮都渲染一遍。系统设了减少动态效果就直接到。
   */
  const glideTo = (target: () => number | null, done?: () => void) => {
    const box = boxRef.current;
    if (!box) return;
    stopGlide();
    const to0 = target();
    if (to0 === null) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      box.scrollTop = to0;
      done?.();
      return;
    }
    const far = box.clientHeight * 1.5;
    if (Math.abs(to0 - box.scrollTop) > far) box.scrollTop = to0 - Math.sign(to0 - box.scrollTop) * far;
    const g = { raf: 0, last: box.scrollTop, startAt: performance.now() };
    glide.current = g;
    const step = () => {
      if (glide.current !== g) return;
      const cur = box.scrollTop;
      if (
        Math.abs(cur - g.last) > 2 ||
        touching.current ||
        draggingBar.current ||
        lastInputAt.current > g.startAt
      ) {
        glide.current = null;
        return;
      }
      const to = target();
      if (to === null) {
        glide.current = null;
        return;
      }
      const d = to - cur;
      if (Math.abs(d) < 1) {
        // 最后半像素直接落到位（高分屏上 scrollTop 是小数）。
        box.scrollTop = to;
        knownTop.current = box.scrollTop;
        glide.current = null;
        done?.();
        return;
      }
      const k = 0.06 + 0.19 * Math.min(1, (performance.now() - g.startAt) / 250);
      box.scrollTop = cur + Math.sign(d) * Math.max(1, Math.abs(d) * k);
      g.last = box.scrollTop;
      knownTop.current = g.last;
      g.raf = requestAnimationFrame(step);
    };
    g.raf = requestAnimationFrame(step);
  };

  const glideToBottomFn = useRef(() => {});
  /** 平滑回到底部，到了接上跟随。 */
  const glideToBottom = () => {
    const box = boxRef.current;
    if (!box) return;
    setHasNew(false);
    glideTo(
      () => bottomTop(box),
      () => {
        stick.current = true;
        pinBottomFn.current(true);
      },
    );
  };

  glideToBottomFn.current = glideToBottom;

  /**
   * 平滑滚到某个元素：放在视口中间（比视口高的贴着顶），到了闪一下（见
   * flashRow）。查找跳转、键盘逐条跳都走这里。
   */
  const glideToEl = (el: Element, align: "center" | "start" = "center", flash = true) => {
    const box = boxRef.current;
    if (!box) return;
    glideTo(
      () => {
        if (!el.isConnected) return null;
        const r = el.getBoundingClientRect();
        const v = box.getBoundingClientRect();
        const off =
          align === "start" || r.height > box.clientHeight - 40
            ? 16
            : (box.clientHeight - r.height) / 2;
        return Math.max(0, Math.min(bottomTop(box), box.scrollTop + r.top - v.top - off));
      },
      flash ? () => flashRow(el) : undefined,
    );
  };
  const glideToElFn = useRef(glideToEl);
  glideToElFn.current = glideToEl;
  const glideToElRef = useCallback(
    (el: Element, align?: "center" | "start", flash?: boolean) => glideToElFn.current(el, align, flash),
    [],
  );

  const restoreView = () => {
    const box = boxRef.current;
    const saved = transcriptView.get(sessionId);
    if (!box || !saved) return;
    if (saved.stick) {
      pinBottom(true);
      return;
    }
    stick.current = false;
    pinning.current = "restore";
    box.scrollTop = saved.top;
    knownTop.current = box.scrollTop;
    captureAnchor();
    setAwayFromBottom(distFromBottom(box) > box.clientHeight);
    requestAnimationFrame(() => {
      if (pinning.current === "restore") pinning.current = null;
    });
  };

  useEffect(() => {
    if (!armed) {
      setFindOpen(false);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [armed]);

  // 只在用户本来就贴着底部时才自动滚。他往上翻着看历史的时候把他拽回来，
  // 是聊天界面里最招人烦的一件事。
  //
  // 解锁看意图，重吸看位置（非对称迟滞，同 ChatGPT / use-stick-to-bottom）：
  // 任何向上滚动立即交出跟随。早先"离底 < 80px 仍算贴底"是位置阈值，
  // 流式期间内容每帧都在长、pinBottom 每帧都在追，向上滚没能一口气
  // 甩出 80px 就会在下一帧被拽回 —— 触控板小幅滚动永远赛不过生成速度，
  // 夺回控制权要靠大力猛划。方向判断没有这场赛跑：动一下就是想走。
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    let lastTop = box.scrollTop;
    const onScroll = () => {
      const top = box.scrollTop;
      const delta = top - lastTop;
      // pinning 帧也要记位置，不然下一次用户滚动会拿到跨帧的假 delta。
      lastTop = top;
      knownTop.current = top;
      // 锚点补偿自己冒的 scroll：不改 stick、更不重记锚点基线（见
      // anchor 的注释）。等值不命中说明同帧还叠着用户滚动，按用户算。
      const compScroll = expectedTop.current !== null && top === expectedTop.current;
      expectedTop.current = null;
      if (compScroll) return;
      // 隐藏那一帧正式包会把 scrollTop 打成 0。armed 在渲染时已是
      // false，这次滚动不是用户翻的，不能写进缓存、也不能改 stick。
      if (!armedRef.current) return;
      if (pinning.current === "restore") return;
      if (pinning.current === "bottom" && Math.abs(top - pinnedTop.current) <= 1) return;
      const dfb = distFromBottom(box);
      if (delta < 0 && dfb > 1 && (!stick.current || userScrolling())) {
        // 往上翻。dfb > 1 挡掉两种假象：底部橡皮筋回弹，以及内容变短时
        // 浏览器把 scrollTop 夹回底部 —— scrollTop 都在变小，但都不是
        // "想往上翻"。滚轮 / 键盘那条路在事件到这里之前已经交出了跟随，
        // 这里兜的是触控板以外的来源（拖滚动条、辅助功能滚动）。
        stick.current = false;
      } else if (delta > 0 && (dfb < 24 || top >= lastHeight.current - box.clientHeight - 24)) {
        // 滚回底部接上跟随。第二个条件按**用户滚动时看到的**内容高度判：
        // scroll 事件晚一帧才派发，这期间流式输出又在下面长了几行，按此刻
        // 的高度量，用户明明滚到了底却"差着几十像素"，跟随就再也接不上。
        // lastHeight 是上一次布局（ResizeObserver）记下的高度，正是用户
        // 滚的时候眼前那一版。
        // 只有自己滚回贴底才恢复跟随。阈值收窄到约一行 —— 停在离底
        // 几十像素处阅读时，跟随不该被抢回去。
        stick.current = true;
      }
      rememberView(box);
      setAwayFromBottom(dfb > box.clientHeight);
      if (dfb < 24) setHasNew(false);
      captureAnchor();
    };
    box.addEventListener("scroll", onScroll, { passive: true });
    return () => box.removeEventListener("scroll", onScroll);
    // rememberView / captureAnchor 每次渲染都是新函数，但它们只读 ref。
    // 放进依赖等于流式输出时每帧解绑重绑一次 scroll 监听，白付开销。
    // 监听的生命周期就该跟着会话走。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // 滚轮。嵌套滚动（代码块 / 工具输出 / 思考块里滚、滚到头之后交给页面）
  // 全交给浏览器原生：WebKit / Chromium 都有滚动锁定（scroll latching），
  // 按系统给的精确手势阶段（手指按着、松手、惯性）把一次手势锁在一个
  // 滚动区上 —— 滚到头不带着页面走，下一次手势才交给外层。这套 JS 拿不到
  // 阶段，模仿只能猜惯性；而且要拦截就得 passive:false，浏览器每个滚轮
  // 事件都得等主线程跑完监听器才敢滚，生成中主线程一直在忙，滚动就发涩。
  //
  // 所以 macOS 这里只挂**被动**监听：记下"用户在滚"（见 userScrolling），
  // 不拦截、不代滚，滚动全程走合成线程。
  //
  // 例外是 Windows：WebView2 对子层的链式滚动经常不交（最初接管滚轮就是
  // 为它），在那里保留老办法 —— 子层会把这一下吞掉时由这里代滚对话流。
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const onWheelIntent = (e: WheelEvent) => {
      if (e.deltaY === 0 || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      const now = performance.now();
      lastInputAt.current = now;
      // 往上滚、落点下又没有能接住它的子层：这一下多半会滚动对话流。这一刻
      // 先别贴底（见 pinBottom），等原生滚动的 scroll 事件来了再由 onScroll
      // 判断是否离开底部 —— 抢在它前面写回底部就是和原生滚动打架。
      if (e.deltaY < 0 && !innerScroller(e.target, box, e.deltaY)) upIntentAt.current = now;
    };
    const onWheelHijack = (e: WheelEvent) => {
      if (e.defaultPrevented) return;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      if (!wheelNeedsHijack(e.target, box, e.deltaY)) return;
      if (box.scrollHeight - box.clientHeight < 2) return;
      let dy = e.deltaY;
      if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) dy *= 16;
      else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) dy *= box.clientHeight;
      box.scrollTop += dy;
      e.preventDefault();
    };
    const hijack = /Windows/i.test(navigator.userAgent);
    // 触屏：手指按着的时候一个像素都不替用户滚。松手后由 scroll 事件
    // 按位置决定还跟不跟。
    const onTouchStart = () => {
      touching.current = true;
      lastInputAt.current = performance.now();
    };
    const onTouchEnd = () => {
      touching.current = false;
      // 松手后惯性还在滚，这段也算用户的。
      lastInputAt.current = performance.now() + 700;
    };
    // 键盘往上翻（焦点在对话流里时）。
    const onKey = (e: KeyboardEvent) => {
      // 键盘开合卡片同鼠标点（见 onPointerDown）。
      if (
        (e.key === "Enter" || e.key === " ") &&
        e.target instanceof Element &&
        e.target.closest("[aria-expanded]")
      ) {
        releaseStick();
        return;
      }
      if (e.key === "PageUp" || e.key === "ArrowUp" || e.key === "Home" || (e.key === " " && e.shiftKey)) {
        lastInputAt.current = performance.now();
        releaseStick();
      } else if (e.key === "PageDown" || e.key === "ArrowDown" || e.key === "End" || e.key === " ") {
        lastInputAt.current = performance.now();
      }
    };
    // 拖滚动条：按在容器自身、落在右侧滚动条那一窄条上。
    //
    // 按在内容上（Claude 桌面版同款）：贴底时先交出跟随。
    // - 点的是展开 / 收起类控件（带 aria-expanded 的：工具卡、思考块、过程
    //   组、长气泡）：内容在它下面长出来，贴底的话整页往上推，刚点的标题
    //   从鼠标底下滑走。交出跟随后由锚点补偿把它钉在原处。
    // - 点在文字上：可能是要选一段字，生成中还贴着底的话字在鼠标底下跑。
    //   松手 500ms 内页面没滚、也没选中文字 —— 只是随手点了一下 —— 再贴回去。
    // - 别的控件（复制、链接、播放器）不动布局，不交。
    const onPointerDown = (e: PointerEvent) => {
      if (e.target === box) {
        if (e.clientX >= box.getBoundingClientRect().right - 16) draggingBar.current = true;
        return;
      }
      if (e.button !== 0 || !stick.current || !(e.target instanceof Element)) return;
      const hit = e.target.closest(PRESS_CONTROL);
      if (hit && !hit.matches("[aria-expanded]")) return;
      releaseStick();
      if (hit) return;
      const top = box.scrollTop;
      window.addEventListener(
        "pointerup",
        () => {
          window.setTimeout(() => {
            if (stick.current || !box.isConnected || Math.abs(box.scrollTop - top) > 1) return;
            const sel = window.getSelection();
            if (sel && !sel.isCollapsed && sel.anchorNode && box.contains(sel.anchorNode)) return;
            pinBottomFn.current(true);
          }, 500);
        },
        { once: true },
      );
    };
    const onPointerUp = () => {
      if (draggingBar.current) lastInputAt.current = performance.now();
      draggingBar.current = false;
    };
    box.addEventListener("wheel", onWheelIntent, { passive: true });
    if (hijack) box.addEventListener("wheel", onWheelHijack, { passive: false });
    box.addEventListener("touchstart", onTouchStart, { passive: true });
    box.addEventListener("touchend", onTouchEnd, { passive: true });
    box.addEventListener("touchcancel", onTouchEnd, { passive: true });
    box.addEventListener("keydown", onKey);
    box.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      box.removeEventListener("wheel", onWheelIntent);
      box.removeEventListener("wheel", onWheelHijack);
      box.removeEventListener("touchstart", onTouchStart);
      box.removeEventListener("touchend", onTouchEnd);
      box.removeEventListener("touchcancel", onTouchEnd);
      box.removeEventListener("keydown", onKey);
      box.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
    };
    // releaseStick 只读 ref（同 onScroll 那个 effect 的说明）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 键盘在消息之间跳（Claude 桌面版同款）。焦点在对话里（某条消息本身，
  // 或消息里的按钮、链接）时：↑ / ↓ 上一条 / 下一条，Home / End 第一条 /
  // 最后一条，Esc 回到输入框。输入框空着时按 ↑ 从最后一条进来。
  //
  // 消息平时不能拿焦点 —— 带 tabindex 的话鼠标点在字上也会把焦点给它，
  // WKWebView 随即把它滚进视野（长消息就是一跳）。只在跳到它的那一刻临时
  // 给一个 tabindex=-1，焦点一走就摘掉。
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const focusArticle = (el: HTMLElement, key: string | null) => {
      if (!el.hasAttribute("tabindex")) {
        el.tabIndex = -1;
        el.addEventListener("blur", () => el.removeAttribute("tabindex"), { once: true });
      }
      navFocusing.current = true;
      el.focus({ preventScroll: true });
      navFocusing.current = false;
      const r = el.getBoundingClientRect();
      const v = box.getBoundingClientRect();
      // 从输入框进来（key = null）：落在眼前这条上，看得见一截就不滚。
      if (key === null && r.bottom > v.top && r.top < v.bottom) return;
      const list = box.querySelectorAll(ARTICLE);
      if (key === "End" || (el === list[list.length - 1] && key !== "Home" && key !== "ArrowUp")) {
        // 到了最后一条：滚到底、接上跟随。
        glideToBottomFn.current();
        return;
      }
      releaseStickFn.current();
      if (r.top < v.top + 8 || r.bottom > v.bottom - 8) glideToElFn.current(el, "start", false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey || e.defaultPrevented) return;
      if (!["ArrowUp", "ArrowDown", "Home", "End", "Escape"].includes(e.key)) return;
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest('input,textarea,select,[contenteditable="true"],.find-bar')) return;
      const cur = target.closest<HTMLElement>(ARTICLE);
      if (!cur || !box.contains(cur)) return;
      e.preventDefault();
      if (e.key === "Escape") {
        box.closest(".chat-pane")?.querySelector<HTMLElement>(".composer-input")?.focus();
        return;
      }
      const list = Array.from(box.querySelectorAll<HTMLElement>(ARTICLE));
      const i = list.indexOf(cur);
      const next =
        e.key === "ArrowUp" ? i - 1 : e.key === "ArrowDown" ? i + 1 : e.key === "Home" ? 0 : list.length - 1;
      const el = list[next];
      if (el) focusArticle(el, e.key);
    };
    const onEnter = () => {
      const list = box.querySelectorAll<HTMLElement>(ARTICLE);
      const last = list[list.length - 1];
      if (last) focusArticle(last, null);
    };
    box.addEventListener("keydown", onKey);
    box.addEventListener(ENTER_TRANSCRIPT_EVENT, onEnter);
    return () => {
      box.removeEventListener("keydown", onKey);
      box.removeEventListener(ENTER_TRANSCRIPT_EVENT, onEnter);
    };
  }, []);

  // 空闲时把视口附近还没解析的正文提前解析掉（Claude 桌面版的 lookahead）。
  //
  // 懒加载行本来要进到视口 1200px 内才解析（见 LazyMarkdown），往上快速翻
  // 历史时，解析就挤在滚动的那几帧里，长回答一条十几毫秒。这里等滚动停
  // 下来，趁空闲一次解析一条：离视口最近的先来，上方优先（翻历史多半往上
  // 翻），三屏以内。解析会让上方的行变高，这时用户没在滚，锚点补偿那一下
  // 不和触控板惯性打架。
  useEffect(() => {
    const box = boxRef.current;
    if (!box || !armed) return;
    const ric = typeof window.requestIdleCallback === "function" ? window.requestIdleCallback : null;
    let idle = 0;
    let timer = 0;
    let quiet = 0;
    let stopped = false;
    const cancel = () => {
      if (idle && ric) window.cancelIdleCallback(idle);
      window.clearTimeout(timer);
      idle = 0;
      timer = 0;
    };
    const pick = (): Element | null => {
      const v = box.getBoundingClientRect();
      const range = box.clientHeight * 3;
      let best: Element | null = null;
      let bestD = Infinity;
      for (const el of box.querySelectorAll(".md-lazy")) {
        // 量所在的轮：轮本身不被跳过排版，量它不会逼浏览器排里面。
        const r = (el.closest(".turn") ?? el).getBoundingClientRect();
        const d =
          r.bottom <= v.top ? v.top - r.bottom : r.top >= v.bottom ? (r.top - v.bottom) * 1.5 : 0;
        if (d < range && d < bestD) {
          best = el;
          bestD = d;
        }
      }
      return best;
    };
    const work = () => {
      idle = 0;
      timer = 0;
      if (stopped || userScrolling()) return;
      const el = pick();
      if (!el) return;
      el.dispatchEvent(new Event(HYDRATE_EVENT));
      schedule();
    };
    function schedule() {
      cancel();
      if (ric) idle = ric(work, { timeout: 1500 });
      else timer = window.setTimeout(work, 80);
    }
    const onScroll = () => {
      cancel();
      window.clearTimeout(quiet);
      quiet = window.setTimeout(schedule, 200);
    };
    box.addEventListener("scroll", onScroll, { passive: true });
    quiet = window.setTimeout(schedule, 600);
    return () => {
      stopped = true;
      cancel();
      window.clearTimeout(quiet);
      box.removeEventListener("scroll", onScroll);
    };
  }, [armed, sessionId]);

  // 贴底时键盘焦点从外面进来（输入框里 Shift+Tab、侧栏里 Tab），落点在视口
  // 外的话浏览器会把它滚进视野 —— 一下跳到很久以前那条消息、贴底也跟着
  // 丢了。Claude 桌面版的做法：改落到视口里最后一个能聚焦的元素上，
  // preventScroll，位置不动。
  //
  // 只管"从外面进来"。焦点在对话流里挪（Tab 一个个往上走）是用户自己在
  // 翻，照常滚；鼠标点出来的焦点（编辑框、按钮）也不管。
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    let pointerAt = -Infinity;
    const onPointer = () => {
      pointerAt = performance.now();
    };
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target;
      const from = e.relatedTarget;
      if (!stick.current || !(target instanceof HTMLElement) || target === box) return;
      // 键盘逐条跳过来的：落点就是用户要的，滚动由那边管。
      if (navFocusing.current) return;
      if (from instanceof Node && box.contains(from)) return;
      if (performance.now() - pointerAt < 500) return;
      // 位置按"贴在底部时"判：Chromium 先把目标滚进视野再派发 focusin，
      // 这时量到的已经是滚过之后的位置。贴着底的话滚之前 scrollTop 就是
      // 底部，差多少补回多少。
      const shift = bottomTop(box) - box.scrollTop;
      const view = box.getBoundingClientRect();
      const inView = (el: Element) => {
        const r = el.getBoundingClientRect();
        return r.height > 0 && r.top - shift >= view.top && r.bottom - shift <= view.bottom;
      };
      if (inView(target)) return;
      const all = box.querySelectorAll<HTMLElement>(FOCUSABLE);
      for (let i = all.length - 1; i >= 0; i--) {
        const el = all[i]!;
        if (el.matches(":disabled") || !inView(el)) continue;
        if (typeof el.checkVisibility === "function" && !el.checkVisibility({ visibilityProperty: true })) {
          continue;
        }
        // 落在一条消息的操作栏里时落到栏首（复制），不落在末尾的删除 /
        // 重新生成上 —— 回车一按就是动作。再按 Tab 照常往后走。
        const bar = el.closest(".msg-actions");
        (bar?.querySelector<HTMLElement>(".msg-action") ?? el).focus({ preventScroll: true });
        break;
      }
      // 浏览器可能已经先滚过去了（Chromium），也可能在这之后才滚（各家
      // 时机不一）：当场贴回底部，下一帧再核一次。
      pinBottomFn.current(true);
      requestAnimationFrame(() => {
        if (stick.current) pinBottomFn.current(true);
      });
    };
    box.addEventListener("pointerdown", onPointer, true);
    box.addEventListener("focusin", onFocusIn);
    return () => {
      box.removeEventListener("pointerdown", onPointer, true);
      box.removeEventListener("focusin", onFocusIn);
    };
  }, []);

  // 切回来把位置还回去。
  //
  // 正式包的 WKWebView 揭开隐藏的会话面板（content-visibility）之后，会在
  // 接下来某一帧把 scrollTop 清零 —— 时机不定，layout 时写一次压不住。
  // 正排容器里 0 是对话的**最顶上**：清零那一帧画出来，就是整页闪到开头
  // 再跳回来（早先倒排时 0 恰好是底部，贴底的会话看不出来）。
  //
  // 所以位置落稳之前，对话列先透明（只动 opacity，不影响布局和滚动）：
  // 每帧核对一次，被清了就再写回去，连续两帧都在该在的地方才显示出来，
  // 最多等 6 帧。用户看到的第一帧就是正确的位置。清零会冒一次 scroll，
  // 那里也当场写回。
  //
  // `[约束]` 显示不能只靠 rAF：窗口被遮挡、低电量时 rAF 会被系统降频，
  // 内容就一直透明着。150ms 兜底，到点无论如何显示。
  useLayoutEffect(() => {
    if (!armed) return;
    const box = boxRef.current;
    const col = box?.querySelector<HTMLElement>(".thread-col");
    const saved = transcriptView.get(sessionId);
    if (col) col.style.opacity = "0";
    restoreView();
    let raf = 0;
    let frames = 0;
    let settled = 0;
    let fallback = 0;
    const onFakeScroll = () => {
      if (!box) return;
      const want = !saved || saved.stick ? bottomTop(box) : saved.top;
      if (Math.abs(box.scrollTop - want) > 1) restoreView();
    };
    const reveal = () => {
      if (col) col.style.opacity = "";
      window.clearTimeout(fallback);
      box?.removeEventListener("scroll", onFakeScroll);
    };
    box?.addEventListener("scroll", onFakeScroll, { passive: true });
    fallback = window.setTimeout(() => {
      cancelAnimationFrame(raf);
      reveal();
    }, 150);
    const check = () => {
      if (!box) return reveal();
      const want = !saved || saved.stick ? bottomTop(box) : saved.top;
      if (Math.abs(box.scrollTop - want) > 1) {
        restoreView();
        settled = 0;
      } else {
        settled++;
      }
      if (settled >= 2 || ++frames >= 6) return reveal();
      raf = requestAnimationFrame(check);
    };
    raf = requestAnimationFrame(check);
    return () => {
      cancelAnimationFrame(raf);
      reveal();
    };
    // `[约束]` restoreView 绝不能进依赖。它每次渲染都是新引用，进去之后
    // 这个 effect 每渲染一次就把滚动位置写回缓存值一次 —— 流式输出期间
    // 等于每帧把用户拽回上次记录的位置，页面再也滚不动。
    // 位置恢复只该发生在"切回来"这一刻，也就是 armed / sessionId 变化时。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed, sessionId]);

  // 内容高度一变（流式追加、懒水合落地、图片 / mermaid 出图）就到这里。
  //
  // - 跟随中：贴回底部（pinBottom 自己会让着正在滚的用户）。
  // - 翻历史中：**下方**长高什么都不用做 —— 正排容器里它不动视口。这正是
  //   生成中翻历史稳定的原因：流式输出每帧都在长，这里一次都不写
  //   scrollTop，原生滚动（触控板惯性、平滑滚动）完全不受打扰。只有锚点
  //   **上方**的东西变了高（懒加载换真身、估高落地、图片出图）才补一次。
  //
  // ResizeObserver 回调在 layout 之后、paint 之前跑，补写用户看不到中间态。
  useEffect(() => {
    const box = boxRef.current;
    const col = box?.querySelector(".thread-col");
    if (!box || !col) return;
    lastHeight.current = box.scrollHeight;
    const ro = new ResizeObserver(() => {
      lastHeight.current = box.scrollHeight;
      const liveTurn = col.querySelector<HTMLElement>(".turn[data-tail]");
      const liveKey = liveTurn?.dataset["turnKey"];
      if (liveTurn && liveKey) {
        liveTurnHeights.current.set(liveKey, Math.round(liveTurn.getBoundingClientRect().height));
      }
      if (stick.current) {
        pinBottom();
        return;
      }
      if (armedRef.current && !pinning.current) {
        const boxTop = box.getBoundingClientRect().top;
        let dy = 0;
        if (Math.abs(box.scrollTop - knownTop.current) > 0.5) {
          // 用户刚滚过、scroll 事件还没派发：锚点基线还是滚动之前的，拿它
          // 补偿等于把用户这一下按回去。按此刻的位置重记，这一帧不补。
          knownTop.current = box.scrollTop;
          captureAnchor();
        } else if (anchor.current && !anchor.current.el.isConnected) {
          // 锚点块被换成了新元素（正在长的块落定）：按它前面那块挪了多少
          // 补，再在新布局上重记锚点。不补的话，落定那一帧布局一变，正读
          // 着的思考 / 正文当场跳走。
          const p = anchor.current.prev;
          if (p?.el.isConnected) dy = p.el.getBoundingClientRect().top - boxTop - p.top;
          captureAnchor();
          if (anchor.current) anchor.current.top -= Math.round(dy);
          if (anchor.current?.prev) anchor.current.prev.top -= Math.round(dy);
        } else {
          const a = anchor.current;
          dy = a ? a.el.getBoundingClientRect().top - boxTop - a.top : 0;
        }
        if (Math.abs(dy) > 0.5) {
          box.scrollTop = box.scrollTop + Math.round(dy);
          expectedTop.current = box.scrollTop;
          knownTop.current = box.scrollTop;
          // 平滑滚动途中补偿：这一下是自己写的，别让它当成用户接手。
          if (glide.current) glide.current.last = box.scrollTop;
          rememberView(box);
        }
        // 前一块的基线跟着这一帧重记：它自己可能刚长高过（懒加载换真身），
        // 锚点补偿把锚点拉回了原处，前一块却挪了。不重记的话，等锚点被换
        // 掉那一下会按这段旧账多补一截。
        const p = anchor.current?.prev;
        if (p?.el.isConnected) p.top = p.el.getBoundingClientRect().top - box.getBoundingClientRect().top;
      }
      // 交出跟随后内容还在下面长，离底距离变大但不触发 scroll 事件 ——
      // 「回到底部」得靠这里浮出来，不然用户翻上去就找不到回程。
      setAwayFromBottom(distFromBottom(box) > box.clientHeight);
    });
    ro.observe(col);
    // 对话区自己变高变矮也要管：输入框随草稿长高缩回、上方出现横条时，
    // 列没变、视口变了 —— 跟随中不贴一下，底部就露出一截或被盖住一截。
    ro.observe(box);
    return () => ro.disconnect();
    // pinBottom / rememberView 只读 ref。放进依赖会让 ResizeObserver 每次
    // 渲染 disconnect 再重建 —— 每帧重建既贵又会丢掉观测基线。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 「回到底部」上的新内容提示，按**数据**判，不按高度判。
  //
  // `[约束]` 不能用"内容变高了"推断。切到历史会话往上翻时，视口下方的行
  // 一直在变高 —— 懒加载换真身、content-visibility 的估高落地、图片出图
  // —— 那只是渲染完成，不是模型说了新话；按高度判，翻历史时这个点亮个
  // 不停。这里只认对话内容本身往后长了：多了条目、正文 / 思考在流、最后
  // 那张工具卡的状态或输出变了。且只在这一轮正在跑时认 —— 切会话、拉历史
  // 快照对账换掉 items 时 busy 为假，不会误报；后台任务完成通知会让轮子
  // 重新跑起来，那时它再长出来的内容照常算。
  const contentMark = (() => {
    const last = items[items.length - 1];
    const tail =
      last?.kind === "tool"
        ? `${last.status}:${last.output.length}:${last.result?.length ?? 0}`
        : last && "text" in last
          ? `${last.text.length}`
          : "";
    return `${items.length}|${last?.id ?? ""}|${tail}`;
  })();
  const seenMark = useRef(contentMark);
  useEffect(() => {
    if (seenMark.current === contentMark) return;
    seenMark.current = contentMark;
    if (armed && busy && !stick.current) setHasNew(true);
  }, [contentMark, armed, busy]);
  // 正文 / 思考在流也算新内容。它们不经过渲染（见 live），直接听 store。
  const markGate = useRef({ armed, busy });
  markGate.current = { armed, busy };
  useEffect(
    () =>
      live.subscribe(() => {
        const g = markGate.current;
        if (g.armed && g.busy && !stick.current) setHasNew(true);
      }),
    [live],
  );

  // 自己发的消息无条件回到底部。没有这条的话，在上面翻历史时发了新
  // 消息，stick 是 false，整轮生成都不跟随 —— 得手动滑到底才恢复。
  //
  // 认"新消息"按最后一条用户消息的**位置**往后挪，不按 id 变：乐观气泡
  // 换成宿主回声时 id 会从 `local-*` 变成正式的，那不是新发的一句 ——
  // 按 id 认的话，用户在开轮头几百毫秒里往上翻，会被这一下拽回底部。
  const lastUserAt = useRef(-1);
  useLayoutEffect(() => {
    let force = false;
    let at = -1;
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i]?.kind === "user") {
        at = i;
        break;
      }
    }
    if (at > lastUserAt.current) {
      stick.current = true;
      force = true;
    }
    lastUserAt.current = at;
    if (stick.current) pinBottom(force);
    // pinBottom 不进依赖：依赖列的是"什么变化该重新贴底"，那是内容本身。
    // 把每帧新建的函数混进去只会让这个列表失去表达力。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, streaming, thinking, modeAsk?.requestId, choiceAsk?.requestId, permAsks?.length, busy]);

  // 还在转圈的工具。底部状态行靠它说清此刻在等谁 —— 一次 build 跑两
  // 分钟的时候，"生成中"是句废话。
  const runningTool = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it && it.kind === "tool" && it.status === "running") return it.name;
    }
    return null;
  }, [items]);

  const waitLabel = runningTool
    ? t("transcript.wait.runningTool", { tool: runningTool })
    : t("transcript.wait.generating");

  // 连续的思考 / 工具折成组（学 Cursor）。长探索几十行连排会把回答
  // 挤出屏幕，折完对话流里剩下的才是内容。生成期间正在跑的工具也在
  // 组里，组头单行直播（见 ProcessGroup）—— 工具完成只换字不增删行，
  // 底部不再随每个工具弹跳。正文开始流（streaming 为真）说明尾部那段
  // 过程已经讲完，live 撤下、单条段落还原成普通行 —— 一行换一行，
  // 这次落定同样不跳。liveTail 先算成布尔再进 useMemo：跑轮时工具参数、
  // 输出也在一帧帧改 items，分组不该跟着无关的重渲染重算。
  // ── 条目身份与入场 ──────────────────────────
  //
  // 乐观气泡（`local-*`）在宿主回声到达时换成正式 id。React 按 id 当 key
  // 的话，那一下整条气泡（连同它开的那一轮）卸掉重挂：入场动画被拦腰
  // 截断、悬停态和编辑态丢掉、轮里的东西全部重建。这里把正式 id 映射回
  // 它顶替的那个本地 id，key 从头到尾不变。映射只增不减、按内容配对，
  // 同样的输入算出同样的结果（渲染期计算安全）。
  const keyAlias = useRef(new Map<string, string>());
  /** 上一次提交时还在的乐观气泡（提交后才更新，见下面的 layout effect）。 */
  const prevLocals = useRef<{ id: string; text: string }[]>([]);
  for (const it of items) {
    if (it.kind !== "user" || it.id.startsWith("local-") || keyAlias.current.has(it.id)) continue;
    const was = prevLocals.current.find(
      (l) => l.text === it.text && !items.some((x) => x.id === l.id),
    );
    if (was && ![...keyAlias.current.values()].includes(was.id)) keyAlias.current.set(it.id, was.id);
  }
  const keyOf = useCallback((id: string) => keyAlias.current.get(id) ?? id, []);

  /**
   * 这一次渲染里**新出现**的条目：挂上时轻轻淡入（见 Row 的 enter）。
   *
   * 首次挂载、切回会话、历史水合进来的都不算 —— 那是"一直在那儿的东西"，
   * 整屏一起淡入只会显得慢。一次冒出来好几条也当水合（快照对账），
   * 不算新消息。
   */
  const seen = useRef<Set<string> | null>(null);
  const fresh = useMemo(() => {
    const out = new Set<string>();
    const known = seen.current;
    if (!known) return out;
    for (const it of items) {
      const k = keyAlias.current.get(it.id) ?? it.id;
      if (!known.has(k)) out.add(k);
    }
    return out.size > 3 ? new Set<string>() : out;
  }, [items]);
  useLayoutEffect(() => {
    const known = seen.current ?? new Set<string>();
    for (const it of items) known.add(keyAlias.current.get(it.id) ?? it.id);
    seen.current = known;
    prevLocals.current = items.flatMap((it) =>
      it.kind === "user" && it.id.startsWith("local-") ? [{ id: it.id, text: it.text }] : [],
    );
  }, [items]);

  const liveTail = busy && !streaming;
  const blocks = useMemo(() => groupBlocks(items, liveTail, thinking), [items, liveTail, thinking]);
  // 再按轮收一层。离屏的轮整个跳过排版绘制，这一层就是那个开关挂的地方
  // （见 groupTurns 和 styles.css 的 `.turn`）。
  const turns = useMemo(() => groupTurns(blocks, keyOf), [blocks, keyOf]);
  // 每轮没渲染过时的占位高度，按内容估（见 lib/turnHeight）。列宽取渲染时
  // 量到的；第一次渲染还没有 DOM，按最宽算。渲染过的轮浏览器记着真实
  // 高度（contain-intrinsic-size 的 auto），这个估值就不再起作用。
  const colWidth = boxRef.current?.querySelector<HTMLElement>(".thread-col")?.clientWidth || 720;
  //
  // 当过最后一轮的例外，用量到的真实高度（见 liveTurnHeights）。
  const turnHeights = useMemo(
    () => turns.map((t) => liveTurnHeights.current.get(t.key) ?? estimateTurnHeight(t.blocks, colWidth)),
    [turns, colWidth],
  );
  // 正在流的思考挂进尾部那个组的组尾 —— 它落定后就进这个组（见
  // groupBlocks 的 liveThink），挂在别处落定时就是一次换位。正文已经
  // 开始流、组不再直播时也照挂。尾部没有组（前面是正文或提问）才单独
  // 成行：落定后还是这一行；接着开了工具就和工具成组（用户展开着在读
  // 的话组跟着开，见 ProcessGroup）。
  const tailBlock = blocks[blocks.length - 1];
  const liveFold = tailBlock?.kind === "fold" ? tailBlock : undefined;
  // 贴底的那几条立刻走完整 markdown / diff。更早的等进视野再解析，
  // 否则长会话第一次打开会把主线程卡死。查找时全量水合，否则搜不到。
  const hydrateFrom = Math.max(0, blocks.length - 12);

  return (
    <div className="transcript-shell" onContextMenu={suppressNativeMenu}>
      <main className="transcript" ref={boxRef}>
        {/* 查找条 sticky 钉在视口上缘，所以必须是滚动容器的第一个孩子。 */}
        {findOpen && armed ? (
          <FindBar
            box={boxRef}
            onNeedle={setFindNeedle}
            onJump={releaseStickRef}
            scrollTo={glideToElRef}
            onClose={() => {
              setFindOpen(false);
              setFindNeedle("");
            }}
          />
        ) : null}
        <div className="thread-col">
        {turns.map((t, ti) => (
          <div
            className="turn"
            key={t.key}
            style={{ containIntrinsicSize: `auto ${turnHeights[ti]}px` }}
            data-turn-key={t.key}
            // 最后一轮不省渲染：生成中内容每帧在长，估高一直失效，而它
            // 本来就在视口里（见 styles.css 的 .turn[data-tail]）。
            // data-live 另算，只在生成中挂（操作栏的悬停显示用它）。
            //
            // `[约束]` data-tail 生成结束后也不摘，等下一轮出现才摘。结束那一下正好是
            // 直播思考 / 正文搬进这一轮的同一次提交：此时摘掉，它变回
            // content-visibility: auto，判定"在屏幕上"之前那一帧按占位高度
            // 排，内容当场缩掉几千像素，阅读位置被浏览器夹走（见
            // liveTurnHeights）。等下一轮出现时它早已按真实高度排过、量过。
            {...(ti === turns.length - 1 ? { "data-tail": "" } : {})}
            {...(busy && ti === turns.length - 1 ? { "data-live": "" } : {})}
          >
            {(() => {
              // 操作栏按轮挂：只给这一轮最后一条回答。生成中的那一轮先都不挂
              // —— 后面还会冒出新正文，挂了又摘会让上面的内容跳一下；结束时
              // 挂在轮尾，只往下长。
              const actionsAt = busy && ti === turns.length - 1 ? -1 : lastAssistantIndex(t.blocks);
              return t.blocks.map((b, bi) => {
              // 懒水合的窗口按块数算，所以要用块在 blocks 里的原下标。
              const i = t.from + bi;
              const rowKey = b.kind === "row" ? keyOf(b.item.id) : "";
              return b.kind === "row" ? (
                <Row
                  key={rowKey}
                  item={b.item}
                  enter={fresh.has(rowKey)}
                  hydrate={i >= hydrateFrom || findHydrate.has(b.item.id)}
                  actions={bi === actionsAt}
                  regenEnabled={!busy}
                  mutateEnabled={!busy}
                  {...(onRegenerate ? { onRegenerate: requestRegenerate } : {})}
                  {...(onEditEntry ? { onEditEntry } : {})}
                  {...(onResendEntry
                    ? { onResendEntry, onConfirmResend: confirmResend }
                    : {})}
                  {...(onDeleteEntry ? { onDeleteEntry: requestDelete } : {})}
                  {...(onRestoreEntry
                    ? { checkpointIds, onRestoreEntry: requestRestore }
                    : {})}
                  {...(redoId && onRedo ? { redoId, onRedo } : {})}
                />
              ) : (
                <ProcessGroup
                  key={b.id}
                  id={b.id}
                  items={b.items}
                  live={b.live}
                  {...(b === liveFold && thinking
                    ? { thinkingLive: live, thinkingClock: thinkClock ?? null }
                    : {})}
                />
              );
              });
            })()}
          </div>
        ))}

        {thinking && !liveFold ? (
          <LiveThinking live={live} clock={thinkClock ?? null} />
        ) : null}
        {streaming ? <LiveMarkdown live={live} /> : null}
        {/* 换模式的建议长在对话流里（Cursor 同款）：它是对话的一部分，
            不是危险操作；用户看着模型给的理由点「切换」或者不切。 */}
        {modeAsk && onAnswerMode ? (
          <ModeSwitchCard
            key={modeAsk.requestId}
            ask={modeAsk.detail}
            execMode={execMode}
            onAnswer={onAnswerMode}
          />
        ) : null}
        {choiceAsk && onAnswerChoice ? (
          choiceAsk.detail.preview.kind === "env_vars" ? (
            <EnvVarsCard
              key={choiceAsk.requestId}
              ask={choiceAsk.detail}
              onAnswer={onAnswerChoice}
            />
          ) : (
            <AskChoiceCard
              key={choiceAsk.requestId}
              ask={choiceAsk.detail}
              onAnswer={onAnswerChoice}
            />
          )
        ) : null}
        {/* 权限确认同样长在对话流里（照 Claude Code）。key 让每个请求拿到
            全新的卡片实例：上一张的"已答"状态不会残留到下一张上。 */}
        {onAnswerPermission
          ? permAsks?.map((a) => (
              <PermissionCard
                key={a.requestId}
                ask={a.detail}
                onAnswer={(r) => onAnswerPermission(a.requestId, r)}
              />
            ))
          : null}
        {/*
         * 状态行在整个忙碌期间常驻，**不和流式内容二选一**。
         *
         * `[约束]` 早先的写法是"有流式文本就把它藏起来"，理由是文字本身
         * 就在动。但模型说完"先写文件："之后要花十几秒生成工具参数，
         * 那段时间一个字都不吐 —— 屏幕彻底静止，和卡死没有区别。等的
         * 是什么、等了多久，只有这一行能回答。
         *
         * 压缩优先且不看 busy：手动 `/compact` 不开轮次，不占 busy。
         */}
        {compacting ? (
          <Dots label={t("transcript.wait.compacting")} timed since={waitSince} />
        ) : busy && !modeAsk && !choiceAsk && !permAsks?.length ? (
          <Dots label={waitLabel} timed since={waitSince} />
        ) : null}
        </div>
      </main>
      {/* 删除确认 portal 到 body、遮罩盖整个窗口（和别处的确认框一样）。
          就地渲染的话它是滚动容器的孩子，列上哪天再挂 transform /
          contain，fixed 遮罩的包含块就从视口变成滚动区，弹窗偏移错位。 */}
      {confirmDel ? (
        <ConfirmDialog c={confirmDel} portal onClose={() => setConfirmDel(null)} />
      ) : null}
      {/* 叠在滚动容器外面。滚动流里 sticky + 负边距：WebKit 把按钮
          挤出视口（Mac 上看不见），Chromium 把它压扁（Windows 上不圆）。
          往上翻超过一屏才出现 —— 贴底时它只是噪音。 */}
      {awayFromBottom ? (
        <button
          type="button"
          className={hasNew ? "jump-bottom has-new" : "jump-bottom"}
          title={hasNew ? t("transcript.jumpBottomNew") : t("transcript.jumpBottom")}
          aria-label={hasNew ? t("transcript.jumpBottomNew") : t("transcript.jumpBottom")}
          onClick={glideToBottom}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path
              d="M8 3v10M3.5 8.5L8 13l4.5-4.5"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {hasNew ? <span className="jump-dot" aria-hidden /> : null}
        </button>
      ) : null}
    </div>
  );
});

/**
 * 正在流的正文。只有它订阅 store 的正文，流式期间每帧重画的就是这一块
 * （见 lib/liveText）。
 *
 * animated：新长出来的块逐个淡入 —— token 是成撮到的，不淡的话是一坨
 * 一坨往外蹦。落定成 Row 之后就是普通历史消息，不再带这个开关（见
 * styles.css 的 .md[data-md-animated]）。
 */
function LiveMarkdown({ live }: { live: LiveTextStore }) {
  const text = useLiveText(live, "text");
  return text ? (
    <div className="msg assistant">
      <Markdown text={text} animated />
    </div>
  ) : null;
}

/**
 * memo：跑轮时 items 一帧帧在换（工具参数、输出），历史条目不该跟着刷。
 * items 数组里未变化的元素引用是稳定的（更新走的是替换单个元素），
 * 所以浅比较有效。
 */
export const Row = memo(function Row({
  item,
  actions = true,
  enter = false,
  onRegenerate,
  regenEnabled,
  hydrate,
  onEditEntry,
  onResendEntry,
  onConfirmResend,
  onDeleteEntry,
  checkpointIds,
  onRestoreEntry,
  redoId,
  onRedo,
  mutateEnabled,
}: {
  item: Item;
  /** 回答底下挂不挂操作栏：对话流里一轮只有最后一条回答挂（见 lastAssistantIndex）。默认挂。 */
  actions?: boolean;
  /**
   * 这条是刚冒出来的（不是水合进来的历史）：挂上时轻轻淡入。只看挂载
   * 那一刻的值 —— 之后 Transcript 会把它翻回 false，动画不能因此被掐断。
   */
  enter?: boolean;
  onRegenerate?: (itemId: string) => void;
  regenEnabled?: boolean;
  /** 贴底 / 查找中：立刻解析 markdown 和工具详情。 */
  hydrate?: boolean;
  /** 上下文编辑（见 Transcript 的同名 prop）。 */
  onEditEntry?: (item: TextItem, text: string, images?: ImageInput[]) => Promise<boolean>;
  /** 编辑后重发（见 Transcript 的同名 prop）。只有用户气泡用它。 */
  onResendEntry?: (item: TextItem, text: string, images?: ImageInput[]) => Promise<boolean>;
  /** 发送前确认会不会回退文件。false = 取消，编辑框留着。 */
  onConfirmResend?: (item: TextItem) => Promise<boolean>;
  /** 上下文删除。收到的是 Transcript 的确认包装 —— 点击先弹确认框。 */
  onDeleteEntry?: (item: TextItem) => void;
  checkpointIds?: string[];
  onRestoreEntry?: (item: TextItem) => void;
  /** 回退后留下的那条提问 id。这条上的回退图标翻成前进。 */
  redoId?: string;
  onRedo?: () => void;
  /** 编辑/删除此刻可用（空闲）。生成中改历史会和正在写的轮子打架。 */
  mutateEnabled?: boolean;
}) {
  const { t } = useT();
  // 编辑态挂在 Row 上（hooks 不能进 switch 分支），只有文本气泡用它。
  const [editing, setEditing] = useState(false);
  const [entering] = useState(enter);
  const enterCls = entering ? " msg-enter" : "";

  switch (item.kind) {
    case "user":
      if (editing && onEditEntry) {
        return (
          <div className="msg user editing">
            <Composer
              variant="edit"
              initial={item.text}
              parseChips
              allowImages
              initialImages={item.images ?? []}
              onCancel={() => setEditing(false)}
              onSave={async (text, images) => {
                const ok = await onEditEntry(item, text, images);
                if (ok) setEditing(false);
                return ok;
              }}
              {...(onResendEntry
                ? {
                    onResend: async (text: string, images?: ImageInput[]) => {
                      const ok = await onResendEntry(item, text, images);
                      if (ok) setEditing(false);
                      return ok;
                    },
                    ...(onConfirmResend ? { onBeforeResend: () => onConfirmResend(item) } : {}),
                  }
                : {})}
            />
          </div>
        );
      }
      // 按钮发的那条（「构建」/「并行构建」）画成构建卡，不画成气泡：正文
      // 只是一句占位话，用户按的是键、不是在说话（Cursor 同款：Build 的
      // 气泡正文为空，界面按 isPlanExecution 画卡）。
      if (item.nudge) {
        return (
          <div className={`user-row${enterCls}`}>
            <BuildCard item={item} />
            <MsgActions
              text={item.text}
              mutateEnabled={!!mutateEnabled}
              {...(item.at ? { at: item.at } : {})}
              {...(onDeleteEntry ? { onDelete: () => onDeleteEntry(item) } : {})}
            />
          </div>
        );
      }
      // 用户输入按原文显示，不走 markdown —— 渲染会篡改他说的话。
      // 操作按钮排在气泡右下方的流内位置（不用绝对定位：thread-col 的
      // content-visibility 隐含 paint containment，定位出气泡边界会被裁掉）。
      return (
        <div className={`user-row${enterCls}`}>
          <div className="msg user">
            {/* 自己附的图要看得见。不回显的话，发完之后附件条一清空，
                用户就再也确认不了刚才发出去的是哪张。 */}
            {item.images?.length ? (
              <div className="msg-images">
                {item.images.map((src, i) => (
                  <UserImage key={i} src={src} />
                ))}
              </div>
            ) : null}
            <UserBody text={item.text} {...(item.files ? { files: item.files } : {})} />
          </div>
          <MsgActions
            text={item.text}
            mutateEnabled={!!mutateEnabled}
            {...(item.at ? { at: item.at } : {})}
            {...(onEditEntry ? { onEdit: () => setEditing(true) } : {})}
            {...(onDeleteEntry ? { onDelete: () => onDeleteEntry(item) } : {})}
            {...(redoId && item.id === redoId && onRedo
              ? { onRedo }
              : canRestoreUser(item, checkpointIds) && onRestoreEntry
                ? { onRestore: () => onRestoreEntry(item) }
                : {})}
          />
        </div>
      );
    case "assistant":
      if (editing && onEditEntry) {
        return (
          <div className="msg assistant editing">
            <Composer
              variant="edit"
              initial={item.text}
              onCancel={() => setEditing(false)}
              onSave={async (text) => {
                const ok = await onEditEntry(item, text);
                if (ok) setEditing(false);
                return ok;
              }}
            />
          </div>
        );
      }
      return (
        <div className="msg assistant">
          <LazyMarkdown text={item.text} eager={!!hydrate} />
          {/* 半截话得说明白它为什么半截 —— 不标的话，用户过一会儿回来
              看到的是一句戛然而止的回答，分不清是自己停的还是模型崩了。 */}
          {item.stopped ? <div className="msg-stopped">{t("transcript.msg.stopped")}</div> : null}
          {actions ? (
            <MsgActions
              text={item.text}
              regenEnabled={!!regenEnabled && !!onRegenerate}
              mutateEnabled={!!mutateEnabled}
              {...(item.at ? { at: item.at } : {})}
              {...(onRegenerate ? { onRegenerate: () => onRegenerate(item.id) } : {})}
              {...(onEditEntry ? { onEdit: () => setEditing(true) } : {})}
              {...(onDeleteEntry ? { onDelete: () => onDeleteEntry(item) } : {})}
            />
          ) : null}
        </div>
      );
    case "thinking":
      return <ThinkingBlock text={item.text} durationMs={item.durationMs} />;
    case "tool":
      return <ToolCard tool={item} eager={!!hydrate} />;
    case "error":
      return <ErrorCard item={item} enter={entering} />;
    case "notice":
      return <div className={`msg notice${enterCls}`}>{item.text}</div>;
    case "task_notice":
      return entering ? (
        <div className="msg-enter">
          <TaskNoticeCard item={item} />
        </div>
      ) : (
        <TaskNoticeCard item={item} />
      );
    case "compact":
      return (
        <div className="compact-rule" role="separator">
          {t("transcript.compactRule")}
        </div>
      );
  }
});

/**
 * 错误卡：常驻的只有一句人话，技术细节折在「详情」里。
 *
 * 照 Codex 的处理：出错时用户要知道的是"怎么回事、该做什么"，一屏服务方
 * 的原始响应（整段 JSON、整张网页）回答不了这两个问题，只会把对话流
 * 撑成一大块红。原话是排查的人才需要的，点开再看 —— 而且内核那边已经
 * 只留了说明原因的那一句（见 riot-providers 的 summarize_body）。
 */
function ErrorCard({
  item,
  enter = false,
}: {
  item: Extract<Item, { kind: "error" }>;
  enter?: boolean;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className={enter ? "msg error msg-enter" : "msg error"}>
      <div className="error-line">
        <span className="error-text">{item.text}</span>
        {item.detail ? (
          <button
            type="button"
            className="error-detail-toggle"
            // 只为开合，不把焦点吃过去：WKWebView 会把 focused button 滚进视野。
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
          >
            {t("transcript.error.detail")}
            <Chevron open={open} />
          </button>
        ) : null}
      </div>
      {item.detail ? (
        <SmoothFold open={open}>
          <code className="error-detail">{item.detail}</code>
        </SmoothFold>
      ) : null}
    </div>
  );
}

/**
 * 气泡上的时刻只到分钟。
 *
 * 秒对读对话没有意义。格式化器实例由 i18n 的 dateTimeFormat 按语言缓存 ——
 * 每条消息每帧现造一个 Intl 实例，流式输出时是几百次没有产出的构造。
 */
const HHMM_OPTS: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
};

/** hover 提示给完整日期：长会话里光看"15:18"分不出是哪天。 */
const FULL_STAMP_OPTS: Intl.DateTimeFormatOptions = {
  dateStyle: "long",
  timeStyle: "medium",
};

/** 悬停出现的消息操作：复制 / 重新生成 / 上下文编辑 / 删除，末尾是时刻。
 *  占位始终在，hover 才可见。 */
/**
 * 「构建」/「并行构建」按钮发出的那条消息（照 Cursor 的 Build 气泡）：
 * 用户侧一张卡，标签写按了哪个键，下面是构建的那份计划的标题。整张卡
 * 是打开计划面板的入口，和对话里的计划卡一致。
 */
function BuildCard({ item }: { item: Extract<Item, { kind: "user" }> }) {
  const { t } = useT();
  const parallel = item.nudge === "build_in_parallel";
  return (
    <button
      type="button"
      className="msg user build-card"
      onClick={openPlanPanel}
      title={t("transcript.plan.open")}
    >
      <span className="build-card-icon" aria-hidden>
        <PlanModeIcon />
      </span>
      <span className="build-card-main">
        <span className="build-card-badge">
          {parallel ? t("composer.build.parallel") : t("composer.build")}
        </span>
        <span className="build-card-title">{item.planName ?? t("transcript.plan.untitled")}</span>
      </span>
    </button>
  );
}

function MsgActions({
  text,
  at,
  onRegenerate,
  regenEnabled,
  onEdit,
  onDelete,
  onRestore,
  onRedo,
  mutateEnabled,
}: {
  text: string;
  /** 消息产生的时刻（Unix 毫秒）。undefined = 老记录没有，不显示。 */
  at?: number;
  onRegenerate?: () => void;
  regenEnabled?: boolean;
  /** 进入编辑态。undefined = 这条不可编辑。 */
  onEdit?: () => void;
  /** 从上下文删除。undefined = 这条不可删。 */
  onDelete?: () => void;
  /** 回退到这条提问发出时。undefined = 没有检查点。 */
  onRestore?: () => void;
  /** 把最近一次回退撤回去。有它时画前进图标，不再画回退。 */
  onRedo?: () => void;
  /** 编辑/删除此刻可用（空闲）。 */
  mutateEnabled?: boolean;
}) {
  const { t } = useT();
  const [copied, flashCopied] = useTimedFlag(false, 1500);
  const copyLabel = copied ? t("common.copied") : t("transcript.msg.copy");
  return (
    <div className="msg-actions">
      <button
        type="button"
        className={copied ? "msg-action done" : "msg-action"}
        title={copyLabel}
        aria-label={copyLabel}
        onClick={() => {
          void navigator.clipboard.writeText(text);
          flashCopied(true);
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
      {onRegenerate ? (
        <button
          type="button"
          className="msg-action"
          title={
            regenEnabled ? t("transcript.msg.regenerate") : t("transcript.msg.regenerateBusy")
          }
          aria-label={t("transcript.msg.regenerate")}
          disabled={!regenEnabled}
          onClick={() => onRegenerate()}
        >
          <RegenIcon />
        </button>
      ) : null}
      {onEdit ? (
        <button
          type="button"
          className="msg-action"
          title={mutateEnabled ? t("transcript.msg.edit") : t("transcript.msg.editBusy")}
          aria-label={t("transcript.msg.editLabel")}
          disabled={!mutateEnabled}
          onClick={onEdit}
        >
          <EditIcon />
        </button>
      ) : null}
      {onRedo ? (
        <button
          type="button"
          className="msg-action"
          title={mutateEnabled ? t("transcript.restore.redo") : t("transcript.restore.busy")}
          aria-label={t("transcript.restore.redo")}
          disabled={!mutateEnabled}
          onClick={onRedo}
        >
          <RedoIcon />
        </button>
      ) : onRestore ? (
        <button
          type="button"
          className="msg-action"
          title={
            mutateEnabled ? t("transcript.restore.title") : t("transcript.restore.busy")
          }
          aria-label={t("transcript.restore.title")}
          disabled={!mutateEnabled}
          onClick={onRestore}
        >
          <RestoreIcon />
        </button>
      ) : null}
      {onDelete ? (
        <button
          type="button"
          className="msg-action"
          title={
            mutateEnabled ? t("transcript.msg.deleteTurnTitle") : t("transcript.msg.deleteBusy")
          }
          aria-label={t("transcript.msg.deleteTurn")}
          disabled={!mutateEnabled}
          onClick={onDelete}
        >
          <TrashIcon />
        </button>
      ) : null}
      {at ? <MsgTime at={at} /> : null}
    </div>
  );
}

/** 消息时刻。跟在操作按钮后面，和它们一起 hover 出现。 */
function MsgTime({ at }: { at: number }) {
  // 只为订阅语言：切语言时格式化器要跟着换。
  useT();
  const d = new Date(at);
  return (
    <time
      className="msg-time"
      dateTime={d.toISOString()}
      title={dateTimeFormat(FULL_STAMP_OPTS).format(d)}
    >
      {dateTimeFormat(HHMM_OPTS).format(d)}
    </time>
  );
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.4" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M10.5 5.5V4.2A1.7 1.7 0 0 0 8.8 2.5H4.2A1.7 1.7 0 0 0 2.5 4.2v4.6A1.7 1.7 0 0 0 4.2 10.5H5.5"
        stroke="currentColor"
        strokeWidth="1.3"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3.5 8.2L6.6 11.2 12.5 4.8"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M9.9 3.1l3 3L6.4 12.6l-3.6.6.6-3.6L9.9 3.1z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M8.6 4.4l3 3" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M13 13.2V8A3.5 3.5 0 0 0 9.5 4.5H3"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6.2 7.7 3 4.5 6.2 1.3"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RedoIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3 13.2V8A3.5 3.5 0 0 1 6.5 4.5H13"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9.8 7.7 13 4.5 9.8 1.3"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 回退后留下的那条提问：对话被截到它，它就是最后一条用户气泡。 */
function lastRestoredUserId(items: Item[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it?.kind === "user") return it.id;
  }
  return undefined;
}

/** 这条助手回复前面最近的用户提问 —— 重新生成会截回到它、文件也回到它发出时。 */
function userPromptBefore(items: Item[], assistantItemId: string): TextItem | undefined {
  const at = items.findIndex((it) => it.id === assistantItemId);
  if (at < 0) return undefined;
  for (let i = at - 1; i >= 0; i--) {
    const it = items[i];
    if (it?.kind === "user") return it;
  }
  return undefined;
}

function checkpointMessageId(item: Item): string {
  return item.id.replace(/-[tuk]\d*$/, "");
}

function canRestoreUser(item: Item, ids?: string[]): boolean {
  if (item.kind !== "user") return false;
  if (item.id.startsWith("local-")) return false;
  const id = checkpointMessageId(item);
  // 事件流换上的正式 id 没有 `-uN` 后缀：切片跟提问一起拍，不必等快照。
  if (item.id === id) return true;
  return !!ids?.includes(id);
}

function restoreConfirmBody(
  p: RestorePreview,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
  bodyKey: MessageKey = "transcript.restore.body",
): string {
  const parts = [t(bodyKey, { files: p.files })];
  if (p.dirty) parts.push(t("transcript.restore.dirty"));
  if (p.afterSlice) parts.push(t("transcript.restore.afterSlice", { count: p.afterSlice }));
  if (p.skipped.length) {
    const names = p.skipped
      .map((s) => `${s.path} (${skipReason(s.reason, t)})`)
      .join(t("transcript.listSep"));
    parts.push(t("transcript.restore.skipped", { files: names }));
  }
  parts.push(t("transcript.restore.bashNote"));
  return parts.join(" ");
}

function skipReason(
  reason: string,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string {
  if (reason === "binary") return t("transcript.restore.skip.binary");
  if (reason === "too_large") return t("transcript.restore.skip.tooLarge");
  if (reason === "unreadable") return t("transcript.restore.skip.unreadable");
  if (reason === "store_failed") return t("transcript.restore.skip.storeFailed");
  return reason;
}

function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3 4.5h10M6.4 4.5V3.3a.8.8 0 0 1 .8-.8h1.6a.8.8 0 0 1 .8.8v1.2M4.4 4.5l.5 8.2a1 1 0 0 0 1 .95h4.2a1 1 0 0 0 1-.95l.5-8.2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6.7 7.2v3.8M9.3 7.2v3.8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function RegenIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3.2 8.2A4.8 4.8 0 0 1 12 5.4l.2-2.1"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12.8 7.8A4.8 4.8 0 0 1 4 10.6l-.2 2.1"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12.2 2.8v2.6H9.6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3.8 13.2V10.6H6.4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * 等待指示。
 *
 * `label` 说明这次等的是什么。同一个动画表示好几件事的话，用户只能按
 * 最常见的那个理解 —— 所以有具体原因时必须写出来。
 *
 * `timed` 让它自己数秒。模型准备工具参数的那十几秒里一个字都不会吐，
 * 静止的三个点和"卡死了"看起来一模一样；走动的秒数是那段时间里唯一
 * 能证明系统还活着的东西。
 */
function Dots({
  label,
  timed,
  since,
}: {
  label?: string;
  timed?: boolean;
  /**
   * 计时起点（epoch ms）。不给就从挂载时刻起数。
   * 切会话会把整棵 Chat 重挂载，挂载时刻起数的话，切走再切回秒数从 0
   * 重来 —— 等待的起点必须由活得过重挂载的地方（useSession 的模块级
   * 表）给进来。
   */
  since?: number | null;
}) {
  const mountedAt = useRef(Date.now());
  const start = since ?? mountedAt.current;
  const [elapsed, setElapsed] = useState(() => Math.round((Date.now() - start) / 1000));

  useEffect(() => {
    if (!timed) return;
    const tick = () => setElapsed(Math.round((Date.now() - start) / 1000));
    // 立即算一次：切回会话时等待往往已经进行了很久，先显示旧值再等
    // 一秒才跳到真实值，看起来像计时器坏了。
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [timed, start]);

  const dots = (
    <div className="dots">
      <span />
      <span />
      <span />
    </div>
  );
  // 头几秒不报时:答得快的时候跳一下数字，看着像出了故障。
  const secs = timed && elapsed >= 3 ? `${elapsed}s` : "";
  if (!label && !secs) return dots;
  return (
    <div className="wait-note" role="status">
      {dots}
      {label ? <span className="wait-note-text">{label}</span> : null}
      {secs ? <span className="wait-note-time">{secs}</span> : null}
    </div>
  );
}

/** 用户消息的正文，太长的先收起（见 lib/turnHeight 的 isLongUserText）。 */
function UserBody({ text, files }: { text: string; files?: string[] }) {
  const { t, tn } = useT();
  const [open, setOpen] = useState(false);
  const lines = useMemo(() => text.split("\n").length, [text]);
  const body = <UserText text={text} {...(files ? { files } : {})} />;
  if (!isLongUserText(text)) return body;
  return (
    <>
      <div className={open ? "user-clamp open" : "user-clamp"}>{body}</div>
      <button
        type="button"
        className="user-clamp-toggle"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {open ? t("transcript.user.collapse") : tn("transcript.user.expand", lines)}
      </button>
    </>
  );
}

/**
 * 用户消息的正文：把 `@路径` 标记画成引用块，其余原样。
 *
 * 用户在输入框里看到的是一行"分别打开 [a] [b]"，气泡里就该是同一行 ——
 * 把块抽出来堆到文字下面，等于把他写的句子拆了。
 */
function UserText({ text, files = [] }: { text: string; files?: string[] }) {
  const lead = SLASH_HEAD_RE.exec(text);
  const cmdName = lead?.[1];
  const body = lead ? text.slice(lead[0].length).replace(/^\s/, "") : text;

  const fileNodes = (src: string): ReactNode => {
    const spans = extractMentionSpans(src);
    if (spans.length === 0 && files.length === 0) return src;
    const out: React.ReactNode[] = [];
    const seen = new Set<string>();
    let last = 0;
    for (const s of spans) {
      if (s.index > last) out.push(src.slice(last, s.index));
      out.push(<FileChip key={`${s.path}-${s.index}`} path={s.path} preview />);
      seen.add(s.path);
      last = s.index + s.length;
    }
    if (last < src.length) out.push(src.slice(last));
    const orphans = files.filter((f) => !mentionCovers(seen, f));
    return (
      <>
        {out}
        {orphans.map((p) => (
          <FileChip key={`orphan-${p}`} path={p} preview />
        ))}
      </>
    );
  };

  // 先把"页面元素"标记切出来画成绿色色块（和输入框里一致），标记之间的
  // 普通文本再交给 fileNodes 处理 `@文件` 引用。两层不会互相吞：元素标记
  // 用【】+反引号，文件用 `@`。
  const bodyNodes = (src: string): ReactNode => {
    const marks = extractElemSpans(src);
    if (marks.length === 0) return fileNodes(src);
    const out: React.ReactNode[] = [];
    let last = 0;
    marks.forEach((e, i) => {
      if (e.index > last) {
        out.push(<Fragment key={`t-${i}`}>{fileNodes(src.slice(last, e.index))}</Fragment>);
      }
      out.push(
        <Chip key={`el-${i}`} seg={{ kind: "elem", value: e.selector, label: e.label }} />,
      );
      last = e.index + e.length;
    });
    if (last < src.length) {
      out.push(<Fragment key="t-end">{fileNodes(src.slice(last))}</Fragment>);
    }
    return <>{out}</>;
  };

  if (!cmdName) {
    return <>{bodyNodes(body)}</>;
  }

  return (
    <>
      <Chip seg={{ kind: "cmd", value: cmdName }} />
      {body || files.length > 0 ? <> {bodyNodes(body)}</> : null}
    </>
  );
}

/** 用户消息里附的图。点击全屏放大 —— 附完图想核对细节是常事。 */
function UserImage({ src }: { src: string }) {
  const { t } = useT();
  const [viewer, setViewer] = useState(false);
  return (
    <>
      <button
        type="button"
        className="msg-image-btn"
        onClick={() => setViewer(true)}
        aria-label={t("transcript.image.zoom")}
      >
        <img src={src} alt="" />
      </button>
      {viewer ? (
        <ShotViewer src={src} alt={t("transcript.image.attached")} onClose={() => setViewer(false)} />
      ) : null}
    </>
  );
}
