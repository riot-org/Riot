import { describe, expect, it } from "vitest";

import { extractSlashSpans, isLongPaste, promptToSegs, type Seg, segsToPrompt } from "./promptText";

describe("isLongPaste", () => {
  it("folds pastes of 20+ lines or 2000+ characters", () => {
    expect(isLongPaste("a\n".repeat(18))).toBe(false);
    expect(isLongPaste("a\n".repeat(19))).toBe(true);
    expect(isLongPaste("x".repeat(1999))).toBe(false);
    expect(isLongPaste("x".repeat(2000))).toBe(true);
  });
});

describe("segsToPrompt", () => {
  it("expands a paste chip back into its full text in place", () => {
    const text = "line 1\nline 2";
    expect(
      segsToPrompt([
        { kind: "text", value: "看下这个报错：\n" },
        { kind: "paste", value: text },
        { kind: "text", value: "\n怎么回事" },
      ]),
    ).toBe(`看下这个报错：\n${text}\n怎么回事`);
  });
});

describe("extractSlashSpans", () => {
  const names = new Set(["add-mcp", "create-plugin"]);

  it("认句中、换行后的已知名字", () => {
    expect(extractSlashSpans("帮我配置好\n/add-mcp", names)).toEqual([
      { name: "add-mcp", index: 6, length: 8 },
    ]);
    expect(extractSlashSpans("用 /create-plugin 创建", names)).toEqual([
      { name: "create-plugin", index: 2, length: 14 },
    ]);
  });

  it("路径、未知名字、贴着别的字都不认", () => {
    expect(extractSlashSpans("去 /tmp 看看", names)).toEqual([]);
    expect(extractSlashSpans("a/add-mcp", names)).toEqual([]);
    expect(extractSlashSpans("/add-mcp/x", names)).toEqual([]);
    expect(extractSlashSpans("/add-mcps", names)).toEqual([]);
  });
});

describe("promptToSegs：文本 → 块只有这一个入口", () => {
  const slashNames = new Set(["add-mcp", "create-plugin"]);

  it("技能句首句中一个规则，只认名单里的", () => {
    expect(promptToSegs("/add-mcp 配一下", { slashNames })).toEqual([
      { kind: "cmd", value: "add-mcp" },
      { kind: "text", value: " 配一下" },
    ]);
    expect(promptToSegs("配置好\n/add-mcp", { slashNames })).toEqual([
      { kind: "text", value: "配置好\n" },
      { kind: "cmd", value: "add-mcp" },
    ]);
    // 不在名单里的句首 `/xxx` 是普通文字（以前气泡会画成块）。
    expect(promptToSegs("/tmp 是什么", { slashNames })).toEqual([
      { kind: "text", value: "/tmp 是什么" },
    ]);
  });

  it("元素标记里的 `/`、`@` 不被后两层吃掉", () => {
    expect(promptToSegs("看【按钮】`a[href='/add-mcp'] @x` 这里", { slashNames })).toEqual([
      { kind: "text", value: "看" },
      { kind: "elem", value: "a[href='/add-mcp'] @x", label: "按钮" },
      { kind: "text", value: " 这里" },
    ]);
  });

  it("正文没留标记的附件补在末尾，skip 里的不补", () => {
    expect(promptToSegs("读 @src/a.rs", { refs: ["/p/src/a.rs", "/p/b.rs", "/p/c.rs"], skip: ["/p/c.rs"] })).toEqual([
      { kind: "text", value: "读 " },
      { kind: "ref", value: "src/a.rs" },
      { kind: "ref", value: "/p/b.rs" },
    ]);
  });

  it("发出去再认回来，块一个不丢、位置不变", () => {
    const cases: Seg[][] = [
      [{ kind: "cmd", value: "create-plugin" }, { kind: "text", value: " 创建" }],
      [{ kind: "text", value: "先" }, { kind: "cmd", value: "add-mcp" }, { kind: "text", value: "再说" }],
      [{ kind: "cmd", value: "add-mcp" }, { kind: "ref", value: "src/a.rs" }],
      [{ kind: "cmd", value: "add-mcp" }, { kind: "cmd", value: "create-plugin" }],
      [{ kind: "elem", value: "#x", label: "按钮" }, { kind: "cmd", value: "add-mcp" }],
    ];
    const chips = (segs: Seg[]) => segs.filter((s) => s.kind !== "text");
    for (const segs of cases) {
      expect(chips(promptToSegs(segsToPrompt(segs), { slashNames }))).toEqual(chips(segs));
    }
  });
});
