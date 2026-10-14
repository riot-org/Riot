import { afterEach, describe, expect, it, vi } from "vitest";

import { drafts } from "./state";

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe("drafts", () => {
  it("persists to localStorage after a short debounce and reads it back", () => {
    vi.useFakeTimers();
    drafts.set("s1", [{ kind: "text", value: "写了一半" }]);
    expect(localStorage.getItem("riot.draft:s1")).toBeNull();
    vi.advanceTimersByTime(500);
    expect(JSON.parse(localStorage.getItem("riot.draft:s1") ?? "null")).toEqual([
      { kind: "text", value: "写了一半" },
    ]);
    // 模拟重启：内存里没有了，从本地存储读回来。
    Map.prototype.delete.call(drafts, "s1");
    expect(drafts.get("s1")).toEqual([{ kind: "text", value: "写了一半" }]);
  });

  it("removes the stored copy when the draft is cleared", () => {
    vi.useFakeTimers();
    drafts.set("s2", [{ kind: "text", value: "x" }]);
    drafts.flush();
    expect(localStorage.getItem("riot.draft:s2")).not.toBeNull();
    drafts.delete("s2");
    drafts.flush();
    expect(localStorage.getItem("riot.draft:s2")).toBeNull();
  });
});
