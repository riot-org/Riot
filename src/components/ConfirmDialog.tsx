import { type ReactNode, useState } from "react";

import { useT } from "../i18n";
import { Modal } from "./Modal";

/** 确认框里的一个单选项。 */
export interface ConfirmChoice {
  id: string;
  label: string;
  hint?: string;
}

/** 破坏性操作的确认内容。 */
export interface ConfirmRequest {
  title: string;
  /** 接受节点而不只是字符串 —— 调用方已经在往里塞代码片段。 */
  body: ReactNode;
  confirmLabel: string;
  /** 有 `choices` 时收到选中的那个 id。 */
  action: (choice?: string) => void;
  /** 默认 true。非破坏性确认（「知道了」）设 false，用主按钮而不是红色。 */
  danger?: boolean;
  /** 取消 / Esc / 点遮罩。确认走 `action`，不会进这里。 */
  onCancel?: () => void;
  /** 确认之前还要选一样（删 worktree 会话时「留着 / 一起删」）。 */
  choices?: ConfirmChoice[];
  /** 默认选中的。不给就是第一个。 */
  choice?: string;
}

/**
 * 破坏性操作的确认。默认焦点在"取消"，Esc / 点遮罩也是取消 ——
 * 一个习惯性的回车不应该完成一次删除。
 *
 * dialog 语义、焦点陷阱、Esc 分层都在 [`Modal`] 里 —— 确认框是
 * 破坏性操作的最后防线，读屏用户尤其不能听不到它。
 */
export function ConfirmDialog({
  c,
  portal,
  onClose,
}: {
  c: ConfirmRequest;
  /** 住在开合面板里时必须置真。理由见 [`Modal`] 的同名 prop。 */
  portal?: boolean;
  onClose: () => void;
}) {
  const { t } = useT();
  const [picked, setPicked] = useState(c.choice ?? c.choices?.[0]?.id);
  const cancel = () => {
    const fn = c.onCancel;
    onClose();
    fn?.();
  };
  return (
    <Modal className="confirm" label={c.title} alert onClose={cancel} portal={!!portal}>
      <div className="confirm-body">
        <h3>{c.title}</h3>
        <p>{c.body}</p>
      </div>
      {c.choices ? (
        <div className="radio-opts" role="radiogroup" aria-label={c.title}>
          {c.choices.map((o) => (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={picked === o.id}
              className="radio-opt"
              onClick={() => setPicked(o.id)}
            >
              <span className="radio-opt-title">{o.label}</span>
              {o.hint ? <span className="radio-opt-desc">{o.hint}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      <div className="modal-actions">
        <button autoFocus onClick={cancel}>
          {t("common.cancel")}
        </button>
        <button
          className={c.danger === false ? "primary" : "btn-danger"}
          onClick={() => {
            onClose();
            c.action(picked);
          }}
        >
          {c.confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
