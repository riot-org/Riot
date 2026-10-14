import { describe, expect, it } from "vitest";

import { isLongPaste, segsToPrompt } from "./promptText";

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
