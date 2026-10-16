/**
 * 模型起的终端（Bash `background: true` 的服务）在界面上的两件事：
 *
 * - **谁在跑**：顶栏终端按钮的计数、工具卡片上"查看终端"按钮都要知道。
 *   真相在 TerminalPanel 的标签表里，它每次变化就推一份到这里。
 * - **打开它**：点计数或卡片 → 弹出终端面板并切到那个标签。调用点在
 *   memo 过的卡片里，接收方是 App（开面板）和 TerminalPanel（选标签），
 *   和 subagentLink 的 openSubagent 同一个形状。
 *
 * 为什么要这一层：模型起终端时不再自动弹面板（大部分时候用户不关心
 * 服务日志，弹出来是打断），所以得有个不打扰、但点得到的入口。
 */

import { useSyncExternalStore } from "react";

export interface AgentTerminal {
  /** 宿主侧终端 id（工具结果里"终端 N"的那个 N）。 */
  hostId: number;
  /** 归属的会话。顶栏只数当前会话的。 */
  sessionId: string | null;
}

let running: AgentTerminal[] = [];
const subs = new Set<() => void>();

/** TerminalPanel 推：此刻还在跑的模型终端。内容没变就不通知。 */
export function setRunningAgentTerminals(next: AgentTerminal[]): void {
  const same =
    next.length === running.length &&
    next.every(
      (x, i) =>
        x.hostId === running[i]?.hostId &&
        x.sessionId === running[i]?.sessionId,
    );
  if (same) return;
  running = next;
  for (const f of subs) f();
}

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

const snapshot = () => running;

export function useRunningAgentTerminals(): AgentTerminal[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

type OpenListener = (hostId: number | null) => void;
const openListeners = new Set<OpenListener>();

/** 弹出终端面板。给了 hostId 就切到那个标签，没给就切到当前会话最近一个在跑的。 */
export function openAgentTerminal(hostId: number | null = null): void {
  for (const f of openListeners) f(hostId);
}

/** App（开面板）和 TerminalPanel（选标签）各订一份。返回退订函数。 */
export function subscribeAgentTerminalOpen(cb: OpenListener): () => void {
  openListeners.add(cb);
  return () => openListeners.delete(cb);
}

/** 从 Bash 起服务的结果里捞终端 id（内核 bash.rs 的 spawn_service：「已在终端 N 起了」）。 */
export function terminalIdFromResult(text: string | undefined): number | null {
  const m = text ? /已在终端 (\d+) 起了/.exec(text) : null;
  return m?.[1] ? Number(m[1]) : null;
}
