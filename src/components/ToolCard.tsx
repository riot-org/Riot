import { memo, startTransition, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { type BackgroundTaskView, readImage, renderUiText } from "../bridge";
import type { Item } from "../hooks/useSession";
import { t, tn, useT } from "../i18n";
import {
  openAgentTerminal,
  terminalIdFromResult,
  useRunningAgentTerminals,
} from "../lib/agentTerminals";
import { type AnsweredAsk, answeredAsk } from "../lib/askAnswer";
import { LEGACY_PLAN_TOOL, openPlanPanel, PLAN_TOOL, SWITCH_MODE_TOOL } from "../lib/plan";
import { agentIdFromResult, openSubagent, SubagentsContext } from "../lib/subagentLink";
import { Chevron } from "./Chevron";
import { PlanModeIcon } from "./icons";
import { useEscLayer } from "./Modal";
import { SmoothFold } from "./SmoothFold";

type Tool = Extract<Item, { kind: "tool" }>;

/** TodoWrite 输入里的一项。宽松解析 —— 界面拿到什么画什么。 */
interface TodoInput {
  content?: string;
  status?: string;
  activeForm?: string;
}

function todosOf(tool: Tool): TodoInput[] {
  const i = tool.input as Record<string, unknown>;
  return Array.isArray(i?.todos) ? (i.todos as TodoInput[]) : [];
}

/** 子 agent 结束态的一行：状态词，有步数就带上。 */
function finishedLabel(status: BackgroundTaskView["status"], toolUses: number): string {
  const word =
    status === "completed"
      ? t("transcript.task.status.completed")
      : status === "cancelled"
        ? t("transcript.task.status.cancelled")
        : t("common.failed");
  return toolUses ? `${word} · ${tn("transcript.steps", toolUses)}` : word;
}

/**
 * 一次工具调用。
 *
 * 默认折叠。展开的话，一次 `cargo build` 的输出就会把整个对话冲走 ——
 * 用户来这里是看模型在干什么，不是读日志。摘要行说清"做了什么、成没成"，
 * 想看细节再点开。
 *
 * memo：流式输出时 transcript 每帧重渲染，历史工具卡片不该跟着刷。
 */
export const ToolCard = memo(function ToolCard({
  tool,
  eager = false,
}: {
  tool: Tool;
  /**
   * 贴底的那几条立刻画详情。其余的等进视野再挂 —— Edit/Write 默认
   * 展开，长会话里几十份 diff 一起进 DOM 会把切回卡成白屏。
   */
  eager?: boolean;
}) {
  // 子 agent 有自己的卡：不折叠、不展开输出，点开是它的整个会话。
  if (tool.name === "Task") return <TaskCard tool={tool} />;
  // 计划也有自己的卡：标题 + 概述，点开是右侧抽屉里的计划面板。
  if (tool.name === PLAN_TOOL) return <PlanCard tool={tool} />;
  // 选择题答完之后留着原来那张卡，标出用户点的那项。还在等回答时对话
  // 底部有可点的那张（AskChoiceCard），这里只占一行。
  if (tool.name === "AskUserQuestion" && tool.status !== "running") {
    const answered = answeredAsk(tool.input, tool.status, tool.result);
    if (answered) return <AnsweredAskCard ask={answered} />;
  }
  return <PlainToolCard tool={tool} eager={eager} />;
});

/**
 * 答完的选择题：还是那张卡（同一个徽标、同一句问题），但它已经是一条
 * 记录、不能再点 —— 选项不再画成一个个带框的大按钮，收成一张紧凑的只读
 * 列表：点中的打勾、强调色，没选的变淡。自己写的那句另起一行，没作答的
 * 在卡尾说一声。
 */
const AnsweredAskCard = memo(function AnsweredAskCard({ ask }: { ask: AnsweredAsk }) {
  const { t } = useT();
  return (
    <div className="plan-card ask-card ask-card-answered" role="region" aria-label={t("transcript.ask.ariaLabel")}>
      <div className="plan-card-head">
        <span className="plan-card-badge">{t("transcript.ask.badge")}</span>
        <span className="plan-card-title">{ask.question}</span>
      </div>
      <ul className="ask-answers">
        {ask.options.map((o) => (
          <li key={o.id} className={ask.picked.includes(o.id) ? "on" : undefined}>
            {o.label}
          </li>
        ))}
        {ask.other ? <li className="on">{ask.other}</li> : null}
      </ul>
      {ask.unanswered ? <div className="ask-card-note">{t("transcript.ask.unanswered")}</div> : null}
    </div>
  );
});

/**
 * CreatePlan 的卡片（照 Cursor：对话里一张计划卡，正文在旁边的面板）。
 *
 * 卡上只放标题和一两句概述 —— 计划是要读的文档，几页纸铺进对话流会把
 * 对话本身冲走；整张卡是打开计划面板的入口。撰写中显示"正在撰写"，
 * 面板那边同步在流。
 */
const PlanCard = memo(function PlanCard({ tool }: { tool: Tool }) {
  const { t } = useT();
  const i = tool.input as Record<string, unknown>;
  const str = (k: string) => (typeof i?.[k] === "string" ? (i[k] as string) : "");
  const name = str("name").trim() || t("transcript.plan.untitled");
  const overview = str("overview").trim();
  const running = tool.status === "running";
  return (
    <div className={`tool tool-${tool.status} tool-plan`}>
      <button
        type="button"
        className="tool-head plan-tool-head"
        onClick={openPlanPanel}
        title={t("transcript.plan.open")}
      >
        <span className="plan-tool-icon" aria-hidden>
          <PlanModeIcon />
        </span>
        <span className="plan-tool-main">
          <span className="plan-tool-badge">
            {running ? t("transcript.plan.drafting") : t("transcript.plan.badge")}
            {running ? <span className="plan-caret" aria-hidden /> : null}
          </span>
          <span className="plan-tool-title">{name}</span>
        </span>
        {/* 概述另起一行、从图标那一列起排：它是整段话，不是标题的附注，
            缩进到标题下面会在图标底下空出一列。 */}
        {overview ? <span className="plan-tool-overview">{overview}</span> : null}
        {tool.status === "error" ? (
          <span className="plan-tool-overview tool-fail">{tool.result ?? t("common.failed")}</span>
        ) : null}
        <span className="task-card-go" aria-hidden>
          ›
        </span>
      </button>
    </div>
  );
});

/**
 * Task 工具的卡片（照 Cursor）：一行"标题 · 模型"，下面一行它此刻在做
 * 什么；整张卡是一个链接，点开右侧抽屉里它的完整会话。
 *
 * 数据来自会话的子 agent 登记表（SubagentsContext，按 tool_use_id 认领），
 * 卡片本身只知道输入参数。登记表跟着会话落盘，重启后照样认得；实在没有
 * 它（记录文件被删了、当时一条消息都没写下）就退回参数里的描述，agent id
 * 从结果文本里捞 —— 点开会看到"找不到记录"，但至少知道它存在过。
 */
const TaskCard = memo(function TaskCard({ tool }: { tool: Tool }) {
  const { t } = useT();
  const tasks = useContext(SubagentsContext);
  const task: BackgroundTaskView | undefined = tasks.find((x) => x.tool_use_id === tool.id);
  const i = tool.input as Record<string, unknown>;
  const str = (k: string) => (typeof i?.[k] === "string" ? (i[k] as string) : "");
  const title = task?.title || str("description") || t("transcript.task.subtask");
  const agentId = task?.id ?? agentIdFromResult(tool.result) ?? null;
  const resume = str("resume");
  const background = task?.background ?? (i?.run_in_background === true || resume === "self");
  const kind = task?.kind ?? (resume === "self" ? "fork" : str("subagent_type") || "general-purpose");
  // 运行状态以登记表为准（后台任务的卡片早就 ok 了，任务还在跑）；没有
  // 登记表时看卡片自己。
  const status: "running" | "ok" | "error" = task
    ? task.status === "running"
      ? "running"
      : task.status === "completed"
        ? "ok"
        : "error"
    : tool.status;
  const activity =
    status === "running"
      ? (task ? renderUiText(task.activity) : "") ||
        tool.output[tool.output.length - 1] ||
        t("transcript.task.starting")
      : task
        ? finishedLabel(task.status, task.tool_uses)
        : tool.status === "error"
          ? t("common.failed")
          : t("transcript.task.status.completed");

  const open = () => {
    if (agentId) openSubagent(agentId, title);
  };
  // 它派出去的子 agent，缩进挂在它下面（照 Cursor 的树形）。只挂直接
  // 孩子：孙子挂在孩子那一行下面，点进孩子的会话看。
  const children = agentId ? tasks.filter((x) => x.parent === agentId) : [];

  return (
    <div className={`tool tool-${status} tool-task`}>
      <button
        type="button"
        className="tool-head task-card-head"
        onClick={open}
        disabled={!agentId}
        title={agentId ? t("transcript.task.openSession") : t("transcript.task.noId")}
      >
        <span className={status === "running" ? "tool-icon tool-icon-spin" : "tool-icon"}>
          {status === "running" ? "◐" : status === "ok" ? "✓" : "✕"}
        </span>
        <span className="task-card-title">{title}</span>
        {task?.model ? <span className="task-card-model">{task.model}</span> : null}
        <span className="task-card-tags">
          <span className="task-kind">
            {kind === "explore"
              ? t("transcript.task.kind.explore")
              : kind === "fork"
                ? t("transcript.task.kind.fork")
                : resume
                  ? t("transcript.task.kind.resume")
                  : t("transcript.task.kind.run")}
          </span>
          {background ? <span className="task-kind">{t("transcript.task.background")}</span> : null}
        </span>
        {agentId ? <span className="task-card-go" aria-hidden>›</span> : null}
      </button>
      <div className="task-card-activity">
        {activity}
      </div>
      {children.length > 0 ? (
        <div className="task-card-children">
          {children.map((c) => (
            <ChildTaskRow key={c.id} task={c} tasks={tasks} depth={1} />
          ))}
        </div>
      ) : null}
    </div>
  );
});

/**
 * 子 agent 派的子 agent：一行标题 · 模型，下面一行动作，再往下递归挂它
 * 自己的孩子。整行可点，打开那个子 agent 的会话。
 */
function ChildTaskRow({
  task,
  tasks,
  depth,
}: {
  task: BackgroundTaskView;
  tasks: BackgroundTaskView[];
  depth: number;
}) {
  const { t } = useT();
  const running = task.status === "running";
  const icon = running ? "◐" : task.status === "completed" ? "✓" : "✕";
  const activity = running
    ? renderUiText(task.activity) || t("transcript.task.starting")
    : finishedLabel(task.status, task.tool_uses);
  const grandchildren = tasks.filter((x) => x.parent === task.id);
  return (
    <div className={`task-child task-child-${task.status}`}>
      <button
        type="button"
        className="task-child-head"
        onClick={() => openSubagent(task.id, task.title)}
        title={t("transcript.task.openSession")}
      >
        <span className={running ? "tool-icon tool-icon-spin" : "tool-icon"}>{icon}</span>
        <span className="task-card-title">{task.title}</span>
        <span className="task-card-model">{task.model}</span>
        <span className="task-card-tags">
          <span className="task-kind">
            {task.kind === "explore"
              ? t("transcript.task.kind.explore")
              : t("transcript.task.kind.run")}
          </span>
        </span>
        <span className="task-card-go" aria-hidden>
          ›
        </span>
      </button>
      <div className="task-card-activity">
        {activity}
      </div>
      {grandchildren.length > 0 && depth < 3 ? (
        <div className="task-card-children">
          {grandchildren.map((g) => (
            <ChildTaskRow key={g.id} task={g} tasks={tasks} depth={depth + 1} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

const PlainToolCard = memo(function PlainToolCard({
  tool,
  eager = false,
}: {
  tool: Tool;
  eager?: boolean;
}) {
  const { t } = useT();
  const [userToggle, setUserToggle] = useState<boolean | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(eager);
  // 图片结果（截图、读图）不靠展开看：摘要行右侧常驻一张缩略图，悬停
  // 放大、点击开查看器（照 Claude）。早先整张图默认铺开，连读几张图
  // 就把回答冲出屏幕，主次全乱；缩略图既告诉用户"图在这"，又不占地方。
  // Edit / Write 也默认收着（照 Claude）：摘要行带「+N −M」，改了多少
  // 一眼可见；diff 和写入内容点开再看。早先默认铺开，一轮改十个文件
  // 就是十大块 diff，把回答本身冲走。Delete 仍然展开：一个文件没了
  // 不该藏在折叠后面，而它展开也只有一句话。
  // 文本结果维持默认折叠 —— 一次 cargo build 的输出会把对话冲走。
  //
  // TodoWrite 刻意**不**默认展开：进度由输入框上方的常驻面板就地更新，
  // 对话流里的每次调用只是历史快照 —— 都展开的话，一个十步任务会在
  // 对话里铺十张几乎相同的清单。摘要行说清"几之几、正在干什么"，
  // 点开看的是"那一刻清单长什么样"。
  /**
   * 这张卡在眼前从运行中跑完了。只有这种时候状态图标才过渡（转圈 →
   * 弹出对勾 / 叉）；历史里水合出来的卡一挂上就是终态，动画在那里只是噪音。
   *
   * "在眼前"不限于这个实例：跑着的工具多半在折起的直播组里（卡片根本
   * 没挂载），跑完才还原成普通行、以终态挂上来 —— 所以挂载时还要问一句
   * 它是不是刚刚还在跑（见 seenRunning）。
   */
  if (tool.status === "running") noteToolRunning(tool.id);
  const [settleOnMount] = useState(
    () => tool.status !== "running" && seenRunning.has(tool.id),
  );
  const sawRunning = useRef(tool.status === "running");
  if (tool.status === "running") sawRunning.current = true;
  const settled = (sawRunning.current || settleOnMount) && tool.status !== "running";
  // 落定动画播过一次就从表里摘掉：之后因为分组变化重挂，不该再弹一次。
  useEffect(() => {
    if (tool.status !== "running") seenRunning.delete(tool.id);
  }, [tool.status, tool.id]);
  const open = userToggle ?? tool.name === "Delete";
  const detail = hasDetail(tool);
  const summary = summarize(tool);
  const stat = tool.status === "error" ? null : diffStat(tool);

  useEffect(() => {
    if (near) return;
    const el = cardRef.current;
    if (!el) return;
    const root = el.closest(".transcript");
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          startTransition(() => setNear(true));
        }
      },
      { root: root instanceof Element ? root : null, rootMargin: "800px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [near]);

  useEffect(() => {
    if (eager) setNear(true);
  }, [eager]);

  // 摘要行被 CSS 截成一行，title 兜底让全文悬停可见 —— 长 Bash 命令
  // 在展开区还有完整版（见 renderDetail）。
  const head = (
    <>
      {/* 运行中转起来 —— 静止的 ◐ 和卡死看起来一模一样 */}
      {/* key 跟着状态走：跑完时换一个新节点，落定动画从头播一次。 */}
      <span
        key={tool.status}
        className={
          tool.status === "running"
            ? "tool-icon tool-icon-spin"
            : settled
              ? "tool-icon tool-icon-settle"
              : "tool-icon"
        }
      >
        {icon(tool.status)}
      </span>
      <span className="tool-name">{tool.name}</span>
      {/* 失败不能只靠 12px 图标变红 —— 扫视时根本发现不了 */}
      {tool.status === "error" ? <span className="tool-fail">{t("common.failed")}</span> : null}
      <span className="tool-summary">
        {summary}
      </span>
      {stat ? (
        <span className="change-stat">
          <span className="add">+{stat.added}</span>
          {stat.removed > 0 ? <span className="del"> −{stat.removed}</span> : null}
        </span>
      ) : null}
    </>
  );

  return (
    <div ref={cardRef} className={`tool tool-${tool.status} tool-plain`}>
      {/* 缩略图是自己的按钮，不能嵌在摘要行的 button 里，所以并排放。 */}
      <div className="tool-head-row">
        {detail ? (
          <button
            className="tool-head"
            onClick={() => {
              setNear(true);
              setUserToggle(!open);
            }}
            type="button"
            aria-expanded={open}
          >
            {head}
            <Chevron open={open} />
          </button>
        ) : (
          // 没有详情就别渲染成按钮 —— 可点但点了毫无反应，比不可点更糟
          <div className="tool-head">{head}</div>
        )}
        {hasImage(tool) ? <ToolThumb tool={tool} /> : null}
        {tool.name === "Bash" ? <OpenTerminalButton tool={tool} /> : null}
      </div>

      {detail ? (
        <SmoothFold open={open && near}>
          <div className="tool-detail">{renderDetail(tool)}</div>
        </SmoothFold>
      ) : null}
    </div>
  );
});

/**
 * Bash 起的服务（`background: true`）：摘要行右侧一个"查看终端"。
 *
 * 认领服务不再弹终端面板（见 lib/agentTerminals），想看日志就点这里。只在
 * 那个终端还在跑时出现 —— 退出后标签会自动收掉，点了也没处可去。
 */
function OpenTerminalButton({ tool }: { tool: Tool }) {
  const { t } = useT();
  const running = useRunningAgentTerminals();
  const i = tool.input as Record<string, unknown>;
  if (i?.background !== true) return null;
  const id = terminalIdFromResult(tool.result);
  if (id == null || !running.some((x) => x.hostId === id)) return null;
  return (
    <button type="button" className="tool-term-link" onClick={() => openAgentTerminal(id)}>
      {t("transcript.tool.openTerminal")}
    </button>
  );
}

/**
 * 最近被画成"运行中"的工具（卡片或直播组头都算）。跑完时以终态新挂上的
 * 卡片靠它知道"我刚刚还在跑"，从而播一次落定动画。有上限：在折叠组里
 * 跑完、始终没被挂成卡片的那些不会被摘，按插入顺序淘汰。
 */
const seenRunning = new Set<string>();
const SEEN_RUNNING_MAX = 200;

export function noteToolRunning(id: string) {
  if (seenRunning.has(id)) return;
  seenRunning.add(id);
  if (seenRunning.size > SEEN_RUNNING_MAX) {
    const oldest = seenRunning.values().next();
    if (!oldest.done) seenRunning.delete(oldest.value);
  }
}

function icon(s: Tool["status"]): string {
  if (s === "running") return "◐";
  if (s === "ok") return "✓";
  return "✕";
}

/** 一行说清这次调用在做什么。参数原样 dump 没人看得下去。
 *  导出给过程组的直播头复用 —— 组头滚的就是这句。 */
export function summarize(tool: Tool): string {
  const i = tool.input as Record<string, unknown>;
  const str = (k: string) => (typeof i?.[k] === "string" ? (i[k] as string) : "");
  const num = (k: string) => (typeof i?.[k] === "number" ? (i[k] as number) : 0);
  // 点击/输入的三种定位（ref/selector/text）挑给出的那个显示。
  const target = (textKey = "text") => {
    if (typeof i?.ref === "number") return `[${i.ref as number}]`;
    if (str("selector")) return `\`${str("selector")}\``;
    if (str(textKey)) return `“${str(textKey)}”`;
    return t("transcript.tool.element");
  };

  switch (tool.name) {
    case "Task": {
      const resume = str("resume");
      const bg = i?.run_in_background === true || resume === "self";
      const what =
        resume === "self"
          ? t("transcript.task.kind.fork")
          : resume
            ? t("transcript.tool.task.resume", { id: resume })
            : (str("subagent_type") || "general-purpose") === "explore"
              ? t("transcript.task.kind.explore")
              : t("transcript.task.kind.run");
      const bgTag = bg ? ` · ${t("transcript.task.background")}` : "";
      return `${what}${bgTag} · ${str("description") || t("transcript.task.subtask")}`;
    }
    case "TodoWrite": {
      const todos = todosOf(tool);
      const done = todos.filter((x) => x.status === "completed").length;
      const doing = todos.find((x) => x.status === "in_progress");
      const progress = t("transcript.tool.todo.progress", { done, total: todos.length });
      return `${progress}${doing?.activeForm ? ` · ${doing.activeForm}` : ""}`;
    }
    // 摘要行放模型写的那句描述（照 Claude）：一长串命令截成一行没人读得完，
    // 「列出摘要目录」才一眼看得懂。没给描述才退回命令；完整命令在悬停
    // 提示和展开区。
    case "Bash":
      return str("description").trim() || str("command");
    // 计划有自己的卡（PlanCard）；这条只给过程组的直播头和旧 transcript
    // 里的 ExitPlanMode 用。不写的话会落到 default，把整份计划 dump 进摘要行。
    case PLAN_TOOL:
    case LEGACY_PLAN_TOOL:
      return str("name").trim() || t("transcript.tool.writingPlan");
    case SWITCH_MODE_TOOL:
      return t("transcript.tool.switchMode", { mode: str("target_mode_id") || "?" });
    case "AskUserQuestion":
      return str("question") || t("transcript.tool.question");
    case "Read":
    case "Write":
    case "Edit":
    case "Delete":
    case "PreviewFile": {
      // 摘要行只放文件名（照 Claude）：一长串目录前缀挤在行里没人读，
      // 文件名才是认得出的那部分。完整路径在悬停提示和展开区第一行。
      const path = filePathOf(tool);
      return path.split(/[\\/]/).pop() || path;
    }
    case "Grep":
      return str("path")
        ? t("transcript.tool.grepIn", { pattern: str("pattern"), path: short(str("path")) })
        : str("pattern");
    // 不带参数。不写这条会落到 default，摘要行是空的。
    case "ShowBrowser":
      return t("transcript.tool.showBrowser");
    case "BrowserNavigate":
      return short(str("url"), 80);
    case "BrowserClick": {
      const key =
        i?.double === true
          ? "transcript.tool.click.double"
          : i?.right === true
            ? "transcript.tool.click.right"
            : "transcript.tool.click.single";
      return t(key, { target: target() });
    }
    case "BrowserType": {
      const typed = t("transcript.tool.type", {
        target: target("target_text"),
        text: clip(str("text"), 40),
      });
      return `${typed}${i?.submit === true ? " ⏎" : ""}`;
    }
    case "BrowserKey":
      return t("transcript.tool.key", { key: str("key") });
    case "BrowserScroll": {
      const d = num("delta_y");
      return d < 0
        ? t("transcript.tool.scrollUp", { px: Math.round(-d) })
        : t("transcript.tool.scrollDown", { px: Math.round(d) });
    }
    case "BrowserHover":
      return t("transcript.tool.hover", { target: target() });
    case "BrowserSelect":
      return t("transcript.tool.select", { target: target(), value: str("value") });
    case "BrowserDrag":
      return t("transcript.tool.drag");
    case "BrowserWaitFor": {
      if (str("selector")) return t("transcript.tool.wait.appear", { selector: str("selector") });
      if (str("selector_gone")) {
        return t("transcript.tool.wait.gone", { selector: str("selector_gone") });
      }
      if (str("text")) return t("transcript.tool.wait.text", { text: str("text") });
      if (str("url_contains")) return t("transcript.tool.wait.url", { text: str("url_contains") });
      if (i?.network_idle === true) return t("transcript.tool.wait.networkIdle");
      return t("transcript.tool.wait.generic");
    }
    case "BrowserGo": {
      const dir = str("direction");
      return dir === "back"
        ? t("transcript.tool.go.back")
        : dir === "forward"
          ? t("transcript.tool.go.forward")
          : dir === "reload"
            ? t("common.refresh")
            : t("transcript.tool.go.history");
    }
    case "BrowserTabs":
      return t("transcript.tool.tabs", { action: str("action") || "list" });
    case "BrowserEvaluate":
      return t("transcript.tool.evaluate", { expr: clip(str("expression"), 60) });
    case "BrowserCookies":
      return t("transcript.tool.cookies");
    case "BrowserNetwork": {
      const head = t("transcript.tool.network", { action: str("action") || "list" });
      return `${head}${str("filter") ? ` (${str("filter")})` : ""}`;
    }
    case "BrowserReplay":
      return t("transcript.tool.replay", {
        method: str("method") || "GET",
        url: short(str("url"), 60),
      });
    case "BrowserIntercept": {
      const head = t("transcript.tool.intercept", { action: str("action") });
      return `${head}${str("url_pattern") ? ` \`${str("url_pattern")}\`` : ""}`;
    }
    case "BrowserSecrets":
      return t("transcript.tool.secrets");
    case "BrowserDiscover":
      return t("transcript.tool.discover");
    case "BrowserFuzz":
      return `fuzz ${short(str("url"), 60)}`;
    case "BrowserUpload": {
      const n = Array.isArray(i?.paths) ? (i.paths as unknown[]).length : 0;
      return tn("transcript.tool.upload", n);
    }
    case "BrowserCrawl":
      return t("transcript.tool.crawl", { url: short(str("url"), 60) });
    case "BrowserReport": {
      const n = Array.isArray(i?.findings) ? (i.findings as unknown[]).length : 0;
      return tn("transcript.tool.report", n);
    }
    default:
      return clip(
        Object.entries(i ?? {})
          .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
          .join(" "),
        120,
      );
  }
}

/**
 * Edit / Write 的增删行数，给摘要行的「+N −M」。
 *
 * Edit 去掉新旧文本首尾相同的行再数 —— 模型为了定位常带上下文行，
 * 原样数的话改一行会报成「+5 −5」。中间不做逐行对齐：要精确的看
 * Git 改动面板，这里只求量级对。Write 只知道写了多少行，覆盖掉的
 * 旧内容不在输入里，所以只有 +N。
 */
export function diffStat(tool: Tool): { added: number; removed: number } | null {
  const i = tool.input as Record<string, unknown>;
  const str = (k: string) => (typeof i?.[k] === "string" ? (i[k] as string) : "");
  if (tool.name === "Write") {
    const content = str("content");
    if (!content) return null;
    return { added: content.replace(/\n$/, "").split("\n").length, removed: 0 };
  }
  if (tool.name !== "Edit") return null;
  const oldS = str("old_string");
  const newS = str("new_string");
  if (!oldS && !newS) return null;
  const a = oldS ? oldS.split("\n") : [];
  const b = newS ? newS.split("\n") : [];
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  return { added: b.length - head - tail, removed: a.length - head - tail };
}

/** 超长才截，截了要看得出来 —— 没有省略号的硬截像话说了一半。 */
function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** 有没有值得展开的内容。只读字段，不建 React 树。 */
/** 文件类工具操作的那个路径；别的工具返回空串。 */
const FILE_TOOLS = new Set(["Read", "Write", "Edit", "Delete", "PreviewFile"]);
function filePathOf(tool: Tool): string {
  if (!FILE_TOOLS.has(tool.name)) return "";
  const i = tool.input as Record<string, unknown>;
  const v = i?.path ?? i?.file_path;
  return typeof v === "string" ? v : "";
}

function hasDetail(tool: Tool): boolean {
  // 摘要行只有文件名，展开至少还能看到完整路径。
  if (filePathOf(tool)) return true;
  if (tool.name === "TodoWrite") return todosOf(tool).length > 0;
  if (tool.output.length > 0) return true;
  if (tool.status !== "running" && tool.result) return true;
  const i = tool.input as Record<string, unknown>;
  if (tool.name === "Bash" && typeof i.command === "string" && i.command) return true;
  if (tool.name === "Edit" && (i.old_string || i.new_string)) return true;
  if (tool.name === "Write" && typeof i.content === "string" && i.content) return true;
  return false;
}

/**
 * 展开后的内容。按工具语义渲染，不是 JSON dump：
 * Edit 给 diff，Write 给内容预览，Bash 给实时输出或结果。
 */
function renderDetail(tool: Tool): React.ReactNode {
  const i = tool.input as Record<string, unknown>;
  const str = (k: string) => (typeof i?.[k] === "string" ? (i[k] as string) : "");

  // 任务清单：从 tool_use 的输入渲染（清单在输入里；结果只是一句固定
  // 确认，显示它反而是噪音）。
  if (tool.name === "TodoWrite") {
    const todos = todosOf(tool);
    if (todos.length === 0) return null;
    return (
      <ul className="todo-list">
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

  const parts: React.ReactNode[] = [];

  const path = filePathOf(tool);
  if (path) {
    parts.push(
      <div key="path" className="tool-path">
        {path}
      </div>,
    );
  }

  // 长命令的摘要行被截断，全文在这里 —— 审计的核心信息不能在界面上无处可看。
  if (tool.name === "Bash") {
    const cmd = str("command");
    if (cmd) {
      parts.push(
        <pre key="cmd" className="tool-body tool-cmd">
          {cmd}
        </pre>,
      );
    }
  }

  if (tool.name === "Edit") {
    const oldS = str("old_string");
    const newS = str("new_string");
    if (oldS || newS) {
      parts.push(
        <pre key="diff" className="tool-body tool-diff">
          {oldS.split("\n").map((l, n) => (
            <div key={`o${n}`} className="del">
              - {l}
            </div>
          ))}
          {newS.split("\n").map((l, n) => (
            <div key={`n${n}`} className="add">
              + {l}
            </div>
          ))}
        </pre>,
      );
    }
  } else if (tool.name === "Write") {
    const content = str("content");
    if (content) {
      const lines = content.split("\n");
      // 写的过程中跟着尾巴走：定在开头的话，写到第 100 行时画面已经
      // 十几秒没动过了，和卡住一样。落定之后回到开头 —— 那时用户要
      // 确认的是"写了个什么东西"，不是逐行审阅。
      const live = tool.status === "running";
      const from = live ? Math.max(0, lines.length - 30) : 0;
      // 和 Edit 同一套 diff 画法：新写的文件每一行都是新增，摘要行也写着
      // 「+N」—— 展开后画成普通代码块的话，两处说法对不上。省略 / 总行数
      // 那两行是说明，不是文件内容，不染色。
      parts.push(
        <pre key="w" className="tool-body tool-diff">
          {from > 0 ? (
            <div className="diff-note">{tn("transcript.tool.write.skipped", from)}</div>
          ) : null}
          {lines.slice(from, from + 30).map((l, n) => (
            <div key={from + n} className="add">
              + {l}
            </div>
          ))}
          {!live && lines.length > 30 ? (
            <div className="diff-note">{tn("transcript.tool.write.total", lines.length)}</div>
          ) : null}
        </pre>,
      );
    }
  }

  // 结果里的图不在这里：它在摘要行右侧的缩略图上（见 ToolThumb）。

  // 运行中显示实时输出；结束后最终结果更权威（实时行只是进度侧影）
  const live = tool.output.length > 0 ? tool.output.join("\n") : "";
  const result = tool.status === "running" ? live : tool.result || live;
  // Edit / Write 成功时的结果只是一句「已修改 xx（替换了 1 处）」——
  // 上面的 diff / 内容已经说明了一切，再复述一遍是噪音。失败时的原因要留着。
  const echo = (tool.name === "Edit" || tool.name === "Write") && tool.status === "ok";
  if (result && !echo) {
    parts.push(
      <pre key="r" className="tool-body">
        {result}
      </pre>,
    );
  }

  return parts.length ? parts : null;
}

/** 工具结果带不带图（截图、读图）。 */
export function hasImage(tool: Tool): boolean {
  return Boolean(tool.resultImage || tool.resultImagePath);
}

/**
 * 原图按路径读回来的缓存。
 *
 * 消息里只带压缩图（给模型的那份，看布局够、看文字糊），原图在磁盘上。
 * 悬停预览和查看器要原图；同一张图在单卡和组头各有一张缩略图，悬停
 * 来回扫也不该反复读盘。原图是整张 base64，留太多白占内存，只留最近的。
 */
const originals = new Map<string, Promise<string | null>>();
const ORIGINALS_MAX = 24;

function loadOriginal(path: string): Promise<string | null> {
  const hit = originals.get(path);
  if (hit) {
    originals.delete(path);
    originals.set(path, hit);
    return hit;
  }
  const p = readImage(path)
    .then((img) => `data:${img.mediaType};base64,${img.data}`)
    // 原图没了（被清理、超上限）就用压缩图，不报错：图能看就行。
    .catch(() => null);
  originals.set(path, p);
  if (originals.size > ORIGINALS_MAX) {
    const oldest = originals.keys().next();
    if (!oldest.done) originals.delete(oldest.value);
  }
  return p;
}

/** 先给压缩图；`wantOriginal` 时按路径换成原图。都没有返回 undefined。 */
function useImageSrc(
  path: string | undefined,
  fallback: string | undefined,
  wantOriginal: boolean,
): string | undefined {
  const [original, setOriginal] = useState<string | null>(null);
  useEffect(() => {
    if (!wantOriginal || !path) return;
    let alive = true;
    void loadOriginal(path).then((src) => {
      if (alive && src) setOriginal(src);
    });
    return () => {
      alive = false;
    };
  }, [path, wantOriginal]);
  return original ?? fallback;
}

/** 悬停多久才弹预览：鼠标只是路过一排缩略图时不该闪一串大图。 */
const PREVIEW_DELAY_MS = 120;

/**
 * 工具结果图的缩略图（照 Claude）：摘要行右侧一枚小图，悬停放大预览，
 * 点击开查看器看原图。单卡和过程组的组头共用。
 *
 * 缩略图本身用消息里的压缩图（够认出是哪张），没有压缩图才读原图；
 * 预览和查看器要看清文字，用到时再按路径读原图。
 */
export function ToolThumb({ tool }: { tool: Tool }) {
  const { t } = useT();
  const ref = useRef<HTMLButtonElement>(null);
  const [hover, setHover] = useState(false);
  const [viewer, setViewer] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const path = tool.resultImagePath;
  const fallback = tool.resultImage;
  const thumb = useImageSrc(path, fallback, !fallback);
  const full = useImageSrc(path, fallback, hover || viewer);
  const alt = t("transcript.tool.resultImageOf", { tool: tool.name });
  const caption = path ? (path.split(/[\\/]/).pop() ?? tool.name) : tool.name;

  useEffect(() => () => window.clearTimeout(timer.current), []);
  // 预览是 fixed 定位在缩略图旁边的；对话一滚它就悬空了，收掉。
  useEffect(() => {
    if (!hover) return;
    const hide = () => setHover(false);
    window.addEventListener("scroll", hide, true);
    return () => window.removeEventListener("scroll", hide, true);
  }, [hover]);

  if (!thumb) return null;
  const leave = () => {
    window.clearTimeout(timer.current);
    setHover(false);
  };
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="tool-thumb"
        onMouseEnter={() => {
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setHover(true), PREVIEW_DELAY_MS);
        }}
        onMouseLeave={leave}
        // 同 fold-head：点击不拿焦点，WKWebView 会把 focused button 滚进视野。
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          leave();
          setViewer(true);
        }}
        aria-label={t("transcript.image.zoomNamed", { name: alt })}
      >
        <img src={thumb} alt="" draggable={false} />
      </button>
      {hover && full && ref.current ? (
        <ThumbPreview anchor={ref.current} src={full} caption={caption} alt={alt} />
      ) : null}
      {viewer && full ? <ShotViewer src={full} alt={alt} onClose={() => setViewer(false)} /> : null}
    </>
  );
}

/** 预览框的最大尺寸。图按比例缩进来，下方一行文件名。 */
const PREVIEW_W = 480;
const PREVIEW_H = 360;

/**
 * 悬停放大的预览：贴着缩略图右对齐，下面放得下就往下弹，否则往上。
 * portal 到 body —— 卡片在带 overflow 的滚动容器里，fixed 浮层留在原地
 * 会被裁掉。不吃鼠标：鼠标移上去不该让它以为离开了缩略图。
 */
function ThumbPreview({
  anchor,
  src,
  caption,
  alt,
}: {
  anchor: HTMLElement;
  src: string;
  caption: string;
  alt: string;
}) {
  const r = anchor.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const room = PREVIEW_H + 48;
  const below = vh - r.bottom >= room || r.top < room;
  const style: React.CSSProperties = {
    right: Math.max(12, vw - r.right),
    maxWidth: Math.min(PREVIEW_W, vw - 24),
    ...(below ? { top: r.bottom + 6 } : { bottom: vh - r.top + 6 }),
  };
  return createPortal(
    <div className="thumb-preview" style={style} aria-hidden>
      <img src={src} alt={alt} style={{ maxHeight: PREVIEW_H }} />
      <div className="thumb-preview-caption">{caption}</div>
    </div>,
    document.body,
  );
}

/** 查看器缩放范围：相对"适配视口"那一档的倍数。 */
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 20;
/** 按钮 / 键盘每步的倍率。 */
const ZOOM_STEP = 1.25;
/** 指针按下后挪过这么多像素才算拖动 —— 不到这个数松手仍按点击处理。 */
const DRAG_SLOP = 4;

type View = { s: number; x: number; y: number };
const FIT: View = { s: 1, x: 0, y: 0 };

/**
 * 以屏幕点 (px, py) 为不动点把缩放改到 next。cx/cy 是图在布局里的
 * 中心（transform 不影响布局，所以它固定）。缩回 ≤1 时平移归零，
 * 免得图缩小后飘在角落。
 */
function zoomAt(v: View, next: number, px: number, py: number, cx: number, cy: number): View {
  const s = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
  if (s <= 1) return { s, x: 0, y: 0 };
  const k = s / v.s;
  return { s, x: px - cx - k * (px - cx - v.x), y: py - cy - k * (py - cy - v.y) };
}

/**
 * 图片查看器:全屏遮罩，图在视口里上下左右居中；超大的缩到视口内。
 * 滚轮 / 触控板捏合以光标为中心缩放，双击在适配和 2× 之间切换，
 * 放大后拖动平移；底部一排 − 百分比 + 按钮，键盘 + / - / 0 同样可用。
 *
 * portal 到 body —— 卡片在带 overflow 的滚动容器里，fixed 遮罩留在原地
 * 会被裁掉。导出给聊天区图片和磁盘图片文件的放大查看共用。
 */
export function ShotViewer({
  src,
  alt: altProp,
  onClose,
}: {
  src: string;
  alt?: string;
  onClose: () => void;
}) {
  const { t } = useT();
  const alt = altProp ?? t("transcript.tool.resultImage");
  // Esc 走公共栈 —— 查看器开在权限卡之上时，Esc 只关查看器，
  // 不会顺手把底下的权限请求也拒了。
  useEscLayer(onClose);

  const [view, setView] = useState<View>(FIT);
  const [dragging, setDragging] = useState(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  const rootRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  // 活动指针：一根是拖动，两根是捏合。
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{
    startX: number;
    startY: number;
    view: View;
    dist: number;
    moved: boolean;
  } | null>(null);
  // 刚拖完的那次 click 不能当"点空白关闭"：从图上拖到遮罩上松手，
  // click 落在共同祖先（遮罩）上。
  const suppressClick = useRef(false);

  // 换图回到适配。
  useEffect(() => setView(FIT), [src]);

  const center = useCallback(() => {
    const r = imgRef.current?.getBoundingClientRect();
    const v = viewRef.current;
    if (!r) return { cx: window.innerWidth / 2, cy: window.innerHeight / 2 };
    // 量到的是变换后的框，减掉平移就是布局中心（缩放绕中心，不移中心）。
    return { cx: r.left + r.width / 2 - v.x, cy: r.top + r.height / 2 - v.y };
  }, []);

  const zoomBy = useCallback(
    (factor: number, px?: number, py?: number) => {
      const { cx, cy } = center();
      setView((v) => zoomAt(v, v.s * factor, px ?? cx, py ?? cy, cx, cy));
    },
    [center],
  );

  // 滚轮要 preventDefault（不然触控板捏合会缩放整个 WebView），React 的
  // onWheel 是 passive 的，只能挂原生监听。
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1;
      // 捏合（ctrlKey）的 delta 很小，系数放大；鼠标滚轮一格约 100。
      const k = e.ctrlKey ? 0.01 : 0.0015;
      zoomBy(Math.exp(-e.deltaY * unit * k), e.clientX, e.clientY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomBy]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "+" || e.key === "=") zoomBy(ZOOM_STEP);
      else if (e.key === "-" || e.key === "_") zoomBy(1 / ZOOM_STEP);
      else if (e.key === "0") setView(FIT);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomBy]);

  const startGesture = () => {
    const pts = [...pointers.current.values()];
    const mid = pts.reduce((a, p) => ({ x: a.x + p.x / pts.length, y: a.y + p.y / pts.length }), {
      x: 0,
      y: 0,
    });
    const [a, b] = pts;
    const dist = a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    gesture.current = {
      startX: mid.x,
      startY: mid.y,
      view: viewRef.current,
      dist,
      moved: gesture.current?.moved ?? false,
    };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.currentTarget.setPointerCapture(e.pointerId);
    startGesture();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) return;
    const [a, b] = pointers.current.values();
    if (a && b) {
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const { cx, cy } = center();
      const z = zoomAt(g.view, g.view.s * (dist / (g.dist || dist)), g.startX, g.startY, cx, cy);
      // 捏合中心本身也可能移动：叠加中心位移做平移。
      setView(z.s > 1 ? { s: z.s, x: z.x + mx - g.startX, y: z.y + my - g.startY } : z);
      g.moved = true;
      return;
    }
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (!g.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
    g.moved = true;
    // 适配档没什么可平移的，拖了也只是吞掉这次点击。
    if (g.view.s <= 1) return;
    setDragging(true);
    setView({ s: g.view.s, x: g.view.x + dx, y: g.view.y + dy });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!pointers.current.delete(e.pointerId)) return;
    if (pointers.current.size > 0) {
      // 捏合松开一指：剩下那根接着拖，从当前状态重新起算。
      startGesture();
      return;
    }
    if (gesture.current?.moved) suppressClick.current = true;
    gesture.current = null;
    setDragging(false);
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (e.target !== imgRef.current) return;
    const { cx, cy } = center();
    setView((v) => (v.s > 1 ? FIT : zoomAt(v, 2, e.clientX, e.clientY, cx, cy)));
  };

  const zoomed = view.s > 1;
  return createPortal(
    // 点空白处（遮罩本身）关闭；点图不关。
    <div
      ref={rootRef}
      className={`shot-viewer shot-viewer-zoomable${zoomed ? " zoomed" : ""}${dragging ? " dragging" : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      onClick={(e) => {
        if (suppressClick.current) {
          suppressClick.current = false;
          return;
        }
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <button
        className="shot-viewer-close"
        onClick={onClose}
        type="button"
        aria-label={t("common.close")}
      >
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <path
            d="M2 2l8 8M10 2L2 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <img
        ref={imgRef}
        src={src}
        alt={t("transcript.image.original", { name: alt })}
        draggable={false}
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` }}
      />
      <div className="shot-viewer-zoombar">
        <button
          type="button"
          onClick={() => zoomBy(1 / ZOOM_STEP)}
          disabled={view.s <= ZOOM_MIN}
          aria-label={t("transcript.image.zoomOut")}
          title={t("transcript.image.zoomOut")}
        >
          −
        </button>
        <button
          type="button"
          className="shot-viewer-zoomlevel"
          onClick={() => setView(FIT)}
          aria-label={t("transcript.image.zoomReset")}
          title={t("transcript.image.zoomReset")}
        >
          {Math.round(view.s * 100)}%
        </button>
        <button
          type="button"
          onClick={() => zoomBy(ZOOM_STEP)}
          disabled={view.s >= ZOOM_MAX}
          aria-label={t("transcript.image.zoomIn")}
          title={t("transcript.image.zoomIn")}
        >
          +
        </button>
      </div>
    </div>,
    document.body,
  );
}

/** 长路径留尾部 —— 文件名比目录前缀有用得多。 */
function short(p: string, max = 48): string {
  return p.length <= max ? p : `…${p.slice(-(max - 1))}`;
}
