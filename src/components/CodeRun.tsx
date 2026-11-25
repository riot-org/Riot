//! 回答里命令代码块的「一键运行」：标题条上的运行 / 停止键，代码块底部
//! 的状态行和高风险确认。哪些块能跑、要不要确认见 lib/commandRun.ts；
//! 命令真正写进哪个终端、怎么知道跑完了见 TerminalPanel 的 startRun。
//!
//! 结果只给一句结论（成功 / 退出码 / 用时），失败时带最后几行输出 ——
//! 代码块下面不是第二个终端，完整输出点「查看终端」。

import { type ReactNode, useState } from "react";

import { useTimedFlag } from "../hooks/useTimedFlag";
import { useT } from "../i18n";
import {
  type RunRisk,
  TAIL_LINES,
  clipForShare,
  extractCommand,
  hasPlaceholder,
  isRunnableLang,
  runRisks,
  tailLines,
} from "../lib/commandRun";
import { type CommandRun, requestRun, shareRunOutput, useCommandRun } from "../lib/terminalRuns";
import { basename } from "../pathDisplay";
import { CopiedCheck, PlayIcon, StopIcon } from "./icons";

/** 被 Ctrl-C 打断的退出码（128 + SIGINT）。算「中断」不算「失败」。 */
const INTERRUPTED = 130;

export function useCodeRun({
  lang,
  source,
  root,
  open,
}: {
  lang: string;
  source: string;
  /** 项目目录：命令在这里跑。空 = 终端面板的默认目录。 */
  root: string;
  /** 代码块还没闭合（回答正在写这一块）：先别让跑，不然跑的是半截命令。 */
  open: boolean;
}): { button: ReactNode; footer: ReactNode } | null {
  const { t } = useT();
  const runnable = isRunnableLang(lang);
  const command = runnable ? extractCommand(lang, source) : "";
  const run = useCommandRun(command);
  const [confirm, setConfirm] = useState<RunRisk[] | null>(null);
  const [filled, flashFilled] = useTimedFlag(false, 2500);
  if (!command) return null;

  const placeholder = hasPlaceholder(command);
  const busy = run != null && run.phase !== "done";
  const go = (execute: boolean) => {
    setConfirm(null);
    requestRun({ kind: "run", command, root: root || null, execute });
    if (!execute) flashFilled(true);
  };
  const onRun = () => {
    // 有占位符：只填不跑，改好由用户自己回车。这时不用确认 —— 什么都还没执行。
    if (placeholder) return go(false);
    const risks = runRisks(command);
    if (risks.length) setConfirm(risks);
    else go(true);
  };

  let button: ReactNode;
  if (open) {
    button = (
      <button type="button" className="codeblock-copy codeblock-run" disabled title={t("transcript.run.waitStream")}>
        <PlayIcon />
        {t("transcript.run.run")}
      </button>
    );
  } else if (busy) {
    button = (
      <button
        type="button"
        className="codeblock-copy codeblock-run"
        title={t("transcript.run.stopTitle")}
        onClick={() => requestRun({ kind: "stop", command })}
      >
        <StopIcon />
        {t("transcript.run.stop")}
      </button>
    );
  } else if (placeholder) {
    button = (
      <button type="button" className="codeblock-copy codeblock-run" title={t("transcript.run.fillTitle")} onClick={onRun}>
        {filled ? <CopiedCheck /> : <PlayIcon />}
        {filled ? t("transcript.run.filled") : t("transcript.run.fill")}
      </button>
    );
  } else {
    button = (
      <button
        type="button"
        className={confirm ? "codeblock-copy codeblock-run on" : "codeblock-copy codeblock-run"}
        title={t("transcript.run.runTitle")}
        onClick={onRun}
        aria-expanded={confirm ? true : undefined}
      >
        {run?.phase === "done" ? <RerunIcon /> : <PlayIcon />}
        {run?.phase === "done" ? t("transcript.run.rerun") : t("transcript.run.run")}
      </button>
    );
  }

  let footer: ReactNode = null;
  if (confirm) {
    const dir = root ? basename(root) : "";
    footer = (
      <div className="run-confirm" role="alertdialog" aria-label={t("transcript.run.confirmTitle")}>
        <WarnIcon />
        <span className="run-confirm-text">
          {confirm.map((r) => t(`transcript.run.risk.${r}`, { n: command.split("\n").length })).join(t("transcript.run.riskSep"))}
          {dir ? t("transcript.run.confirmIn", { dir }) : t("transcript.run.confirm")}
        </span>
        <button type="button" className="run-btn" onClick={() => setConfirm(null)}>
          {t("common.cancel")}
        </button>
        <button type="button" className="run-btn primary" onClick={() => go(true)}>
          {t("transcript.run.run")}
        </button>
      </div>
    );
  } else if (run) {
    footer = <RunFooter run={run} command={command} />;
  }
  return { button, footer };
}

