import { describe, expect, it } from "vitest";
import { answeredAsk } from "./askAnswer";

const input = {
  question: "这个测试变量要怎么处理？",
  options: [
    { id: "keep", label: "留着" },
    { id: "settings_delete", label: "你自己在设置页删掉，我不动手" },
  ],
};

describe("answeredAsk", () => {
  it("reads the picked option from the tool result", () => {
    const r = answeredAsk(input, "ok", "用户选了：你自己在设置页删掉，我不动手（settings_delete）\n\n按这个继续，不要再确认一遍。");
    expect(r).toMatchObject({ picked: ["settings_delete"], other: null, unanswered: false });
    expect(r?.options).toHaveLength(2);
  });

  it("reads multiple picks and the user's own text", () => {
    const r = answeredAsk(input, "ok", "用户选了：留着（keep）、自己填写：先问问同事\n\n按这个继续，不要再确认一遍。");
    expect(r).toMatchObject({ picked: ["keep"], other: "先问问同事" });
  });

  it("marks skipped or interrupted questions as unanswered", () => {
    expect(answeredAsk(input, "error", "用户拒绝了这次操作。")?.unanswered).toBe(true);
  });

  it("stays null while waiting or when the input is malformed", () => {
    expect(answeredAsk(input, "running", undefined)).toBeNull();
    expect(answeredAsk({ question: "?" }, "ok", "用户选了：x")).toBeNull();
  });
});
