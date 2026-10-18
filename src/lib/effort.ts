import type { ThinkingPolicy } from "../bridge";

/**
 * 思考力度（Effort）的档位，模型菜单的二级菜单用。
 *
 * 档名和标题都刻意不进词典：照 Claude 桌面端的样子固定用英文，
 * 各语言界面里看到的是同一组词。档位到请求参数的映射在内核
 * （riot-providers），这里只管展示。
 */
export type EffortKey = "low" | "medium" | "high" | "max" | "disabled";

export const EFFORT_TITLE = "Effort";

export const EFFORT_OPTIONS: {
  key: EffortKey;
  label: string;
  /** 跟在档名后面的小标签。 */
  badge?: string;
  /** 悬停说明：这一档实际发什么参数。 */
  tip?: string;
}[] = [
  { key: "low", label: "Low" },
  { key: "medium", label: "Medium" },
  { key: "high", label: "High", badge: "Default" },
  {
    key: "max",
    label: "Max",
    badge: "More usage",
    tip: "Deepest and slowest; sends max to DeepSeek, xhigh to OpenAI",
  },
  { key: "disabled", label: "Off", tip: "Turns thinking off; not supported by some endpoints" },
];

export function effortKey(p: ThinkingPolicy): EffortKey {
  return p.mode === "fixed" ? p.level : "disabled";
}

export function effortPolicy(k: EffortKey): ThinkingPolicy {
  return k === "disabled" ? { mode: "disabled" } : { mode: "fixed", level: k };
}

export function effortLabel(p: ThinkingPolicy): string {
  const k = effortKey(p);
  return EFFORT_OPTIONS.find((o) => o.key === k)?.label ?? k;
}
