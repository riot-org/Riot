/**
 * 选择题（AskUserQuestion）答完之后的样子：从工具输入和结果里还原"问了
 * 什么、用户点了哪个"，让卡片留在对话里。
 *
 * 和计划卡同一个处境（见 lib/plan.ts）：工具的 ui_payload 到不了前端，
 * 只能从给模型看的结果文本里认。
 *
 * `[约束]` 下面两个前缀和 `crates/riot-tools/src/tools/ask.rs` 的 `call` /
 * `pick_for_model` 对齐：结果是 `用户选了：<label>（<id>）、…`，自己填写的
 * 那条是 `自己填写：<原文>`（排在最后）。改一边必须改另一边。
 */

// eslint-disable-next-line no-restricted-syntax -- 内核 AskUserQuestion 结果的原文（与 ask.rs 对齐），不是界面文案
const ANSWER_PREFIX = "用户选了：";
// eslint-disable-next-line no-restricted-syntax -- 同上
const OTHER_PREFIX = "自己填写：";

export interface AskOption {
  id: string;
  label: string;
}

export interface AnsweredAsk {
  question: string;
  options: AskOption[];
  /** 点中的选项 id。 */
  picked: string[];
  /** 用户点「其他」自己写的话。 */
  other: string | null;
  /** 没有作答：跳过、被停止、没回答就发了新消息。 */
  unanswered: boolean;
}

function parseOptions(input: unknown): { question: string; options: AskOption[] } | null {
  const i = input as Record<string, unknown> | null;
  if (!i || typeof i.question !== "string" || !Array.isArray(i.options)) return null;
  const options = i.options.flatMap((o) => {
    const r = o as Record<string, unknown> | null;
    return r && typeof r.id === "string" && typeof r.label === "string" ? [{ id: r.id, label: r.label }] : [];
  });
  return options.length ? { question: i.question, options } : null;
}

/** 答完了才有；还在等用户（running）或参数不成形时返回 null。 */
export function answeredAsk(
  input: unknown,
  status: "running" | "ok" | "error",
  result: string | undefined,
): AnsweredAsk | null {
  if (status === "running") return null;
  const parsed = parseOptions(input);
  if (!parsed) return null;
  const text = result ?? "";
  if (status === "error" || !text.startsWith(ANSWER_PREFIX)) {
    return { ...parsed, picked: [], other: null, unanswered: true };
  }
  const answer = text.slice(ANSWER_PREFIX.length).split("\n\n")[0] ?? "";
  // eslint-disable-next-line no-restricted-syntax -- 结果里选项 id 的括号（与 ask.rs 对齐），不是界面文案
  const picked = parsed.options.filter((o) => answer.includes(`（${o.id}）`)).map((o) => o.id);
  const at = answer.indexOf(OTHER_PREFIX);
  const other = at >= 0 ? answer.slice(at + OTHER_PREFIX.length).trim() || null : null;
  return { ...parsed, picked, other, unanswered: false };
}
