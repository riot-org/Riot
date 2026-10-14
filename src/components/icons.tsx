/** 内联 SVG 图标。从 App.tsx 拆出 —— 纯展示，无状态。 */


/*
 * 布局开关（侧栏 / 右侧工作台）：矩形 + 一道分割线，线在哪边就是哪块
 * 面板（VS Code、Cursor、Codex 同一套画法）。终端开关不在这一家，用的是
 * 提示符（见 TerminalIcon）。
 *
 * `on` 时把那块面板填实（VS Code 的 layout-*-off / layout-* 同款）：开没开
 * 看图标本身就知道，不只靠按钮底色 —— 底色在某些主题和悬停态下几乎看
 * 不出差别。
 */

/** 侧边栏开关：矩形 + 左侧一道竖线。 */
export function SidebarToggleIcon({ on = false }: { on?: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6 2.5v11" stroke="currentColor" strokeWidth="1.3" />
      {on ? <path d="M6 2.5H3.5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2H6z" fill="currentColor" /> : null}
    </svg>
  );
}

/**
 * 浏览器：Chrome 的轮廓（内置浏览器跑的就是 Chromium）。
 *
 * 圆形在一排矩形图标里本身就够显眼，不用靠颜色 —— 旁边几个都是矩形
 * 加一道线，只差线的方向，扫一眼分不出谁是谁。
 */
export function BrowserIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9.5" />
      <circle cx="12" cy="12" r="4" />
      <path d="M21.17 8H12M3.95 6.06 8.54 14M10.88 21.94 15.46 14" />
    </svg>
  );
}

/**
 * 终端：提示符 `>_`。顶栏的终端开关和终端面板的标签共用这一个形状。
 *
 * 顶栏开关早先是"矩形 + 底部一道横线"（布局开关那一家）。那只说了"底下
 * 有块面板"，没说是什么；提示符一眼就是终端。
 */
export function TerminalIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3 4.5l3.5 3.5L3 11.5M8.5 12H13"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 右侧工作台开关：矩形 + 右侧一道竖线。 */
export function PanelRightIcon({ on = false }: { on?: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10.5 2.5v11" stroke="currentColor" strokeWidth="1.3" />
      {on ? <path d="M10.5 2.5h2a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-2z" fill="currentColor" /> : null}
    </svg>
  );
}

/**
 * Git 改动：折角文档里一个加号、一个减号（GitHub 的 file-diff 同款）。
 * 外形和 FileDocIcon 同一个文档轮廓。
 *
 * 早先是光秃秃的「±」三笔：读起来像打出来的数学符号，而且和旁边的浏览器
 * （整圆）、文件（整个轮廓）摆一列时分量轻得多，空落落的。
 */
export function DiffIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M9.2 1.8H4.5a1 1 0 0 0-1 1v10.4a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5.1L9.2 1.8z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M8 5.8v3.4M6.3 7.5h3.4M6.3 11.3h3.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** 文件预览开关：折角文档 + 两行正文。 */
export function FileDocIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M9.2 1.8H4.5a1 1 0 0 0-1 1v10.4a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5.1L9.2 1.8z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M9 2v3.3h3.4" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path
        d="M5.6 9h4.8M5.6 11.4h3.2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/**
 * 空会话上方的品牌标记：应用图标里那个 R，只留线条。
 *
 * 用的不是 icons/ 里那张位图 —— 那是给 Dock 和安装包用的立体图标，
 * 摆进这块纯色界面里像贴了一张贴纸。这里跟界面其余图标同一套语言：
 * 描边、圆角端点、颜色跟着 currentColor 走。
 *
 * 三笔各自成类，是为了让它动起来：这个 R 拆开看就是个小人 —— 上面
 * 的半圆是头、竖笔是身子、右下那折是腿，腿要能自己甩（见 .riot-mark）。
 */
export function RiotMark() {
  return (
    <svg className="riot-mark" width="42" height="42" viewBox="0 0 24 24" fill="none" aria-hidden>
      <g stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path className="riot-mark-body" d="M7.4 4.2v15.6" />
        <path className="riot-mark-head" d="M7.4 4.2h5A4.2 4.2 0 0 1 12.4 12.6H7.4" />
        <path className="riot-mark-leg" d="M11.6 12.6l5 4.9-2.7 2.3" />
      </g>
    </svg>
  );
}

