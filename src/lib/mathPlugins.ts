/**
 * 公式渲染（remark-math + rehype-katex）的按需加载。
 *
 * KaTeX 连同样式和字体几百 KB，大部分对话一个公式都没有 —— 和 mermaid
 * 一样动态加载：哪一段里第一次出现公式记号才去取，取回来之前那一段先按
 * 原文显示（就是一行 `$x$`），落地后所有等着的段落一起重画一次。
 */

import { useSyncExternalStore } from "react";
import type ReactMarkdown from "react-markdown";

type PluggableList = NonNullable<Parameters<typeof ReactMarkdown>[0]["remarkPlugins"]>;

export interface MathPlugins {
  remark: PluggableList;
  rehype: PluggableList;
}

let plugins: MathPlugins | null = null;
let loading: Promise<void> | null = null;
const subs = new Set<() => void>();

/** 这段文字里有没有可能是公式的记号。宁可多判（多加载一次），不能漏。 */
export function mayHaveMath(text: string): boolean {
  return text.includes("$") || text.includes("\\(") || text.includes("\\[");
}

function load(): void {
  if (loading) return;
  loading = Promise.all([
    import("remark-math"),
    import("rehype-katex"),
    import("katex/dist/katex.min.css"),
  ])
    .then(([rm, rk]) => {
      plugins = {
        // 单 `$` 交给 normalizeMath 按 Pandoc 规则判（见 lib/mathText），
        // remark-math 自己的配对会把「$5 涨到 $10」吃成公式。
        remark: [[rm.default, { singleDollarTextMath: false }]],
        // 写错的公式不抛错，原样标红显示 —— 一处笔误不该让整段回答渲染失败。
        rehype: [[rk.default, { throwOnError: false, strict: "ignore" }]],
      };
      for (const f of subs) f();
    })
    .catch(() => {
      // 取不到（离线的网页版、chunk 丢了）：保持原文显示，下次再试。
      loading = null;
    });
}

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

const snapshot = () => plugins;

/**
 * 需要公式时给插件（还没加载就触发加载，先返回 null）。不需要时返回 null，
 * 也不订阅 —— 没有公式的段落不因为别处加载完而白白重画。
 */
export function useMathPlugins(need: boolean): MathPlugins | null {
  if (need && !plugins) load();
  const p = useSyncExternalStore(need ? subscribe : noopSubscribe, snapshot, snapshot);
  return need ? p : null;
}

const noopSubscribe = () => () => {};
