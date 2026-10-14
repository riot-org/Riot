import { describe, expect, it, vi } from "vitest";

import { createLiveTextStore } from "./liveText";

describe("createLiveTextStore", () => {
  it("notifies subscribers only when a field actually changes", () => {
    const store = createLiveTextStore({ text: "", thinking: "" });
    const fn = vi.fn();
    const off = store.subscribe(fn);
    store.set({ text: "a", thinking: "" });
    store.set({ text: "a", thinking: "" });
    expect(fn).toHaveBeenCalledTimes(1);
    store.set({ text: "a", thinking: "b" });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(store.get()).toEqual({ text: "a", thinking: "b" });
    off();
    store.set({ text: "ab", thinking: "b" });
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
