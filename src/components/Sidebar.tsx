/**
 * 侧边栏：定时任务入口 + 按项目分组的会话列表。从 App.tsx 拆出 ——
 * 宽度/开合等布局真值仍在 App，这里管分组折叠与每行的交互。
 */

import { type ReactNode, useCallback, useState } from "react";

import { projectRootOf, type SessionInfo } from "../bridge";
import { useImeGuard } from "../hooks/useImeGuard";
import { useT } from "../i18n";
import { shortcut } from "../lib/keys";
import { basename } from "../pathDisplay";
import { Chevron } from "./Chevron";
import {
  BranchIcon,
  ClockIcon,
  DotsIcon,
  FolderIcon,
  GearIcon,
  PlusIcon,
  SidebarToggleIcon,
} from "./icons";

/** 折叠集的持久化键。纯 UI 状态，存 localStorage。 */
const COLLAPSED_KEY = "riot.layout.collapsedProjects";

function loadCollapsedProjects(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return new Set();
    const arr: unknown = JSON.parse(raw);
    return new Set(
      Array.isArray(arr)
        ? arr.filter((x): x is string => typeof x === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

function saveCollapsedProjects(roots: Set<string>) {
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...roots]));
}

/** 大分组（定时任务 / 项目）的折叠开关，各存一个布尔键。 */
function useSectionFold(key: string): [boolean, () => void] {
  const [folded, setFolded] = useState(() => localStorage.getItem(key) === "1");
  const toggle = useCallback(() => {
    setFolded((v) => {
      localStorage.setItem(key, v ? "0" : "1");
      return !v;
    });
  }, [key]);
  return [folded, toggle];
}

export interface SidebarProps {
  /** 用户拖出来的宽度。真值和持久化都在 App 那层。 */
  width: number;
  projects: string[];
  /** 磁盘上已经找不到的项目根。 */
  missing: ReadonlySet<string>;
  sessions: SessionInfo[];
  active: string | null;
  /** 最近开聊的时刻（切换会话不算）。同项目里按它倒序，没记录的退回创建序。 */
  recency: Readonly<Record<string, number>>;
  renaming: string | null;
  onSelect: (id: string) => void;
  onNewSession: (root: string) => void;
  onOpenProject: () => void;
  onSettings: () => void;
  /** 打开主区的定时任务页（一级菜单项，Codex 的「已安排」同款）。 */
  onSchedules: () => void;
  /** 任务页正在前台 —— 菜单项画高亮，跟会话行互斥。 */
  schedulesActive: boolean;
  /** 启动时发现的错过运行条数。>0 时菜单项挂红点。 */
  missedSchedules: number;
  onSessionMenu: (e: React.MouseEvent, s: SessionInfo) => void;
  onProjectMenu: (e: React.MouseEvent, root: string) => void;
  /** 右键 / … 菜单正对着的行。菜单在文档别处，行要靠这个保住 hover。 */
  menuAnchor: string | null;
  onRenameSubmit: (id: string, title: string) => void;
  onRenameCancel: () => void;
  /** 收起侧栏。按钮坐在侧栏顶栏；收起后入口回到主区顶栏。 */
  onCollapse: () => void;
  /** 没有会话认领的 worktree 有几个。>0 时侧栏底部挂一条提示。 */
  orphanWorktrees: number;
  onOrphanWorktrees: () => void;
}

