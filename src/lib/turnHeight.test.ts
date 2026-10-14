import { describe, expect, it } from "vitest";

import type { Block } from "../components/ProcessFold";
import { estimateTurnHeight, isLongUserText, markdownHeight, wrappedLines } from "./turnHeight";

describe("wrappedLines", () => {
  it("counts each source line at least once", () => {
    expect(wrappedLines("a\nb\n\nc", 700)).toBe(4);
  });

  it("wraps CJK at roughly one character per font width", () => {
    // 700px / 14px = 50 个汉字一行。
    expect(wrappedLines("字".repeat(100), 700)).toBe(2);
    expect(wrappedLines("字".repeat(101), 700)).toBe(3);
  });

  it("treats Latin as narrower than CJK", () => {
    // 一行约 50 / 0.55 ≈ 90 个拉丁字符。
    expect(wrappedLines("a".repeat(90), 700)).toBe(1);
    expect(wrappedLines("a".repeat(90), 700)).toBeLessThan(wrappedLines("字".repeat(90), 700));
  });
});

describe("markdownHeight", () => {
  it("counts code block lines without wrapping", () => {
    const code = "```ts\n" + "x".repeat(500) + "\ny\n```";
    expect(markdownHeight(code, 700)).toBeCloseTo((2 * 20 + 40 - 15) * 0.92);
  });

  it("reserves room for embedded media", () => {
    expect(markdownHeight("![clip](a.webm)", 700)).toBeGreaterThan(200);
    expect(markdownHeight("[a](x.wav)", 700)).toBeGreaterThan(markdownHeight("[a](x.txt)", 700));
  });

  it("grows with paragraph count", () => {
    expect(markdownHeight("one\n\ntwo\n\nthree", 700)).toBeGreaterThan(markdownHeight("one", 700) * 2);
  });
});

describe("estimateTurnHeight", () => {
  it("scales with the length of the answer", () => {
    const turn = (text: string): Block[] => [
      { kind: "row", item: { kind: "user", id: "u", text: "hi" } },
      { kind: "row", item: { kind: "assistant", id: "a", text } },
    ];
    const short = estimateTurnHeight(turn("ok"), 700);
    const long = estimateTurnHeight(turn("字".repeat(5000)), 700);
    expect(short).toBeLessThan(150);
    expect(long).toBeGreaterThan(2000);
  });

  it("gives a collapsed fold one summary line", () => {
    const b: Block[] = [{ kind: "fold", id: "f", items: [], live: false }];
    expect(estimateTurnHeight(b, 700)).toBe(26);
  });
});

describe("isLongUserText", () => {
  it("collapses bubbles past the clamp in lines or characters", () => {
    expect(isLongUserText("a\n".repeat(10))).toBe(false);
    expect(isLongUserText("a\n".repeat(20))).toBe(true);
    expect(isLongUserText("字".repeat(2000))).toBe(true);
  });
});
