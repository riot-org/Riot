/**
 * 分叉确认框（见 docs/FORK_DESIGN.md「确认框」）：和原会话共用工作区，
 * 还是开一个新的 git worktree。数字（带几轮、分叉点之后又改过几个文件、
 * worktree 的分支名）来自宿主的预览。
 */

import { useEffect, useRef, useState } from "react";

import { type ForkPreviewOut, describeError, forkPreview } from "../bridge";
import { useT } from "../i18n";
import { Modal } from "./Modal";

/** 一次分叉请求：从哪个会话的哪条回答所在那一轮的结尾。 */
export interface ForkRequest {
  sessionId: string;
  /** 内核消息 id。 */
  messageId: string;
}

export function ForkDialog({
  req,
  onClose,
  onFork,
}: {
  req: ForkRequest;
  onClose: () => void;
  /** 真正去分叉。抛错就留在框里显示，用户可以换个选项再试。 */
  onFork: (worktree: boolean) => Promise<void>;
}) {
  const { t, tn } = useT();
  const [preview, setPreview] = useState<ForkPreviewOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [worktree, setWorktree] = useState(false);
  const [busy, setBusy] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let alive = true;
    forkPreview(req.sessionId, req.messageId)
      .then((p) => {
        if (!alive) return;
        setPreview(p);
        // 分叉点之后还有轮次时，共用工作区意味着新会话一开张磁盘就和它
        // 记得的不一样 —— 能建 worktree 就默认建。
        setWorktree(p.branch !== null && !p.latest);
        requestAnimationFrame(() => confirmRef.current?.focus());
      })
      .catch((e: unknown) => {
        if (alive) setError(describeError(e));
      });
    return () => {
      alive = false;
    };
  }, [req.sessionId, req.messageId]);

  const title = t("app.fork.title");
  const summary = preview ? tn("app.fork.turns", preview.turns) : null;

  const go = () => {
    setBusy(true);
    setError(null);
    onFork(worktree).catch((e: unknown) => {
      setError(describeError(e));
      setBusy(false);
    });
  };

  const git = preview?.branch ?? null;
  return (
    <Modal className="confirm fork-dialog" label={title} onClose={() => !busy && onClose()}>
      <div className="confirm-body">
        <h3>{title}</h3>
        <p>{summary ?? (error ? null : t("app.fork.loading"))}</p>
      </div>
      {preview ? (
        <div className="radio-opts" role="radiogroup" aria-label={title}>
          <button
            type="button"
            role="radio"
            aria-checked={!worktree}
            className="radio-opt"
            disabled={busy}
            onClick={() => setWorktree(false)}
          >
            <span className="radio-opt-title">{t("app.fork.shared")}</span>
            <span className="radio-opt-desc">{t("app.fork.sharedDesc")}</span>
            {preview.changedAfter > 0 ? (
              <span className="radio-opt-warn">
                {tn("app.fork.changedAfter", preview.changedAfter)}
              </span>
            ) : null}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={worktree}
            className="radio-opt"
            disabled={busy || git === null}
            onClick={() => setWorktree(true)}
          >
            <span className="radio-opt-title">
              {git ? t("app.fork.worktree", { branch: git }) : t("app.fork.worktreeNoGit")}
            </span>
            <span className="radio-opt-desc">
              {git === null
                ? t("app.fork.notGit")
                : t(preview.latest ? "app.fork.worktreeDescLatest" : "app.fork.worktreeDesc")}
            </span>
            {git !== null && !preview.hasSlice ? (
              <span className="radio-opt-warn">{t("app.fork.noSlice")}</span>
            ) : null}
            {git !== null ? <span className="radio-opt-note">{t("app.fork.worktreeNote")}</span> : null}
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="dialog-status error" role="alert">
          {error}
        </p>
      ) : busy ? (
        <p className="dialog-status" role="status">
          {t(worktree ? "app.fork.workingWorktree" : "app.fork.working")}
        </p>
      ) : null}
      <div className="modal-actions">
        <button onClick={onClose} disabled={busy}>
          {t("common.cancel")}
        </button>
        <button ref={confirmRef} className="primary" disabled={!preview || busy} onClick={go}>
          {t("app.fork.confirm")}
        </button>
      </div>
    </Modal>
  );
}
