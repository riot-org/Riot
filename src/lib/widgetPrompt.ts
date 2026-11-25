/**
 * 回答里的组件（components/Widget.tsx）点了按钮、要替用户发一句话。
 *
 * 组件在 memo 过的 Markdown 深处，发消息的函数在 Chat 里 —— 和
 * terminalRuns 一样走模块级的发布订阅。只有正显示着的那个会话订阅
 * （Chat 的 visible），保活在后台的会话不接。
 */

const subs = new Set<(text: string) => void>();

export function emitWidgetPrompt(text: string): void {
  if (!text) return;
  for (const f of subs) f(text);
}

export function subscribeWidgetPrompt(cb: (text: string) => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}
