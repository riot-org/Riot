import { describe, expect, it } from "vitest";

import { findBareLocalUrls, isLocalDevUrl, localUrlOfCode, normalizeLocalUrl } from "./localUrl";

describe("isLocalDevUrl", () => {
  it("回环地址算", () => {
    for (const u of [
      "http://localhost:5173/",
      "http://127.0.0.1:8080/api",
      "https://localhost",
      "http://[::1]:3000",
      "http://app.localhost:1420",
      "http://0.0.0.0:8000",
    ]) {
      expect(isLocalDevUrl(u), u).toBe(true);
    }
  });
  it("别的不算", () => {
    for (const u of ["https://example.com", "http://192.168.1.5:5173", "file:///tmp/a.html", "http://localhost.evil.com"]) {
      expect(isLocalDevUrl(u), u).toBe(false);
    }
  });
});

describe("localUrlOfCode", () => {
  it("行内代码里的完整网址", () => {
    expect(localUrlOfCode("http://localhost:5173")).toBe("http://localhost:5173");
    expect(localUrlOfCode("http://127.0.0.1:8080/api/health")).toBe("http://127.0.0.1:8080/api/health");
  });
  it("不带协议的要带端口", () => {
    expect(localUrlOfCode("localhost:3000")).toBe("http://localhost:3000");
    expect(localUrlOfCode("localhost")).toBeNull();
  });
  it("0.0.0.0 换成 localhost", () => {
    expect(localUrlOfCode("http://0.0.0.0:8000/")).toBe("http://localhost:8000/");
    expect(normalizeLocalUrl("0.0.0.0:8000")).toBe("http://localhost:8000");
  });
  it("命令、别的网址不算", () => {
    expect(localUrlOfCode("curl http://localhost:3000")).toBeNull();
    expect(localUrlOfCode("https://example.com")).toBeNull();
    expect(localUrlOfCode("npm run dev")).toBeNull();
  });
});

describe("findBareLocalUrls", () => {
  it("正文里不带协议的", () => {
    const r = findBareLocalUrls("服务起在 localhost:5173/admin，打开看看。");
    expect(r).toEqual([{ index: 5, text: "localhost:5173/admin", url: "http://localhost:5173/admin" }]);
  });
  it("句末标点不算进去", () => {
    expect(findBareLocalUrls("open localhost:3000.")[0]?.url).toBe("http://localhost:3000");
  });
  it("带协议的、没端口的、邮箱里的不管", () => {
    expect(findBareLocalUrls("http://localhost:3000")).toEqual([]);
    expect(findBareLocalUrls("跑在 localhost 上")).toEqual([]);
    expect(findBareLocalUrls("root@localhost:22")).toEqual([]);
  });
});
