import { useState } from "react";

import { type QueuedItem } from "../../hooks/useSession";
import { useT } from "../../i18n";
import { Chevron } from "../Chevron";
import { ArrowUpIcon, PencilIcon, TrashIcon } from "../icons";

/**
 * 排队面板：模型跑动中发的插话停在这里（Cursor 同款交互），当前任务
 * **完全跑完**才自动发出、变成对话气泡 —— 中途不插队。想立刻处理就点
 * ↑（停止当前轮，优先发这条）；也可以撤回编辑、删除。
 */
export function QueuePanel({
  queued,
  onEdit,
  onSendNow,
  onDelete,
}: {
  queued: QueuedItem[];
  onEdit: (id: string) => void;
  onSendNow: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const { t, tn } = useT();
  const [open, setOpen] = useState(true);
  return (
    <div className="queue-panel">
      <button type="button" className="queue-head" onClick={() => setOpen((v) => !v)}>
        <Chevron open={open} />
        {tn("composer.queue.count", queued.length)}
      </button>
      {open
        ? queued.map((q) => (
            <div className="queue-row" key={q.id}>
              <span className="queue-ring" aria-hidden />
              <span className="queue-text" title={q.text}>
                {q.text || t("composer.queue.imageOnly")}
              </span>
              {q.images.length > 0 ? (
                <span className="queue-imgs">{tn("composer.queue.images", q.images.length)}</span>
              ) : null}
              {q.refs.length > 0 ? (
                <span className="queue-imgs" title={q.refs.join("\n")}>
                  {tn("common.files", q.refs.length)}
                </span>
              ) : null}
              <span className="queue-actions">
                <button
                  type="button"
                  title={t("composer.queue.edit.title")}
                  aria-label={t("common.edit")}
                  onClick={() => onEdit(q.id)}
                >
                  <PencilIcon />
                </button>
                <button
                  type="button"
                  title={t("composer.queue.sendNow.title")}
                  aria-label={t("composer.queue.sendNow")}
                  onClick={() => onSendNow(q.id)}
                >
                  <ArrowUpIcon />
                </button>
                <button
                  type="button"
                  title={t("common.delete")}
                  aria-label={t("common.delete")}
                  onClick={() => onDelete(q.id)}
                >
                  <TrashIcon />
                </button>
              </span>
            </div>
          ))
        : null}
    </div>
  );
}

