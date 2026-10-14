import { describe, expect, it } from "vitest";

import type { AgentEvent, BackgroundTaskView } from "../../bridge";
import {
  MAX_TOOL_LINES,
  appendToolOutput,
  applyDone,
  applyMessage,
  applyResolved,
  applyWithdrawn,
  dropSettled,
  fillToolInput,
  trimAfterUserPrompt,
  trimThroughEdited,
  upsertTask,
} from "./items";
import { EMPTY_STATE, type Item, type SessionState } from "./types";

type MessageEvent = Extract<AgentEvent, { type: "message" }>;
type ToolItem = Extract<Item, { kind: "tool" }>;

const tool = (id: string, over: Partial<ToolItem> = {}): ToolItem => ({
  kind: "tool",
  id,
  name: "Bash",
  input: {},
  status: "running",
  output: [],
  ...over,
});

const state = (over: Partial<SessionState> = {}): SessionState => ({ ...EMPTY_STATE, ...over });

describe("applyMessage", () => {
  it("fills the matching tool card with its result", () => {
    const s = state({ items: [tool("t1"), tool("t2")] });
    const ev: MessageEvent = {
      type: "message",
      role: "user",
      id: "m1",
      content: [
        { type: "tool_result", tool_use_id: "t2", is_error: true, content: { type: "text", text: "boom" } },
      ],
    };
    const out = applyMessage(s, ev);
    expect(out.items[0]).toBe(s.items[0]);
    expect(out.items[1]).toMatchObject({ status: "error", result: "boom" });
  });

  it("swaps the optimistic bubble for the echoed prompt instead of adding a second one", () => {
    const s = state({ items: [{ kind: "user", id: "local-1", text: "hi", at: 1 }] });
    const out = applyMessage(s, {
      type: "message",
      role: "user",
      id: "msg_1",
      content: [{ type: "text", text: "hi" }],
      meta: { created_at_ms: 42 },
    });
    expect(out.items).toEqual([{ kind: "user", id: "msg_1", text: "hi", at: 42 }]);
    expect(out.checkpointIds).toEqual(["msg_1"]);
  });

  it("gives every text and thinking block of one assistant message its own id", () => {
    const out = applyMessage(state(), {
      type: "message",
      role: "assistant",
      id: "a1",
      content: [
        { type: "thinking", text: "first thought" },
        { type: "text", text: "one" },
        { type: "thinking", text: "second thought" },
        { type: "text", text: "two" },
      ],
    });
    const ids = out.items.map((it) => it.id);
    expect(new Set(ids).size).toBe(ids.length);
    // 剥后缀找消息 id 的正则（`-t\d*` / `-k\d*`）仍然认得它们。
    for (const id of ids) expect(id.replace(/-[tk]\d*$/, "")).toBe("a1");
  });

  it("completes a streamed tool card in place and accumulates usage", () => {
    const s = state({
      items: [tool("t1", { output: ["line"] })],
      tokens: { input: 10, output: 5, context: 15 },
    });
    const out = applyMessage(s, {
      type: "message",
      role: "assistant",
      id: "a1",
      content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
      usage: { input_tokens: 100, cache_read_tokens: 20, cache_creation_tokens: 0, output_tokens: 7 },
    });
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ input: { command: "ls" }, output: ["line"], status: "running" });
    expect(out.tokens).toEqual({ input: 130, output: 12, context: 127 });
  });
});

describe("applyDone", () => {
  it("marks dangling tools unfinished and appends the error card", () => {
    const s = state({ busy: true, items: [tool("t1"), tool("t2", { status: "ok" })], streaming: "x" });
    const out = applyDone(s, {
      type: "done",
      reason: { reason: "error", error: { kind: "context_exhausted", used: 10, limit: 5 } },
    });
    expect(out.busy).toBe(false);
    expect(out.streaming).toBe("");
    expect(out.items[0]).toMatchObject({ status: "error" });
    expect(out.items[1]).toBe(s.items[1]);
    expect(out.items.at(-1)?.kind).toBe("error");
  });

  it("keeps pending asks while a background subagent is still running", () => {
    const ask = { requestId: "r1", detail: {} as never };
    const bg = { id: "agt", background: true, status: "running" } as BackgroundTaskView;
    const done = { type: "done", reason: { reason: "completed" } } as const;
    expect(applyDone(state({ asks: [ask] }), done).asks).toEqual([]);
    expect(applyDone(state({ asks: [ask], tasks: [bg] }), done).asks).toEqual([ask]);
  });
});

