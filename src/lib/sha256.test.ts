import { describe, expect, it } from "vitest";

import { sha256Hex } from "./sha256";

const enc = new TextEncoder();

describe("sha256Hex", () => {
  it("标准测试向量", () => {
    expect(sha256Hex(new Uint8Array())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Hex(enc.encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  // 和宿主（sha2 crate）对不上，保存就永远报"文件被改过"。补位边界
  // （55 / 56 / 64 字节）和多块输入最容易错。期望值由 node:crypto 算出。
  it("补位边界和多块输入", () => {
    const expected: Record<number, string> = {
      1: "ca358758f6d27e6cf45272937977a748fd88391db679ceda7dc7bf1f005ee879",
      55: "8aa994584139d128848eeebc4e815639ba5ab6e6e39574195a63ac4f14f7c43b",
      56: "ad574708f75c044c9b85de64cb568ee7711ff4f36448c6242f053ba8f6cc2b63",
      63: "280ed3e8ff1df845b2e7dfe6ac6cee817bef20e783cc65abc41b818b4d2fe076",
      64: "c6ab9724ade5b6a7a1edfffb12f3aa9181351355af8fd08c919952ad211339dd",
      65: "788367c73c7ddf4c53f65e68cc0d943e6227ab55b0e78ba63ace822b1c6301c0",
      119: "3d610547d68216dedf7435a4fb6260353911f6b3fd3f18805ddb8be285d726fe",
      120: "1f80156a804cb7862ad113e8200e9d74499723e7c7854d5f48776d3148e09656",
      1000: "5097e7d587352f5097062ae679f37bda5802d9f875aba14c8cb4d1a188ada179",
      70000: "3500f58cfd1bd88e231edf56dca995542a702bd54525804e5a8604c8aa5cb52e",
    };
    for (const [n, hex] of Object.entries(expected)) {
      const data = new Uint8Array(Number(n)).map((_, i) => (i * 31 + 7) & 0xff);
      expect(sha256Hex(data), `len=${n}`).toBe(hex);
    }
    expect(sha256Hex(enc.encode("厦门钨业 PE 17.4\r\n﻿"))).toBe(
      "5ce6d16e8ce1ba7b610d9fc4eca9a5b1d2d5056b23dabeaef5fddaafba6828e7",
    );
  });
});
