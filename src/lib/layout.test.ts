import { describe, expect, it } from "vitest";

import { DRAWER_MIN, MAIN_MIN, drawerDragLayout, sidebarPushCollapses } from "./layout";

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
