import { describe, expect, it } from "vitest";

import { guardChipDeletes, handleChipKey, readEditor, writeEditor } from "./chipEditor";

const key = (k: string) => ({ key: k, altKey: false, metaKey: false, ctrlKey: false });

function caretAt(node: Node, offset: number) {
  const r = document.createRange();
  r.setStart(node, offset);
  r.collapse(true);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(r);
}

describe("handleChipKey 顶墙判断", () => {
  it("原生回车包出来的 <div> 行首退格不被吞（交回浏览器删换行）", () => {
    const root = document.createElement("div");
    root.innerHTML = "分析下今天大盘<div>的分时走势</div>";
    document.body.append(root);
    caretAt(root.querySelector("div")!.firstChild!, 0);
    expect(handleChipKey(key("Backspace"), root)).toBe(false);
    root.remove();
  });

  it("编辑区真正的最前面仍然吃掉退格", () => {
    const root = document.createElement("div");
    root.innerHTML = "<div>abc</div>";
    document.body.append(root);
    caretAt(root.querySelector("div")!.firstChild!, 0);
    expect(handleChipKey(key("Backspace"), root)).toBe(true);
    root.remove();
  });

  it("行尾 Delete 不被当成顶墙", () => {
    const root = document.createElement("div");
    root.innerHTML = "<div>abc</div><div>def</div>";
    document.body.append(root);
    caretAt(root.querySelector("div")!.firstChild!, 3);
    expect(handleChipKey(key("Delete"), root)).toBe(false);
    root.remove();
  });
});

describe("guardChipDeletes 选区删除", () => {
  it("全选后退格连块带字整段删掉", () => {
    const root = document.createElement("div");
    root.contentEditable = "true";
    document.body.append(root);
    writeEditor(root, [
      { kind: "cmd", value: "create-plugin" },
      { kind: "text", value: " 创建" },
    ]);
    const r = document.createRange();
    r.selectNodeContents(root);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
    let changed = 0;
    const off = guardChipDeletes(root, () => false, () => changed++);
    const e = new InputEvent("beforeinput", {
      inputType: "deleteContentBackward",
      cancelable: true,
    });
    // jsdom 不给目标区间；WebKit 给的就是整个选区。
    Object.defineProperty(e, "getTargetRanges", { value: () => [r.cloneRange()] });
    root.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(readEditor(root)).toEqual([]);
    expect(changed).toBe(1);
    off();
    root.remove();
  });
});
