/**
 * 上下文占用环：还能聊多久，一眼看到。
 *
 * `[取舍]` 环显示的是**当前占用**（最近一次请求真实发出去的量），不是本会话
 * 累计。累计只增不减，聊到后面永远是满的，说明不了"现在还剩多少" —— 而那
 * 才是用户看这个东西的原因。累计花费移进点开的明细里，一键可达。
 *
 * 分母取**模型窗口**（和 Claude / Codex 一样，300K 的窗口就显示 300K），
 * 压缩点在进度条上单独标出来。没配窗口的模型不知道窗口多大，退回用压缩阈值。
 *
 * 变色仍按"离压缩点多近"算，不按窗口占比：内核给模型的用量提示是相对压缩
 * 阈值的，两边要在同一刻变档（见 `WARN_PCT`）。
 *
 * 点开时向内核要一次分类明细（系统提示词、工具、记忆文件、消息……，照
 * Claude 的上下文面板）。明细是估算，拿不到就只显示上面那几行 —— 当前
 * 占用本身来自服务方的 usage，不依赖它。
 */

import { useEffect, useState } from "react";

import { type ContextBreakdown, sessionContextBreakdown } from "../bridge";
import { useT } from "../i18n";
import { type ContextRow, type ContextRowKey, layoutBreakdown } from "../lib/contextBreakdown";
import { fmtTokens } from "../lib/contextWindow";
import { useDropdown } from "./pickers";

/** 环的半径与线宽（px）。够小以便和 pill 并排，又能看清缺口。 */
const R = 7;
const STROKE = 1.5;
const SIZE = (R + STROKE) * 2;
const CIRC = 2 * Math.PI * R;

/**
 * 变色的两道坎，取自内核环境档位（`riot-kernel` 的 `env::usage_band`，
 * 三档是 50 / 70 / 85）的后两档 —— 界面转色的那一刻，模型也正好收到同一
 * 档的提示。两边不对齐的话，用户会看到模型忽然开始收着做事，而界面上
 * 一点征兆都没有。
 */
const WARN_PCT = 70;
const DANGER_PCT = 85;

/** 百分比的显示：小于 1% 但不为 0 的写成 `<1%`，免得一排 0% 看着像没有。 */
function fmtPct(pct: number): string {
  if (pct <= 0) return "0%";
  if (pct < 1) return "<1%";
  return `${pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%`;
}

/** MCP 工具名 `mcp__服务器__工具` 显示成 `服务器 · 工具`；记忆文件是路径，原样。 */
function itemLabel(key: ContextRowKey, name: string): string {
  if (key !== "mcpTools") return name;
  return name.replace(/^mcp__/, "").split("__").join(" · ");
}

