/**
 * 没有会话认领的 worktree：会话删了、worktree 因为有改动或没合并的提交
 * 留下来的。只列出来，删不删由用户定 —— 里面可能是没提交的活。
 */

import { useState } from "react";

import { describeError, type OrphanWorktree, revealInFinder } from "../bridge";
import { useT } from "../i18n";
import { revealInFileManagerLabel } from "../lib/platform";
import { Modal } from "./Modal";

export function OrphanWorktreesDialog({
  orphans,
  onDiscard,
  onClose,
}: {
  orphans: OrphanWorktree[];
  /** 删掉目录（分支只在已经合进别处时一起删）。抛错就留在框里显示。 */
  onDiscard: (path: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useT();
  /** 点过一次「删除」、等第二下确认的那一项。 */
  const [arming, setArming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const title = t("app.orphans.title");

  const discard = (path: string) => {
    setBusy(path);
    setError(null);
    onDiscard(path)
      .catch((e: unknown) => setError(describeError(e)))
      .finally(() => {
        setBusy(null);
        setArming(null);
      });
  };

  return (
    <Modal className="confirm orphan-dialog" label={title} onClose={() => busy === null && onClose()}>
      <div className="confirm-body">
        <h3>{title}</h3>
        <p>{t("app.orphans.body")}</p>
      </div>
      {orphans.length ? (
        <ul className="orphan-list">
          {orphans.map((o) => (
            <li key={o.path} className="orphan-row">
              <div className="orphan-main">
                <span className="orphan-branch">{o.branch ?? t("app.orphans.noBranch")}</span>
                <span className="orphan-path" title={o.path}>
                  {o.path}
                </span>
              </div>
              <div className="orphan-actions">
                <button type="button" onClick={() => void revealInFinder(o.path)}>
                  {revealInFileManagerLabel()}
                </button>
                {arming === o.path ? (
                  <button
                    type="button"
                    className="btn-danger"
                    disabled={busy !== null}
                    onClick={() => discard(o.path)}
                  >
                    {busy === o.path ? t("app.orphans.discarding") : t("app.orphans.confirmDiscard")}
                  </button>
                ) : (
                  <button type="button" disabled={busy !== null} onClick={() => setArming(o.path)}>
                    {t("common.delete")}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="dialog-status">{t("app.orphans.empty")}</p>
      )}
      {error ? (
        <p className="dialog-status error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="modal-actions">
        <button className="primary" autoFocus onClick={onClose} disabled={busy !== null}>
          {t("common.close")}
        </button>
      </div>
    </Modal>
  );
}
