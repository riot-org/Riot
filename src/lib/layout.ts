/**
 * 主窗口布局：各面板的尺寸约束、持久化键和读写。纯 UI 状态，存
 * localStorage，不进宿主配置。
 */

/** 布局尺寸的持久化键。存 localStorage —— 纯 UI 状态，不值得进宿主配置。 */
export const LS = {
  sidebar: "riot.layout.sidebar",
  sidebarOpen: "riot.layout.sidebarOpen",
  drawer: "riot.layout.drawer",
  term: "riot.layout.term",
  schedDetail: "riot.layout.schedDetail",
  recency: "riot.session.recency",
};

/** 侧栏按「最近聊过」排。纯 UI 顺序，不进宿主索引。 */
export function loadRecency(): Record<string, number> {
  try {
    const raw = localStorage.getItem(LS.recency);
    if (!raw) return {};
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object") return {};
    const out: Record<string, number> = {};
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
      if (typeof n === "number" && Number.isFinite(n)) out[k] = n;
    }
    return out;
  } catch {
    return {};
  }
}




export const SIDEBAR = { def: 280, min: 180, max: 420 };
/** 抽屉窄过这个值页面就没法看了，浏览器面板自己也有同样的下限。 */
export const DRAWER_MIN = 320;
export const TERM = { def: 260, min: 110 };
/** 定时任务详情（占用系统右侧栏的位置，宽度独立于工作台抽屉）。 */
export const SCHED_DETAIL = { def: 612, min: 500, max: 1008 };
/** 主区挤到底还要留的宽度。跟 .main 的 min-width 是同一个数。 */
export const MAIN_MIN = 280;

/** 抽屉的默认宽度跟着窗口走 —— 固定像素在小窗口上会把对话挤没。 */
export const drawerDefault = () => Math.round(window.innerWidth * 0.42);

/**
 * 右侧面板（工作台抽屉 / 任务详情）能拖到多宽。
 *
 * `[约束]` 上限必须按剩余空间算，不能只取窗口的一个比例。面板壳是
 * flex-shrink:0（开合动画得靠固定尺寸撑着），拖过头它不会被挤扁，而是把
 * 右缘顶出窗口、再被 .shell 的 overflow:hidden 裁掉 —— 表现就是面板跑到
 * 屏幕外面去了。所以得减掉左边两列真正占住的位置：侧栏（收起时为 0）
 * 加主区的下限。窗口窄到连 min 都塞不下时以 min 为准，让位给可用性。
 */
export function rightPanelMax(sidebar: number, min: number): number {
  return Math.max(min, window.innerWidth - sidebar - MAIN_MIN);
}

export function loadPx(key: string, fallback: number): number {
  const v = Number(localStorage.getItem(key));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function savePx(key: string, v: number) {
  localStorage.setItem(key, String(Math.round(v)));
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

