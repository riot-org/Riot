/**
 * 对话列（`.chat-col`）的宽度档，挂成属性给 CSS 用：
 * `data-narrow` = 列宽 ≤ 768，`data-tight` = 列宽 ≤ 560（规则见 styles.css）。
 *
 * `[约束]` 不能换回 CSS 容器查询（`container-type` 挂在 `.chat-col` 上）。
 * WKWebView 里查询容器内部插入新元素时，会先在新元素还没有渲染对象的
 * 状态下把容器排一遍。生成结束那一下，直播思考和直播正文同时换成落定
 * 条目：旧的已经摘掉、新的还没排进来，对话流在那一刻只剩一屏高，
 * scrollTop 被夹到 0 —— 展开思考往上翻着读的人，整页跳回对话开头。
 * 这一下没有脚本写 scrollTop，Transcript 的锚点补偿拦不住，只能不当查询容器。
 *
 * 属性直接写在 DOM 上，不走 React 状态：拖侧栏 / 抽屉时宽度每帧在变，
 * 走状态就是每帧重渲染整个 App。ResizeObserver 在布局之后、绘制之前
 * 回调，改完属性浏览器在同一帧里重排，看不到中间态。
 */
const NARROW_MAX = 768;
const TIGHT_MAX = 560;

/**
 * `.chat-col` 的 ref 回调。模块级的同一个函数，React 只在挂载 / 卸载时
 * 调它（返回的清理函数在卸载时执行）—— 启动骨架阶段这一列还不存在，
 * 用 ref 对象配 effect 的话，挂载晚了就接不上。
 */
export function trackChatColWidth(el: HTMLDivElement | null) {
  if (!el) return;
  const apply = (width: number) => {
    el.toggleAttribute("data-narrow", width <= NARROW_MAX);
    el.toggleAttribute("data-tight", width <= TIGHT_MAX);
  };
  // 首帧就要对：等 ResizeObserver 的第一次回调的话，窄窗口第一帧是宽列的样式。
  apply(el.clientWidth);
  const ro = new ResizeObserver((entries) => {
    const e = entries[entries.length - 1];
    if (!e) return;
    apply(e.contentBoxSize?.[0]?.inlineSize ?? e.contentRect.width);
  });
  ro.observe(el);
  return () => ro.disconnect();
}
