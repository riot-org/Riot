import { describe, expect, it } from "vitest";

import type { Item } from "../hooks/useSession";
import { findHits, findTextRanges, stripMarkdown } from "./findHits";

const items: Item[] = [
  { kind: "user", id: "u", text: "foo bar" },
  { kind: "assistant", id: "a1", text: "Plain foo bar here" },
  { kind: "assistant", id: "a2", text: "Styled **Foo** _bar_" },
  { kind: "assistant", id: "a3", text: "See [foo bar](http://x) link" },
  { kind: "assistant", id: "a4", text: "nothing relevant" },
];

describe("findHits", () => {
  it("picks assistant rows whose rendered text contains the query, case-insensitively", () => {
    expect([...findHits(items, "foo bar")]).toEqual(["a1", "a2", "a3"]);
  });

  it("is empty for an empty query", () => {
    expect(findHits(items, "").size).toBe(0);
  });
});

describe("stripMarkdown", () => {
  it("drops inline markers and keeps link text", () => {
    expect(stripMarkdown("# t **b** `c` [d](e) ![f](g)")).toBe(" t b c d f");
  });
});

describe("findTextRanges", () => {
  const html = (s: string) => {
    const root = document.createElement("div");
    root.innerHTML = s;
    return root;
  };

  it("matches across inline formatting", () => {
    const root = html("<p>has <strong>Bold</strong>, <code>code</code> here</p>");
    const hits = findTextRanges(root, "bold, code");
    expect(hits.map((r) => r.toString())).toEqual(["Bold, code"]);
  });

  it("does not join text across block boundaries", () => {
    const root = html("<p>end of one</p><p>start of two</p>");
    expect(findTextRanges(root, "onestart")).toEqual([]);
    expect(findTextRanges(root, "one start")).toEqual([]);
    expect(findTextRanges(root, "of").map((r) => r.toString())).toEqual(["of", "of"]);
  });

  it("finds repeated hits in one node and ignores an empty query", () => {
    const root = html("<li>aXaXa</li>");
    expect(findTextRanges(root, "a")).toHaveLength(3);
    expect(findTextRanges(root, "")).toEqual([]);
  });

  it("anchors a hit that starts exactly at a node boundary in the later node", () => {
    const root = html("<p><em>ab</em>cd</p>");
    const [r] = findTextRanges(root, "cd");
    expect(r?.startContainer.textContent).toBe("cd");
    expect(r?.startOffset).toBe(0);
  });
});
