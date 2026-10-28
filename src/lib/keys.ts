/**
 * 跨平台的快捷键：macOS 用 ⌘，Windows / Linux 用 Ctrl。
 *
 * `[约束]` 不能只认 `metaKey`。Windows / Linux 上它是 Win / Super 键，
 * 系统先截走，⌘ 系的快捷键在那两个平台上等于不存在。
 *
 * 按**用户的系统**判，不按"是不是桌面窗口"判（不是 chrome.tsx 的 IS_MAC，
 * 那个只管红绿灯让位）：网页版在 Mac 的浏览器里，用户按的照样是 ⌘。
 */

import { PLATFORM } from "./platform";

const IS_MAC_KEYS = PLATFORM === "mac";

/** 这一下按的是本平台的主修饰键（⌘ / Ctrl），而且没混着另一个。 */
export function isModKey(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return IS_MAC_KEYS ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/**
 * 快捷键的显示文字：`shortcut("B")` → macOS「⌘B」、其他「Ctrl+B」；
 * `shortcut("G", { shift: true })` → 「⌘⇧G」/「Ctrl+Shift+G」。
 */
export function shortcut(key: string, opts: { shift?: boolean; mod?: boolean } = {}): string {
  const mod = opts.mod ?? true;
  if (IS_MAC_KEYS) return `${mod ? "⌘" : ""}${opts.shift ? "⇧" : ""}${key}`;
  return [mod ? "Ctrl" : "", opts.shift ? "Shift" : "", key].filter(Boolean).join("+");
}

/**
 * 焦点在终端里：Windows / Linux 上 Ctrl 系的键全是 shell 的（Ctrl+W 删词、
 * Ctrl+P/N 翻历史、Ctrl+B/J…），应用的快捷键一律让给它。macOS 上用的是 ⌘，
 * 和终端的 Ctrl 是两个键，不冲突，照常生效。
 */
export function terminalOwnsKey(target: EventTarget | null): boolean {
  return !IS_MAC_KEYS && target instanceof Element && target.closest(".xterm") !== null;
}

/** 焦点在代码编辑器（CodeMirror）里：查找类的键归编辑器自己。 */
export function editorOwnsKey(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".cm-editor") !== null;
}
