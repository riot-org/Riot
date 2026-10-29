import { describe, expect, it } from "vitest";

import type { ContextBreakdown } from "../bridge";
import { layoutBreakdown } from "./contextBreakdown";

function breakdown(over: Partial<ContextBreakdown> = {}): ContextBreakdown {
  const b: ContextBreakdown = {
    reported: 40_000,
    system_prompt: 6_000,
    custom_instructions: 0,
    system_tools: 12_000,
    mcp_tools: [{ name: "mcp__gh__issue", tokens: 1_000 }],
    skills: 500,
    memory_files: [{ name: "/p/AGENTS.md", tokens: 1_500 }],
    messages: 19_000,
    since_last_update: 2_000,
    deferred_system_tools: 6_000,
    deferred_mcp_tools: [],
    total: 42_000,
    ...over,
  };
  return b;
}

describe("layoutBreakdown", () => {
  it("计入的各行加上缓冲区和剩余正好是整个窗口", () => {
    const { rows, used } = layoutBreakdown(breakdown(), 200_000, 160_000);
    expect(used).toBe(42_000);
    const total = rows.reduce((n, r) => n + r.tokens, 0);
    expect(total).toBe(200_000);
    expect(rows.find((r) => r.key === "autocompactBuffer")?.tokens).toBe(40_000);
    expect(rows.find((r) => r.key === "freeSpace")?.tokens).toBe(118_000);
  });

  it("0 的类别不出行，可展开的类别带清单", () => {
    const { rows } = layoutBreakdown(breakdown(), 200_000, 160_000);
    const keys = rows.map((r) => r.key);
    expect(keys).not.toContain("customInstructions");
    expect(keys.slice(0, 3)).toEqual(["systemPrompt", "systemTools", "mcpTools"]);
    expect(rows.find((r) => r.key === "memoryFiles")?.items).toHaveLength(1);
    expect(rows.find((r) => r.key === "systemPrompt")?.items).toBeUndefined();
  });

  it("没配窗口（分母就是阈值）时没有缓冲区，剩余不为负", () => {
    const { rows } = layoutBreakdown(breakdown({ total: 50_000 }), 40_000, 40_000);
    expect(rows.map((r) => r.key)).not.toContain("autocompactBuffer");
    expect(rows.find((r) => r.key === "freeSpace")?.tokens).toBe(0);
  });

  it("延迟加载的工具单独给出，不进行里", () => {
    const { rows, deferred } = layoutBreakdown(breakdown(), 200_000, 160_000);
    expect(deferred.systemTools).toBe(6_000);
    expect(rows.reduce((n, r) => n + r.tokens, 0)).toBe(200_000);
  });
});
