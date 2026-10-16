import { describe, expect, it } from "vitest";

import { browserOpenableFile, fileUrlOf, planPanelOpen, splitLinkIntent } from "./linkIntent";

describe("splitLinkIntent", () => {
  it("拆出前缀和目标", () => {
    expect(splitLinkIntent("browser:/Users/me/a.html")).toEqual({
      intent: "browser",
      rest: "/Users/me/a.html",
    });
    expect(splitLinkIntent("reveal:报告.html")).toEqual({ intent: "reveal", rest: "报告.html" });
    expect(splitLinkIntent("Browser:https://example.com")).toEqual({
      intent: "browser",
      rest: "https://example.com",
    });
  });

  it("没有前缀、空目标、双斜杠都不算", () => {
    expect(splitLinkIntent("/Users/me/a.html")).toBeNull();
    expect(splitLinkIntent("browser:")).toBeNull();
    expect(splitLinkIntent("browser://x")).toBeNull();
    expect(splitLinkIntent("https://example.com")).toBeNull();
  });
});

describe("browserOpenableFile", () => {
  it("只放网页本来会打开的格式", () => {
    expect(browserOpenableFile("/a/报告.html")).toBe(true);
    expect(browserOpenableFile("/a/b.PDF")).toBe(true);
    expect(browserOpenableFile("/Users/me/.ssh/id_rsa")).toBe(false);
    expect(browserOpenableFile("/a/.html")).toBe(false);
    expect(browserOpenableFile("/a/config.json")).toBe(false);
  });
});

describe("fileUrlOf", () => {
  it("逐段编码", () => {
    expect(fileUrlOf("/Users/me/Documents/报告 1.html")).toBe(
      "file:///Users/me/Documents/%E6%8A%A5%E5%91%8A%201.html",
    );
  });

  it("Windows 盘符", () => {
    expect(fileUrlOf("C:\\Users\\me\\a.html")).toBe("file:///C:/Users/me/a.html");
  });
});

describe("planPanelOpen", () => {
  const REPORT = fileUrlOf("/Users/me/Documents/报告.html");

  it("同一个地址已经开着就切过去，本地文件顺手刷新", () => {
    const state = {
      tabs: [
        { id: 1, url: "https://example.com/" },
        { id: 2, url: REPORT },
      ],
      active: 1,
    };
    expect(planPanelOpen(state, REPORT)).toEqual({ kind: "select", tab: 2, reload: true });
  });

  it("宿主报回编码过的地址、链接没编码，也认成同一个", () => {
    const state = { tabs: [{ id: 3, url: REPORT }], active: 3 };
    expect(planPanelOpen(state, "file:///Users/me/Documents/报告.html")).toEqual({
      kind: "select",
      tab: 3,
      reload: true,
    });
  });

  it("网页切过去但不刷新，末尾斜杠不算差别", () => {
    const state = { tabs: [{ id: 1, url: "https://example.com/" }], active: 1 };
    expect(planPanelOpen(state, "https://example.com")).toEqual({
      kind: "select",
      tab: 1,
      reload: false,
    });
  });

  it("没有页、或激活页是空白页，就地导航", () => {
    expect(planPanelOpen({ tabs: [], active: 0 }, REPORT)).toEqual({ kind: "navigate" });
    expect(planPanelOpen({ tabs: [{ id: 1, url: "" }], active: 1 }, REPORT)).toEqual({
      kind: "navigate",
    });
  });

  it("别的页开着就新开一页", () => {
    expect(
      planPanelOpen({ tabs: [{ id: 1, url: "https://example.com/" }], active: 1 }, REPORT),
    ).toEqual({ kind: "newTab" });
  });
});