export function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M1.5 4a1 1 0 011-1h3l1.5 1.5h6a1 1 0 011 1V12a1 1 0 01-1 1h-11a1 1 0 01-1-1V4z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

export function GearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2" />
      <path
        d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.1a2 2 0 0 1-1-1.74v-.47a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ArrowUpIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 13V3M3.5 7.5L8 3l4.5 4.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function StopIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <rect x="1.5" y="1.5" width="9" height="9" rx="1.5" fill="currentColor" />
    </svg>
  );
}

/** 「构建」键的三角：计划审完，开始跑。 */
export function PlayIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
      <path d="M3 1.8v8.4c0 .5.5.8.9.55l6.3-4.2a.65.65 0 0 0 0-1.1L3.9 1.25A.6.6 0 0 0 3 1.8z" fill="currentColor" />
    </svg>
  );
}

export function PencilIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M11.3 2.2a1.6 1.6 0 0 1 2.3 2.3l-8 8-3.1.8.8-3.1 8-8z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2.5 4.5h11M5.5 4.5V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.5M4 4.5l.7 8.6a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.6"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function DotsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <circle cx="3.5" cy="8" r="1.3" />
      <circle cx="8" cy="8" r="1.3" />
      <circle cx="12.5" cy="8" r="1.3" />
    </svg>
  );
}

/** 定时任务（侧栏一级菜单）。 */
export function ClockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M8 4.8V8l2.2 1.6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
/** 跳到另一处（任务详情里打开对应会话）。 */
export function ArrowOutIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M6 3.5H4.2A1.2 1.2 0 003 4.7v7.1c0 .66.54 1.2 1.2 1.2h7.1c.66 0 1.2-.54 1.2-1.2V10"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path
        d="M9 3.5h3.5V7M12.5 3.5L8 8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function EyeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M1.8 8s2.4-4.5 6.2-4.5S14.2 8 14.2 8s-2.4 4.5-6.2 4.5S1.8 8 1.8 8z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="1.9" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

/** 普通 agent：无穷符号（Cursor 同款）—— 边看边做，不设限地跑下去。 */
export function AgentModeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 12c-2-2.67-4-4-6-4a4 4 0 1 0 0 8c2 0 4-1.33 6-4Zm0 0c2 2.67 4 4 6 4a4 4 0 0 0 0-8c-2 0-4 1.33-6 4Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * 多任务：一根主干分出两条支线（fork）。
 *
 * 不用 ⑂ 字形：主字体里没有这个字符，回退字体的基线和主字体对不上，
 * 行盒被撑高，pill 就比 Agent / Plan 高出一两像素。三个记号都走 SVG，
 * 盒子尺寸才真正一致。
 */
export function MultitaskIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 13.2V8.4" />
        <path d="M8 8.4 4.2 4.6M8 8.4l3.8-3.8" />
        <circle cx="4.2" cy="3.4" r="1.3" />
        <circle cx="11.8" cy="3.4" r="1.3" />
        <circle cx="8" cy="13.3" r="1.3" />
      </g>
    </svg>
  );
}

/** 规划模式：条目清单。只在 pill 上标状态。 */
export function PlanModeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
        <path d="M2.6 4.4h.01M6 4.4h7.4" />
        <path d="M2.6 8h.01M6 8h7.4" />
        <path d="M2.6 11.6h.01M6 11.6h7.4" />
      </g>
    </svg>
  );
}

/** 下拉菜单选中项右侧的勾（Cursor 同款）。未选中时占位但不可见，保持各行对齐。 */
export function MenuPickCheck({ active }: { active: boolean }) {
  return (
    <svg
      className={active ? "menu-pick-check" : "menu-pick-check menu-pick-check--empty"}
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden
    >
      {active ? (
        <path
          d="M2.25 6.1 4.65 8.5 9.75 3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
    </svg>
  );
}

/**
 * 子 agent（子任务）。工作台标签、回答里的子任务链接共用这一枚，
 * 看到它就知道"这是一个子 agent"。不用 ⑂ 字形：主字体里没有这个字符，
 * 回退字体的笔画粗细和基线都和界面对不上。
 */
export function ForkIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="4" cy="3.5" r="1.7" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="12" cy="3.5" r="1.7" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="8" cy="12.5" r="1.7" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M4 5.2v1.3c0 1.2.8 2 2 2h4c1.2 0 2-.8 2-2V5.2M8 8.5v2.3"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}
