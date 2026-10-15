import { describe, expect, it } from "vitest";

import { handleChipKey } from "./chipEditor";

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
