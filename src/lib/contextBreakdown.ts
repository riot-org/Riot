/**
 * 上下文明细浮层的行与分段（见 `components/ContextRing.tsx`）。
 *
 * 内核给的是各类别的 token 估算（`ContextBreakdown`），这里补上它不知道的
 * 两行：自动压缩缓冲区（窗口 − 压缩阈值）和剩余空间。窗口是宿主的模型
 * 配置，环本来就拿它当分母 —— 两行在这里算，浮层的条和环才对得上。
 */

import type { ContextBreakdown, ContextItem } from "../bridge";

/** 计入占用的类别，顺序即条上的分段顺序和明细里的行序（照 Claude 的面板）。 */
export type CountedKey =
  | "systemPrompt"
  | "systemTools"
  | "mcpTools"
  | "skills"
  | "customInstructions"
  | "memoryFiles"
  | "messages"
  | "sinceLastUpdate";

export type ContextRowKey = CountedKey | "autocompactBuffer" | "freeSpace";

export interface ContextRow {
  key: ContextRowKey;
  tokens: number;
  /** 占窗口的百分比（未取整）。 */
  pct: number;
  /** 可展开看清单的那几行（MCP 工具、记忆文件）。 */
  items?: ContextItem[];
}

export interface ContextLayout {
  /** 计入占用的各行 + 缓冲区 + 剩余，0 的行已去掉（剩余空间除外）。 */
  rows: ContextRow[];
  /** 延迟加载、不计入占用的两行。 */
  deferred: { systemTools: number; mcpTools: ContextItem[] };
  /** 计入占用的总和。 */
  used: number;
}

const sum = (items: ContextItem[]) => items.reduce((n, i) => n + i.tokens, 0);

/**
 * 把内核的明细排成浮层的行。`cap` 是进度条的分母（窗口，没配就是阈值），
 * `threshold` 是自动压缩点。
 */
export function layoutBreakdown(
  b: ContextBreakdown,
  cap: number,
  threshold: number,
): ContextLayout {
  const pct = (n: number) => (cap > 0 ? (n / cap) * 100 : 0);
  const counted: [CountedKey, number, ContextItem[]?][] = [
    ["systemPrompt", b.system_prompt],
    ["systemTools", b.system_tools],
    ["mcpTools", sum(b.mcp_tools), b.mcp_tools],
    ["skills", b.skills],
    ["customInstructions", b.custom_instructions],
    ["memoryFiles", sum(b.memory_files), b.memory_files],
    ["messages", b.messages],
    ["sinceLastUpdate", b.since_last_update],
  ];
  const rows: ContextRow[] = counted
    .filter(([, tokens]) => tokens > 0)
    .map(([key, tokens, items]) => ({
      key,
      tokens,
      pct: pct(tokens),
      ...(items && items.length > 0 ? { items } : {}),
    }));
  // 用内核给的总数，不自己加：两边各加一遍的话，取整差异会让总数和
  // 各行之和在最后一位上对不上。
  const used = b.total;
  // 阈值就是分母时（没配窗口）没有缓冲区可言，条满就是压缩点。
  const buffer = cap > threshold ? cap - threshold : 0;
  if (buffer > 0) rows.push({ key: "autocompactBuffer", tokens: buffer, pct: pct(buffer) });
  const free = Math.max(cap - used - buffer, 0);
  rows.push({ key: "freeSpace", tokens: free, pct: pct(free) });
  return {
    rows,
    deferred: { systemTools: b.deferred_system_tools, mcpTools: b.deferred_mcp_tools },
    used,
  };
}
