//! 状态托盘：输入框正上方的一行，收着任务清单、后台任务、排队消息、本次
//! 改动这几类"除了眼前这条回答，还有什么在进行 / 留下了什么"。
//!
//! 早先它们是各自独立的横条，同时出现时一层层叠起来（每条都有自己的框、
//! 标题和关闭键），把输入框越垫越高、对话区越来越小。托盘把它们收成一行
//! 标签：每类一个，标签上带一句摘要（3/7 + 正在做的那步、N 个文件 +x −y
//! ……），不展开也看得到进度；点标签在托盘里展开那一类，同一时间只展开
//! 一类。收着时不管有几类都只占一行。
//!
//! 每类的数据、关闭规则、展开内容都由它自己的 hook 给（useTodoSection /
//! useChangesSection / useTasksSection / queueSection），托盘只管排版和开合。
//! 需要用户处理的警告（没配 key、目录丢了、信任提示）不进托盘，仍在上方单独
//! 显示 —— 它们不是状态，是待办。

import { type ReactNode, useState } from "react";

export interface TraySection {
  /** 稳定的 id：展开状态按它记。 */
  id: "todo" | "tasks" | "queue" | "changes";
  icon: ReactNode;
  /** 标签主文案，尽量短，图标负责说明是哪一类（"任务 3/7"、"3 个文件"、"后台 2"）。 */
  label: string;
  /** 悬停提示里的完整说法（"本次改动 3 个文件"）。不给就用 label。 */
  hint?: string;
  /** 聊天区很窄时替代 label 的短写，只有数字（"3/7"、"5"），靠图标区分是哪类。 */
  short: string;
  /** 跟在主文案后面的淡色摘要（正在做的那步、+x −y）。 */
  extra?: ReactNode;
  /** 正在进行：标签前挂一个呼吸的点。 */
  live?: boolean;
  /** 展开后的内容。 */
  body: ReactNode;
  /**
   * 用户没手动开合过时，是否默认展开它。几类都想默认展开时按传进来的顺序取
   * 第一个（顺序即优先级：任务清单 > 后台任务 > 排队 > 改动）。
   */
  autoOpen?: boolean;
  /**
   * 标签上的 ×（悬停才出现，像浏览器标签页）：把这一类从托盘里拿掉，直到
   * 有新内容（清单更新、又改了文件、又有任务结束）再回来。各类"什么算新
   * 内容"不同，由各自的 hook 给；`title` 说清这一类什么时候回来。
   *
   * 放在标签自己身上，而不是标签行右端：那个角上的键看着像关掉整个面板
   * （甚至窗口），也说不清关的是哪一类。
   */
  dismiss?: { title: string; onClick: () => void };
}

/** 上次的顺序 + 这次在场的 id → 新顺序：留下的保持原位，新来的接在后面。
 *  没变时原样返回同一个数组（调用方拿引用判断要不要更新）。 */
export function arrivalOrder<T>(prev: readonly T[], present: readonly T[]): readonly T[] {
  const next = [...prev.filter((id) => present.includes(id)), ...present.filter((id) => !prev.includes(id))];
  return next.length === prev.length && next.every((id, i) => id === prev[i]) ? prev : next;
}

export function StatusTray({ sections }: { sections: TraySection[] }) {
  /**
   * 用户的选择：undefined = 没碰过，按 autoOpen 走；null = 主动全收起；
   * 其余是展开的那一类。选中的那类消失了（清单做完、改动被关掉）就回到
   * 自动 —— 否则托盘会卡在一个不存在的展开态上，什么都不显示。
   */
  const [choice, setChoice] = useState<TraySection["id"] | null | undefined>(undefined);
  /**
   * 标签按出现先后排：后冒出来的接在尾巴上，已有的不挪位置 —— 像标签页，
   * 不然新来一类就把别的往右挤，手正要点的那个跑了。消失的从顺序里拿掉，
   * 再出现时又排到最后。传进来的 `sections` 顺序只管"默认展开谁"的优先级。
   */
  const ids = sections.map((s) => s.id);
  const [order, setOrder] = useState<readonly TraySection["id"][]>(ids);
  const nextOrder = arrivalOrder(order, ids);
  if (nextOrder !== order) setOrder(nextOrder);
  if (sections.length === 0) return null;
  const shown = nextOrder.map((id) => sections.find((s) => s.id === id)).filter((s): s is TraySection => !!s);

  const auto = sections.find((s) => s.autoOpen)?.id ?? null;
  const openId =
    choice === undefined ? auto : choice === null ? null : sections.some((s) => s.id === choice) ? choice : auto;
  const open = sections.find((s) => s.id === openId);

  return (
    <div className={open ? "status-tray open" : "status-tray"}>
      <div className="tray-chips">
        {shown.map((s) => {
          const on = s.id === openId;
          return (
            <span key={s.id} className={s.dismiss ? "tray-tab closable" : "tray-tab"}>
              <button
                type="button"
                className={on ? "tray-chip on" : "tray-chip"}
                data-tray={s.id}
                aria-expanded={on}
                title={s.hint ?? s.label}
                onClick={() => setChoice(on ? null : s.id)}
              >
                <span className="tray-chip-icon" aria-hidden>
                  {s.icon}
                  {s.live ? <span className="tray-live-dot" /> : null}
                </span>
                <span className="tray-chip-label">{s.label}</span>
                {/* 窄屏只显示这一份（见 styles.css 的 .chat-col[data-tight]）。 */}
                <span className="tray-chip-short">{s.short}</span>
                {s.extra ? <span className="tray-chip-extra">{s.extra}</span> : null}
              </button>
              {s.dismiss ? (
                <button
                  type="button"
                  className="tray-chip-close"
                  title={s.dismiss.title}
                  aria-label={s.dismiss.title}
                  onClick={() => {
                    s.dismiss?.onClick();
                    if (on) setChoice(undefined);
                  }}
                >
                  <CloseIcon />
                </button>
              ) : null}
            </span>
          );
        })}
      </div>
      {/* key 跟着展开的那一类走：换一类时内容区重挂，入场动画重播一次。 */}
      {open ? (
        <div className="tray-body" key={open.id} data-tray={open.id}>
          {open.body}
        </div>
      ) : null}
    </div>
  );
}

function CloseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
