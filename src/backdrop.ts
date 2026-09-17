/**
 * 侧栏磨砂底的门控：`<html data-vibrancy="mac" | "win">`。
 *
 * 侧栏的磨砂来自窗口那层系统材质（macOS 是 NSVisualEffectView 的 sidebar，
 * Windows 是 DWM 的 mica，见 src-tauri/src/vibrancy.rs）。要透出材质，页面得
 * 先把自己的背景让开（styles.css 的 `[data-vibrancy]`）—— 而这只能在材质
 * **真的铺上了**的时候干：
 *
 * - Linux 那层不存在，透掉只会露出窗口底下的桌面。
 * - Windows 上材质要 Win11 22H2（DWMSBT）。旧系统上宿主关了逐像素 alpha，
 *   透明像素按**预乘** RGB 合成：浅色主题 30% 的 #f3f3f3 出来是一块 #494949，
 *   深灰的字压在上面看不见 —— Win10 22H2 上侧栏整块发黑就是这个。
 *
 * 材质在不在，页面自己判不了：UA 里 Win10 和 Win11 都是 "Windows NT 10.0"。
 * 由宿主告诉它，分两步：建窗时按系统版本注一个首帧提示
 * （`window.__RIOT_BACKDROP__`，页面脚本跑之前就在），`setAppearance` 的
 * 回话再给真值（DWM 真试过的结果）校正。前者保证首帧不闪，后者是事实来源。
 *
 * 属性带值是因为两边的材质深浅不同，侧栏的不透明度要分开调（styles.css）。
 * macOS 的判断跟顶栏给红绿灯让位那处保持一致（App.tsx 的 IS_MAC）。
 */

declare global {
  interface Window {
    /** 宿主建窗时注入：这台机器上窗口底下有没有系统材质。浏览器里没有。 */
    __RIOT_BACKDROP__?: boolean;
  }
}

/** 这个平台的材质叫什么；没有材质的平台（Linux、浏览器）是 null。 */
function backdropKind(): "mac" | "win" | null {
  const ua = navigator.userAgent;
  if (ua.includes("Mac")) return "mac";
  if (ua.includes("Windows NT")) return "win";
  return null;
}

/** 宿主注入的首帧提示。没注（不该发生）按"macOS 有、别处没有"。 */
export function backdropHint(): boolean {
  return window.__RIOT_BACKDROP__ ?? backdropKind() === "mac";
}

/**
 * 按"材质在不在"挂 / 摘 `data-vibrancy`。幂等：首帧按提示挂一次，之后每次
 * `setAppearance` 回话再对一次。
 */
export function applyBackdrop(available: boolean): void {
  const kind = backdropKind();
  if (available && kind) {
    document.documentElement.dataset.vibrancy = kind;
  } else {
    delete document.documentElement.dataset.vibrancy;
  }
}
