//! 文件改动列表:会话改动条和 Git 抽屉共用的渲染。
//!
//! 两个视图的数据形状相同(FileChange),差别只在来源和空态文案 ——
//! 逐文件的行、hunk、复制路径这些交互只写一份,两边不会慢慢长歪。
//!
//! 行是无边框的紧凑列表(Cursor 同款):图标认文件类型、颜色认状态,
//! 一屏能扫二十个文件。每行一个框的话,十个文件就把面板占满了。

import { useContext, useRef, useState } from "react";

import type { FileChange } from "../bridge";
import { type MessageKey, t, useT } from "../i18n";
import { joinRoot, looksAbsPath } from "../pathDisplay";
import { Chevron } from "./Chevron";
import { FileIcon } from "./FileIcon";
import { openFilePreview } from "./FilePreview";
import { ProjectRootContext } from "./Markdown";

const STATUS_LABEL: Record<FileChange["status"], MessageKey> = {
  created: "transcript.change.created",
  modified: "transcript.change.modified",
  deleted: "transcript.change.deleted",
  renamed: "transcript.change.renamed",
};

/** 状态字母(git 惯例)。"修改"是常态,不标 —— 只让例外跳出来。 */
const STATUS_MARK: Partial<Record<FileChange["status"], string>> = {
  created: "A",
  deleted: "D",
  renamed: "R",
};

export function FileChangeList({ changes }: { changes: FileChange[] }) {
  const { t } = useT();
  // 手风琴:同时只展开一个文件。review 是一份一份看的,开着上一份
  // 去点下一份,旧 diff 只会把新 diff 顶出视野,还得手动收。
  const [expanded, setExpanded] = useState<string | null>(null);
  /** 刚复制过路径的那一行。给"复制路径"按钮一个"已复制"的确认拍。 */
  const [copied, setCopied] = useState<string | null>(null);
  const copiedTimer = useRef<number | undefined>(undefined);
  /** 改动路径是相对项目根的，预览要拼成绝对的。 */
  const root = useContext(ProjectRootContext);

  const copyPath = (path: string) => {
    void navigator.clipboard.writeText(path).then(() => {
      setCopied(path);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(null), 1500);
    });
  };

  const toggle = (path: string) => setExpanded((cur) => (cur === path ? null : path));

  return (
    <>
      {changes.map((c) => {
        const open = expanded === c.path;
        const mark = STATUS_MARK[c.status];
        const { dir, name } = splitDisplayPath(c.path);
        return (
          <div className="change" key={c.path}>
            <button
              className="change-head"
              onClick={() => toggle(c.path)}
              type="button"
              aria-expanded={open}
              title={fullTitle(c)}
            >
              <FileIcon path={c.path} />
              <ChangePath dir={dir} name={name} deleted={c.status === "deleted"} />
              <span className="change-stat">
                <span className="add">+{c.added}</span>{" "}
                <span className="del">−{c.removed}</span>
              </span>
              {mark ? (
                <span className={`change-mark ${c.status}`} title={t(STATUS_LABEL[c.status])}>
                  {mark}
                </span>
              ) : null}
              <span className="change-head-grow" />
              {/* 操作钮平时藏着：扫列表时只要图标、路径、行数。
                  预览、复制在前，展开在最后 —— 点整行也能展开，箭头只是明示。 */}
              {c.status !== "deleted" ? (
                <span
                  className="change-copy"
                  role="button"
                  tabIndex={0}
                  title={t("transcript.change.preview")}
                  onClick={(e) => {
                    e.stopPropagation();
                    openFilePreview(looksAbsPath(c.path) ? c.path : joinRoot(root, c.path));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      openFilePreview(looksAbsPath(c.path) ? c.path : joinRoot(root, c.path));
                    }
                  }}
                >
                  <EyeIcon />
                </span>
              ) : null}
              <span
                className={copied === c.path ? "change-copy done" : "change-copy"}
                role="button"
                tabIndex={0}
                title={t("transcript.change.copyPath")}
                onClick={(e) => {
                  e.stopPropagation();
                  copyPath(c.path);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    copyPath(c.path);
                  }
                }}
              >
                {copied === c.path ? <CheckIcon /> : <CopyIcon />}
              </span>
              <Chevron open={open} />
            </button>

            {open ? <ChangeDetail c={c} /> : null}
          </div>
        );
      })}
    </>
  );
}

