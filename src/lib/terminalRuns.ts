/**
 * 回答里的命令「一键运行」在界面上的两头：
 *
 * - **发起**：代码块（Markdown.tsx 的 CodeBlock）点运行 / 停止 / 查看终端。
 *   接收方是 App（弹出终端面板）和 TerminalPanel（挑标签、把命令写进
 *   shell、盯着它跑完）。和 agentTerminals 一样是模块级的发布订阅：
 *   代码块在 memo 过的 Markdown 深处，一路传回调不现实。
 * - **状态**：TerminalPanel 写，代码块读（运行中、退出码、输出尾巴）。
 *
 * 状态按「会话 + 命令文本」记，不按代码块实例记：对话区是懒水合、会
 * 卸载重挂的，按实例记的话滚出去再滚回来状态就没了；同一会话里两处
 * 一模一样的命令显示同一份结果，本来也说得通。只存在内存里，不写进
 * 对话记录 —— 这是「这台机器刚刚发生的事」，不是对话内容。
 */

import { useSyncExternalStore } from "react";

export interface CommandRun {
  command: string;
  /**
   * starting：在等 shell 就绪（新开的标签还没出提示符）；
   * running：命令已经写进去了；done：跑完了。
   */
  phase: "starting" | "running" | "done";
  /** 退出码。null = 不知道（shell 没装上集成，只能看出跑完了没有）。 */
  exitCode: number | null;
  startedAt: number;
  endedAt?: number;
  /** 这条命令自己的输出（不含命令回显和下一个提示符）。跑完才有。 */
  output?: string;
  /** 跑在哪个终端标签（标题给代码块显示，uid 给「查看终端」切过去）。 */
  tabUid?: string;
  tabTitle?: string;
}

export type RunRequest =
  /** `execute: false`：只填进终端不回车（命令里有占位符要先改）。 */
  | { kind: "run"; command: string; root: string | null; execute: boolean }
  | { kind: "stop"; command: string }
  | { kind: "focus"; command: string };

const runs = new Map<string, CommandRun>();
let session: string | null = null;
const subs = new Set<() => void>();
const requestSubs = new Set<(r: RunRequest) => void>();
const shareSubs = new Set<(text: string) => void>();

const keyOf = (sid: string | null, command: string) => `${sid ?? ""}\u0000${command}`;

function notify() {
  for (const f of subs) f();
}

/** TerminalPanel 推：当前会话。代码块据此只看本会话的运行结果。 */
export function setRunSession(sid: string | null): void {
  if (sid === session) return;
  session = sid;
  notify();
}

/** TerminalPanel 写状态。`sid` 是发起时的会话，跑的途中切走了也记在原处。 */
export function putRun(sid: string | null, run: CommandRun): void {
  runs.set(keyOf(sid, run.command), run);
  notify();
}

export function patchRun(sid: string | null, command: string, patch: Partial<CommandRun>): void {
  const k = keyOf(sid, command);
  const cur = runs.get(k);
  if (!cur) return;
  runs.set(k, { ...cur, ...patch });
  notify();
}

export function getRun(sid: string | null, command: string): CommandRun | undefined {
  return runs.get(keyOf(sid, command));
}

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

/** 代码块读：这条命令在当前会话里最近一次运行的状态。 */
export function useCommandRun(command: string): CommandRun | undefined {
  const get = () => (command ? runs.get(keyOf(session, command)) : undefined);
  return useSyncExternalStore(subscribe, get, get);
}

/** 代码块发：运行 / 停止 / 查看终端。 */
export function requestRun(r: RunRequest): void {
  for (const f of requestSubs) f(r);
}

/** App（开面板）和 TerminalPanel（干活）各订一份。返回退订函数。 */
export function subscribeRunRequests(cb: (r: RunRequest) => void): () => void {
  requestSubs.add(cb);
  return () => requestSubs.delete(cb);
}

/** 「发给 agent」：一段整理好的文字塞进输入框（不直接发送）。 */
export function shareRunOutput(text: string): void {
  for (const f of shareSubs) f(text);
}

export function subscribeRunShare(cb: (text: string) => void): () => void {
  shareSubs.add(cb);
  return () => shareSubs.delete(cb);
}
