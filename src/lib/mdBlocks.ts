/**
 * 正在流的 Markdown 按顶层块切开，只让最后一块随每帧重新 parse。
 *
 * 整段重 parse 的代价随正文长度线性涨，乘上每帧一次就是平方 —— 一段
 * 几千字、带几个代码块的回答流到后半程，每帧要把前面所有块重新走一遍
 * remark + highlight.js，打字机效果肉眼可见地一顿一顿。切开之后，前面
 * 已经说完的块文字不再变，memo 挡住；每帧只 parse 尾巴那一块。
 *
 * `[约束]` 切分必须**不改变渲染结果**：流完之后这条消息会换成整段 parse
 * 的历史行，两边画得不一样就是落定那一刻跳一下。所以这里只在空行之后、
 * 下一行明确开启一个新的顶层块时才切，拿不准一律不切（多 parse 一点，
 * 不会画错）：
 *
 * - 围栏代码块内部不切（代码里的空行不是块边界）；
 * - 下一行以空白开头不切：可能是列表项的续行、也可能是缩进代码块；
 * - 下一行像列表标记不切：`- a⏎⏎- b` 是**一个**松散列表，切开就成了
 *   两个紧凑列表，间距不一样；
 * - 正文里有链接引用定义 / 脚注定义 / 跨空行的原始 HTML 时整段不切 ——
 *   它们的作用范围跨块，切开就解析不到。
 */

/** 作用范围跨空行的东西：出现就整段不切。 */
const UNSPLITTABLE = /^ {0,3}\[[^\]\n]+\]:|<(?:!--|pre\b|script\b|style\b|textarea\b)/im;

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
/**
 * 像列表项开头的行，含还没打完的（`-`、`12`、`3.`）。宁可多认：认错
 * 只是少切一刀；认漏了，列表在流到一半时会先被切开、再并回去，那几项
 * 重挂载一次、淡入重播。
 */
const LIST_START = /^(?:[-*+]|\d{1,9}[.)]?)(?:\s|$)/;

/** 空行之后的这一行能不能开一个独立的新块。 */
function startsFreshBlock(line: string): boolean {
  if (/^\s/.test(line)) return false;
  return !LIST_START.test(line);
}

export function splitMarkdownBlocks(text: string): string[] {
  if (!text.includes("\n\n") || UNSPLITTABLE.test(text)) return [text];
  const lines = text.split("\n");
  const blocks: string[] = [];
  let cur: string[] = [];
  let fence: { ch: string; len: number } | null = null;
  let afterBlank = false;
  for (const line of lines) {
    if (fence) {
      cur.push(line);
      const m = FENCE_CLOSE.exec(line);
      const mark = m?.[1];
      if (mark && mark[0] === fence.ch && mark.length >= fence.len) fence = null;
      continue;
    }
    const blank = line.trim() === "";
    if (!blank && afterBlank && cur.length > 0 && startsFreshBlock(line)) {
      blocks.push(cur.join("\n"));
      cur = [];
    }
    cur.push(line);
    afterBlank = blank;
    const open = FENCE_OPEN.exec(line)?.[1];
    if (open) fence = { ch: open[0] ?? "`", len: open.length };
  }
  blocks.push(cur.join("\n"));
  return blocks;
}
