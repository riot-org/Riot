import { memo, useEffect, useState } from "react";

import { type FileChange, sessionChanges } from "../bridge";
import { useT } from "../i18n";
import { Chevron } from "./Chevron";
import { FileChangeList } from "./FileChangeList";

/** 每个会话"关掉时的改动规模"。纯 UI 状态，存 localStorage —— 切会话、
 *  重启都记得，不然关掉的条切回来又冒出来。 */
const DISMISSED_KEY = "riot.changesBar.dismissed";
/** 最多记多少个会话。删掉的会话没人来清，封个顶免得无限长。 */
const DISMISSED_MAX = 200;

function loadDismissed(): Record<string, string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    const obj: unknown = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === "object" ? (obj as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function saveDismissed(sessionId: string, signature: string) {
  try {
    const all = loadDismissed();
    delete all[sessionId];
    all[sessionId] = signature;
    // 插入顺序即新旧顺序，超了从最老的砍。
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - DISMISSED_MAX))) delete all[k];
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(all));
  } catch {
    // 存不下就只在这次挂载里生效。
  }
}

/**
 * 输入框上方的"本次会话改动"条(Cursor 同款位置)。
 *
 * 回答的是"这个会话到底动了哪些行、有没有手滑多改" —— 基线是会话
 * 自己记的,不跟 git 走:commit 了它还在,直到会话结束都能回看。
 * 工作区维度的未提交改动在右侧抽屉的 Git 面板。
 *
 * 收起时只占一行(N 个文件 +x −y);点开在原地向上展开列表。没有
 * 改动时整条不出现 —— 一条常驻的"0 个文件"只是噪音。
 */
export const SessionChangesBar = memo(function SessionChangesBar({
  sessionId,
  /** 变一次就重新拉一次。外层把主 agent 的编辑落盘、子 agent 的收尾和
   *  编辑活动都编进去 —— 跑轮中的改动要实时长出来,不能等到轮子结束。 */
  refreshKey,
  paused = false,
}: {
  sessionId: string;
  refreshKey: string | number;
  /** 保活但不可见时别轮询。切回来 refreshKey 会再推一次。 */
  paused?: boolean;
}) {
  const { t, tn } = useT();
  const [changes, setChanges] = useState<FileChange[] | null>(null);
  const [open, setOpen] = useState(false);
  /**
   * 手动关掉时记下的是**那一刻的改动规模**，不是一个布尔：之后又改了
   * 文件（规模变了）条自己回来 —— 用户关掉的是"这些我看过了"，不是
   * 永久不要这个条。按会话记、落盘（见 DISMISSED_KEY）。
   */
  const [dismissedAt, setDismissedAt] = useState<string | null>(
    () => loadDismissed()[sessionId] ?? null,
  );
  useEffect(() => setDismissedAt(loadDismissed()[sessionId] ?? null), [sessionId]);

  useEffect(() => {
    if (paused) return;
    // alive 防的是快速切会话:先发的请求后返回,会把新会话的改动
    // 覆盖成旧会话的。
    let alive = true;
    sessionChanges(sessionId)
      .then((c) => {
        if (alive) setChanges(c);
      })
      .catch(() => {
        // 拉不到就保持上一次的列表。这是常驻小条,不值得为它弹错误 ——
        // 需要诊断时抽屉的 Git 面板会把错误显出来。
      });
    return () => {
      alive = false;
    };
  }, [sessionId, refreshKey, paused]);

  if (!changes?.length) return null;

  const total = changes.reduce(
    (acc, c) => ({ added: acc.added + c.added, removed: acc.removed + c.removed }),
    { added: 0, removed: 0 },
  );
  const signature = `${changes.length}:${total.added}:${total.removed}`;
  if (signature === dismissedAt) return null;

  return (
    <div className="changes-bar">
      {open ? (
        <div className="changes-bar-list">
          <FileChangeList changes={changes} />
        </div>
      ) : null}
      <div className="changes-bar-row">
        <button
          type="button"
          className="changes-bar-head"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          title={t("transcript.changesBar.title")}
        >
          <Chevron open={open} />
          <span className="changes-bar-title">
            {tn("transcript.changesBar.label", changes.length)}
          </span>
          <span className="changes-bar-stat">
            <span className="add">+{total.added}</span> <span className="del">−{total.removed}</span>
          </span>
        </button>
        <button
          type="button"
          className="todo-panel-close"
          onClick={() => {
            setOpen(false);
            setDismissedAt(signature);
            saveDismissed(sessionId, signature);
          }}
          title={t("transcript.changesBar.closeTitle")}
          aria-label={t("transcript.changesBar.close")}
        >
          ✕
        </button>
      </div>
    </div>
  );
});
