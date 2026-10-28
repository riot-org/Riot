import { describe, expect, it } from "vitest";

import { editorOwnsKey, isModKey, shortcut, terminalOwnsKey } from "./keys";

// jsdom 的 UA 不是 Mac：这里测的就是 Windows / Linux 那条路。
describe("快捷键（非 Mac）", () => {
  it("主修饰键是 Ctrl，Win 键不算", () => {
    expect(navigator.userAgent).not.toMatch(/Mac/);
    expect(isModKey({ ctrlKey: true, metaKey: false })).toBe(true);
    expect(isModKey({ ctrlKey: false, metaKey: true })).toBe(false);
    expect(isModKey({ ctrlKey: true, metaKey: true })).toBe(false);
  });

  it("提示文字按 Ctrl+ 写", () => {
    expect(shortcut("B")).toBe("Ctrl+B");
    expect(shortcut("G", { shift: true })).toBe("Ctrl+Shift+G");
    expect(shortcut("Enter", { shift: true, mod: false })).toBe("Shift+Enter");
  });

  it("焦点在终端里时快捷键让给终端", () => {
    const term = document.createElement("div");
    term.className = "xterm";
    const input = document.createElement("textarea");
    term.appendChild(input);
    document.body.appendChild(term);
    expect(terminalOwnsKey(input)).toBe(true);
    expect(terminalOwnsKey(document.body)).toBe(false);
    term.remove();
  });

  it("焦点在代码编辑器里时查找归编辑器", () => {
    const ed = document.createElement("div");
    ed.className = "cm-editor";
    const content = document.createElement("div");
    ed.appendChild(content);
    expect(editorOwnsKey(content)).toBe(true);
    expect(editorOwnsKey(null)).toBe(false);
  });
});
