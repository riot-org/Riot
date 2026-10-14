import type { Block } from "../components/ProcessFold";

/**
 * 一轮对话没渲染过时的占位高度（px），给 `.turn` 的 contain-intrinsic-size。
 *
 * 离屏的轮跳过排版（content-visibility: auto），渲染过一次后浏览器记住真实
 * 高度（`auto` 关键字），之前一直按占位算。占位全给同一个数（早先 240px）
 * 的话，往上翻到从没渲染过的历史，一轮几千字的回答从 240 变成 2000，滚动条
 * 一路抖、对话流靠锚点补偿一路挪。Claude 桌面版同理按内容估：按块类型给
 * 不同的估值、虚拟列表按文字长度乘字号估行高。这里按文字量和列宽估行数，
 * 不求准，只求和真实高度在一个量级。
 *
 * 常数对着真实渲染校过（14px 字、正文 1.7 行高、列宽 712）：一段带标题、
 * 列表、代码、表格的长回答，估值和解析完的真实高度差在 5% 以内；整个
 * 测试会话的总误差是统一 240px 时的七分之一。
 */

/**
 * 用户气泡收起时露出的行数。超过它（或字数太多）的气泡先收起，只露头几行
 * —— 粘贴进来的日志、整个文件一铺就是几屏（见 Transcript 的 UserBody）。
 */
export const USER_CLAMP_LINES = 12;

export function isLongUserText(text: string): boolean {
  return text.length > 1600 || text.split("\n").length > USER_CLAMP_LINES + 2;
}

/** 正文一行的高度：14px × 1.7。 */
const LINE = 23.8;
/** 代码一行的高度。 */
const CODE_LINE = 20;
/** 块之间（`.turn` / `.thread-col` 的 gap）。 */
const GAP = 14;

/** 一段文字在给定宽度下折成几行。CJK / 全角按一个字宽，其余按半个多。 */
export function wrappedLines(text: string, widthPx: number, fontPx = 14): number {
  const perLine = Math.max(1, widthPx / fontPx);
  let lines = 0;
  for (const line of text.split("\n")) {
    let units = 0;
    for (const ch of line) {
      const c = ch.codePointAt(0) ?? 0;
      units += c >= 0x1100 && (c <= 0x115f || c >= 0x2e80) ? 1 : 0.55;
    }
    lines += Math.max(1, Math.ceil(units / perLine));
  }
  return lines;
}

/** 正文里嵌的图片 / 视频（`![](...)`）：按一个中等高度的播放器 / 图片算。 */
const EMBED = /!\[[^\]]*\]\([^)]+\)/g;
/** 链到音频文件的链接渲染成一条播放条。 */
const AUDIO_LINK = /\]\([^)]+\.(?:wav|mp3|m4a|ogg|oga|flac|aac|opus)\)/gi;

/** 一段 markdown 渲染后的大致高度。 */
export function markdownHeight(text: string, widthPx: number): number {
  let h = 0;
  const parts = text.split(/^```.*$/m);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      // 代码块：每行一行（不折行，横向滚动），加上下内边距和外边距。
      h += part.replace(/^\n|\n$/g, "").split("\n").length * CODE_LINE + 40;
      return;
    }
    for (const para of part.split(/\n{2,}/)) {
      const p = para.trim();
      if (!p) continue;
      if (/^\|.*\|$/m.test(p) && p.includes("---")) {
        // 表格：一行一行，表头分隔行不占高。
        h += (p.split("\n").length - 1) * 34 + 16;
        continue;
      }
      // 段落 / 列表 / 标题：行数 × 行高 + 段间距。
      h += wrappedLines(p, widthPx - (/^\s*([-*+]|\d+\.)\s/.test(p) ? 24 : 0)) * LINE + 15;
    }
  });
  // 段间距按每段都算了一份，相邻外边距实际会折叠，整体收一点。
  h = (h - 15) * 0.92;
  h += (text.match(EMBED)?.length ?? 0) * 200 + (text.match(AUDIO_LINK)?.length ?? 0) * 44;
  return Math.max(LINE, h);
}

function blockHeight(b: Block, widthPx: number): number {
  if (b.kind === "fold") return 26;
  const it = b.item;
  switch (it.kind) {
    case "user": {
      // 气泡：最宽 85%，左右内边距 14，上下 9；底下一行时间 / 操作。
      // 图片一张一行缩略图。
      // 太长的收起着：露 USER_CLAMP_LINES 行 + 一行「展开全部」。
      const lines = it.text ? wrappedLines(it.text, widthPx * 0.85 - 28) : 0;
      const shown = isLongUserText(it.text) ? Math.min(lines, USER_CLAMP_LINES) : lines;
      const text = it.text ? shown * 23.1 + 18 + (isLongUserText(it.text) ? 26 : 0) : 0;
      return text + 28 + (it.images?.length ? 88 : 0);
    }
    case "assistant":
      // 正文 + 底下一行操作栏（时间、复制……）。
      return markdownHeight(it.text, widthPx) + 28;
    case "tool":
      // 卡片默认收着，只剩摘要行。
      return 24;
    case "thinking":
      return 23;
    case "compact":
      return 32;
    default:
      return wrappedLines(it.text, widthPx) * LINE;
  }
}

/** 一轮的占位高度。 */
export function estimateTurnHeight(blocks: Block[], widthPx: number): number {
  let h = 0;
  for (const b of blocks) h += blockHeight(b, widthPx);
  return Math.round(h + GAP * Math.max(0, blocks.length - 1));
}
