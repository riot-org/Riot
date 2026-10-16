/**
 * Markdown 表格单元格的保底内容宽度（em）：取文字自然宽度的估计值，
 * 封顶 [`CELL_FLOOR_CAP_EM`]。
 *
 * 自动表格布局在容器装不下各列的自然宽度时，按 (max-content −
 * min-content) 的比例分剩余宽度：短列差值小，几乎只拿到自己的
 * min-content —— 中文的 min-content 就是一个字，「国家队（推断）」
 * 就这么被挤成一字一行。给每格一个 min-width 把下限抬起来：
 *
 * - 短格的下限就是它整行的宽度 —— 能一行放下的永远不折；
 * - 长格的下限封顶，剩下的宽度照常按比例分给它，在合理宽度内折行；
 * - 所有列的下限加起来超过容器时表格变宽，由外层横向滚动。
 *
 * 一刀切的固定下限（claude.ai 的做法是每格 `min-width: 6rem`）在
 * 列多时会让长列也只拿到那点宽度 —— 表格横向滚动的同时，备注列
 * 还被压成一条窄缝、行高撑得很高。按内容估就没有这个问题。
 *
 * 估计宁大勿小：估小了，短格最后一个字会被折到第二行；估大了只是
 * 多一点留白。CJK / 全角字符按 1em，其余按 0.62em（等宽数字和多数
 * 拉丁字母的字宽都在这以内）。
 */
export const CELL_FLOOR_CAP_EM = 8;

const WIDE =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꥠ-꥿가-힣豈-﫿︰-﹏＀-｠￠-￦]/;

export function cellFloorEm(text: string, bold = false): number {
  let em = 0;
  for (const ch of text.trim()) {
    em += WIDE.test(ch) ? 1 : ch.length > 1 ? 1.25 : 0.62;
    if (em >= CELL_FLOOR_CAP_EM) return CELL_FLOOR_CAP_EM;
  }
  // 表头是粗体，字面比常规体宽一点。
  if (bold) em *= 1.08;
  return Math.min(Math.ceil(em * 10) / 10, CELL_FLOOR_CAP_EM);
}
