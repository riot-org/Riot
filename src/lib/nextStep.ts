/**
 * 收尾卡片（NextStep 工具，见 components/NextStepCard.tsx）的状态。
 *
 * 卡片画的是工具的输入（小结、问题、按钮），自己没有状态可存 —— 它是
 * "活的"还是"历史"，全看它在对话里的位置：
 *
 * - **活的**：这个会话最后一张、之后没有用户消息、这一轮已经跑完。按钮可点。
 * - **已回复**：之后有了用户消息。记下那句话，卡片上标「已回复『…』」。
 * - 其余（被新一轮盖过、还在跑）只剩小结，是对话历史的一部分。
 *
 * 另外两份跨组件的小状态也在这里：侧栏要知道哪个会话"在等你拍板"
 * （活卡片带着问题），用户点 × 收起的卡片要记住（切会话再切回来不复活）。
 */

import { createContext, useSyncExternalStore } from "react";

import type { Item } from "../hooks/session/types";

export const NEXT_STEP_TOOL = "NextStep";

export interface NextStepInput {
  recap: string;
  ask: string | null;
  options: string[];
}

/** 工具输入 → 卡片内容。流式中的半截输入、坏数据都返回 null（先不画）。 */
export function readNextStep(input: unknown): NextStepInput | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  if (typeof o.recap !== "string" || !o.recap.trim()) return null;
  const ask = typeof o.ask === "string" && o.ask.trim() ? o.ask.trim() : null;
  const options = Array.isArray(o.options)
    ? o.options.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim())
    : [];
  return { recap: o.recap.trim(), ask, options: ask ? options.slice(0, 2) : [] };
}

export interface NextStepState {
  /** 活卡片的工具调用 id。没有就是 null。 */
  active: string | null;
  /** 卡片 id → 它之后用户回的第一句话。 */
  replies: ReadonlyMap<string, string>;
}

export const EMPTY_NEXT_STEP: NextStepState = { active: null, replies: new Map() };

export function nextStepState(items: readonly Item[], busy: boolean): NextStepState {
  const replies = new Map<string, string>();
  let pending: string[] = [];
  for (const it of items) {
    if (it.kind === "tool" && it.name === NEXT_STEP_TOOL && it.status === "ok") {
      pending.push(it.id);
    } else if (it.kind === "user") {
      for (const id of pending) replies.set(id, it.text);
      pending = [];
    }
  }
  const last = pending[pending.length - 1];
  if (!replies.size && !last) return EMPTY_NEXT_STEP;
  return { active: !busy && last ? last : null, replies };
}

/** 对话区往卡片里传的状态（Chat 算、ToolCard 里的卡片读）。 */
export const NextStepContext = createContext<NextStepState>(EMPTY_NEXT_STEP);

/* ── 点 × 收起的卡片 ───────────────────────── */

const dismissed = new Set<string>();
const dismissSubs = new Set<() => void>();
let dismissVersion = 0;

export function dismissNextStep(id: string): void {
  dismissed.add(id);
  dismissVersion++;
  for (const f of dismissSubs) f();
}

export function useNextStepDismissed(id: string): boolean {
  useSyncExternalStore(
    (cb) => {
      dismissSubs.add(cb);
      return () => dismissSubs.delete(cb);
    },
    () => dismissVersion,
    () => dismissVersion,
  );
  return dismissed.has(id);
}

/* ── 侧栏："这个会话在等你拍板" ───────────────── */

let waiting: ReadonlyMap<string, string> = new Map();
const waitSubs = new Set<() => void>();

/** Chat 报：会话 `sid` 的活卡片带着问题（`recap` 是它的小结），或者没有了（null）。 */
export function setNextStepWaiting(sid: string, recap: string | null): void {
  if ((waiting.get(sid) ?? null) === recap) return;
  const next = new Map(waiting);
  if (recap === null) next.delete(sid);
  else next.set(sid, recap);
  waiting = next;
  for (const f of waitSubs) f();
}

/** 侧栏读：会话 id → 它在等你拍板的那张卡片的小结。整张表，侧栏订一次。 */
export function useNextStepWaiting(): ReadonlyMap<string, string> {
  return useSyncExternalStore(
    (cb) => {
      waitSubs.add(cb);
      return () => waitSubs.delete(cb);
    },
    () => waiting,
    () => waiting,
  );
}

/** 小结的第一句：侧栏里一行放得下的那部分。 */
export function firstSentence(text: string): string {
  const m = /^[\s\S]*?[。！？.!?](?=\s|$|[^\d])/.exec(text.trim());
  return (m ? m[0] : text).trim();
}
