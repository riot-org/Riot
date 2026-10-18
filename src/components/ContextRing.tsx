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
 */

import { useState } from "react";

import { useT } from "../i18n";
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

export function ContextRing({
  used,
  threshold,
  totals,
  window: contextWindow,
}: {
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

  const cap = contextWindow && contextWindow > threshold ? contextWindow : threshold;
  const pct = cap > 0 ? Math.min((used / cap) * 100, 100) : 0;
  /** 压缩点在进度条上的位置。分母就是阈值时它在最右端，不画。 */
  const markPct = cap > threshold ? (threshold / cap) * 100 : null;
  const toCompact = threshold > 0 ? (used / threshold) * 100 : 0;
  const level = toCompact >= DANGER_PCT ? "danger" : toCompact >= WARN_PCT ? "warn" : "";
  // 四舍五入到整数百分比，但别把"刚开始用"显示成 0% —— 有内容就至少 1%。
  const shown = used > 0 ? Math.max(Math.round(pct), 1) : 0;

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
          <div className="ctx-bar">
            <span className={level ? `ctx-bar-fill ${level}` : "ctx-bar-fill"} style={{ width: `${pct}%` }} />
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
          <p className="ctx-note">{t("app.ctx.note", { threshold: fmtTokens(threshold) })}</p>
        </div>
      ) : null}
    </div>
  );
}
