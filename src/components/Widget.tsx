//! 回答里的 HTML / SVG 组件：```widget（HTML，可以带脚本、可以交互）和
//! ```svg 直接画出来，```html 默认仍是代码、可以切到预览。
//!
//! 组件在沙箱 iframe 里跑（页面和隔离方式见 src-tauri/src/widget_frame.rs
//! 和 src-tauri/assets/widget-frame.html）。这边负责：
//!
//! - 把源码和 Riot 的主题色发进去，切主题时跟着换；
//! - 按组件回报的高度撑开 iframe，不出现内层滚动条；
//! - 组件里的按钮调 `sendPrompt` → 作为用户消息发出去（见 acceptPrompt
//!   的把关），点链接 → 系统浏览器。

import { type ReactNode, useEffect, useRef, useState } from "react";

import { openInBrowser } from "../bridge";
import { useT } from "../i18n";
import { emitWidgetPrompt } from "../lib/widgetPrompt";
import { type Theme, useTheme } from "../theme";

export type WidgetKind = "html" | "svg";

/** 沙箱页的地址：桌面版走自定义协议，网页版走远程服务（开发时是 Vite）的路由。 */
function frameUrl(): string {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    return /Win/i.test(navigator.userAgent) ? "http://riot-widget.localhost/" : "riot-widget://localhost/";
  }
  return `${location.origin}/__riot_widget`;
}

/**
 * 发进组件的颜色。组件读的是 Riot 自己的 token 名（--bg、--text、--accent
 * ……），另外给几组常见的别名 —— 模型照别处组件的写法用 --text-primary、
 * --surface-1 之类时也能对上，不至于深色主题里一片黑字。
 */
const TOKENS = [
  "--bg",
  "--bg-side",
  "--bg-card",
  "--bg-hover",
  "--border",
  "--border-strong",
  "--text",
  "--text-dim",
  "--text-faint",
  "--accent",
  "--ok",
  "--danger",
  "--warn",
] as const;

const ALIASES: Record<string, (typeof TOKENS)[number]> = {
  "--text-primary": "--text",
  "--text-secondary": "--text-dim",
  "--text-muted": "--text-faint",
  "--text-accent": "--accent",
  "--text-success": "--ok",
  "--text-danger": "--danger",
  "--text-warning": "--warn",
  "--surface-0": "--bg-side",
  "--surface-1": "--bg",
  "--surface-2": "--bg-card",
  "--bg-neutral": "--bg-card",
  "--border-default": "--border",
};

function themeVars(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};
  for (const k of TOKENS) vars[k] = cs.getPropertyValue(k).trim();
  for (const [alias, k] of Object.entries(ALIASES)) vars[alias] = vars[k] ?? "";
  return vars;
}

/** 脚本还没跑完时占多高；组件回报了真实高度就按它来（最矮 MIN_H），
 *  最高 MAX_H（再高就在里面滚）。 */
const PLACEHOLDER_H = 48;
const MIN_H = 16;
const MAX_H = 2400;
/** 两次 sendPrompt 至少隔多久。按钮连点、脚本循环调用都挡在这里。 */
const PROMPT_GAP_MS = 1500;

export function WidgetFrame({
  kind,
  source,
  hidden = false,
  onMounted,
}: {
  kind: WidgetKind;
  source: string;
  /**
   * 藏起来但照常排版（visibility: hidden + 绝对定位，宽度不变）：切到源码时
   * 组件不卸载、状态都在；从源码切到预览时先在后台渲染、量好高度再露出来，
   * 页面只变一次，不会先塌成占位再一截截长高。不能用 display: none ——
   * 那样里面量不到尺寸，回报的高度是错的。
   */
  hidden?: boolean;
  /** 组件脚本跑完、高度已经回报过。 */
  onMounted?: () => void;
}) {
  const { t } = useT();
  const theme = useTheme();
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(PLACEHOLDER_H);
  const [mounted, setMounted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastPrompt = useRef(0);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const mountedRef = useRef(onMounted);
  mountedRef.current = onMounted;

  const post = (msg: Record<string, unknown>) =>
    ref.current?.contentWindow?.postMessage({ riotHost: true, ...msg }, "*");

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const frame = ref.current;
      // 只认自己这个 iframe 发来的：对话里可能有好几个组件。
      if (!frame || e.source !== frame.contentWindow) return;
      const m = e.data as { riotWidget?: boolean; type?: string } & Record<string, unknown>;
      if (!m || m.riotWidget !== true) return;
      switch (m.type) {
        case "ready":
          post({
            type: "render",
            kind,
            source: sourceRef.current,
            vars: themeVars(),
            scheme: document.documentElement.dataset.theme ?? "dark",
          });
          break;
        case "height": {
          const h = Number(m.height);
          if (Number.isFinite(h)) setHeight(Math.min(MAX_H, Math.max(MIN_H, Math.ceil(h))));
          break;
        }
        case "mounted":
          setMounted(true);
          mountedRef.current?.();
          break;
        case "error":
          setError((prev) => prev ?? String(m.message ?? "").slice(0, 200));
          break;
        case "prompt":
          if (typeof m.text === "string") acceptPrompt(frame, m.text);
          break;
        case "open":
          if (typeof m.url === "string" && /^https?:\/\//i.test(m.url)) void openInBrowser(m.url).catch(() => {});
          break;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // kind 不会变（变了是另一个组件），源码变化不重挂（见 sourceRef）。
  }, [kind]);

  /**
   * 组件要替用户发一句话。
   *
   * 组件是模型写的，而模型可能被网页、文件里的内容带偏 —— 不能让一段脚本
   * 加载完就自己替用户发消息。所以只认「用户刚在这个组件里点过」：点进
   * iframe 时焦点会落到它身上，脚本自己做不到这一点（跨源 iframe 不能在
   * 没有用户操作时抢焦点）。再加一道频率限制。
   */
  const acceptPrompt = (frame: HTMLIFrameElement, text: string) => {
    if (document.activeElement !== frame) return;
    const now = Date.now();
    if (now - lastPrompt.current < PROMPT_GAP_MS) return;
    lastPrompt.current = now;
    emitWidgetPrompt(text.trim());
  };

  // 切主题：颜色 token 换了，发进去。组件不重挂，状态（滑块、输入）都还在。
  useEffect(() => {
    if (!mounted) return;
    post({ type: "theme", vars: themeVars(), scheme: theme satisfies Theme });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);

  return (
    <div className={hidden ? "widget-body widget-hidden" : "widget-body"} aria-hidden={hidden || undefined}>
      <iframe
        ref={ref}
        className={mounted ? "widget-frame ready" : "widget-frame"}
        src={frameUrl()}
        // 只给脚本。没有 allow-same-origin：不透明 origin，碰不到 Riot 的界面
        // 和存储；没有 allow-popups / allow-forms / allow-top-navigation。
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        title={t("transcript.widget.title")}
        style={{ height }}
      />
      {error ? <div className="widget-error">{t("transcript.widget.error", { message: error })}</div> : null}
    </div>
  );
}

/** 组件还在写（围栏没闭合）时的占位：不把几百行源码刷一遍给用户看。 */
export function WidgetPending({ lines }: { lines: number }): ReactNode {
  const { t } = useT();
  return (
    <div className="widget-pending" role="status">
      <span className="run-dot" aria-hidden />
      {t("transcript.widget.pending", { n: lines })}
    </div>
  );
}
