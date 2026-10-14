import { describe, expect, it } from "vitest";

import type { Message } from "../../bridge";
import {
  PHANTOM_AFTER_MS,
  applyHistorySnap,
  liveDeltasOf,
  locateMessage,
  mergeLive,
  messagesToItems,
  phantomBubbles,
  rebuildFromSnap,
  reconcileAsks,
} from "./history";
import { EMPTY_STATE, type HistorySnap, type Item, type SessionState } from "./types";

const snap = (over: Partial<HistorySnap> = {}): HistorySnap => ({
  messages: [],
  archived: [],
  busy: false,
  compacting: false,
  pendingAsks: [],
  liveText: "",
  liveThinking: "",
  tasks: [],
  ...over,
});

const state = (over: Partial<SessionState> = {}): SessionState => ({ ...EMPTY_STATE, ...over });

const turn: Message[] = [
  { role: "user", id: "u1", content: [{ type: "text", text: "list files" }], meta: { created_at_ms: 5 } },
  {
    role: "assistant",
    id: "a1",
    content: [
      { type: "thinking", text: "hmm", duration_ms: 1200 },
      { type: "text", text: "Running ls" },
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
    ],
    usage: { input_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0, output_tokens: 3 },
  },
  {
    role: "user",
    id: "u2",
    content: [{ type: "tool_result", tool_use_id: "t1", is_error: false, content: { type: "text", text: "a b" } }],
  },
];

describe("mergeLive", () => {
  it.each([
    ["", "abc", "abc"],
    ["abc", "", "abc"],
    ["abc", "abcdef", "abcdef"],
    ["abcdef", "abc", "abcdef"],
    ["hello wor", "world!", "hello world!"],
    ["abc", "xyz", "abcxyz"],
  ])("merge(%j, %j) = %j", (a, b, want) => {
    expect(mergeLive(a, b)).toBe(want);
  });

  it("treats a missing snapshot as empty", () => {
    expect(mergeLive(undefined, "x")).toBe("x");
  });
});

describe("liveDeltasOf", () => {
  it("concatenates text and thinking deltas separately", () => {
    expect(
      liveDeltasOf([
        { type: "delta", kind: "text", message_id: "m", text: "a" },
        { type: "delta", kind: "thinking", message_id: "m", text: "k" },
        { type: "compacting" },
        { type: "delta", kind: "text", message_id: "m", text: "b" },
      ]),
    ).toEqual({ text: "ab", thinking: "k" });
  });
});

describe("messagesToItems", () => {
  it("turns a full turn into prompt, thinking, answer and a finished tool card", () => {
    const items = messagesToItems(turn);
    expect(items.map((it) => it.kind)).toEqual(["user", "thinking", "assistant", "tool"]);
    expect(items[0]).toMatchObject({ text: "list files", at: 5 });
    expect(items[1]).toMatchObject({ durationMs: 1200 });
    expect(items[3]).toMatchObject({ id: "t1", status: "ok", result: "a b", input: { command: "ls" } });
  });

  it("shows attached images on the prompt bubble", () => {
    const items = messagesToItems([
      {
        role: "user",
        id: "u",
        content: [
          { type: "text", text: "look" },
          { type: "attachment", kind: "image", media_type: "image/png", data: "QUJD" } as never,
        ],
      },
    ]);
    expect(items[0]).toMatchObject({ kind: "user", images: ["data:image/png;base64,QUJD"] });
  });
});

describe("applyHistorySnap", () => {
  it("idle snapshot replaces the items and clears busy leftovers", () => {
    const s = state({ busy: true, streaming: "stale", items: [{ kind: "notice", id: "n", text: "x" }] });
    const out = applyHistorySnap(s, snap({ messages: turn }));
    expect(out.busy).toBe(false);
    expect(out.streaming).toBe("");
    expect(out.items.map((it) => it.kind)).toEqual(["user", "thinking", "assistant", "tool"]);
    expect(out.tokens).toEqual({ input: 10, output: 3, context: 13 });
  });

  it("busy snapshot keeps live tool output and does not mark running tools unfinished", () => {
    const running = turn.slice(0, 2);
    const s = state({
      busy: true,
      items: [{ kind: "tool", id: "t1", name: "Bash", input: {}, status: "running", output: ["partial"] }],
    });
    const out = applyHistorySnap(s, snap({ messages: running, busy: true, liveText: "more" }));
    const card = out.items.find((it) => it.id === "t1");
    expect(card).toMatchObject({ status: "running", output: ["partial"] });
    expect(out.streaming).toBe("more");
  });

  it("keeps an optimistic bubble the host has not recorded yet", () => {
    const bubble: Item = { kind: "user", id: "local-9", text: "new question", at: Date.now() };
    const out = applyHistorySnap(state({ items: [bubble] }), snap({ messages: turn, busy: true }));
    expect(out.items.at(-1)).toBe(bubble);
  });
});

describe("rebuildFromSnap", () => {
  it("drops optimistic bubbles — the snapshot is the whole truth after an edit", () => {
    const s = state({ items: [{ kind: "user", id: "local-1", text: "gone", at: 1 }] });
    expect(rebuildFromSnap(s, snap()).items).toEqual([]);
  });
});

describe("phantomBubbles", () => {
  const old = Date.now() - PHANTOM_AFTER_MS - 1;

  it("flags the last unanswered prompt the host does not know about", () => {
    const items: Item[] = [{ kind: "user", id: "msg_x", text: "lost", at: old }];
    expect(phantomBubbles(items, [])).toEqual(items);
  });

  it("ignores prompts that already have an answer or are still in the send grace period", () => {
    expect(
      phantomBubbles(
        [
          { kind: "user", id: "u", text: "q", at: old },
          { kind: "assistant", id: "a", text: "r" },
        ],
        [],
      ),
    ).toEqual([]);
    expect(phantomBubbles([{ kind: "user", id: "local-1", text: "q", at: Date.now() }], [])).toEqual([]);
  });

  it("ignores prompts the snapshot does contain", () => {
    const items: Item[] = [{ kind: "user", id: "local-1", text: "q", at: old }];
    expect(phantomBubbles(items, [{ kind: "user", id: "msg", text: "q" }])).toEqual([]);
  });
});

describe("locateMessage", () => {
  it("strips item suffixes, then falls back to role + text, newest first", () => {
    const msgs: Message[] = [
      { role: "user", id: "m1", content: [{ type: "text", text: "same" }] },
      { role: "user", id: "m2", content: [{ type: "text", text: "same" }] },
    ];
    expect(locateMessage(msgs, { kind: "user", id: "m1-u0", text: "x" })).toBe("m1");
    expect(locateMessage(msgs, { kind: "user", id: "local-1", text: "same" })).toBe("m2");
    expect(locateMessage(msgs, { kind: "assistant", id: "t-t", text: "same" })).toBeNull();
  });
});

describe("reconcileAsks", () => {
  it("keeps existing ask objects and drops ones the host resolved", () => {
    const keep = { requestId: "r1", detail: {} as never };
    const gone = { requestId: "r2", detail: {} as never };
    const out = reconcileAsks([keep, gone], [
      { request_id: "r1", detail: {} as never },
      { request_id: "r3", detail: {} as never },
    ] as never);
    expect(out[0]).toBe(keep);
    expect(out.map((a) => a.requestId)).toEqual(["r1", "r3"]);
  });
});
