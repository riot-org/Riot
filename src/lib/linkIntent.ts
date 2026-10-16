/**
 * 链接意图：模型在 Markdown 链接的目标前加一个前缀，说清楚点了以后
 * 该做什么。
 *
 *     [打开报告](browser:/Users/me/Documents/报告.html)  → 内置浏览器打开
 *     [报告所在位置](reveal:/Users/me/Documents/报告.html) → 在文件夹中显示
 *
 * 同一个 `.html`，有时要看渲染效果，有时是要找到它拷走 —— 只有写链接
 * 的模型知道当时的上下文，扩展名看不出来。不带前缀的链接照旧按类型
 * 走默认分流（见 FilePreview 的 openFilePreview）。
 */
export type LinkIntent = "browser" | "reveal";

const INTENT = /^(browser|reveal):(?!\/\/)/i;

/** 拆出意图前缀。`browser://…` 这种双斜杠写法不算（那更像一个真协议）。 */
export function splitLinkIntent(raw: string): { intent: LinkIntent; rest: string } | null {
  const m = INTENT.exec(raw);
  if (!m?.[1]) return null;
  const rest = raw.slice(m[0].length).trim();
  return rest ? { intent: m[1].toLowerCase() as LinkIntent, rest } : null;
}

/**
 * 本地文件里，哪些允许用 `browser:` 开进内置浏览器。
 *
 * `[约束]` 只放网页本来就会打开的格式。内置浏览器是和模型共用的 ——
 * 用户点一下把 `~/.ssh/id_rsa` 开进去，模型的浏览器工具下一步就能
 * 截图读走；被注入的模型写一条这样的链接，就是一次借用户之手的越权
 * 读取。名单外的照默认分流走（预览有自己的围栏）。
 */
const BROWSER_FILE_EXTS = new Set(["html", "htm", "xhtml", "svg", "pdf"]);

export function browserOpenableFile(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 && BROWSER_FILE_EXTS.has(name.slice(dot + 1).toLowerCase());
}

/** 本地绝对路径 → 内置浏览器能导航的 file:// 地址（中文、空格逐段编码）。 */
export function fileUrlOf(absPath: string): string {
  const unified = absPath.replace(/\\/g, "/");
  const encoded = unified.split("/").map(encodeURIComponent).join("/");
  return /^[A-Za-z]%3A/.test(encoded)
    ? `file:///${encoded.replace("%3A", ":")}`
    : `file://${encoded}`;
}

/* ── 打开内置浏览器的通道 ─────────────────────
 * 浏览器面板的状态在 App 里（见 useBrowserPanel），Markdown 链接够不着；
 * 和 FilePreview 的 subscribeFilePreview 同一个做法：App 挂一个接收者。 */

let listener: ((url: string) => void) | null = null;

export function subscribePanelBrowser(cb: (url: string) => void): () => void {
  listener = cb;
  return () => {
    if (listener === cb) listener = null;
  };
}

/** 在内置浏览器里打开 `url`（切页还是新开见 [`planPanelOpen`]）。没有接收者（还没挂上）就返回 false。 */
export function openInPanelBrowser(url: string): boolean {
  if (!listener) return false;
  listener(url);
  return true;
}

/** 内置浏览器里，这一下该怎么开。见 [`planPanelOpen`]。 */
export type PanelOpenPlan =
  | { kind: "select"; tab: number; reload: boolean }
  | { kind: "navigate" }
  | { kind: "newTab" };

/**
 * `browser:` 链接点下去，内置浏览器该切页、用当前页还是新开一页。
 *
 * - 同一个地址已经开着 → 切过去，不重复开页（点几次开几页，标签栏很快
 *   就是一排同名页）。本地文件顺手刷新：模型常常刚改过这份报告，切过去
 *   看到的是旧版本反而误导；网页不刷，刷了会丢用户在页上的操作。
 * - 一页都没有、或激活页是空白新标签 → 就在它上面导航。
 * - 否则新开一页，不顶掉模型或用户正在看的页。
 */
export function planPanelOpen(
  state: { tabs: readonly { id: number; url: string }[]; active: number },
  url: string,
): PanelOpenPlan {
  const want = comparableUrl(url);
  const same =
    state.tabs.find((t) => t.id === state.active && comparableUrl(t.url) === want) ??
    state.tabs.find((t) => comparableUrl(t.url) === want);
  if (same) return { kind: "select", tab: same.id, reload: /^file:/i.test(url) };
  const cur = state.tabs.find((t) => t.id === state.active);
  if (state.tabs.length === 0 || cur?.url === "") return { kind: "navigate" };
  return { kind: "newTab" };
}

/** 宿主报回来的地址是编码过的（`%E5%AF%BC…`），链接里的可能没编码。两边都解开再比。 */
function comparableUrl(url: string): string {
  let u = url.trim();
  try {
    u = decodeURI(u);
  } catch {
    // 孤立的 `%`：按原样比。
  }
  return u.replace(/\/+$/, "");
}