function ChangeDetail({ c }: { c: FileChange }) {
  const { t } = useT();
  // 没有逐行差异的三种情况要说清是哪种 —— 全都显示成空白的话,
  // 用户分不清"没改内容"和"比不出来"。
  if (c.binary) {
    return <div className="change-note">{t("transcript.change.binary")}</div>;
  }
  if (c.hunks.length === 0) {
    if (c.status === "renamed") {
      return (
        <div className="change-note">
          {t("transcript.change.renamedOnly")}
          {c.renamedFrom ? (
            <span className="change-note-from">
              {t("transcript.change.oldPath", { path: c.renamedFrom })}
            </span>
          ) : null}
        </div>
      );
    }
    return (
      <div className="change-note">
        {c.truncated ? t("transcript.change.noDiff") : t("transcript.change.unchanged")}
      </div>
    );
  }
  return (
    <div className="change-diff">
      {c.status === "renamed" && c.renamedFrom ? (
        <div className="change-note">{t("transcript.change.oldPath", { path: c.renamedFrom })}</div>
      ) : null}
      {c.hunks.map((h, i) => (
        <div className="hunk" key={i}>
          <div className="hunk-head">{h.header}</div>
          {h.lines.map((l, j) => (
            <div className={`hunk-line ${l.kind}`} key={j}>
              <span className="hunk-sign" aria-hidden>
                {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
              </span>
              <span className="hunk-text">{l.text || "\u00a0"}</span>
            </div>
          ))}
        </div>
      ))}
      {c.truncated ? (
        <div className="hunk-more">{t("transcript.change.truncated")}</div>
      ) : null}
    </div>
  );
}

/** 悬停提示:状态 + 全路径;重命名带上旧路径,一眼看全"从哪来到哪去"。 */
function fullTitle(c: FileChange): string {
  const status = t(STATUS_LABEL[c.status]);
  if (c.status === "renamed" && c.renamedFrom) {
    return t("transcript.change.titleRenamed", { status, from: c.renamedFrom, path: c.path });
  }
  return t("transcript.change.title", { status, path: c.path });
}

/**
 * 文件名在前、目录在后（VS Code 的写法）：扫一列改动时认的是文件名，
 * 目录只是区分同名文件的补充。目录用淡色小字跟在后面，放不下就自己
 * 截断 —— 文件名永远完整。
 *
 * 早先是"目录/文件名"整条等宽字，行一窄就整段拿掉目录（要量宽度、
 * 防抖重算）；文件名打头之后截断目录就够了，那套测量也不再需要。
 */
function ChangePath({
  dir,
  name,
  deleted,
}: {
  dir: string;
  name: string;
  deleted: boolean;
}) {
  return (
    <span className={deleted ? "change-path deleted" : "change-path"}>
      <span className="change-name">{name}</span>
      {dir ? <span className="change-dir">{dir}</span> : null}
    </span>
  );
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.4" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M10.5 5.5V4.2A1.7 1.7 0 0 0 8.8 2.5H4.2A1.7 1.7 0 0 0 2.5 4.2v4.6A1.7 1.7 0 0 0 4.2 10.5H5.5"
        stroke="currentColor"
        strokeWidth="1.3"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3.5 8.2L6.6 11.2 12.5 4.8"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M1.8 8s2.3-4.2 6.2-4.2S14.2 8 14.2 8s-2.3 4.2-6.2 4.2S1.8 8 1.8 8z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="1.9" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function splitDisplayPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf("/");
  if (slash < 0) return { dir: "", name: path };
  // 目录跟在文件名后面显示，末尾的斜杠去掉。
  return { dir: path.slice(0, slash), name: path.slice(slash + 1) };
}
