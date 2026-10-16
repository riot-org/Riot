import { describe, expect, it } from "vitest";

import { CELL_FLOOR_CAP_EM, cellFloorEm } from "./tableCellFloor";

describe("cellFloorEm", () => {
  it("短的中文格按整行宽度给下限", () => {
    // 7 个全角字符（括号也是全角）。
    expect(cellFloorEm("国家队（推断）")).toBe(7);
  });

  it("数字和拉丁字母按窄字宽估", () => {
    expect(cellFloorEm("600000")).toBeCloseTo(3.8);
    expect(cellFloorEm("+0.30%")).toBeCloseTo(3.8);
  });

  it("表头是粗体，略放宽", () => {
    expect(cellFloorEm("资金", true)).toBeGreaterThan(cellFloorEm("资金"));
  });

  it("长格封顶", () => {
    expect(cellFloorEm("沪深300ETF 成交额 160.9 亿 = 20 日均值 4.6 倍；上证 +0.24%")).toBe(
      CELL_FLOOR_CAP_EM,
    );
  });

  it("首尾空白不计", () => {
    expect(cellFloorEm("  键  ")).toBe(1);
    expect(cellFloorEm("")).toBe(0);
  });
});