export function ContextRing({
  sessionId,
  used,
  threshold,
  totals,
  window: contextWindow,
}: {
  /** 明细按会话查。 */
  sessionId: string;
  /** 当前上下文占用。 */
  used: number;
  /** 到这个数就自动压缩。 */
  threshold: number;
  /** 本会话累计，明细里显示。 */
  totals: { input: number; output: number };
  /** 这个模型配的窗口，百分比和进度条的分母。没配就用 `threshold`。 */
  window?: number;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const { rootRef, onKeyDown } = useDropdown(open, setOpen);
  /** 明细：undefined = 还在拉，null = 拉不到（退回简版）。 */
  const [detail, setDetail] = useState<ContextBreakdown | null | undefined>(undefined);
  /** 展开着的那一行。延迟加载的 MCP 工具和计入的那行同名，单独给个键。 */
  const [expanded, setExpanded] = useState<ContextRowKey | "deferredMcp" | null>(null);

  // 每次打开现拉一次：明细跟着历史、MCP 连接、技能目录变，缓存住就会过期。
  // 关掉或换会话时丢掉在途的结果，免得旧会话的明细画到新会话的浮层里。
  useEffect(() => {
    if (!open) return;
    let live = true;
    setDetail(undefined);
    setExpanded(null);
    sessionContextBreakdown(sessionId).then(
      (b) => live && setDetail(b),
      () => live && setDetail(null),
    );
    return () => {
      live = false;
    };
  }, [open, sessionId]);

  const cap = contextWindow && contextWindow > threshold ? contextWindow : threshold;
  const pct = cap > 0 ? Math.min((used / cap) * 100, 100) : 0;
  /** 压缩点在进度条上的位置。分母就是阈值时它在最右端，不画。 */
  const markPct = cap > threshold ? (threshold / cap) * 100 : null;
  const toCompact = threshold > 0 ? (used / threshold) * 100 : 0;
  const level = toCompact >= DANGER_PCT ? "danger" : toCompact >= WARN_PCT ? "warn" : "";
  // 四舍五入到整数百分比，但别把"刚开始用"显示成 0% —— 有内容就至少 1%。
  const shown = used > 0 ? Math.max(Math.round(pct), 1) : 0;
  const layout = detail ? layoutBreakdown(detail, cap, threshold) : null;

  return (
    <div className="ctx-ring-wrap" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        className={level ? `ctx-ring ${level}` : "ctx-ring"}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("app.ctx.ariaLabel", { pct: shown })}
        title={t("app.ctx.title", {
          used: fmtTokens(used),
          threshold: fmtTokens(cap),
          pct: shown,
        })}
        onClick={() => setOpen(!open)}
      >
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden>
          <circle
            className="ctx-ring-track"
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={R}
            fill="none"
            strokeWidth={STROKE}
          />
          <circle
            className="ctx-ring-fill"
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={R}
            fill="none"
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={CIRC}
            // 起点在 12 点、顺时针增长。SVG 的 0° 在 3 点方向，靠样式表里
            // 给 svg 的 rotate(-90deg) 掰过来。
            strokeDashoffset={CIRC * (1 - pct / 100)}
          />
        </svg>
      </button>
      {open ? (
        <div className="ctx-panel" role="dialog" aria-label={t("app.ctx.usage")}>
          <div className="ctx-panel-head">
            <span className="ctx-panel-title">{t("app.ctx.usage")}</span>
            <span className={level ? `ctx-panel-pct ${level}` : "ctx-panel-pct"}>{shown}%</span>
          </div>
          <div className={layout ? "ctx-bar segmented" : "ctx-bar"}>
            {layout ? (
              // 分段条：各类别按占窗口的比例排开，剩余空间不画（就是底色）。
              layout.rows
                .filter((r) => r.key !== "freeSpace")
                .map((r) => (
                  <span
                    key={r.key}
                    className={`ctx-seg ctx-c-${r.key}`}
                    style={{ width: `${Math.min(r.pct, 100)}%` }}
                  />
                ))
            ) : (
              <span
                className={level ? `ctx-bar-fill ${level}` : "ctx-bar-fill"}
                style={{ width: `${pct}%` }}
              />
            )}
            {markPct !== null ? (
              <span
                className="ctx-bar-mark"
                style={{ left: `${markPct}%` }}
                title={t("app.ctx.note", { threshold: fmtTokens(threshold) })}
              />
            ) : null}
          </div>
          <dl className="ctx-rows">
            <div className="ctx-row">
              <dt>{t("app.ctx.current")}</dt>
              <dd>
                {fmtTokens(used)} / {fmtTokens(cap)}
              </dd>
            </div>
            <div className="ctx-row">
              <dt>{t("app.ctx.total")}</dt>
              <dd>
                ↑{fmtTokens(totals.input)} ↓{fmtTokens(totals.output)}
              </dd>
            </div>
          </dl>
          {detail === undefined ? <p className="ctx-loading">{t("app.ctx.loading")}</p> : null}
          {layout ? (
            <>
              <ul className="ctx-cats">
                {layout.rows.map((r) => (
                  <CategoryRow
                    key={r.key}
                    row={r}
                    open={expanded === r.key}
                    onToggle={() => setExpanded(expanded === r.key ? null : r.key)}
                  />
                ))}
              </ul>
              {layout.deferred.systemTools > 0 || layout.deferred.mcpTools.length > 0 ? (
                <div className="ctx-deferred">
                  <div className="ctx-deferred-head">{t("app.ctx.deferred")}</div>
                  <ul className="ctx-cats">
                    {layout.deferred.systemTools > 0 ? (
                      <CategoryRow
                        row={{ key: "systemTools", tokens: layout.deferred.systemTools, pct: 0 }}
                        open={false}
                        onToggle={() => {}}
                        deferred
                      />
                    ) : null}
                    {layout.deferred.mcpTools.length > 0 ? (
                      <CategoryRow
                        row={{
                          key: "mcpTools",
                          tokens: layout.deferred.mcpTools.reduce((n, i) => n + i.tokens, 0),
                          pct: 0,
                          items: layout.deferred.mcpTools,
                        }}
                        open={expanded === "deferredMcp"}
                        onToggle={() =>
                          setExpanded(expanded === "deferredMcp" ? null : "deferredMcp")
                        }
                        deferred
                      />
                    ) : null}
                  </ul>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 明细里的一行：色块、类别、token、占比；带清单的行能展开。 */
function CategoryRow({
  row,
  open,
  onToggle,
  deferred,
}: {
  row: ContextRow;
  open: boolean;
  onToggle: () => void;
  /** 延迟加载、不计入占用的行：不画色块、不写占比。 */
  deferred?: boolean;
}) {
  const { t } = useT();
  const label = t(`app.ctx.cat.${row.key}`);
  const body = (
    <>
      <span className={deferred ? "ctx-dot none" : `ctx-dot ctx-c-${row.key}`} aria-hidden />
      <span className="ctx-cat-name">{label}</span>
      <span className="ctx-cat-num">{fmtTokens(row.tokens)}</span>
      {deferred ? null : <span className="ctx-cat-pct">{fmtPct(row.pct)}</span>}
    </>
  );
  if (!row.items) {
    return (
      <li className="ctx-cat">
        <div className="ctx-cat-line">{body}</div>
      </li>
    );
  }
  return (
    <li className="ctx-cat">
      <button type="button" className="ctx-cat-line expandable" aria-expanded={open} onClick={onToggle}>
        {body}
        <span className={open ? "ctx-caret open" : "ctx-caret"} aria-hidden>
          ›
        </span>
      </button>
      {open ? (
        <ul className="ctx-items">
          {row.items.map((i) => (
            <li key={i.name} className="ctx-item-row" title={i.name}>
              <span className="ctx-item-name">{itemLabel(row.key, i.name)}</span>
              <span className="ctx-cat-num">{fmtTokens(i.tokens)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