export function Sidebar(props: SidebarProps) {
  const {
    width,
    projects,
    sessions,
    active,
    onOpenProject,
    onSettings,
    onSchedules,
    onCollapse,
  } = props;
  const { t, tn } = useT();
  const [collapsed, setCollapsed] = useState(loadCollapsedProjects);
  const [projectsFolded, toggleProjectsFolded] = useSectionFold(
    "riot.layout.projectsFold",
  );

  const toggleCollapsed = useCallback((root: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(root)) next.delete(root);
      else next.add(root);
      saveCollapsedProjects(next);
      return next;
    });
  }, []);

  const expandProject = useCallback((root: string) => {
    setCollapsed((prev) => {
      if (!prev.has(root)) return prev;
      const next = new Set(prev);
      next.delete(root);
      saveCollapsedProjects(next);
      return next;
    });
  }, []);

  // worktree 会话归原项目（它的 root 是应用自己建的目录）。
  // 有会话但不在项目列表里的根也要显示（理论上不会发生，但真发生时
  // 隐藏会话比多显示一个组糟得多）。
  const roots = [...projects];
  for (const s of sessions) {
    const root = projectRootOf(s);
    if (!roots.includes(root)) roots.push(root);
  }
  // 整个「项目」区收起时，其它项目逐个折走，当前会话所在的项目留在原位、
  // 自己也收起来（只露当前会话那一行）—— 和 Claude 侧栏一样：折起来的
  // 是其它的，不是你正在看的那个。
  const activeSession = props.schedulesActive
    ? undefined
    : sessions.find((s) => s.id === active);
  const activeRoot = activeSession ? projectRootOf(activeSession) : null;

  return (
    <aside className="sidebar" style={{ width }}>
      {/* macOS 红绿灯占左上角；开关靠右，贴着侧栏和主区的缝。空白处仍可拖窗口。 */}
      <div className="traffic-space" data-tauri-drag-region>
        <button
          className="tb-btn"
          onClick={onCollapse}
          title={t("app.sidebar.collapseTitle", { key: shortcut("B") })}
          aria-label={t("app.sidebar.collapse")}
        >
          {/* 这颗键住在展开着的侧栏里，所以总是"开"的样子；收起后顶栏那颗是空的。 */}
          <SidebarToggleIcon on />
        </button>
      </div>

      <button className="new-thread" onClick={onOpenProject}>
        <PlusIcon />
        {t("app.openDir")}
      </button>

      {/* 菜单项在滚动区里跟着列表一起走 —— 项目多的时候它占着顶部不动，
          等于白吃一行可视高度。 */}
      <nav className="threads">
        <button
          className={
            props.schedulesActive
              ? "side-item side-nav active"
              : "side-item side-nav"
          }
          onClick={onSchedules}
        >
          <ClockIcon />
          <span className="side-label">{t("app.sidebar.schedules")}</span>
          {props.missedSchedules > 0 ? (
            <span
              className="side-badge"
              title={tn("app.sidebar.missedTitle", props.missedSchedules)}
            >
              {props.missedSchedules}
            </span>
          ) : null}
        </button>

        {roots.length ? (
          <div className="section-head">
            <button
              type="button"
              className="section-toggle"
              aria-expanded={!projectsFolded}
              onClick={toggleProjectsFolded}
            >
              <span className="section-name">{t("app.sidebar.projects")}</span>
              <Chevron open={!projectsFolded} solid />
              {projectsFolded ? (
                <span className="project-count">{roots.length}</span>
              ) : null}
            </button>
            <button
              className="row-btn"
              onClick={onOpenProject}
              title={t("app.openDir")}
            >
              <PlusIcon />
            </button>
          </div>
        ) : null}
        <div className="section-body">
          {roots.map((root) => {
            const pinned = projectsFolded && root === activeRoot;
            return (
              <FoldRow key={root} folded={projectsFolded && !pinned}>
                <ProjectGroup
                  {...props}
                  root={root}
                  gone={props.missing.has(root)}
                  sessions={sessions.filter((s) => projectRootOf(s) === root)}
                  collapsed={pinned || collapsed.has(root)}
                  onToggle={
                    pinned ? toggleProjectsFolded : () => toggleCollapsed(root)
                  }
                  onExpand={() => expandProject(root)}
                />
              </FoldRow>
            );
          })}
        </div>
      </nav>

      <div className="sidebar-foot">
        {props.orphanWorktrees > 0 ? (
          <button
            className="side-item side-warn"
            onClick={props.onOrphanWorktrees}
          >
            <BranchIcon />
            <span className="side-label">
              {tn("app.sidebar.orphanWorktrees", props.orphanWorktrees)}
            </span>
          </button>
        ) : null}
        <button className="side-item" onClick={onSettings}>
          <GearIcon />
          <span className="side-label">{t("app.sidebar.settings")}</span>
        </button>
      </div>
    </aside>
  );
}

/**
 * 定时任务开的会话标题是「任务名 · MM-DD」（宿主 run_schedule 里定的）。
 * 拆开来：名字可以截断，日期放右边不截。不是这个形状就返回 null。
 */
function splitRunTitle(
  title: string | null | undefined,
): { name: string; date: string } | null {
  const m = title?.match(/^(.*\S) · (\d{2}-\d{2})$/);
  return m?.[1] && m[2] ? { name: m[1], date: m[2] } : null;
}

type Entry =
  | { kind: "one"; session: SessionInfo }
  | {
      kind: "group";
      name: string;
      runs: { session: SessionInfo; date: string }[];
    };

