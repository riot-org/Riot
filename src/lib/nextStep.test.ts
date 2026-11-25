import { describe, expect, it } from "vitest";

import type { Item } from "../hooks/session/types";
import { firstSentence, nextStepState, readNextStep } from "./nextStep";

const card = (id: string, status: "ok" | "running" = "ok"): Item => ({
  kind: "tool",
  id,
  name: "NextStep",
  input: { recap: "做好了。", ask: "要提交吗？", options: ["提交", "先不提交"] },
  status,
  output: [],
});
const user = (id: string, text: string): Item => ({ kind: "user", id, text });
const reply = (id: string): Item => ({ kind: "assistant", id, text: "好的" });

describe("nextStepState", () => {
  it("最后一张、之后没有用户消息、不在跑：是活的", () => {
    expect(nextStepState([user("u1", "做"), reply("a1"), card("c1")], false).active).toBe("c1");
  });

  it("还在跑的时候不活（按钮这时点了也是排队）", () => {
    expect(nextStepState([card("c1")], true).active).toBeNull();
  });

  it("之后有用户消息：不再活，记下回了哪句", () => {
    const s = nextStepState([card("c1"), user("u2", "提交"), reply("a2")], false);
    expect(s.active).toBeNull();
    expect(s.replies.get("c1")).toBe("提交");
  });

  it("新一轮又给了一张：只有新的那张活", () => {
    const s = nextStepState([card("c1"), user("u2", "提交"), card("c2")], false);
    expect(s.active).toBe("c2");
    expect(s.replies.get("c1")).toBe("提交");
  });

  it("参数还没流完的不算", () => {
    expect(nextStepState([card("c1", "running")], false).active).toBeNull();
  });
});

describe("readNextStep", () => {
  it("没有问题时丢掉按钮，最多两个按钮", () => {
    expect(readNextStep({ recap: "好了", options: ["a"] })).toEqual({ recap: "好了", ask: null, options: [] });
    expect(readNextStep({ recap: "好了", ask: "?", options: ["a", "b", "c"] })?.options).toEqual(["a", "b"]);
  });

  it("半截或坏的输入不画", () => {
    expect(readNextStep({})).toBeNull();
    expect(readNextStep({ recap: "  " })).toBeNull();
    expect(readNextStep(null)).toBeNull();
  });
});

describe("firstSentence", () => {
  it("取到第一个句号", () => {
    expect(firstSentence("补丁应用做好了。还没提交。")).toBe("补丁应用做好了。");
    expect(firstSentence("Done. Not committed yet.")).toBe("Done.");
  });
  it("小数点不算句号", () => {
    expect(firstSentence("升到 0.1.21 了。下一步")).toBe("升到 0.1.21 了。");
  });
});
