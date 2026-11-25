//! 回答里 ```diff 补丁块的「应用到文件」：标题条上一个「应用」，代码块底部
//! 回报结果（改了哪些文件、撤销）。真正的应用和路径校验在宿主
//! （src-tauri/src/patch_apply.rs）：路径出了项目、有一块对不上，都不动文件。
//!
//! 不弹确认：补丁内容就摆在用户眼前，而且随时能撤销。

import { type ReactNode, useState } from "react";

import { type PatchOutcome, applyPatch } from "../bridge";
import { useT } from "../i18n";
import { joinRoot } from "../pathDisplay";
import { openFilePreview } from "./FilePreview";
import { CopiedCheck } from "./icons";

const PATCH_LANGS = new Set(["diff", "patch"]);

/** 有 `--- 路径` / `+++ 路径` 文件头才知道改哪个文件；只有 +/- 行的片段不给应用。 */
export function isApplicablePatch(lang: string, source: string): boolean {
  if (!PATCH_LANGS.has(lang.toLowerCase())) return false;
  return /^(?:\+\+\+|---) (?!\/dev\/null)\S/m.test(source) && /^@@ /m.test(source);
}

type State =
  | { kind: "idle" }
  | { kind: "busy"; reverse: boolean }
  | { kind: "done"; outcome: PatchOutcome; reverse: boolean };

export function usePatchApply({
  lang,
  source,
  sessionId,
  root,
  open,
}: {
  lang: string;
  source: string;
  sessionId: string;
  root: string;
  /** 补丁还在写（围栏没闭合）：别让应用半截补丁。 */
  open: boolean;
}): { button: ReactNode; footer: ReactNode } | null {
  const { t } = useT();
  const [state, setState] = useState<State>({ kind: "idle" });
  if (!sessionId || !isApplicablePatch(lang, source)) return null;

  const run = (reverse: boolean) => {
    setState({ kind: "busy", reverse });
    applyPatch(sessionId, source, reverse).then(
      (outcome) => setState({ kind: "done", outcome, reverse }),
      (e: unknown) => setState({ kind: "done", outcome: { status: "failed", reason: String(e) }, reverse }),
    );
  };

  // 已经在文件里（刚应用过，或者之前应用过）：标题条上不再给「应用」。
  const inFile =
    state.kind === "done" &&
    !state.reverse &&
    (state.outcome.status === "applied" || state.outcome.status === "alreadyApplied");

  const button = inFile ? null : (
    <button
      type="button"
      className="codeblock-copy codeblock-run"
      disabled={open || state.kind === "busy"}
      title={open ? t("transcript.run.waitStream") : t("transcript.patch.applyTitle")}
      onClick={() => run(false)}
    >
      <ApplyIcon />
      {state.kind === "busy" && !state.reverse ? t("transcript.patch.applying") : t("transcript.patch.apply")}
    </button>
  );

  let footer: ReactNode = null;
  if (state.kind === "done") {
    const o = state.outcome;
    const files = o.status === "failed" ? [] : o.files;
    const fileList = (
      <span className="patch-files">
        {files.map((f, i) => (
          <span key={f}>
            {i > 0 ? t("transcript.patch.fileSep") : null}
            <button type="button" className="patch-file" onClick={() => openFilePreview(root ? joinRoot(root, f) : f)}>
              {f}
            </button>
          </span>
        ))}
      </span>
    );
    if (o.status === "failed") {
      footer = (
        <div className="run-foot-wrap" data-state="fail">
          <div className="run-foot" data-state="fail">
            <span className="run-mark" aria-hidden>
              ✕
            </span>
            <span className="run-status">
              <span className="run-label">
                {state.reverse ? t("transcript.patch.undoFailed") : t("transcript.patch.failed")}
              </span>
            </span>
          </div>
          <pre className="run-tail">{o.reason}</pre>
        </div>
      );
    } else if (state.reverse) {
      footer = (
        <div className="run-foot" data-state="ended">
          <span className="run-mark" aria-hidden>
            ■
          </span>
          <span className="run-status">{t("transcript.patch.undone")}</span>
        </div>
      );
    } else {
      footer = (
        <div className="run-foot" data-state="ok">
          <span className="run-mark" aria-hidden>
            <CopiedCheck />
          </span>
          <span className="run-status">
            {o.status === "applied"
              ? t("transcript.patch.applied", { n: files.length })
              : t("transcript.patch.already")}
            {" · "}
            {fileList}
          </span>
          <button type="button" className="run-btn" onClick={() => run(true)}>
            {t("transcript.patch.undo")}
          </button>
        </div>
      );
    }
  } else if (state.kind === "busy" && state.reverse) {
    footer = (
      <div className="run-foot" data-state="running">
        <span className="run-dot" aria-hidden />
        <span className="run-status">{t("transcript.patch.undoing")}</span>
      </div>
    );
  }
  return { button, footer };
}

function ApplyIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M3 8.5 6.4 12 13 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
