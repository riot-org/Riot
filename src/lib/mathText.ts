/**
 * 回答里公式写法的归一化：渲染前把各家模型的写法都收成 remark-math 认的
 * `$$…$$`（行内）和独占几行的 `$$`（块级）。
 *
 * - `\[ … \]` → 块级（OpenAI、DeepSeek 系常这么写）
 * - `\( … \)` → 行内
 * - `$x$` → 行内，但要过 Pandoc 的那条规则：开头的 `$` 后面不是空白，
 *   结尾的 `$` 前面不是空白、后面不紧跟数字，而且中间不能再出现 `$`。
 *   remark-math 自己的单 `$` 解析是关掉的（见 Markdown.tsx）—— 它照代码
 *   span 的规则配对，「从 $5 涨到 $10」会被吃成一个公式。
 *
 * 代码块和行内代码里的东西一律原样不动：那是代码，不是公式。
 */

export function normalizeMath(text: string): string {
  // 没有可疑字符的绝大多数段落直接放行，流式每帧都要过这一遍。
  if (!text.includes("$") && !text.includes("\\(") && !text.includes("\\[")) return text;
  let out = "";
  let i = 0;
  const n = text.length;
  let lineStart = true;
  while (i < n) {
    // 围栏代码块：行首（最多三个空格缩进）三个以上 ` 或 ~，到同字符、不短于它的一行结束。
    if (lineStart) {
      const m = /^ {0,3}(`{3,}|~{3,})/.exec(text.slice(i, i + 200));
      if (m && m[1]) {
        const fence = m[1];
        const lineEnd = text.indexOf("\n", i);
        let j = lineEnd < 0 ? n : lineEnd + 1;
        const close = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`);
        while (j < n) {
          const e = text.indexOf("\n", j);
          const line = text.slice(j, e < 0 ? n : e);
          j = e < 0 ? n : e + 1;
          if (close.test(line)) break;
        }
        out += text.slice(i, j);
        i = j;
        lineStart = true;
        continue;
      }
    }
    const c = text[i];
    lineStart = false;

    if (c === "\n") {
      out += c;
      i++;
      lineStart = true;
      continue;
    }

    // 反斜杠转义：`\$`、`\\` 原样带过。`\(`、`\[` 在下面单独认。
    if (c === "\\") {
      const next = text[i + 1];
      if (next === "(" || next === "[") {
        const closer = next === "(" ? "\\)" : "\\]";
        const end = text.indexOf(closer, i + 2);
        const body = end < 0 ? "" : text.slice(i + 2, end);
        // 行内的不跨段落（空行）；块级的可以跨行。
        if (end >= 0 && body.trim() && (next === "[" || !/\n\s*\n/.test(body))) {
          out += next === "(" ? `$$${body.trim()}$$` : `\n$$\n${body.trim()}\n$$\n`;
          i = end + 2;
          continue;
        }
      }
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }

    // 行内代码：同样长度的一串反引号收尾，中间原样。
    if (c === "`") {
      let k = i;
      while (text[k] === "`") k++;
      const run = text.slice(i, k);
      const end = findRun(text, run, k);
      if (end < 0) {
        out += run;
        i = k;
        continue;
      }
      out += text.slice(i, end + run.length);
      i = end + run.length;
      continue;
    }

    if (c === "$") {
      // 已经是 `$$…$$`：原样，一直到下一个 `$$`。
      if (text[i + 1] === "$") {
        const end = text.indexOf("$$", i + 2);
        const stop = end < 0 ? n : end + 2;
        out += text.slice(i, stop);
        i = stop;
        continue;
      }
      const close = singleDollarClose(text, i);
      if (close > 0) {
        out += `$$${text.slice(i + 1, close)}$$`;
        i = close + 1;
        continue;
      }
    }

    out += c;
    i++;
  }
  return out;
}

/** 从 `from` 起找恰好等于 `run` 的一串反引号（前后都不是反引号）。 */
function findRun(text: string, run: string, from: number): number {
  let j = text.indexOf(run, from);
  while (j >= 0) {
    if (text[j - 1] !== "`" && text[j + run.length] !== "`") return j;
    j = text.indexOf(run, j + run.length);
  }
  return -1;
}

/**
 * 单 `$` 的公式在哪里收尾（Pandoc 规则），不成立返回 -1。
 * 只看同一行里的下一个 `$`：它不合格，这个开头就不算 —— 不往后接着找，
 * 不然「$5 和 $x$」会配成一个从 5 到 x 的公式。
 */
function singleDollarClose(text: string, open: number): number {
  const first = text[open + 1];
  if (first === undefined || /\s/.test(first)) return -1;
  let j = open + 1;
  while (j < text.length && text[j] !== "\n") {
    if (text[j] === "\\") {
      j += 2;
      continue;
    }
    if (text[j] === "$") {
      const before = text[j - 1] ?? "";
      const after = text[j + 1] ?? "";
      if (j === open + 1 || /\s/.test(before) || /[0-9$]/.test(after)) return -1;
      return j;
    }
    j++;
  }
  return -1;
}
