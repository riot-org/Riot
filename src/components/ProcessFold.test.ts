import { afterAll, describe, expect, it } from "vitest";

import { setLocaleChoice } from "../i18n";
import { type FoldItem, foldStat, foldSummary } from "./ProcessFold";

let n = 0;
function tool(name: string, input: Record<string, unknown> = {}, result?: string): FoldItem {
  n++;
  return {
    kind: "tool",
    id: `t${n}`,
    name,
    input,
    status: "ok",
    output: [],
    ...(result === undefined ? {} : { result }),
  };
}
function edit(path: string, oldS: string, newS: string): FoldItem {
  return tool("Edit", { path, old_string: oldS, new_string: newS });
}
function think(durationMs?: number): FoldItem {
  n++;
  return { kind: "thinking", id: `k${n}`, text: "…", ...(durationMs ? { durationMs } : {}) };
}

describe("foldSummary", () => {
  afterAll(() => setLocaleChoice(null));

  it("认不出的工具说成动作，不出现「其他」", () => {
    setLocaleChoice("zh-CN");
    const s = foldSummary([think(), tool("Bash"), tool("Bash"), tool("ToolSearch")]);
    expect(s).toBe("运行 2 条命令，调用工具 1 次");
    expect(s).not.toContain("其他");
  });

  it("MCP、浏览器都并进「调用工具」，不点名；待办不占地方", () => {
    setLocaleChoice("zh-CN");
    const s = foldSummary([
      tool("Read", { path: "/a/data-formats.md" }),
      tool("mcp__fuyao-a-share__quote"),
      tool("TodoWrite"),
      tool("mcp__fuyao-a-share-index__list"),
      tool("BrowserNavigate"),
    ]);
    expect(s).toBe("读取 1 个文件，调用工具 3 次");
  });

  it("按每类第一次出现的先后排", () => {
    setLocaleChoice("zh-CN");
    expect(foldSummary([tool("mcp__x__y"), tool("Bash"), tool("mcp__x__z")])).toBe(
      "调用工具 2 次，运行 1 条命令",
    );
  });

  it("只更新了待办时才提待办", () => {
    setLocaleChoice("zh-CN");
    expect(foldSummary([think(), tool("TodoWrite")])).toBe("更新待办");
  });

  it("英文照 Claude：小写短语拼接、句首大写、单数用冠词", () => {
    setLocaleChoice("en-US");
    expect(foldSummary([tool("Bash"), tool("Bash"), tool("ToolSearch")])).toBe(
      "Ran 2 commands, used a tool",
    );
  });

  it("编辑按文件数，新建和修改分开（照 Claude）", () => {
    setLocaleChoice("en-US");
    const s = foldSummary([
      tool("Bash"),
      edit("/p/make_dance2.py", "a", "b"),
      edit("/p/make_dance2.py", "c", "d"),
      edit("/p/music.cjs", "e", "f"),
      tool("Read", { path: "/p/a.md" }),
      tool("Read", { path: "/p/b.md" }),
    ]);
    expect(s).toBe("Ran a command, edited 2 files, read 2 files");

    setLocaleChoice("zh-CN");
    expect(
      foldSummary([
        tool("Write", { path: "/p/new.md", content: "x" }, "已创建 /p/new.md（1 行）。"),
        tool("Write", { path: "/p/old.md", content: "x" }, "已覆盖 /p/old.md（1 行）。"),
      ]),
    ).toBe("创建 1 个文件，编辑 1 个文件");
  });

  it("组头的增删行数是各条编辑相加，失败的不算", () => {
    const failed = { ...edit("/p/x", "1\n2", "3"), status: "error" as const };
    expect(
      foldStat([
        edit("/p/x", "a", "b"),
        edit("/p/x", "a\nb", "c\nd\ne"),
        tool("Write", { path: "/p/y", content: "1\n2\n" }),
        failed,
        tool("Bash"),
      ]),
    ).toEqual({ added: 6, removed: 3 });
    expect(foldStat([tool("Bash")])).toBeNull();
  });

  it("只有思考时落到思考时长", () => {
    setLocaleChoice("zh-CN");
    expect(foldSummary([think(3000), think(2000)])).toBe("思考过程 · 5 秒");
  });
});
