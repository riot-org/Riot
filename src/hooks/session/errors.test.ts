import { describe, expect, it } from "vitest";

import { IpcTimeoutError } from "../../bridge";
import { t } from "../../i18n";
import { errorItem, sendFailureItem } from "./errors";

describe("errorItem", () => {
  it("recognises quota errors and keeps the raw text as detail", () => {
    const item = errorItem(new Error("HTTP 402: Insufficient Balance"));
    expect(item).toMatchObject({
      kind: "error",
      text: t("transcript.session.humanize.quota"),
      detail: "Error: HTTP 402: Insufficient Balance",
    });
  });

  it("does not mistake a tool-call validation error for a billing problem", () => {
    const item = errorItem(new Error("insufficient tool messages following tool_calls"));
    expect(item).toMatchObject({ text: "Error: insufficient tool messages following tool_calls" });
  });

  it("passes unknown errors through untouched", () => {
    expect(errorItem("weird")).toMatchObject({ kind: "error", text: "weird" });
  });

  it("truncates very long raw details", () => {
    const item = errorItem(new Error(`rate limit ${"x".repeat(500)}`));
    expect(item.kind === "error" && item.detail?.endsWith("…")).toBe(true);
  });
});

describe("sendFailureItem", () => {
  it("says the outcome is unknown when the host simply did not answer", () => {
    expect(sendFailureItem(new IpcTimeoutError("send_turn", 15_000))).toMatchObject({
      text: t("transcript.session.sendTimeout"),
    });
  });
});
