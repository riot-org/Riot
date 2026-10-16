import { describe, expect, it } from "vitest";

import {
  DRAWER_MIN,
  MAIN_MIN,
  SIDEBAR,
  drawerDragLayout,
  rightShare,
  sidebarDragMax,
  sidebarPushCollapses,
} from "./layout";

describe("drawerDragLayout", () => {
  const sidebar = 280;
  const W = 1600;

  function wall(): number {
    return W - sidebar - MAIN_MIN;
  }

  it("only widens the drawer until the main column minimum", () => {
    window.innerWidth = W;
    const r = drawerDragLayout(wall() - 40, sidebar, true);
    expect(r).toEqual({ drawer: wall() - 40, sidebarShown: null });
    expect(drawerDragLayout(wall(), sidebar, true).sidebarShown).toBeNull();
  });

  it("pushes the sidebar 1:1 past the wall while the main column stays put", () => {
    window.innerWidth = W;
    const r = drawerDragLayout(wall() + 100, sidebar, true);
    expect(r.drawer).toBe(wall() + 100);
    expect(r.sidebarShown).toBe(sidebar - 100);
    // 主区 = 窗口 - 左栏可见 - 抽屉，钉在下限
    expect(W - r.sidebarShown! - r.drawer).toBe(MAIN_MIN);
  });

  it("is reversible: dragging back restores the sidebar", () => {
    window.innerWidth = W;
    drawerDragLayout(wall() + 200, sidebar, true);
    expect(drawerDragLayout(wall() + 10, sidebar, true).sidebarShown).toBe(sidebar - 10);
    expect(drawerDragLayout(wall() - 1, sidebar, true).sidebarShown).toBeNull();
  });

  it("stops pushing at the floor", () => {
    window.innerWidth = W;
    const r = drawerDragLayout(W, sidebar, true, 84);
    expect(r.sidebarShown).toBe(84);
    expect(r.drawer).toBe(W - MAIN_MIN - 84);
    expect(drawerDragLayout(W, sidebar, true).sidebarShown).toBe(0);
  });

  it("holds at the wall when the sidebar cannot be pushed", () => {
    window.innerWidth = W;
    expect(drawerDragLayout(wall() + 80, sidebar, false)).toEqual({
      drawer: wall(),
      sidebarShown: null,
    });
  });

  it("uses the wider ceiling when the sidebar is closed", () => {
    window.innerWidth = W;
    expect(drawerDragLayout(W, 0, true)).toEqual({ drawer: W - MAIN_MIN, sidebarShown: null });
  });

  it("keeps the drawer from shrinking below its own minimum", () => {
    window.innerWidth = W;
    expect(drawerDragLayout(10, 0, false).drawer).toBe(DRAWER_MIN);
  });
});

describe("sidebarPushCollapses", () => {
  it("collapses when less than half is left showing", () => {
    expect(sidebarPushCollapses(139, 280)).toBe(true);
    expect(sidebarPushCollapses(140, 280)).toBe(false);
    expect(sidebarPushCollapses(270, 280)).toBe(false);
  });
});

describe("rightShare", () => {
  const W = 1600;

  it("keeps the right column's share of (window - sidebar) while the sidebar moves", () => {
    window.innerWidth = W;
    // 按下时：左栏 280，右列 528 → 占 1320 的 40%
    const ratio = 528 / (W - 280);
    expect(rightShare(ratio, 280, DRAWER_MIN)).toBe(528);
    // 左栏拖宽 100：可用 1220，右列跟着变成 488，主区也从 792 变成 732 —— 两栏一起让
    expect(rightShare(ratio, 380, DRAWER_MIN)).toBe(488);
    // 往回拖窄：右列一起长回来
    expect(rightShare(ratio, 180, DRAWER_MIN)).toBe(568);
  });

  it("never squeezes the main column below MAIN_MIN nor the right column below its min", () => {
    window.innerWidth = 1100;
    const big = rightShare(0.9, 180, DRAWER_MIN);
    expect(1100 - 180 - big).toBe(MAIN_MIN);
    expect(rightShare(0.05, 180, DRAWER_MIN)).toBe(DRAWER_MIN);
  });

  it("respects the panel's own max", () => {
    window.innerWidth = 3000;
    expect(rightShare(0.9, 180, 500, 1008)).toBe(1008);
  });
});

describe("sidebarDragMax", () => {
  it("leaves room for both the main and the right column minimums", () => {
    window.innerWidth = 1100;
    expect(sidebarDragMax(DRAWER_MIN)).toBe(1100 - MAIN_MIN - DRAWER_MIN);
  });

  it("is the usual max when there is plenty of room", () => {
    window.innerWidth = 1600;
    expect(sidebarDragMax(DRAWER_MIN)).toBe(SIDEBAR.max);
  });

  it("still keeps the main column minimum when no right column is open", () => {
    window.innerWidth = 900;
    expect(sidebarDragMax(0)).toBe(900 - MAIN_MIN);
  });

  it("never goes below the sidebar min on tiny windows", () => {
    window.innerWidth = 700;
    expect(sidebarDragMax(DRAWER_MIN)).toBe(SIDEBAR.min);
  });
});
