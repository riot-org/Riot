//! 回答里的表格：点表头排序、复制为 CSV、宽表横向滚动时首列钉住（样式在
//! styles.css 的 .md-table-wrap）。
//!
//! 排序在 React 这层做（重排 tbody 的子元素），不动 DOM —— Markdown 段落是
//! memo 的、流式期间还会重渲染，直接挪 DOM 节点会和 React 的对账打架。
//! 排序状态在组件里：回答重渲染（流式长出新行）时按同一列继续排着。

import {
  Children,
  type ReactElement,
  type ReactNode,
  cloneElement,
  isValidElement,
  useState,
} from "react";

import { useTimedFlag } from "../hooks/useTimedFlag";
import { useT } from "../i18n";
import { CopiedCheck } from "./icons";

type El = ReactElement<{ children?: ReactNode } & Record<string, unknown>>;

/** 行数少于这个不给排序：两三行一眼看完，表头上多一排箭头只是噪音。 */
const SORT_MIN_ROWS = 3;

function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

function elementsOf(node: ReactNode): El[] {
  return Children.toArray(node).filter(isValidElement) as El[];
}

/**
 * 能当数字比的就按数字比：千分位、百分号、货币符号、单位后缀都去掉。
 * 「1,234.5 元」「-3%」「$20」「12 ms」都认。
 */
function numberOf(s: string): number | null {
  const m = /^[^\d+\-.]*([+\-]?[\d,]*\.?\d+(?:e[+\-]?\d+)?)\s*[^\d\s]{0,4}$/i.exec(s.trim());
  if (!m?.[1]) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

const collator = new Intl.Collator(["zh-CN", "en"], { numeric: true, sensitivity: "base" });

function compareCells(a: string, b: string): number {
  // 空格子永远排在最后，不管正序倒序。
  if (!a.trim() || !b.trim()) return (a.trim() ? 0 : 1) - (b.trim() ? 0 : 1);
  const x = numberOf(a);
  const y = numberOf(b);
  if (x !== null && y !== null) return x - y;
  return collator.compare(a, b);
}

function csvCell(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function MdTable({ children, node: _node, ...props }: { children?: ReactNode; node?: unknown }) {
  const { t } = useT();
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const [copied, flashCopied] = useTimedFlag<"idle" | "ok" | "fail">("idle", 1500);

  const parts = elementsOf(children);
  const thead = parts.find((p) => p.type === "thead");
  const tbody = parts.find((p) => p.type === "tbody");
  const headRow = thead ? elementsOf(thead.props.children)[0] : undefined;
  const headCells = headRow ? elementsOf(headRow.props.children) : [];
  const rows = tbody ? elementsOf(tbody.props.children) : [];
  const sortable = headCells.length > 0 && rows.length >= SORT_MIN_ROWS;

  const cellTexts = (row: El) => elementsOf(row.props.children).map((c) => textOf(c.props.children).trim());
  const indexed = rows.map((row, i) => ({ row, i, cells: cellTexts(row) }));
  if (sort) {
    indexed.sort((a, b) => {
      const d = compareCells(a.cells[sort.col] ?? "", b.cells[sort.col] ?? "");
      // 相同的保持原顺序（稳定），倒序时也一样。
      return d === 0 ? a.i - b.i : d * sort.dir;
    });
  }

  // 点一次正序、再点倒序、第三次回到原顺序。
  const toggle = (col: number) =>
    setSort((s) => (s?.col !== col ? { col, dir: 1 } : s.dir === 1 ? { col, dir: -1 } : null));

  const head =
    thead && headRow && sortable
      ? cloneElement(thead, {
          children: cloneElement(headRow, {
            children: headCells.map((th, col) => {
              const on = sort?.col === col;
              return cloneElement(th, {
                key: col,
                className: on ? "md-th-sort on" : "md-th-sort",
                "aria-sort": on ? (sort.dir === 1 ? "ascending" : "descending") : "none",
                tabIndex: 0,
                title: t("transcript.table.sortTitle"),
                onClick: () => toggle(col),
                onKeyDown: (e: React.KeyboardEvent) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggle(col);
                  }
                },
                children: (
                  <>
                    {th.props.children}
                    {/* 箭头不参与文字排版（绝对定位在右侧内边距里，见 styles.css
                        的 .md-th-sort）：跟在文字后面的话，窄列（「排名」两个字）
                        里它会被挤到第二行。 */}
                    <span className="md-sort-mark" aria-hidden>
                      {on ? (sort.dir === 1 ? "↑" : "↓") : "↕"}
                    </span>
                  </>
                ),
              });
            }),
          }),
        })
      : thead;

  const body = tbody && sort ? cloneElement(tbody, { children: indexed.map((r) => r.row) }) : tbody;

  const copyCsv = () => {
    const lines = [headCells.map((c) => textOf(c.props.children).trim()), ...indexed.map((r) => r.cells)];
    const csv = lines.map((l) => l.map(csvCell).join(",")).join("\n");
    navigator.clipboard.writeText(csv).then(
      () => flashCopied("ok"),
      () => flashCopied("fail"),
    );
  };

  return (
    <div className="md-table-wrap">
      <table {...props}>
        {head}
        {body}
      </table>
      {headCells.length ? (
        <button type="button" className="md-table-copy" onClick={copyCsv}>
          {copied === "ok" ? (
            <>
              <CopiedCheck />
              {t("common.copied")}
            </>
          ) : copied === "fail" ? (
            t("transcript.md.copyFailed")
          ) : (
            t("transcript.table.copyCsv")
          )}
        </button>
      ) : null}
    </div>
  );
}
