/**
 * 展开/收起箭头。用方盒包 SVG，旋转中心就是几何中心 ——
 * 文字 ▸ 的字框上下不对称，转 90° 会看起来在绕圈。
 *
 * `down`：下拉菜单用，默认朝下，打开再翻朝上。
 * `up`：内容往上展开的（标题在下、列表长在上面，如输入框上方的改动条）。
 *   收着和其他折叠行一样朝右，展开转朝上 —— 指向内容长出来的方向。
 * `solid`：实心三角（侧栏项目头），默认朝右，展开转朝下。
 */
export function Chevron({
  open,
  down,
  up,
  solid,
}: {
  open?: boolean;
  down?: boolean;
  up?: boolean;
  solid?: boolean;
}) {
  const cls = ["chevron", down ? "down" : "", up ? "up" : "", solid ? "solid" : "", open ? "open" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={cls} aria-hidden>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
        {solid ? (
          <path
            d="M6 4.5L10.5 8L6 11.5Z"
            fill="currentColor"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        ) : (
          <path
            d="M6 3.5L10.5 8L6 12.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </svg>
    </span>
  );
}