/** 同名的定时任务会话收成一组，组排在它最近那次的位置上。顺序沿用传入的（最近在上）。 */
function groupRuns(ordered: SessionInfo[]): Entry[] {
  const byName = new Map<string, { session: SessionInfo; date: string }[]>();
  for (const s of ordered) {
    const split = splitRunTitle(s.title);
    if (!split) continue;
    const runs = byName.get(split.name) ?? [];
    runs.push({ session: s, date: split.date });
    byName.set(split.name, runs);
  }
  const out: Entry[] = [];
  const placed = new Set<string>();
  for (const s of ordered) {
    const split = splitRunTitle(s.title);
    const runs = split ? byName.get(split.name) : undefined;
    if (!split || !runs || runs.length < 2) {
      out.push({ kind: "one", session: s });
      continue;
    }
    if (placed.has(split.name)) continue;
    placed.add(split.name);
    out.push({ kind: "group", name: split.name, runs });
  }
  return out;
}

function ProjectGroup(
  props: SidebarProps & {
    root: string;
    gone: boolean;
    collapsed: boolean;
    onToggle: () => void;
    onExpand: () => void;
  },
) {
  const {
    root,
    gone,
    sessions,
    active,
    renaming,
    collapsed,
    onSelect,
    onNewSession,
    onSessionMenu,
    onProjectMenu,
    onRenameSubmit,
    onRenameCancel,
    onToggle,
    onExpand,
    schedulesActive,
    menuAnchor,
    recency,
  } = props;
  const name = basename(root) || root;
  const { t } = useT();
  // 同一时刻只有一行在改名，一个 guard 够用。
  const ime = useImeGuard();
  // 刚聊过的在上面；并列时退回创建序。
  const ordered = [...sessions].sort((a, b) => {
    const ra = recency[a.id] ?? 0;
    const rb = recency[b.id] ?? 0;
    if (ra !== rb) return rb - ra;
    return b.seq - a.seq;
  });
  const busy = collapsed && ordered.some((s) => s.busy);
  // 收起时当前会话不跟着藏：它留在原位，其它的各自折起来。
  const activeId = schedulesActive ? null : active;
  // 定时任务每跑一次就新开一个「任务名 · MM-DD」会话。同名的收成一组：
  // 组头是任务名和次数，展开后每行只写日期 —— 不然侧栏被一模一样的
  // 标题刷满，截断后连日期都看不见。只有一个的不成组。
  const entries = groupRuns(ordered);
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set());
  const toggleGroup = (name: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  /** 一行会话。`date` 有值 = 组里的一次运行，标签只写日期。 */
  const renderRow = (s: SessionInfo, date: string | null) => {
    if (renaming === s.id) {
      return (
        <input
          key={s.id}
          className="rename-input"
          defaultValue={s.title ?? ""}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onCompositionStart={ime.onCompositionStart}
          onCompositionEnd={ime.onCompositionEnd}
          onKeyDown={(e) => {
            // 组字中的回车确认候选词、Esc 取消候选，都不该动这次改名。
            if (ime.isComposing(e)) return;
            if (e.key === "Enter") onRenameSubmit(s.id, e.currentTarget.value);
            if (e.key === "Escape") onRenameCancel();
          }}
          onBlur={(e) => onRenameSubmit(s.id, e.currentTarget.value)}
        />
      );
    }
    const split = date === null ? splitRunTitle(s.title) : null;
    return (
      <div
        key={s.id}
        className={
          (s.id === active && !schedulesActive ? "thread active" : "thread") +
          (menuAnchor === `session:${s.id}` ? " menu-open" : "")
        }
        onContextMenu={(e) => onSessionMenu(e, s)}
      >
        <button className="thread-label" onClick={() => onSelect(s.id)}>
          {/* 正在跑的会话给个小圆点 —— 切走之后它还在干活，列表里
              得看得出来，不然用户以为它闲着。 */}
          {s.busy ? (
            <span
              className="thread-busy"
              title={t("common.running")}
              aria-label={t("common.running")}
            />
          ) : s.awaitingUser ? (
            // 停在等用户决定：不在跑，但得回来点卡片。
            <span
              className="thread-awaiting"
              title={t("app.session.awaiting")}
              aria-label={t("app.session.awaiting")}
            />
          ) : null}
          {date !== null ? (
            <span className="thread-title">{date}</span>
          ) : split ? (
            // 日期单独放右侧、不参与截断：长任务名截掉的是名字尾巴，不是日期。
            <>
              <span className="thread-title">{split.name}</span>
              <span className="thread-meta">
                <span className="thread-date">{split.date}</span>
              </span>
            </>
          ) : (
            <>
              {/* 分叉出来的会话标题沿用原会话的，靠这枚记号区分。 */}
              {s.forkedFrom ? (
                <span className="thread-fork" title={t("app.session.forked")}>
                  <BranchIcon size={12} />
                </span>
              ) : null}
              <span className="thread-title">
                {s.title ?? t("app.newSession")}
              </span>
              {/* 在 worktree 里的：分支名是它和同名会话唯一的区别，放右边不参与截断。 */}
              {s.forkedFrom?.worktree ? (
                <span className="thread-meta">
                  <span
                    className="thread-branch"
                    title={s.forkedFrom.worktree.path}
                  >
                    {s.forkedFrom.worktree.branch.replace(/^riot\//, "")}
                  </span>
                </span>
              ) : null}
            </>
          )}
        </button>
        <button
          className="row-btn"
          onClick={(e) => onSessionMenu(e, s)}
          title={t("app.session.actions")}
        >
          <DotsIcon />
        </button>
      </div>
    );
  };
  const foldState = t(
    collapsed ? "app.project.collapsed" : "app.project.expanded",
  );

  return (
    <div className={collapsed ? "project collapsed" : "project"}>
      <div
        className={
          (gone ? "project-head gone" : "project-head") +
          (menuAnchor === `project:${root}` ? " menu-open" : "")
        }
        onContextMenu={(e) => onProjectMenu(e, root)}
      >
        <button
          type="button"
          className="project-toggle"
          aria-expanded={!collapsed}
          aria-label={t(
            gone ? "app.project.ariaLabelGone" : "app.project.ariaLabel",
            {
              name,
              state: foldState,
            },
          )}
          title={gone ? t("app.project.titleGone", { root }) : root}
          onClick={onToggle}
        >
          <FolderIcon />
          <span className="project-name">{name}</span>
          {gone ? (
            <span className="project-gone" title={t("app.project.dirGone")}>
              {t("app.project.gone")}
            </span>
          ) : null}
          <Chevron open={!collapsed} solid />
          {busy ? (
            <span
              className="thread-busy"
              title={t("app.project.busy")}
              aria-label={t("app.project.busy")}
            />
          ) : null}
          {collapsed && ordered.length > 0 ? (
            <span className="project-count">{ordered.length}</span>
          ) : null}
        </button>
        <button
          className="row-btn"
          onClick={() => {
            onExpand();
            onNewSession(root);
          }}
          title={t("app.project.newSessionIn", { name })}
        >
          <PlusIcon />
        </button>
        <button
          className="row-btn"
          onClick={(e) => onProjectMenu(e, root)}
          title={t("app.project.actions")}
        >
          <DotsIcon />
        </button>
      </div>

      <div className="project-threads-inner">
        {entries.map((e) => {
          if (e.kind === "one") {
            return (
              <FoldRow
                key={e.session.id}
                folded={collapsed && e.session.id !== activeId}
              >
                {renderRow(e.session, null)}
              </FoldRow>
            );
          }
          const open = openGroups.has(e.name);
          // 组里有当前会话时组头也留着：那一行只写日期，没有组头就认不出
          // 是哪个任务。
          const holdsActive = e.runs.some((r) => r.session.id === activeId);
          const busyRun = e.runs.some((r) => r.session.busy);
          const waitingRun = e.runs.some((r) => r.session.awaitingUser);
          return (
            <div key={`group:${e.name}`} className="thread-group">
              <FoldRow folded={collapsed && !holdsActive}>
                <div className="thread">
                  <button
                    type="button"
                    className="thread-label"
                    aria-expanded={open}
                    onClick={() => toggleGroup(e.name)}
                  >
                    {busyRun ? (
                      <span
                        className="thread-busy"
                        title={t("common.running")}
                        aria-label={t("common.running")}
                      />
                    ) : waitingRun ? (
                      <span
                        className="thread-awaiting"
                        title={t("app.session.awaiting")}
                        aria-label={t("app.session.awaiting")}
                      />
                    ) : null}
                    <span className="thread-title">{e.name}</span>
                    {/* 组头只挂次数：日期在展开后的每一行上，挂在这里只会把任务名挤短。 */}
                    <span className="thread-meta">
                      <span
                        className="thread-runs"
                        title={t("app.session.runs", { count: e.runs.length })}
                      >
                        ×{e.runs.length}
                      </span>
                      <Chevron open={open} />
                    </span>
                  </button>
                </div>
              </FoldRow>
              <div className="thread-group-runs">
                {e.runs.map((r) => (
                  <FoldRow
                    key={r.session.id}
                    folded={r.session.id !== activeId && (collapsed || !open)}
                  >
                    {renderRow(r.session, r.date)}
                  </FoldRow>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 侧栏里逐行的开合：收高度 + 淡出，行在原位不动。样式见 `.fold-row`。 */
function FoldRow({
  folded,
  children,
}: {
  folded: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={folded ? "fold-row folded" : "fold-row"}
      inert={folded}
      aria-hidden={folded}
    >
      <div className="fold-row-inner">{children}</div>
    </div>
  );
}
