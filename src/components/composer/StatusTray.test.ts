import { describe, expect, it } from "vitest";

import { arrivalOrder } from "./StatusTray";

describe("arrivalOrder", () => {
  it("后出现的接在尾部，已有的不挪位置", () => {
    expect(arrivalOrder(["changes"], ["todo", "changes"])).toEqual(["changes", "todo"]);
  });

  it("消失的拿掉，再出现时排到最后", () => {
    const gone = arrivalOrder(["todo", "tasks"], ["tasks"]);
    expect(gone).toEqual(["tasks"]);
    expect(arrivalOrder(gone, ["todo", "tasks"])).toEqual(["tasks", "todo"]);
  });

  it("同时出现的按传进来的顺序", () => {
    expect(arrivalOrder([], ["todo", "tasks"])).toEqual(["todo", "tasks"]);
  });

  it("没变时返回同一个数组", () => {
    const prev = ["tasks", "todo"];
    expect(arrivalOrder(prev, ["todo", "tasks"])).toBe(prev);
  });
});
