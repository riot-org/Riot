//! 收尾卡片：模型在一轮做完时调用 NextStep 工具，这里照着它的输入画 ——
//! 两三句小结，需要用户拍板时再加一个问题和一到两个按钮。点按钮就是用户
//! 的回复（走组件 sendPrompt 的同一条路，忙时自动排队）。
//!
//! 卡片是"活的"还是"历史"由它在对话里的位置决定（见 lib/nextStep）：
//! 活的才有按钮；被回复过的标出回的是哪句；其余只剩小结。

import { memo, useContext, useEffect } from "react";

import { useT } from "../i18n";
import {
  type NextStepInput,
  NextStepContext,
  dismissNextStep,
  readNextStep,
  useNextStepDismissed,
} from "../lib/nextStep";
import { emitWidgetPrompt } from "../lib/widgetPrompt";

export const NextStepCard = memo(function NextStepCard({ id, input }: { id: string; input: unknown }) {
  const data = readNextStep(input);
  const { active, replies } = useContext(NextStepContext);
  const dismissed = useNextStepDismissed(id);
  if (!data) return null;
  const reply = replies.get(id);
  if (active === id && !dismissed) return <LiveCard id={id} data={data} />;
  return <PastCard data={data} reply={reply} />;
});

function LiveCard({ id, data }: { id: string; data: NextStepInput }) {
  const { t } = useT();
  const primary = data.options[0];

  // ⌘↵ / Ctrl+↵ 点主按钮 —— 只在输入框空着（或焦点不在任何输入框）时：
  // 打了字按 ⌘↵ 是要发自己那句，不能被卡片截走。
  useEffect(() => {
    if (!primary) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.isComposing) return;
      const el = document.activeElement;
      const editing =
        el instanceof HTMLElement &&
        (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA");
      if (editing) {
        const text = el.isContentEditable ? el.innerText : (el as HTMLInputElement).value;
        // 只认对话输入框；别的输入框（设置、搜索）里的 ⌘↵ 不归卡片。
        if (text.trim() || !el.closest(".composer")) return;
      }
      e.preventDefault();
      e.stopPropagation();
      emitWidgetPrompt(primary);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [primary]);

  return (
    <div className="next-step" role="region" aria-label={t("transcript.nextStep.label")}>
      <button
        type="button"
        className="next-step-close"
        title={t("transcript.nextStep.dismiss")}
        aria-label={t("transcript.nextStep.dismiss")}
        onClick={() => dismissNextStep(id)}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
          <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      <p className="next-step-recap">{data.recap}</p>
      {data.ask ? <p className="next-step-ask">{data.ask}</p> : null}
      {data.options.length ? (
        <div className="next-step-actions">
          {data.options.map((o, i) => (
            <button
              key={o}
              type="button"
              className={i === 0 ? "next-step-btn primary" : "next-step-btn"}
              onClick={() => emitWidgetPrompt(o)}
            >
              {o}
              {i === 0 ? (
                <kbd className="next-step-kbd" aria-hidden>
                  {/Mac/i.test(navigator.platform) ? "⌘↵" : "Ctrl ↵"}
                </kbd>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 不再是活的：小结留作历史，回过的标出回了哪句。 */
function PastCard({ data, reply }: { data: NextStepInput; reply: string | undefined }) {
  const { t } = useT();
  const picked = reply !== undefined && data.options.includes(reply.trim()) ? reply.trim() : null;
  return (
    <div className="next-step past">
      <p className="next-step-recap">{data.recap}</p>
      {picked ? <p className="next-step-replied">{t("transcript.nextStep.replied", { reply: picked })}</p> : null}
    </div>
  );
}
