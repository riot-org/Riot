//! 任务清单：跑轮期间放在输入框上方的状态托盘里（见 composer/StatusTray），
//! 显示**最新一次** TodoWrite 的清单。
//!
//! 清单是状态不是事件 —— 模型每次更新进度都整表重传一遍，把每次调用都
//! 铺在对话流里，一个十步任务就是十张几乎相同的卡片。这里只画一份、
//! 就地更新（Cursor / Claude Code 同款）；对话流里的每次调用由 ToolCard
//! 降级成单行，点开才看当时的快照。
//!
//! 生命周期由外层（Chat）按 [`hasActiveTodos`] 控制：只在轮子跑着、
//! 且清单还有没做完的条目时进托盘 —— 全部完成或轮子结束就整个消失；
//! 切回已结束的会话也不会再冒出来。
//! 它是进行时的进度条，不是要留档的结果，回看走对话流里的工具卡。

import { useEffect, useMemo, useRef, useState } from "react";

import type { Item } from "../hooks/useSession";
import { useT } from "../i18n";
import type { TraySection } from "./composer/StatusTray";
import { PlanModeIcon } from "./icons";

/** TodoWrite 输入里的一项。宽松解析 —— 拿到什么画什么。 */
interface TodoEntry {
  content?: string;
  status?: string;
  activeForm?: string;
}

/**
 * items 里最后一次带完整清单的 TodoWrite。`callId` 是那次调用的
 * tool_use id —— 手动关闭按它记账（见下）。
 *
 * `[约束]` 必须跳过空清单的调用。正在流式写参数的那次调用，输入暂时
 * 只有边流边解出来的字符串字段（todos 是数组，解不出来）—— 不跳过的话，
 * 模型每次更新进度，面板都会先闪一下空白再恢复。
 */
function latest(items: Item[]): { callId: string; todos: TodoEntry[] } | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    // 清单之后「转到后台」过（分叉自己）：活连同清单交给了后台那份，
    // 前台这份从此不再更新，留在输入框上方就是一张永远停在半路的清单。
    // 进度改在后台任务那一行看（见 TaskPanel）。前台之后再建新清单
    // 照常显示 —— 它在分叉之后，倒序先遇到它。
    if (it?.kind === "tool" && isForkSelf(it)) return null;
    if (it?.kind !== "tool" || it.name !== "TodoWrite") continue;
    const input = it.input as Record<string, unknown>;
    if (Array.isArray(input?.todos) && input.todos.length > 0) {
      return { callId: it.id, todos: input.todos as TodoEntry[] };
    }
  }
  return null;
}

/** 「转到后台」那种分叉自己的 Task 调用（`resume: "self"`）。 */
function isForkSelf(it: Extract<Item, { kind: "tool" }>): boolean {
  return it.name === "Task" && (it.input as Record<string, unknown>)?.resume === "self";
}

/**
 * 清单里还有没做完的活吗。外层用它决定这一格给任务面板还是改动条 ——
 * 全部 completed 的清单没有进行时价值，不该继续占着输入框上方。
 */
export function hasActiveTodos(items: Item[]): boolean {
  const found = latest(items);
  return found !== null && found.todos.some((t) => t.status !== "completed");
}

/**
 * 托盘里的「任务」一类。`active` 由外层按 [`hasActiveTodos`] 和轮子是否在跑
 * 给；不在进行时返回 null，标签直接不出现。
 *
 * 标签上带「正在做的那步」—— 收着也看得到进度（早先折叠时也是这么做的）。
 * 进行中时默认展开（autoOpen）：跑轮时最想看的就是它。
 */
export function useTodoSection(items: Item[], active: boolean): TraySection | null {
  const { t, locale } = useT();
  const found = useMemo(() => latest(items), [items]);
  /**
   * 手动关闭记的是**那一次调用的 id**，不是一个布尔。模型再次更新清单
   * （新的调用、新的 id）时自己回来 —— 用户关掉的是"这份已经看完的清单"，
   * 不是永久放弃这个功能。
   */
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);

  // 引用要稳：输入框是 memo 的，流式输出时 items 每帧都换，这里每次都给新
  // 对象的话输入框跟着每帧重画（见 Composer.tsx）。一次 TodoWrite 调用的
  // 清单在参数写完后就定了（callId + todos 引用都不变），按它们算。
  const callId = found?.callId;
  const todos = found?.todos;
  return useMemo(() => {
    if (!active || !callId || !todos || callId === dismissedAt) return null;
    const done = todos.filter((x) => x.status === "completed").length;
    const doing = todos.find((x) => x.status === "in_progress");
    return {
      id: "todo",
      icon: <PlanModeIcon />,
      label: t("transcript.todo.title", { done, total: todos.length }),
      short: `${done}/${todos.length}`,
      ...(doing ? { extra: doing.activeForm ?? doing.content } : {}),
      live: true,
      autoOpen: done < todos.length,
      body: <TodoList todos={todos} />,
      dismiss: {
        title: t("transcript.todo.closeTitle"),
        onClick: () => setDismissedAt(callId),
      },
    } satisfies TraySection;
    // locale：换语言时文案要重取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, callId, todos, dismissedAt, locale]);
}

/** 展开后的清单。 */
function TodoList({ todos }: { todos: TodoEntry[] }) {
  const listRef = useRef<HTMLUListElement>(null);
  const doingIdx = todos.findIndex((x) => x.status === "in_progress");
  const done = todos.filter((x) => x.status === "completed").length;

  // 清单限了高会滚动，进度推进时把"进行中"那项带回视野 —— 20 步任务
  // 走到后半段，正在做的事不该藏在滚动条外面。
  useEffect(() => {
    const list = listRef.current;
    const item = list?.querySelector<HTMLElement>(".todo-item.in_progress");
    if (!list || !item) return;
    // 只动清单自己的 scrollTop。scrollIntoView 会沿着祖先链爬，
    // 把对话流也拽走 —— 任务推进时整页跟着跳。
    const top = item.offsetTop;
    const bottom = top + item.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight;
    }
  }, [doingIdx, done]);

  return (
    <ul className="todo-list" ref={listRef}>
      {/* key 用下标：清单是整表替换、条目只会在尾部增删，下标键让
          已有条目的 DOM 节点存续 —— 勾选动画靠 class 变化触发，
          节点换新的话每次更新整列都会重新闪一遍。 */}
      {todos.map((x, n) => (
        <li key={n} className={`todo-item ${x.status ?? "pending"}`}>
          <span className="todo-mark" aria-hidden>
            {x.status === "completed" ? "✓" : x.status === "in_progress" ? "◐" : "○"}
          </span>
          <span className="todo-text">
            {x.status === "in_progress" ? (x.activeForm ?? x.content) : x.content}
          </span>
        </li>
      ))}
    </ul>
  );
}
