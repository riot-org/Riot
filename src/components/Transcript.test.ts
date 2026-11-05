import { describe, expect, it } from "vitest";

import type { Message } from "../bridge";
import { messagesToItems } from "../hooks/session/history";
import { groupBlocks } from "./ProcessFold";
import { type ForkChild, forkMarks, groupTurns } from "./Transcript";

const history: Message[] = [
  { role: "user", id: "u1", content: [{ type: "text", text: "一" }] },
  {
    role: "assistant",
    id: "a1",
    content: [
      { type: "text", text: "先看看" },
      { type: "tool_use", id: "t1", name: "Read", input: { path: "a" } },
    ],
  },
  {
    role: "user",
    id: "r1",
    content: [{ type: "tool_result", tool_use_id: "t1", is_error: false, content: { type: "text", text: "内容" } }],
  },
  { role: "assistant", id: "a1b", content: [{ type: "text", text: "看完了" }] },
  { role: "user", id: "u2", content: [{ type: "text", text: "二" }] },
  { role: "assistant", id: "a2", content: [{ type: "text", text: "答二" }] },
];

const fork = (id: string, message: string): ForkChild => ({ id, title: null, createdAtMs: 0, message, branch: null });

/** 记号挂在哪条（按条目种类和正文认，不依赖条目 id 的后缀写法）→ 挂了哪些。 */
function marksOf(forks: ForkChild[]) {
  const items = messagesToItems(history);
  const marks = forkMarks(groupTurns(groupBlocks(items), (id) => id), forks);
  const label = (id: string) => {
    const it = items.find((x) => x.id === id);
    return it && "text" in it ? `${it.kind}:${it.text}` : id;
  };
  return Object.fromEntries([...marks].map(([id, list]) => [label(id), list.map((f) => f.id)]));
}

describe("forkMarks", () => {
  it("挂在分叉点那一轮带操作栏的回答上，不挂在过渡句上", () => {
    expect(marksOf([fork("f1", "a1b"), fork("f2", "a1"), fork("f3", "a2")])).toEqual({
      "assistant:看完了": ["f1", "f2"],
      "assistant:答二": ["f3"],
    });
  });

  it("分叉点已经不在历史里的不挂", () => {
    expect(marksOf([fork("f4", "gone")])).toEqual({});
  });
});
