import { type QueuedItem } from "../../hooks/useSession";
import { t, tn } from "../../i18n";
import { ArrowUpIcon, PencilIcon, TrashIcon } from "../icons";
import type { TraySection } from "./StatusTray";

/**
 * 托盘里的「排队」一类：模型跑动中发的插话停在这里（Cursor 同款交互），
 * 当前任务**完全跑完**才自动发出、变成对话气泡 —— 中途不插队。想立刻处理
 * 就点 ↑（停止当前轮，优先发这条）；也可以撤回编辑、删除。
 *
 * 默认展开（排在任务清单、在跑的后台任务之后）：排着的是用户自己刚说的
 * 话，得看得见、改得了。没有状态，所以是普通函数不是 hook。渲染时调用，
 * 文案按调用方订阅的语言取。
 */
export function queueSection(
  queued: QueuedItem[],
  onEdit: (id: string) => void,
  onSendNow: (id: string) => void,
  onDelete: (id: string) => void,
): TraySection | null {
  if (queued.length === 0) return null;
  return {
    id: "queue",
    icon: <span className="queue-ring" />,
    label: t("transcript.tray.queue", { count: queued.length }),
    hint: tn("composer.queue.count", queued.length),
    short: String(queued.length),
    autoOpen: true,
    body: (
      <div className="queue-panel">
        {queued.map((q) => (
          <div className="queue-row" key={q.id}>
            <span className="queue-ring" aria-hidden />
            <span className="queue-text">{q.text || t("composer.queue.imageOnly")}</span>
            {q.images.length > 0 ? (
              <span className="queue-imgs">{tn("composer.queue.images", q.images.length)}</span>
            ) : null}
            {q.refs.length > 0 ? <span className="queue-imgs">{tn("common.files", q.refs.length)}</span> : null}
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
        ))}
      </div>
    ),
  };
}
