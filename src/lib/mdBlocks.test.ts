import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";
import { describe, expect, it } from "vitest";

import { splitMarkdownBlocks } from "./mdBlocks";

const html = (md: string) =>
  micromark(md, { extensions: [gfm()], htmlExtensions: [gfmHtml()] })
    .replace(/\n+/g, "\n")
    .trim();

const CASES = [
  "# Title\n\nPara one\nline two\n\n- a\n- b\n\n- c\n\nAfter list\n\n1. x\n\n2. y\n\n   continued\n\nend",
  "Text\n\n```js\nconst a = 1;\n\n\nconst b = 2;\n```\n\nAfter code\n\n~~~\n```\n\nstill code\n~~~\n\nDone",
  "| a | b |\n|---|---|\n| 1 | 2 |\n\nNext para\n\n> quote\n\n> quote2\n\n---\n\nhr above",
  "Para\n\n    indented code\n\n    more\n\nPara2\n\n* item\n\n  item para\n\n* item2",
  "see [x][1]\n\n[1]: http://a.com\n\ntext",
  "中文段落。\n\n## 小标题\n\n- 列表\n  - 嵌套\n\n  续行\n\n结尾",
  "1. step\n   ```bash\n   echo hi\n\n   echo there\n   ```\n\n2. step two\n\nok",
];

describe("splitMarkdownBlocks", () => {
  // 流式渲染按块切开后，拼起来的结果必须和整段解析一模一样 —— 否则
  // 落定那一刻画面会跳。逐个前缀验一遍，等价于把整段"流"一次。
  it.each(CASES)("renders every streaming prefix identically to the whole text (%#)", (md) => {
    for (let n = 1; n <= md.length; n++) {
      const text = md.slice(0, n);
      const parts = splitMarkdownBlocks(text);
      expect(parts.join("\n")).toBe(text);
      const joined = parts.map(html).join("\n").replace(/\n+/g, "\n").trim();
      expect(joined, `prefix ${JSON.stringify(text)}`).toBe(html(text));
    }
  });

  it("splits plain paragraphs but never in front of a list item", () => {
    // 列表项前面不切（可能是松散列表的下一项），宁可尾块大一点。
    expect(splitMarkdownBlocks("a\n\nb\n\n- x\n\n- y")).toEqual(["a\n", "b\n\n- x\n\n- y"]);
    expect(splitMarkdownBlocks("- x\n\nafter")).toEqual(["- x\n", "after"]);
  });

  it("does not split when reference definitions are present", () => {
    expect(splitMarkdownBlocks("[a][1]\n\n[1]: http://x")).toHaveLength(1);
  });
});
