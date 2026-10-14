import type { AgentError } from "../../bridge/generated";
import { isHostError, isIpcTimeout, splitUiError, type SplitError } from "../../bridge";
import { type MessageKey, t, tn } from "../../i18n";
import type { Item } from "./types";

/** 回退 / 前进有文件没写回去：在对话里留一条提示，点过的人要知道哪几个没成。 */
export function restoreFailNotice(
  failed: { path: string; reason: string }[],
): Item {
  return {
    kind: "notice",
    id: `restore-fail-${Date.now()}`,
    text: t("transcript.restore.partialFail", {
      files: failed.map((f) => f.path).join(t("transcript.listSep")),
    }),
  };
}

/**
 * 发送失败时摆在对话流里的那一行。
 *
 * 宿主超时要和"宿主拒绝"分开说。拒绝是确定的：这条没进队列，原文回到
 * 输入框，重发就行。超时的结果**不确定** —— 命令可能已经落地、轮子已经
 * 在跑，只是回执没回来。这时催用户重发，就是在制造两条一模一样的消息。
 */
export function sendFailureItem(e: unknown): Item {
  if (isIpcTimeout(e)) {
    return { kind: "error", id: `err-${Date.now()}`, text: t("transcript.session.sendTimeout") };
  }
  return errorItem(e);
}

/** 错误卡的两段（见 `Item` 的 error 变体）。没有细节就不带这个键。 */
export type ErrorParts = { text: string; detail?: string };

export function parts(text: string, detail?: string | null): ErrorParts {
  const d = detail?.trim();
  return d ? { text, detail: d } : { text };
}

/** catch 到的任何东西 → 一张错误卡。 */
export function errorItem(e: unknown): Item {
  return { kind: "error", id: `err-${Date.now()}`, ...humanizeError(e) };
}

/**
 * 技术错误链 → 人话的匹配表。存的是词典键，匹配到时再查 —— 存译文的话
 * 会钉死在模块加载那一刻的语言上。
 */
export const KNOWN_ERRORS: [RegExp, MessageKey][] = [
  [/timed?\s*out|timeout/, "transcript.session.humanize.timeout"],
  [/dns|name not resolved|nodename/, "transcript.session.humanize.dns"],
  [/connection refused|connect error|network|fetch failed/, "transcript.session.humanize.network"],
  [/401|unauthorized|invalid.*key|authentication/, "transcript.session.humanize.auth"],
  [/429|rate.?limit|overloaded/, "transcript.session.humanize.rateLimit"],
  // 额度类只认带额度语境的措辞。裸的 "insufficient" 会误伤 ——
  // DeepSeek 的 tool_calls 校验报错里就有 "insufficient tool messages"，
  // 真实余额没问题的用户被这句话带去查账单（生产事故）。
  // 覆盖的真实文案：DeepSeek "Insufficient Balance"、OpenAI
  // "insufficient_quota" / "You exceeded your current quota"、
  // Anthropic "credit balance is too low"、Kimi "balance is insufficient"。
  [
    /insufficient[_\s]+(quota|balance|funds|credits)|(credit\s+)?balance\s+is\s+(too\s+low|insufficient)|exceeded.{0,40}quota|quota.{0,40}exceeded|out\s+of\s+(quota|credits)|余额不足|欠费/,
    "transcript.session.humanize.quota",
  ],
];

/**
 * 把一串技术错误链翻成一句人话，原文放进折叠的细节 —— 报 bug 时用得上，
 * 平时不该占地方。识别不了的原样当正文 —— 编出来的解释比看不懂的原文更糟。
 */
export function humanizeError(e: unknown): ErrorParts {
  // 宿主超时要抢在下面那条 timeout 规则前面：那句话说的是"网络或服务方
  // 没按时响应"，而这一类根本没走到网络 —— 是宿主自己没回话。
  if (isIpcTimeout(e)) return parts(t("transcript.session.humanize.ipcTimeout", { message: e.message }));
  // 宿主的结构化错误自带译文和细节，不用再从拼好的字符串里猜。
  if (isHostError(e)) return fromSplit(splitUiError(e));
  const raw = String(e);
  const lower = raw.toLowerCase();
  for (const [re, key] of KNOWN_ERRORS) {
    if (re.test(lower)) return parts(t(key), raw.length > 200 ? `${raw.slice(0, 200)}…` : raw);
  }
  return parts(raw);
}

export function fromSplit(s: SplitError): ErrorParts {
  return parts(s.text, s.detail);
}

export function describeError(e: AgentError): ErrorParts {
  switch (e.kind) {
    case "provider":
      // 内核已按原因（认证、限流、额度、连不上）选好键，HTTP 原文在 detail 里。
      return fromSplit(splitUiError(e.error));
    case "context_exhausted":
      return parts(t("transcript.session.err.contextExhausted", { used: e.used, limit: e.limit }));
    case "compact_circuit_open":
      return parts(tn("transcript.session.err.compactCircuit", e.attempts));
    case "internal": {
      const inner = splitUiError(e.error);
      return parts(t("transcript.session.err.internal", { message: inner.text }), inner.detail);
    }
    default:
      return parts(t("transcript.session.err.unknown"));
  }
}
