import { looksAbsPath } from "../pathDisplay";

/**
 * 相对路径链接在同一段文字里找它的绝对路径。
 *
 * 模型把文件写到工作目录**之外**（`~/Documents/报告.html`）时，常常
 * 链接只写文件名、绝对路径另外用行内代码贴在旁边：
 *
 *     [打开 报告.html](报告.html)（`/Users/me/Documents/报告.html`）
 *
 * 相对路径按工作目录拼出来的文件并不存在，点开就是"读不到文件"。
 * 同一段里明明白白写着 `…/报告.html` 的绝对路径，就用它。
 *
 * 只认以 `/相对路径` 结尾、且前面是绝对路径的片段；同段里出现两个
 * 不同的候选就不猜，原样按工作目录拼。
 */
export function findAbsPathFor(rel: string, texts: readonly string[]): string | null {
  const needle = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!needle || looksAbsPath(needle) || needle.startsWith("../")) return null;
  let found: string | null = null;
  for (const text of texts) {
    for (const token of text.split(PATH_STOP)) {
      const unified = token.replace(/\\/g, "/");
      if (!unified.endsWith(`/${needle}`) || !looksAbsPath(token)) continue;
      if (found !== null && found !== token) return null;
      found = token;
    }
  }
  return found;
}

/** 路径片段的边界：空白、引号、括号（含全角）、中文标点。 */
const PATH_STOP = /[\s`"'<>()（）「」『』，。；：！？、]+/;
