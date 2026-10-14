import { describe, expect, it } from "vitest";

import { PACE_FRAME_MS, PACE_MAX_BACKLOG, PACE_MIN_CHARS, PACE_WINDOW_MS, paceTake } from "./pacing";

describe("paceTake", () => {
  it("releases a slice proportional to elapsed time", () => {
    const backlog = "x".repeat(1200);
    expect(paceTake(backlog, PACE_FRAME_MS)).toBe(Math.ceil((1200 * PACE_FRAME_MS) / PACE_WINDOW_MS));
  });

  it("drains everything once a full window has passed (throttled rAF)", () => {
    expect(paceTake("x".repeat(500), 1000)).toBe(500);
  });

  it("never stalls and flushes catch-up backlogs at once", () => {
    expect(paceTake("abcdefgh", 1)).toBe(PACE_MIN_CHARS);
    expect(paceTake("ab", 1)).toBe(2);
    expect(paceTake("x".repeat(PACE_MAX_BACKLOG + 1), 1)).toBe(PACE_MAX_BACKLOG + 1);
  });

  it("does not split a surrogate pair", () => {
    const s = "ab😀cdefghijklmnop";
    // PACE_MIN_CHARS = 3 would end between the two halves of the emoji.
    const k = paceTake(s, 1);
    expect(k).toBe(4);
    expect(s.slice(0, k)).toBe("ab😀");
  });
});