describe("appendToolOutput", () => {
  it("keeps the array identity when no card matches", () => {
    const items = [tool("t1")];
    expect(appendToolOutput(items, [{ id: "nope", text: "x" }])).toBe(items);
  });

  it("groups lines per card and keeps only the tail", () => {
    const items = [tool("t1"), tool("t2")];
    const lines = Array.from({ length: MAX_TOOL_LINES + 5 }, (_, i) => ({ id: "t1", text: `l${i}` }));
    const out = appendToolOutput(items, [...lines, { id: "t2", text: "other" }]);
    const t1 = out[0] as ToolItem;
    expect(t1.output).toHaveLength(MAX_TOOL_LINES);
    expect(t1.output.at(-1)).toBe(`l${MAX_TOOL_LINES + 4}`);
    expect((out[1] as ToolItem).output).toEqual(["other"]);
  });
});

describe("fillToolInput", () => {
  it("replaces only the cards that got new fields", () => {
    const items = [tool("t1"), tool("t2")];
    const out = fillToolInput(items, new Map([["t2", { command: "ls" }]]));
    expect(out[0]).toBe(items[0]);
    expect(out[1]).toMatchObject({ input: { command: "ls" } });
    expect(fillToolInput(items, new Map())).toBe(items);
  });
});

describe("dropSettled", () => {
  it("removes each settled block once, by content", () => {
    const settled = { text: ["hello"], thinking: [] as string[] };
    const ev: MessageEvent = {
      type: "message",
      role: "assistant",
      id: "a1",
      content: [
        { type: "text", text: "hello" },
        { type: "tool_use", id: "t", name: "Bash", input: {} },
        { type: "text", text: "hello" },
      ],
    };
    const out = dropSettled(ev, settled) as Extract<MessageEvent, { role: "assistant" }>;
    expect(out.content).toHaveLength(2);
    expect(out.content[0]?.type).toBe("tool_use");
    expect(settled.text).toEqual([]);
  });
});

describe("applyWithdrawn", () => {
  it("pulls the last prompt back even with a compact rule after it", () => {
    const s = state({
      items: [
        { kind: "user", id: "u1", text: "old" },
        { kind: "assistant", id: "a1", text: "reply" },
        { kind: "user", id: "local-2", text: "again", images: ["data:image/png;base64,AAAA"] },
        { kind: "compact", id: "c" },
      ],
    });
    const out = applyWithdrawn(s, "msg_2", false);
    expect(out.items.map((it) => it.id)).toEqual(["u1", "a1", "c"]);
    expect(out.withdrawn).toEqual({
      id: "msg_2",
      text: "again",
      images: [{ mediaType: "image/png", data: "AAAA" }],
      refs: [],
      sessionEmpty: false,
    });
  });
});

describe("applyResolved", () => {
  it("ignores unknown requests and only notes timeouts", () => {
    const s = state({ asks: [{ requestId: "r1", detail: {} as never }] });
    expect(applyResolved(s, "zzz", { kind: "timeout" } as never)).toBe(s);
    const quiet = applyResolved(s, "r1", { kind: "user_denied" } as never);
    expect(quiet.asks).toEqual([]);
    expect(quiet.items).toEqual([]);
    const timed = applyResolved(s, "r1", { kind: "timeout" } as never);
    expect(timed.items.at(-1)?.kind).toBe("error");
  });
});

describe("trimming", () => {
  const items: Item[] = [
    { kind: "user", id: "u1", text: "q1" },
    { kind: "assistant", id: "a1", text: "r1" },
    { kind: "user", id: "u2", text: "q2" },
    tool("t1"),
    { kind: "assistant", id: "a2", text: "r2" },
  ];

  it("regenerate keeps everything up to the prompt before the answer", () => {
    expect(trimAfterUserPrompt(items, "a2").map((it) => it.id)).toEqual(["u1", "a1", "u2"]);
    expect(trimAfterUserPrompt(items, "missing")).toBe(items);
  });

  it("resend cuts after the edited prompt and swaps its text", () => {
    const out = trimThroughEdited(items, "u2", "q2 edited", [], 99);
    expect(out.map((it) => it.id)).toEqual(["u1", "a1", "u2"]);
    expect(out[2]).toEqual({ kind: "user", id: "u2", text: "q2 edited", at: 99 });
  });
});

describe("upsertTask", () => {
  it("replaces by id and appends new ones in order", () => {
    const a = { id: "a", status: "running" } as BackgroundTaskView;
    const b = { id: "b", status: "running" } as BackgroundTaskView;
    const a2 = { id: "a", status: "completed" } as BackgroundTaskView;
    expect(upsertTask(upsertTask([a], b), a2)).toEqual([a2, b]);
  });
});
