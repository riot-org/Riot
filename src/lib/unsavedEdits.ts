/**
 * 预览编辑器里"改了没存"的文件。CodeView 往里报，工作台标签栏读它画圆点、
 * 关标签前读它决定要不要确认。
 *
 * 放模块级而不是逐层传 props：CodeView 住在 FilePreview 的 PreviewBody 里，
 * 标签栏和关标签的逻辑在 App —— 中间隔着三层组件，而它们只关心一个布尔。
 *
 * 按路径计数而不是记一个集合：同一个文件可能同时开在两个会话的抽屉里
 * （每个会话一套工作台），一边存了不该把另一边的圆点也抹掉。
 */

import { useSyncExternalStore } from "react";

const counts = new Map<string, number>();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/** 某个编辑器实例对这个文件"脏没脏"的状态变了。只在真变化时调。 */
export function markUnsaved(path: string, dirty: boolean) {
  const n = (counts.get(path) ?? 0) + (dirty ? 1 : -1);
  if (n > 0) counts.set(path, n);
  else counts.delete(path);
  emit();
}

export function hasUnsaved(path: string): boolean {
  return counts.has(path);
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** 订阅一个文件的"未保存"状态。 */
export function useUnsaved(path: string | null): boolean {
  return useSyncExternalStore(subscribe, () => (path ? counts.has(path) : false));
}
