/**
 * 弹层里的滚动。
 *
 * 弹层（下拉、子菜单）里的元素获得焦点或被 `scrollIntoView` 时，浏览器会
 * 把一路上能滚的祖先都滚一遍 —— 包括 `overflow: hidden` 的聊天区，用户还
 * 滚不回来。表现就是整块对话区、侧栏被推到左边、左侧内容被切掉。
 *
 * 所以弹层里一律：聚焦用 `focus({ preventScroll: true })`，要把某一项带进
 * 视野就用 {@link scrollIntoViewWithin} 只滚它所在的列表。菜单本身悬浮在
 * body 上、按窗口摆位，见 `components/pickers.tsx` 的 `useDropdown`。
 */

/**
 * 只滚 `container` 让 `el` 露出来，不碰任何祖先。`scrollIntoView` 会把
 * 一路上能滚的祖先都滚一遍（含 `overflow: hidden` 的），见文件头。
 */
export function scrollIntoViewWithin(container: HTMLElement, el: HTMLElement): void {
  const c = container.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (r.top < c.top) container.scrollTop -= c.top - r.top;
  else if (r.bottom > c.bottom) container.scrollTop += r.bottom - c.bottom;
}