function RunFooter({ run, command }: { run: CommandRun; command: string }) {
  const { t } = useT();
  const view = (
    <button type="button" className="run-btn" onClick={() => requestRun({ kind: "focus", command })}>
      {t("transcript.run.viewTerm")}
    </button>
  );
  if (run.phase !== "done") {
    return (
      <div className="run-foot" data-state="running">
        <span className="run-dot" aria-hidden />
        <span className="run-status">
          {run.phase === "starting"
            ? t("transcript.run.starting")
            : t("transcript.run.running", { tab: run.tabTitle ?? t("panels.terminal.title") })}
        </span>
        {view}
      </div>
    );
  }

  const code = run.exitCode;
  const state = code === 0 ? "ok" : code === INTERRUPTED ? "stopped" : code == null ? "ended" : "fail";
  const took = run.endedAt ? formatDuration(run.endedAt - run.startedAt) : "";
  const label =
    state === "ok"
      ? t("transcript.run.ok")
      : state === "stopped"
        ? t("transcript.run.stopped")
        : state === "fail"
          ? t("transcript.run.exit", { code: String(code) })
          : t("transcript.run.ended");
  const tail = state === "fail" && run.output ? tailLines(run.output, TAIL_LINES) : "";

  const share = () => {
    const { text, clipped } = clipForShare(run.output ?? "");
    const head =
      code == null
        ? t("transcript.run.shareHead")
        : t("transcript.run.shareHeadCode", { code: String(code) });
    const body = text
      ? `${t("transcript.run.shareOutput")}${clipped ? t("transcript.run.shareClipped") : ""}\n\`\`\`\n${text}\n\`\`\``
      : t("transcript.run.shareNoOutput");
    shareRunOutput(`${head}\n\`\`\`bash\n${command}\n\`\`\`\n${body}\n`);
  };

  return (
    <div className="run-foot-wrap" data-state={state}>
      <div className="run-foot" data-state={state}>
        <span className="run-mark" aria-hidden>
          {state === "ok" ? <CopiedCheck /> : state === "fail" ? "✕" : "■"}
        </span>
        <span className="run-status">
          <span className="run-label">{label}</span>
          {took ? <span className="run-took"> · {t("transcript.run.took", { d: took })}</span> : null}
        </span>
        <button
          type="button"
          className={state === "fail" ? "run-btn primary" : "run-btn"}
          title={t("transcript.run.shareTitle")}
          onClick={share}
        >
          {t("transcript.run.share")}
        </button>
        {view}
      </div>
      {tail ? <pre className="run-tail">{tail}</pre> : null}
    </div>
  );
}

function formatDuration(ms: number): string {
  // `echo` 这种几毫秒的写成 0.0s 像是没跑。
  if (ms < 100) return "<0.1s";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function RerunIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M13.2 6.2A5.5 5.5 0 1 0 13.5 10M13.5 2.8v3.6H9.9"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function WarnIcon() {
  return (
    <svg className="run-warn-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 2.2 14.3 13.2H1.7L8 2.2z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M8 6.6v3M8 11.4v.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
