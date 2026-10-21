import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  addProject,
  browserCloseTab,
  browserNavigate,
  browserNewTab,
  browserReload,
  browserSelectTab,
  browserState,
  type ConfigStatus,
  createSession,
  deleteSession,
  encodePlainForComposer,
  encodeRefForComposer,
  getConfig,
  listSessions,
  type PermissionMode,
  openInBrowser,
  pickFiles,
  probeDirs,
  type MissedRun,
  removeProject,
  renameSession,
  revealInFinder,
  scheduleAckMissed,
  scheduleDelete,
  scheduleRunNow,
  scheduleSetEnabled,
  type ScheduledTask,
  type SessionInfo,
  setConfig as saveConfig,
  setSessionModel,
  setWindowTitle,
  subscribeConfigChanges,
  subscribeSessionsChanges,
} from "./bridge";
import { BrowserPanel } from "./components/BrowserPanel";
import { GitChangesPanel } from "./components/GitChangesPanel";
import { ScopePanel } from "./components/ScopePanel";
import { SessionSettings } from "./components/SessionSettings";
import { ConfirmDialog, type ConfirmRequest } from "./components/ConfirmDialog";
import { hasUnsaved } from "./lib/unsavedEdits";
import { useDirectoryPicker } from "./components/DirPicker";
import {
  FilePreviewPanel,
  ImageLightboxHost,
  openFilePreview,
  subscribeFilePreview,
} from "./components/FilePreview";
import type { TreeTarget } from "./components/FileTree";
import { MissingProjectDialog } from "./components/MissingProjectDialog";
import { ProjectRootContext } from "./components/Markdown";
import { PlanPanel } from "./components/PlanPanel";
import { Settings } from "./components/Settings";
import { SubagentPanel } from "./components/SubagentPanel";
import { closeSessionTerminals, TerminalPanel } from "./components/TerminalPanel";
import { forgetSession } from "./hooks/useSession";
import { useAppUpdate } from "./hooks/useAppUpdate";
import { usePanelLayout } from "./hooks/usePanelLayout";
import { useSchedules } from "./hooks/useSchedules";
import { useSessionRecency } from "./hooks/useSessionRecency";
import { useBrowserPanel } from "./hooks/useBrowserPanel";
import { useT } from "./i18n";
import { trackChatColWidth } from "./lib/chatColWidth";
import { planPanelOpen, subscribePanelBrowser } from "./lib/linkIntent";
import { type PlanState, samePlan, sameTodos, subscribePlanOpen } from "./lib/plan";
import { newPresetId } from "./lib/prompts";
import { inheritedSampling } from "./lib/sampling";
import { subscribeSessionOpen } from "./lib/sessionLink";
import { subscribeSubagentOpen } from "./lib/subagentLink";
import {
  openAgentTerminal,
  subscribeAgentTerminalOpen,
  useRunningAgentTerminals,
} from "./lib/agentTerminals";
import { transcriptView } from "./components/Transcript";
import {
  ContextMenu,
  IS_MAC,
  type MenuState,
  Resizer,
  TopBar,
  WindowControls,
} from "./components/chrome";
import {
  EMPTY_WORKBENCH,
  tabId,
  WorkbenchEmpty,
  WorkbenchTabs,
  type WorkbenchState,
  type WorkbenchTab,
} from "./components/Workbench";
import {
  isDoneSchedule,
  ScheduleCreatePanel,
  ScheduleDetail,
  SchedulesPage,
} from "./components/SchedulesPage";
import { Sidebar } from "./components/Sidebar";
import { SlidePanel, slidesSettled, usePresence } from "./components/SlidePanel";
import { Welcome } from "./components/Welcome";
import { type PermissionPick, forgetComposerSession } from "./components/Composer";
import { asDirRef, basename, looksAbsPath } from "./pathDisplay";
import {
  LS,
  SCHED_DETAIL,
  SIDEBAR,
  TERM,
  clamp,
  DRAWER_MIN,
  SIDEBAR_PUSH_FLOOR_LIGHTS,
  drawerDefault,
  drawerDragLayout,
  rightPanelMax,
  rightShare,
  savePx,
  sidebarDragMax,
  sidebarPushCollapses,
} from "./lib/layout";
import {
  isMissingProjectError,
  patchApplied,
  sameSet,
  sessionListEq,
} from "./lib/sessionList";
import { Chat } from "./components/Chat";

/**
 * 布局照着 Codex 桌面端：左侧按项目分组的会话列表（可拖宽、可收起），
 * 主区顶部一条工具栏，中间是对话流，右侧一个多标签工作台（浏览器 /
 * Git 改动 / 每个预览文件各占一个标签，共存不互斥，点着切换；以后的
 * 新面板就是新的一种标签），底部一条终端面板。附属面板的尺寸都能拖，
 * 且记住上次的位置。
 *
 * 没有"当前工作区"这个全局概念 —— 每个会话在创建时绑定自己的项目
 * 目录，之后永不改变。多项目并行时谁也不影响谁；"换了目录代码还写进
 * 旧目录"那类 bug 在这个模型下没有生存空间。
 */
/** 同时保活的会话树上限。切走不卸 DOM，切回才不是白屏。 */
const KEEP_CHATS = 4;

export function App() {
  const { t, tn } = useT();
  const [config, setConfig] = useState<ConfigStatus | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  /**
   * 会话列表的"此刻"那一份。
   *
   * 右键菜单存进 `menu` 之后会一直挂在屏幕上，它里面的删除动作执行时，
   * 建菜单那次渲染的闭包早就过期了 —— 期间 5 秒轮询和定时任务都在换
   * 整份列表。列表本身的修改一律走函数式更新；这个 ref 只给那些"要拿
   * 列表算点别的"（切哪个会话、哪些要清缓存）的地方读。
   */
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  /**
   * 覆盖整份会话列表（拉全量的那几条路共用）。
   *
   * `[约束]` 内容没变就不换引用。`listSessions` 每次都产出全新的数组和
   * 全新的元素对象，而忙碌时每 5 秒就拉一次 —— 不比一遍的话，每一拍都
   * 会重跑探测 effect（一次 probeDirs、解绑重绑 visibilitychange/focus）、
   * 换掉 `activeSession` 的对象身份、连带全局快捷键监听重绑，最后整棵树
   * 重渲染一次。这些全和流式输出的每帧 setState 挤同一条主线程。
   * 范式同 useBrowserPanel 的 panelEq。
   */
  const applySessions = useCallback((next: SessionInfo[]) => {
    setSessions((prev) => (sessionListEq(prev, next) ? prev : next));
  }, []);
  const [active, setActive] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const { recency, touchSession } = useSessionRecency(sessions, booting);
  const [showSettings, setShowSettings] = useState(false);
  /** 定时任务页在主区前台（侧栏一级菜单进入，选会话退出）。 */
  const [schedulePage, setSchedulePage] = useState(false);
  /** 详情面板正看着的任务。详情占用系统右侧栏（工作台抽屉的位置）。 */
  const [selectedSchedule, setSelectedSchedule] = useState<string | null>(null);
  const {
    schedules,
    setSchedules,
    missedSchedules,
    setMissedSchedules,
    reloadSchedules,
    settleMissed,
  } = useSchedules(applySessions);
  /** 创建定时任务的开场白。走 Composer 的 insertText 通道。 */
  const [schedSnippet, setSchedSnippet] = useState<string | null>(null);
  /** 手动创建定时任务的表单在右侧栏展开着。和 selectedSchedule 互斥 ——
   *  两者占的是同一块地方。 */
  const [schedCreating, setSchedCreating] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  /** 目录已不在磁盘上、等用户决定怎么处理的那个项目。 */
  const [goneRoot, setGoneRoot] = useState<string | null>(null);
  /** 探测过、确认不存在的项目根。用来在侧栏和欢迎页标「已失效」。 */
  const [missing, setMissing] = useState<Set<string>>(() => new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  /** 右侧工作台：标签组 + 激活项 + 抽屉开合。标签共存不互斥（Codex
   *  同款），浏览器 / Git 改动 / 每个预览文件各占一个，点着切换。 */
  const [wb, setWb] = useState<WorkbenchState>(EMPTY_WORKBENCH);
  /** 每个会话自己的工作台（工具窗跟会话走：浏览器内容、预览标签本来
   *  就是会话的）。切会话整存整取；会话删除时由 dropSessionWorkbench
   *  清掉。 */
  const workbenchBySession = useRef(new Map<string, WorkbenchState>());
  /** 最近真正看过的预览文件。激活标签不是预览时，保活着的预览面板仍
   *  需要一个"当前文件"定住各 body 的 display —— 用它，免得隐藏的
   *  面板里乱切一通（渲染器会白做适配）。 */
  const lastPreview = useRef<string | null>(null);
  const [showTerm, setShowTerm] = useState(false);
  const runningAgentTerms = useRunningAgentTerminals();
  const [showSessionCfg, setShowSessionCfg] = useState(false);
  /**
   * 每个会话生效中的权限档，由 Composer 上报。SessionInfo.mode 是宿主侧
   * 的 PermissionMode，规划中它是 "plan"，而弹窗要显示的是"批准后按哪档
   * 执行" —— 那个值只有 Composer 知道。
   */
  const [execModes, setExecModes] = useState<Record<string, PermissionMode>>({});
  /** 会话设置弹窗选的权限档，送去给 Composer 落地。 */
  const [permPick, setPermPick] = useState<{ id: string; pick: PermissionPick } | null>(null);
  /** 递增一次，改动面板 / 预览抽屉重新读盘。编辑落盘、轮次结束、回退时推。 */
  const [changesRev, setChangesRev] = useState(0);
  /** 每个会话的计划（从对话条目派生，由 Chat 上报）。右侧抽屉的计划
   *  面板、标签上的标题都从这里取。 */
  const [plans, setPlans] = useState<Record<string, PlanState>>({});
  const onPlanChange = useCallback((sessionId: string, state: PlanState) => {
    setPlans((prev) => {
      const cur = prev[sessionId];
      // 按内容比：流式期间 Chat 每帧派生一份新对象，按引用比的话整个 App
      // 会跟着每个 token 重渲染一次。
      if (
        cur &&
        samePlan(cur.plan, state.plan) &&
        sameTodos(cur.todos, state.todos) &&
        cur.streaming === state.streaming &&
        cur.canBuild === state.canBuild &&
        cur.edits === state.edits
      ) {
        return prev;
      }
      // 内容没变的部分沿用旧对象，PlanPanel 的依赖不白翻。
      const plan = cur && samePlan(cur.plan, state.plan) ? cur.plan : state.plan;
      const todos = cur && sameTodos(cur.todos, state.todos) ? cur.todos : state.todos;
      return { ...prev, [sessionId]: { ...state, plan, todos } };
    });
  }, []);
  /** 用户从终端选中、要交给模型的一段输出。塞进输入框而不是直接发送 ——
   *  他多半还要在前面补一句"这个报错怎么回事"。 */
  const [termSnippet, setTermSnippet] = useState<string | null>(null);
  /** 用户在浏览器面板"取件"点中的元素选择器。同样塞进输入框而不是直接发 ——
   *  他还要补一句"把它改成…"。和 termSnippet 共用 Composer 的 insertText 通道。 */
  const [pickSnippet, setPickSnippet] = useState<string | null>(null);
  /** 最近看过的会话 id（LRU）。这些 Chat 卸不掉，切回去是显示/隐藏。 */
  const [kept, setKept] = useState<string[]>([]);
  const {
    isMobile,
    sidebarOpen,
    setSidebarOpen,
    sidebarVisual,
    setSidebarVisual,
    closeSidebarIfMobile,
    toggleSidebar,
    collapseSidebar,
    sidebarW,
    setSidebarW,
    drawerW,
    setDrawerW,
    termH,
    setTermH,
    schedDetailW,
    setSchedDetailW,
    fullscreen,
    dragFrom,
    dragLive,
  } = usePanelLayout();
  /** 终端收起动画那一拍里内容还要显示（见 TerminalPanel 的 visible）。
   *  放在状态区：App 有条件早退，hook 不能出现在那之后。 */
  const termPresent = usePresence(showTerm);
  /** 任务详情占着右侧栏时，工作台抽屉让位。hook 必须在早退之前。 */
  const scheduleDetailOpen = Boolean(
    schedulePage && selectedSchedule && schedules.some((t) => t.id === selectedSchedule),
  );
  const rightDrawerOpen = Boolean(active && wb.open && !scheduleDetailOpen);
  /** 抽屉还在画面上（含收起动画）。内容要留着，否则是空壳在滑。 */
  const drawerPresent = usePresence(rightDrawerOpen);
  /** 收起动画那 500ms 里，空状态定格在收起前的样子。关掉最后一个标签是
   *  「标签清空」和「抽屉收起」同一拍发生，照 wb.tabs 直接判的话，"添加
   *  面板"那张菜单会在抽屉往外滑的途中冒出来亮一下 —— 用户刚关完东西，
   *  看到的却是一张新菜单飘走。抽屉 keepMounted，SlidePanel 的"最后一帧"
   *  兜不到这里（那条路只在 children 为 null 时走），所以自己记一个。 */
  const emptyShown = useRef(false);
  if (rightDrawerOpen) emptyShown.current = wb.tabs.length === 0;
  const showWorkbenchEmpty = rightDrawerOpen ? wb.tabs.length === 0 : emptyShown.current;
  /** 壳真正开始改宽度的那一拍。窗口开关跟这个走：跟收起动画对齐
   *  坐回顶栏，设置钮才不会先被主区拽到窗口右缘、再被开关挤回来。 */
  const [drawerVisual, setDrawerVisual] = useState(false);
  /** 拖抽屉把左栏往外推时，左栏这一刻露出的宽度。只在那次拖动里有值，
   *  松手就清掉（收起或弹回），见 drawerDragLayout。 */
  const [sidebarShown, setSidebarShown] = useState<number | null>(null);
  const sidebarShownLive = useRef<number | null>(null);
  /** 拖左栏时右列跟着按比例变（见 rightShare）：按下那一刻是哪个右列、
   *  占「窗口 − 左栏」的比例，以及拖动中的最新宽度（松手写盘用）。
   *  右列没开、或窄屏浮层时为 null。 */
  const sidebarDragRight = useRef<{ kind: "drawer" | "sched"; ratio: number; live: number } | null>(
    null,
  );

  useEffect(() => {
    // 必须 catch。没有它的话，任何一次失败都表现为永远停在"启动中" ——
    // 而那种状态不给用户任何可操作的信息，是最糟的一种失败。
    getConfig()
      .then(async (c) => {
        setConfig(c);
        // 宿主还活着的话（前端刷新、HMR），把它内存里的会话捞回来。
        const live = await listSessions().catch(() => [] as SessionInfo[]);
        setSessions(live);
        const last = live[live.length - 1];
        if (last) setActive(last.id);
      })
      .catch((e: unknown) => setBootError(String(e)))
      .finally(() => setBooting(false));
  }, []);

  const projectList = config?.config.projects;
  // 走 useMemo 而不是就地 `?? []`：后者每次渲染都产出新数组，而快捷键
  // effect 依赖它 —— 等于每渲染一次就把 window 的 keydown 解绑重绑一次。
  const projects = useMemo(() => projectList ?? [], [projectList]);
  const activeSession = sessions.find((s) => s.id === active) ?? null;
  /** 当前会话里模型起的、还在跑的终端数。顶栏终端按钮上的计数。 */
  const agentTermsHere = runningAgentTerms.filter((x) => x.sessionId === active).length;
  /** 当前会话生效中的权限档，顶栏标记和会话设置弹窗共用。Composer 还没
   *  上报时退到宿主侧的值；那时它是 plan 的话说明还没有人记得进规划前
   *  那一档，按最严的算。 */
  const activePermission: PermissionMode | null = activeSession
    ? (execModes[activeSession.id] ??
      (activeSession.mode === "plan" ? "default" : activeSession.mode))
    : null;
  /** 顶栏下拉选了新档 → 排给当前会话的 Composer 落地。 */
  const pickPermission = (m: PermissionMode) => {
    if (!activeSession) return;
    const id = activeSession.id;
    setPermPick((prev) => ({ id, pick: { mode: m, seq: (prev?.pick.seq ?? 0) + 1 } }));
  };
  const update = useAppUpdate(!booting && !bootError);
  const updateNotice = update.banner;

  /** 激活的工作台标签。抽屉的渲染分支和顶栏开关的亮灭都从它派生。 */
  const activeTab = wb.tabs.find((t) => tabId(t) === wb.active) ?? null;
  /** 正显示着的标签种类。抽屉收起时是 null —— 开关状态别亮着。
   *  这是**逻辑**状态（开关亮灭、快捷键的"再按一次收起"都看它），
   *  渲染分支不要用它，用下面的 shownKind。 */
  const activeKind = wb.open ? (activeTab?.kind ?? null) : null;
  /**
   * 抽屉还在画面上时（含收起动画）该渲染哪一类面板。
   *
   * `[约束]` 渲染分支必须走这个，不能走 activeKind。activeKind 挂在
   * wb.open 上，一点收起就立刻变 null，面板在动画第一帧就被卸掉/隐藏 ——
   * 标签栏以下只剩一块底色跟着滑出去（症状：刚点收起，浏览器画面就
   * 整块消失了，然后才看到抽屉在动）。drawerPresent 会多撑一拍（见
   * usePresence），正好覆盖这段动画。
   *
   * 切标签时它跟 activeKind 同步变（drawerPresent 一直是 true），所以
   * "浏览器切走就停帧流"那条优化不受影响 —— 多留的只是收起动画这
   * 半秒。
   */
  const shownKind = drawerPresent ? (activeTab?.kind ?? null) : null;
  /** 预览面板在前台：预览某个文件，或"文件"标签（树 + 占位）。两种
   *  标签落在同一个面板实例上，树只有一份。 */
  const previewPanelShown = shownKind === "preview" || shownKind === "files";
  /** 打开着的预览文件（kind=preview 的标签），即预览面板的保活集合。 */
  const previewPaths = useMemo(
    () => wb.tabs.flatMap((t) => (t.kind === "preview" ? [t.path] : [])),
    [wb.tabs],
  );
  const hasFilesTab = wb.tabs.some((t) => t.kind === "files");
  /** 浏览器标签开着没有（不管在不在前台）。页面状态的轮询跟着它走 ——
   *  页面标签展开在统一标签栏上，浏览器在后台时标签也得是活的。 */
  const hasBrowserTab = wb.tabs.some((t) => t.kind === "browser");
  const {
    panel: browserPages,
    apply: applyBrowserPanel,
    patchTab: patchBrowserTab,
  } = useBrowserPanel(activeSession?.id ?? null, hasBrowserTab);

  // 记住最近真正看过的预览文件。effect 不带依赖数组没问题 —— 每次
  // 渲染就一次 ref 赋值，比精确依赖便宜也不会错。
  useEffect(() => {
    if (activeTab?.kind === "preview") lastPreview.current = activeTab.path;
  });
  /** 预览面板这个会话里显示过没有。面板的保活是"显示过之后切走不卸"，
   *  而不是"一恢复会话就在 display:none 里首挂" —— 文档渲染器的首屏
   *  适配必须发生在看得见的容器里（见 FilePreviewPanel 的保活注释）。 */
  const [previewWarm, setPreviewWarm] = useState(false);
  useEffect(() => {
    if (previewPanelShown) setPreviewWarm(true);
  }, [previewPanelShown]);
  /** 预览面板此刻该显示的文件：激活标签是预览就是它；是"文件"标签就
   *  没有（占位 + 树）；面板在后台保活时停在最近看过的那个，别的标签
   *  切来切去不动它。 */
  const activePreviewPath =
    activeTab?.kind === "preview"
      ? activeTab.path
      : shownKind === "files"
        ? null
        : lastPreview.current && previewPaths.includes(lastPreview.current)
          ? lastPreview.current
          : (previewPaths[previewPaths.length - 1] ?? null);

  /** 打开（或激活）一个标签，抽屉随之展开。用户点标签、快捷键、"+"菜单，
   *  以及模型用起浏览器/预览工具，都走这一条。 */
  const openTab = useCallback((tab: WorkbenchTab) => {
    setWb((prev) => {
      const id = tabId(tab);
      if (prev.tabs.some((t) => tabId(t) === id)) {
        return { ...prev, active: id, open: true };
      }
      // 正看着"文件"标签（树 + 占位）时开出第一个预览：预览原位接管这个
      // 标签，而不是在它旁边再开一个。否则那枚"文件"永远空着 —— 用户是
      // 从树里点过来的，树钉在预览旁边继续用，占位页没有存在的必要了。
      // 想要回到"只有树"的形态，⌘⇧E / "+"菜单随时能再开一枚。
      if (
        tab.kind === "preview" &&
        prev.active === "files" &&
        prev.tabs.some((t) => t.kind === "files")
      ) {
        return {
          ...prev,
          tabs: prev.tabs.map((t) => (t.kind === "files" ? tab : t)),
          active: id,
          open: true,
          tree: true,
        };
      }
      return { ...prev, tabs: [...prev.tabs, tab], active: id, open: true };
    });
  }, []);

  /** 关一个标签。关的是激活的就让右邻顶上（没有则左邻，浏览器同款）；
   *  关掉最后一个连抽屉一起收 —— 空状态是"添加面板"的菜单，而刚关完最后
   *  一个标签的人是想腾地方，不是想再加一个，把半个屏幕留给一张没人要的
   *  菜单还得再点一次关。想要那张菜单，顶栏开关展开就有。 */
  const closeTab = useCallback(
    (id: string) => {
      const idx = wb.tabs.findIndex((t) => tabId(t) === id);
      if (idx < 0) return;
      const doClose = () => {
        const tabs = wb.tabs.filter((t) => tabId(t) !== id);
        let active = wb.active;
        if (active === id) {
          const neighbor = tabs[Math.min(idx, tabs.length - 1)];
          active = neighbor ? tabId(neighbor) : null;
        }
        setWb({ ...wb, tabs, active, open: tabs.length > 0 && wb.open });
      };
      // 预览编辑器里改了没存：关标签就是丢掉这些修改，先问一句。
      const tab = wb.tabs[idx];
      if (tab?.kind === "preview" && hasUnsaved(tab.path)) {
        setConfirm({
          title: t("app.workbench.unsavedTitle", { name: basename(tab.path) }),
          body: t("app.workbench.unsavedBody"),
          confirmLabel: t("app.workbench.closeDiscard"),
          action: doClose,
        });
        return;
      }
      doClose();
    },
    [wb, t],
  );

  /** 收起抽屉（标签保留，激活项记着，再展开回到原处）。 */
  const collapseDrawer = useCallback(() => {
    setWb((prev) => ({ ...prev, open: false }));
  }, []);

  /** 展开抽屉。标签组原样回来；一个标签都没有就是空状态（添加面板的菜单）。 */
  const openDrawer = useCallback(() => {
    setWb((prev) => ({ ...prev, open: true }));
  }, []);

  /** 系统文件选择框 → 预览标签。文件树的"从磁盘打开"按钮和 ⌘O 共用这一条。
   *  和文件树的区别只有一点：能打开项目外的文件。
   *  openFilePreview 自带分流：可预览的开成标签，图片开大图，其余访达定位。 */
  const pickAndPreview = useCallback(() => {
    void pickFiles().then((paths) => {
      for (const p of paths) openFilePreview(p);
    });
  }, []);

  /** 每按一次 ⌘P 加一。文件树看到它变了就把焦点放进筛选框。计数而不是
   *  布尔：树可能还没挂载（"文件"标签是这一下才开的），用布尔的话得再
   *  写一手"用完复位"的往返。 */
  const [treeFilterFocus, setTreeFilterFocus] = useState(0);

  /** 预览头部的树开关。 */
  const toggleTree = useCallback(() => {
    setWb((prev) => ({ ...prev, tree: !prev.tree }));
  }, []);

  /** 树里点了一个文件。开成预览标签之余把树钉住 —— 用户正是从树里
   *  点过来的，文件一开树就没了等于把他刚用的东西收走。图片开大图、
   *  预览不了的走访达，这两种不碰树。 */
  const openFromTree = useCallback((abs: string) => {
    if (openFilePreview(abs) === "preview") {
      setWb((prev) => (prev.tree ? prev : { ...prev, tree: true }));
    }
  }, []);

  /** 文件树的右键菜单。只读浏览：没有新建 / 改名 / 删除 —— 那些交给
   *  agent 走工具链和权限管线。 */
  const treeMenu = (e: React.MouseEvent, target: TreeTarget) => {
    e.preventDefault();
    e.stopPropagation();
    const entries: MenuState["entries"] = [];
    if (!target.isDir) {
      entries.push({ label: t("app.treeMenu.preview"), action: () => openFromTree(target.abs) });
    }
    entries.push({
      label: t("app.treeMenu.addToChat"),
      // 目录引用带结尾 `/`，和 `@` 菜单选目录同一约定（见 pathDisplay.isDirRef）。
      action: () =>
        setPickSnippet(encodeRefForComposer(target.isDir ? asDirRef(target.rel) : target.rel)),
    });
    entries.push({
      label: t("app.treeMenu.copyRelPath"),
      action: () => void navigator.clipboard.writeText(target.rel),
    });
    entries.push({
      label: t("app.treeMenu.copyFullPath"),
      action: () => void navigator.clipboard.writeText(target.abs),
    });
    entries.push({
      label: t("app.treeMenu.revealInFileManager"),
      action: () => void revealInFinder(target.abs),
    });
    setMenu({ x: e.clientX, y: e.clientY, entries });
  };

  /** 点了标签栏上的某个浏览器页面：把浏览器带到前台并切到那一页。 */
  const selectBrowserPage = (pageId: number) => {
    openTab({ kind: "browser" });
    if (activeSession) {
      void browserSelectTab(activeSession.id, pageId)
        .then(applyBrowserPanel)
        .catch(() => {});
    }
  };

  /** 关一个浏览器页面。最后一页关掉 = 收掉整个浏览器标签（和浏览器里
   *  关最后一个标签页等于关窗口一个道理）。宿主的进程和授权都留着，
   *  模型下次用到会现开一页。 */
  const closeBrowserPage = useCallback(
    (pageId: number) => {
      if (!activeSession) return;
      void browserCloseTab(activeSession.id, pageId)
        .then((s) => {
          applyBrowserPanel(s);
          if (s.tabs.length === 0) closeTab("browser");
        })
        .catch(() => {});
    },
    [activeSession, applyBrowserPanel, closeTab],
  );

  // 预览请求来自聊天引用、改动列表、Markdown 链接的模块级入口。
  // 已开过的文件只激活标签不重复开。标签共存，不再有"顶掉谁、回到谁"。
  useEffect(
    () => subscribeFilePreview((p) => openTab({ kind: "preview", path: p })),
    [openTab],
  );
  // 回答里的 `browser:` 链接（见 lib/linkIntent）：在内置浏览器里开。
  // 先问宿主手上有哪些页 —— 面板没开时 browserPages 是空的，可模型的
  // 浏览器工具可能早开过页了。切页、就地导航还是新开，见 planPanelOpen。
  // 就地导航时宿主会自己开第一页，和面板挂载时的 browser_open 在宿主
  // 那边排同一把锁，不会多出一个空白页。
  //
  // 这一串等抽屉滑完再发：切页、刷新会把 App 整棵树重渲染几次，页面
  // 重载又带来一阵帧，压在开合动画中段就是一帧卡上百毫秒（实测 106ms，
  // 点右上角开关只开面板时是 18ms）。面板本来就开着时没有动画，不等。
  useEffect(() => {
    const sid = activeSession?.id;
    if (!sid) return;
    return subscribePanelBrowser((url) => {
      openTab({ kind: "browser" });
      void slidesSettled()
        .then(() => browserState(sid))
        .then(async (s) => {
          const plan = planPanelOpen(s, url);
          if (plan.kind === "select") {
            applyBrowserPanel(await browserSelectTab(sid, plan.tab));
            if (plan.reload) await browserReload(sid);
            return;
          }
          if (plan.kind === "newTab") applyBrowserPanel(await browserNewTab(sid));
          await browserNavigate(sid, url);
        })
        .catch((e: unknown) => console.warn("Failed to open link in browser panel", e));
    });
  }, [activeSession?.id, openTab, applyBrowserPanel]);
  // 子 agent 会话：Task 卡片、后台任务面板、回答里的 `agent:` 链接都走
  // 这一条。同一个 agent 只开一个标签（tabId 按 agentId）。
  useEffect(
    () =>
      subscribeSubagentOpen(({ agentId, title }) =>
        openTab({ kind: "subagent", agentId, title }),
      ),
    [openTab],
  );
  // 模型起的终端：顶栏计数、工具卡片的"查看终端"。选哪个标签是
  // TerminalPanel 的事，这里只管把面板打开。
  useEffect(() => subscribeAgentTerminalOpen(() => setShowTerm(true)), []);
  // 计划面板：对话里的计划卡点开它。
  useEffect(() => subscribePlanOpen(() => openTab({ kind: "plan" })), [openTab]);
  // 历史会话：回答里的 `riot://session/<id>` 链接。会话已删就告诉链接
  // "没切成"，它自己提示 —— 点了没反应比一句"已删除"糟得多。
  useEffect(
    () =>
      subscribeSessionOpen((id) => {
        if (!sessions.some((s) => s.id === id)) return false;
        setActive(id);
        setSchedulePage(false);
        return true;
      }),
    [sessions],
  );
  /** 子 agent 面板拉到真名后改标签上的字（打开时可能只知道 id）。 */
  const retitleSubagent = useCallback((agentId: string, title: string) => {
    setWb((prev) => {
      let changed = false;
      const tabs = prev.tabs.map((t) => {
        if (t.kind !== "subagent" || t.agentId !== agentId || t.title === title) return t;
        changed = true;
        return { ...t, title };
      });
      return changed ? { ...prev, tabs } : prev;
    });
  }, []);

  // 切会话：工作台整组随会话切换（每个会话一份）。把当前组存回 Map、
  // 换上目标会话的组；目标会话没存过就是全收起 —— 新会话不该继承上
  // 一个会话临走前开着的面板。
  const prevSessionId = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevSessionId.current;
    const next = activeSession?.id ?? null;
    if (prev === next) return;
    if (prev) workbenchBySession.current.set(prev, wb);
    prevSessionId.current = next;
    setWb((next ? workbenchBySession.current.get(next) : undefined) ?? EMPTY_WORKBENCH);
    lastPreview.current = null;
    setPreviewWarm(false);
    // wb 是被保存的对象而不是触发条件 —— 只在会话切换那一刻读它当时的值。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession?.id]);

  // 欢迎页没有工作台：终端跟着会话走，最后一个会话删掉后收起。右侧
  // 抽屉不用管 —— 它按会话整存整取，没有会话就不渲染，上面的切换
  // effect 也已经把状态清成空。
  useEffect(() => {
    if (activeSession) return;
    setShowTerm(false);
  }, [activeSession]);

  // `[约束]` 链接点击的全局兜底，堵"整窗被导航走"的逃逸口。
  //
  // 预览面板渲染的 markdown / PDF 注释 / PPT 超链接是第三方库自己的
  // <a>，没有组件替它 preventDefault —— webview 的默认行为是把**主窗口
  // 整个导航到目标网址**：Riot 瞬间变成一个无边框浏览器，关掉它等于
  // 关掉应用。挂在 bubble 末端而不是 capture：聊天里的 MdLink 等组件
  // 自己处理过的点击（defaultPrevented）在这里直接放过，不会双开。
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      const a = e
        .composedPath()
        .find(
          (el): el is HTMLAnchorElement =>
            el instanceof HTMLAnchorElement && el.hasAttribute("href"),
        );
      if (!a) return;
      const href = a.getAttribute("href") ?? "";
      // 文档内锚点（目录跳转）不产生真实导航，放行。
      if (href.startsWith("#")) return;
      // 其余一律不许在应用 webview 里发生导航。
      e.preventDefault();
      if (/^https?:\/\//i.test(href) || href.startsWith("mailto:")) {
        void openInBrowser(href);
      }
      // 相对路径 / file: 静默拦下：导航过去只会是 404 白屏或裸文件页。
    };
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  }, []);

  /**
   * 要探测的目录。会话在这里只贡献一个 `root`，其余字段与探测无关 ——
   * 挂在整个 `sessions` 上的话，忙碌时每 5 秒一次的 busy 翻转都会让下面
   * 那个 effect 整个重跑：一次 probeDirs，外加解绑重绑两个窗口事件。
   *
   * 先算成一个字符串键、再从键还原数组：内容一样时数组的引用就不动。
   * 分隔符用 NUL —— 路径里不可能有它。
   */
  const rootsKey = useMemo(
    () => [...new Set([...(projectList ?? []), ...sessions.map((s) => s.root)])].join("\u0000"),
    [projectList, sessions],
  );
  const probeRoots = useMemo(() => (rootsKey ? rootsKey.split("\u0000") : []), [rootsKey]);

  // 项目列表不会因为用户在访达里删了文件夹而自己更新。启动和窗口
  // 回到前台时探一次，侧栏才能把失效项标出来，而不必等点「新会话」才知道。
  useEffect(() => {
    if (probeRoots.length === 0) {
      setMissing((prev) => (prev.size === 0 ? prev : new Set()));
      return;
    }
    const scan = () => {
      probeDirs(probeRoots)
        .then((gone) => {
          // 结果几乎永远不变（目录被删是罕见事件）。每次都换一个新 Set
          // 的话，光是切回窗口就会让整棵树重渲染一遍。
          const next = new Set(gone);
          setMissing((prev) => (sameSet(prev, next) ? prev : next));
        })
        .catch(() => {});
    };
    scan();
    const onVisible = () => {
      if (document.visibilityState === "visible") scan();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", scan);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", scan);
    };
  }, [probeRoots]);

  useLayoutEffect(() => {
    if (!active) return;
    setKept((prev) => {
      const alive = new Set(sessions.map((s) => s.id));
      const next = [...prev.filter((id) => id !== active && alive.has(id)), active];
      const clipped = next.length > KEEP_CHATS ? next.slice(next.length - KEEP_CHATS) : next;
      if (clipped.length === prev.length && clipped.every((id, i) => id === prev[i])) return prev;
      return clipped;
    });
  }, [active, sessions]);

  const mountedSessions = useMemo(() => {
    const alive = new Set(sessions.map((s) => s.id));
    const ids = kept.filter((id) => alive.has(id));
    if (active && !ids.includes(active)) ids.push(active);
    return ids
      .map((id) => sessions.find((s) => s.id === id))
      .filter((s): s is SessionInfo => !!s);
  }, [kept, sessions, active]);

  // 窗口标题跟随项目。多窗口/多桌面时，标题栏是用户分辨"哪个是哪个"
  // 的唯一线索。
  useEffect(() => {
    const name = activeSession?.root ? basename(activeSession.root) : undefined;
    setWindowTitle(name ? `${name} — Riot` : "Riot").catch(() => {});
  }, [activeSession?.root]);

  const noteError = useCallback((title: string, e: unknown) => {
    setConfirm({
      title,
      body: String(e),
      confirmLabel: t("app.dialog.gotIt"),
      danger: false,
      action: () => {},
    });
  }, [t]);

  const newSession = useCallback(async (root: string) => {
    try {
      let info = await createSession(root);
      // 开新会话跟当前正在看的那份模型走，而不是全局默认。否则刚在 A
      // 里换成便宜模型，点「新会话」又跳回设置页那个贵的。
      const src = sessionsRef.current.find((s) => s.id === active);
      if (src && (src.provider || src.model)) {
        const provider = src.provider;
        const model = src.model;
        if (provider !== info.provider || model !== info.model) {
          try {
            await setSessionModel(info.id, provider, model);
            info = { ...info, provider, model };
          } catch {
            // 会话已经建好了，模型停在创建时钉的全局默认上。
          }
        }
      }
      setMissing((prev) => {
        if (!prev.has(root)) return prev;
        const next = new Set(prev);
        next.delete(root);
        return next;
      });
      setSessions((prev) => [...prev, info]);
      setActive(info.id);
      touchSession(info.id);
      setSchedulePage(false);
    } catch (e) {
      // 目录被删是可恢复的：问要不要从列表拿掉或另选，别整页「出错了」。
      if (isMissingProjectError(e)) {
        setMissing((prev) => new Set(prev).add(root));
        setGoneRoot(root);
        return;
      }
      noteError(t("app.error.createSession"), e);
    }
  }, [active, noteError, touchSession, t]);

  const dirPicker = useDirectoryPicker();
  const pickDir = dirPicker.pick;
  const openProject = useCallback(async () => {
    const dir = await pickDir();
    if (!dir) return;
    try {
      const root = await addProject(dir);
      // 宿主更新了 projects 列表，重新拉一份而不是本地拼 —— 规范化
      // 和去重的规则在宿主那边，两边各写一遍迟早不一致。
      setConfig(await getConfig());
      await newSession(root);
    } catch (e) {
      if (isMissingProjectError(e)) {
        setMissing((prev) => new Set(prev).add(dir));
        setGoneRoot(dir);
        return;
      }
      noteError(t("app.error.openDir"), e);
    }
  }, [newSession, noteError, pickDir, t]);

  /** 会话发出第一条消息后补标题。宿主的 title 来自历史，UI 上要即时。 */
  const onFirstMessage = useCallback((sessionId: string, text: string) => {
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId && !s.title ? { ...s, title: text.slice(0, 40) } : s,
      ),
    );
  }, []);

  /**
   * 唯一那条提问被撤回了（模型没开口就停了），会话空了。
   *
   * 标题正是从那句话取的，得跟着撤 —— 宿主同步在做同一件事（见
   * `HostNotice::PromptWithdrawn`），这里只是让侧栏当场跟上，不然要
   * 等下一次拉列表才对。
   */
  const onSessionEmptied = useCallback((sessionId: string) => {
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, title: null } : s)));
  }, []);

  /** 会话设置提交成功后回写列表。listSessions 只在启动时拉一次，
   *  不回写的话，弹窗关掉再打开显示的就是旧值。 */
  const patchSession = useCallback((id: string, patch: Partial<SessionInfo>) => {
    setSessions((prev) => {
      const cur = prev.find((s) => s.id === id);
      // 值原本就是这个就不换引用。Chat 挂载时会把当时的 busy 原样报一次，
      // 而 KEEP_CHATS 保活着四个 —— 每次都产出新列表的话，切一次会话就是
      // 几次整树白重渲染。
      if (!cur || patchApplied(cur, patch)) return prev;
      return prev.map((s) => (s.id === id ? { ...s, ...patch } : s));
    });
  }, []);

  /**
   * 会话设置里的「存为提示词」：把当前正文追加进提示词库。
   *
   * 不带标题存 —— 界面会拿正文首行顶上。写提示词的那一刻让人先给它
   * 取个名，是在打断他手头正在做的事；想改名去设置里改。
   */
  const savePromptPreset = useCallback(
    async (body: string) => {
      const cfg = config?.config;
      if (!cfg) return;
      const list = cfg.prompts ?? [];
      setConfig(
        await saveConfig({ ...cfg, prompts: [...list, { id: newPresetId(list), body }] }),
      );
    },
    [config],
  );

  // 会话表：另一端（网页版 / 另一窗口）新建、删除、改名时重拉。
  // 顺带刷新 config —— 项目分组在那里，加项目不开会话也要跟上。
  useEffect(() => {
    const offSessions = subscribeSessionsChanges(() => {
      listSessions()
        .then(applySessions)
        .catch(() => {});
      getConfig()
        .then(setConfig)
        .catch(() => {});
    });
    const offConfig = subscribeConfigChanges(() => {
      getConfig()
        .then(setConfig)
        .catch(() => {});
    });
    return () => {
      offSessions();
      offConfig();
    };
  }, [applySessions]);

  // 后台会话的忙碌状态没有事件可订阅（只有挂载中的会话有事件流），
  // 侧栏的"正在跑"指示点只能靠轮询对齐。只在确实有会话在跑时才轮 ——
  // 全员空闲时一次都不发。
  const anyBusy = sessions.some((s) => s.busy);
  useEffect(() => {
    if (!anyBusy) return;
    const t = setInterval(() => {
      listSessions()
        .then(applySessions)
        .catch(() => {});
    }, 5000);
    return () => clearInterval(t);
  }, [anyBusy, applySessions]);

  /**
   * 全局 ⌘ 快捷键。macOS 用户带着 Finder/浏览器的肌肉记忆来 ——
   * ⌘N 新会话、⌘, 设置、⌘B 侧栏、⌘J 终端。
   *
   * `[约束]` ⌘W 必须拦下来 preventDefault，否则 WKWebView 默认会关掉整个
   * 窗口 —— 用户想关的多半是一个面板，不是整个应用。这里把它接住当"收起
   * 当前抽屉/终端"，没有可收的就静默吃掉，绝不放它去关窗。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      switch (k) {
        case "n": {
          if (e.shiftKey) return;
          const root = activeSession?.root ?? projects[0];
          if (root) {
            e.preventDefault();
            void newSession(root);
          }
          return;
        }
        case ",":
          e.preventDefault();
          setShowSettings(true);
          return;
        case "b":
          e.preventDefault();
          toggleSidebar();
          return;
        case "j":
          e.preventDefault();
          // 终端组跟着会话走，欢迎页上没有归属可言 —— 不开。
          if (activeSession) setShowTerm((v) => !v);
          return;
        case "t":
          // ⌘T 浏览器（空状态菜单里标着同一个键）。已在前台就收起。
          if (e.shiftKey) return;
          e.preventDefault();
          if (!activeSession) return;
          if (activeKind === "browser") collapseDrawer();
          else openTab({ kind: "browser" });
          return;
        case "g":
          // ⌘⇧G Git 改动。不带 shift 的 ⌘G 留给"查找下一个"这类惯例。
          if (!e.shiftKey) return;
          e.preventDefault();
          if (!activeSession) return;
          if (activeKind === "changes") collapseDrawer();
          else openTab({ kind: "changes" });
          return;
        case "e":
          // ⌘⇧E 文件树（VS Code 的资源管理器同键）。不带 shift 的 ⌘E 留给
          // "用选区查找"这类惯例。
          if (!e.shiftKey) return;
          e.preventDefault();
          if (!activeSession) return;
          if (activeKind === "files") collapseDrawer();
          else openTab({ kind: "files" });
          return;
        case "p":
          // ⌘P 快速打开（VS Code 同键）：开出文件树、光标落进筛选框，
          // 直接敲文件名。必须拦下 —— webview 的默认行为是打印。
          if (e.shiftKey) return;
          e.preventDefault();
          if (!activeSession) return;
          openTab({ kind: "files" });
          setTreeFilterFocus((n) => n + 1);
          return;
        case "o":
          // ⌘O 系统文件选择框（各类应用"打开…"的通用键）。项目里的文件
          // 走 ⌘P 更快，这条留给项目外的文件。
          if (e.shiftKey) return;
          e.preventDefault();
          if (activeSession) pickAndPreview();
          return;
        case "w":
          // 永远拦下，绝不让它冒泡去关窗口。浏览器在前台时关的是当前
          // 页面（Chrome 肌肉记忆），最后一页连带收掉浏览器标签；其余
          // 情况关激活的工作台标签；空状态收抽屉；没抽屉就收终端；
          // 都没有就静默吃掉（绝不关窗）。
          e.preventDefault();
          if (wb.open && wb.active === "browser" && browserPages.tabs.length > 0) {
            closeBrowserPage(browserPages.active);
          } else if (wb.open && wb.active) {
            closeTab(wb.active);
          } else if (wb.open) {
            collapseDrawer();
          } else {
            setShowTerm((v) => (v ? false : v));
          }
          return;
        default:
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    activeSession,
    projects,
    newSession,
    toggleSidebar,
    wb,
    activeKind,
    openTab,
    collapseDrawer,
    pickAndPreview,
    closeTab,
    browserPages,
    closeBrowserPage,
  ]);

  /* ── 会话 / 项目操作 ──────────────────────── */

  /**
   * 会话没了，它在前端留下的一切跟着走：内存里的对话、滚动位置、
   * 输入框草稿与待发图、终端组、预览标签组。
   *
   * 收在一个函数里而不是在每个删除路径上各写一遍 —— 这些缓存都挂在
   * 模块级 Map 上，漏掉一处不会有任何报错，只是那份数据（含 base64
   * 图片）再也没人回收。删除会话有三条路径，以前每条都得记住三行。
   */
  const dropSessionWorkbench = (id: string) => {
    forgetSession(id);
    transcriptView.delete(id);
    forgetComposerSession(id);
    closeSessionTerminals(id);
    workbenchBySession.current.delete(id);
    setExecModes((prev) => {
      if (!(id in prev)) return prev;
      const { [id]: _gone, ...rest } = prev;
      return rest;
    });
    setPlans((prev) => {
      if (!(id in prev)) return prev;
      const { [id]: _gone, ...rest } = prev;
      return rest;
    });
  };

  const doDeleteSession = async (id: string) => {
    await deleteSession(id);
    dropSessionWorkbench(id);
    setKept((prev) => prev.filter((x) => x !== id));
    // `[约束]` 必须函数式更新。菜单是存进 `menu` state 之后一直挂在屏幕上
    // 的，从弹出到点「删除」之间，5 秒轮询和定时任务都可能换上一份新列表 ——
    // 拿建菜单那次渲染的快照去覆盖，等于把这期间新建的会话（比如后台
    // 定时任务刚开的那个）整条抹掉，侧栏凭空少一项。
    setSessions((prev) => prev.filter((s) => s.id !== id));
    // 切哪个会话也要读最新的列表，同样的理由。优先同项目最近的，
    // 没有就全局最近，再没有就回欢迎页。
    const live = sessionsRef.current;
    const victim = live.find((s) => s.id === id);
    const rest = live.filter((s) => s.id !== id);
    const sibling = victim
      ? [...rest].reverse().find((s) => s.root === victim.root)
      : undefined;
    const fallback = (sibling ?? rest[rest.length - 1])?.id ?? null;
    // 删的不是正看着的那个就别动焦点 —— `active` 同样可能在菜单挂着的
    // 期间被用户换过。
    setActive((cur) => (cur === id ? fallback : cur));
  };

  const doRename = async (id: string, title: string) => {
    setRenaming(null);
    try {
      await renameSession(id, title);
      // 空标题会回退到"第一条消息"，那个值只有宿主知道 —— 重新拉列表
      // 而不是本地猜
      applySessions(await listSessions());
    } catch (e) {
      setBootError(String(e));
    }
  };

  const doRemoveProject = async (root: string) => {
    const closed = await removeProject(root);
    const dead = (s: SessionInfo) => s.root === root || closed.includes(s.id);
    // 读最新那份列表，不是建菜单那次渲染的快照（理由见 doDeleteSession）。
    // 中间隔着 await，所以是个函数：用一次算一次。
    const deadIds = () =>
      new Set([...closed, ...sessionsRef.current.filter(dead).map((s) => s.id)]);
    const gone = deadIds();
    for (const id of gone) {
      dropSessionWorkbench(id);
    }
    setKept((prev) => prev.filter((id) => !gone.has(id)));
    setConfig(await getConfig());
    setSessions((prev) => prev.filter((s) => !dead(s)));
    setMissing((prev) => {
      if (!prev.has(root)) return prev;
      const n = new Set(prev);
      n.delete(root);
      return n;
    });
    if (goneRoot === root) setGoneRoot(null);
    // 上面那次 await 之后列表可能又变了，这里重新读一次。
    const rest = sessionsRef.current.filter((s) => !dead(s));
    const fallback = rest[rest.length - 1]?.id ?? null;
    const removed = deadIds();
    setActive((cur) => (cur !== null && removed.has(cur) ? fallback : cur));
  };

  /**
   * 失效项目换一个还在的目录。先打开新的，再把旧的从列表拿掉 ——
   * 反过来的话，选目录失败会先丢掉旧会话。
   */
  const relocateGone = async (oldRoot: string) => {
    const dir = await pickDir();
    if (!dir) return;
    try {
      const root = await addProject(dir);
      const info = await createSession(root);
      const closed = root === oldRoot ? [] : await removeProject(oldRoot);
      const dropped = new Set(closed);
      for (const id of dropped) {
        dropSessionWorkbench(id);
      }
      setKept((prev) => prev.filter((id) => !dropped.has(id)));
      setConfig(await getConfig());
      setSessions((prev) => [
        ...prev.filter((s) => s.root !== oldRoot && !dropped.has(s.id)),
        info,
      ]);
      setActive(info.id);
      touchSession(info.id);
      setMissing((prev) => {
        const n = new Set(prev);
        n.delete(root);
        n.delete(oldRoot);
        return n;
      });
    } catch (e) {
      if (isMissingProjectError(e)) {
        setMissing((prev) => new Set(prev).add(dir));
        setGoneRoot(dir);
        return;
      }
      noteError(t("app.error.openDir"), e);
    }
  };

  const sessionMenu = (e: React.MouseEvent, s: SessionInfo) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      anchor: `session:${s.id}`,
      entries: [
        {
          label: t("app.sessionMenu.rename"),
          action: () => {
            // 改名的输入框在侧栏里。从顶栏标题进来的时候侧栏可能是
            // 收起的 —— 不展开的话点了像没反应。
            setSidebarOpen(true);
            setRenaming(s.id);
          },
        },
        {
          label: t("app.sessionMenu.delete"),
          danger: true,
          action: () =>
            setConfirm({
              title: t("app.sessionMenu.deleteTitle"),
              body: t("app.sessionMenu.deleteBody", { title: s.title ?? t("app.newSession") }),
              confirmLabel: t("common.delete"),
              action: () => void doDeleteSession(s.id).catch((err: unknown) => setBootError(String(err))),
            }),
        },
      ],
    });
  };

  const projectMenu = (e: React.MouseEvent, root: string) => {
    e.preventDefault();
    e.stopPropagation();
    const name = basename(root) || root;
    const count = sessions.filter((s) => s.root === root).length;
    setMenu({
      x: e.clientX,
      y: e.clientY,
      anchor: `project:${root}`,
      entries: [
        { label: t("app.newSession"), action: () => void newSession(root) },
        { label: t("common.revealInFinder"), action: () => void revealInFinder(root) },
        {
          label: t("app.projectMenu.copyPath"),
          action: () => void navigator.clipboard.writeText(root),
        },
        {
          label: t("app.project.removeFromList"),
          danger: true,
          action: () =>
            setConfirm({
              title: t("app.projectMenu.removeTitle", { name }),
              body:
                count > 0
                  ? tn("app.projectMenu.removeBodyCount", count)
                  : t("app.projectMenu.removeBody"),
              confirmLabel: t("common.remove"),
              action: () => void doRemoveProject(root).catch((err: unknown) => setBootError(String(err))),
            }),
        },
      ],
    });
  };

  /** 定时任务行的「…」/ 右键菜单。操作全收在这里，行本身只负责跳转。 */
  const scheduleMenu = (e: React.MouseEvent, task: ScheduledTask) => {
    e.preventDefault();
    e.stopPropagation();
    const missed = missedSchedules.find((m) => m.taskId === task.id);
    const entries: MenuState["entries"] = [];
    if (missed) {
      entries.push({
        label: tn("app.scheduleMenu.rerunMissed", missed.count),
        action: () => {
          settleMissed(task.id);
          void scheduleRunNow(task.id).catch((err: unknown) =>
            noteError(t("app.error.rerun"), err),
          );
        },
      });
      entries.push({ label: t("app.scheduleMenu.ignoreMissed"), action: () => settleMissed(task.id) });
    }
    entries.push({
      label: t("app.scheduleMenu.runNow"),
      action: () =>
        void scheduleRunNow(task.id).catch((err: unknown) => noteError(t("app.error.runNow"), err)),
    });
    // 一次性任务跑完就没有"恢复"可言 —— 时刻已经过了，恢复了也不会再跑。
    const spent = task.repeat.kind === "once" && !task.enabled && !task.nextRunMs;
    if (!spent) {
      entries.push({
        label: task.enabled ? t("app.scheduleMenu.pause") : t("app.scheduleMenu.resume"),
        action: () =>
          void scheduleSetEnabled(task.id, !task.enabled)
            .then(reloadSchedules)
            .catch((err: unknown) =>
              noteError(task.enabled ? t("app.error.pause") : t("app.error.resume"), err),
            ),
      });
    }
    // 和点击行同一个判定：会话还活着才给入口，跳到已删除的会话
    // 只会退回欢迎页，看起来像点坏了。
    if (task.lastSessionId && sessions.some((s) => s.id === task.lastSessionId)) {
      const sid = task.lastSessionId;
      entries.push({
        label: t("app.scheduleMenu.viewLastRun"),
        action: () => {
          setActive(sid);
          setSchedulePage(false);
        },
      });
    }
    entries.push({
      label: t("app.scheduleMenu.delete"),
      danger: true,
      action: () =>
        setConfirm({
          title: t("app.scheduleMenu.deleteTitle", { name: task.name }),
          body: t("app.scheduleMenu.deleteBody"),
          confirmLabel: t("common.delete"),
          action: () =>
            void scheduleDelete(task.id)
              .then(reloadSchedules)
              .catch((err: unknown) => noteError(t("app.error.delete"), err)),
        }),
    });
    setMenu({ x: e.clientX, y: e.clientY, anchor: `schedule:${task.id}`, entries });
  };

  /**
   * 把一段开场白送回输入框（创建的主入口是对话）。任务页会退到后台，
   * 让会话接手 —— 没有活跃会话就什么都不做。
   */
  const scheduleCompose = (snippet: string) => {
    if (!activeSession) return;
    setSchedSnippet(encodePlainForComposer(snippet));
    setSchedulePage(false);
  };

  /** 任务页「创建」按钮的菜单：手动填表，或交给对话里的 agent。
   *  后者需要一个活跃会话把话送进去，没有就不列。 */
  const scheduleCreateMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const entries: MenuState["entries"] = [
      {
        label: t("app.scheduleCreate.manual"),
        action: () => {
          setSelectedSchedule(null);
          setSchedCreating(true);
        },
      },
    ];
    if (activeSession) {
      entries.push({
        label: t("app.scheduleCreate.byRiot"),
        action: () => scheduleCompose(t("app.scheduleCreate.prompt")),
      });
    }
    setMenu({ x: e.clientX, y: e.clientY, anchor: "schedule:create", entries });
  };

  /** 错过补跑：立即跑一次并把这条错过消掉。 */
  const rerunMissed = (m: MissedRun) => {
    settleMissed(m.taskId);
    void scheduleRunNow(m.taskId).catch((err: unknown) => noteError(t("app.error.rerun"), err));
  };

  /** 错过全部忽略。 */
  const dismissAllMissed = () => {
    setMissedSchedules([]);
    void scheduleAckMissed().catch(() => {});
  };

  /** 工作台标签栏的"+"菜单：往抽屉里添一个标签。已开着的项只是激活。
   *  以后的新面板在这里加一行，再到抽屉里加一个渲染分支。 */
  const workbenchAddMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      entries: [
        {
          label: t("app.workbench.browser"),
          action: () => {
            // 已经开着就再开一页（浏览器"+"的直觉）；还没开就先开起来，
            // 第一页宿主自己建。
            const had = wb.tabs.some((x) => x.kind === "browser");
            openTab({ kind: "browser" });
            if (had && browserPages.tabs.length > 0 && activeSession) {
              void browserNewTab(activeSession.id)
                .then(applyBrowserPanel)
                .catch(() => {});
            }
          },
        },
        { label: t("app.workbench.changes"), action: () => openTab({ kind: "changes" }) },
        { label: t("app.workbench.files"), action: () => openTab({ kind: "files" }) },
      ],
    });
  };

  if (bootError) {
    return (
      <div className="boot-fail">
        <h1>{t("app.boot.failed")}</h1>
        <pre className="boot-error">{bootError}</pre>
        <button className="primary" onClick={() => window.location.reload()}>
          {t("app.boot.reload")}
        </button>
      </div>
    );
  }

  if (booting || !config) {
    // 冷启动那一两秒别留纯白屏 —— 给个品牌骨架，让"在启动"看得出来。
    return (
      <div className="booting">
        <div className="booting-logo">Riot</div>
        <div className="booting-spinner" aria-label={t("app.boot.starting")} />
      </div>
    );
  }

  /** 抽屉逻辑上开着。窗口右上角归谁看 drawerPresent（含收起动画）。 */
  const drawerVisible = activeSession !== null && wb.open;
  /** 任务详情占用的就是抽屉这个位置：任务页前台 + 选中了任务才有。 */
  const selSchedule = schedulePage
    ? (schedules.find((t) => t.id === selectedSchedule) ?? null)
    : null;
  /** 右侧栏归定时任务：看详情，或填创建表单。 */
  const schedRailOpen = selSchedule !== null || (schedulePage && schedCreating);
  /** 窗口级分栏开关。钉在 .shell 右上角，不进顶栏 / 抽屉文档流。 */
  const windowControls = (
    <WindowControls
      terminalOpen={showTerm}
      terminalEnabled={activeSession !== null}
      terminalRunning={agentTermsHere}
      // 收着、且有模型的服务在跑：打开时直接切到它 —— 计数就是在说"这里
      // 有东西"，点开却落在一个空 shell 上等于答非所问。
      onToggleTerminal={() =>
        !showTerm && agentTermsHere > 0 ? openAgentTerminal() : setShowTerm((v) => !v)
      }
      drawerOpen={wb.open}
      drawerEnabled={activeSession !== null}
      onToggleDrawer={() => {
        if (wb.open) collapseDrawer();
        else openDrawer();
      }}
    />
  );

  return (
    <ProjectRootContext.Provider value={activeSession?.root ?? ""}>
    <div className="shell" data-fullscreen={fullscreen ? "" : undefined}>
      {/* anchor=end：内层贴壳的**右**缘。侧栏的左缘钉死在窗口左边，
          收起时动的是右缘 —— 内层跟着右缘走，整条侧栏才是被主区往左
          推出屏幕；贴左缘的话它原地不动、只是被从右往左啃掉，而主区
          左缘在移动，两样东西速度不一致，看起来就成了"主区盖上去"。
          详见 styles.css 的 .slide-panel.end。 */}
      {/* 窄屏：侧栏是浮在对话上的抽屉，点遮罩收起。桌面上不渲染这层。 */}
      {isMobile && sidebarOpen ? (
        <div className="mobile-backdrop" onClick={toggleSidebar} aria-hidden />
      ) : null}
      <SlidePanel
        axis="x"
        anchor="end"
        className="side"
        open={sidebarOpen}
        size={sidebarW}
        shown={sidebarShown}
        keepMounted
        onVisualOpen={setSidebarVisual}
      >
          <Sidebar
            width={sidebarW}
            projects={projects}
            missing={missing}
            sessions={sessions}
            active={active}
            renaming={renaming}
            onSelect={(id) => {
              setActive(id);
              setSchedulePage(false);
              closeSidebarIfMobile();
            }}
            recency={recency}
            onNewSession={(root) => {
              closeSidebarIfMobile();
              return newSession(root);
            }}
            onOpenProject={openProject}
            onSettings={() => {
              closeSidebarIfMobile();
              setShowSettings(true);
            }}
            onSchedules={() => {
              // 任务详情要占用右侧栏 —— 工作台开着就先收起来。
              // 进菜单不记住上次打开的详情，每次都从列表开始。
              collapseDrawer();
              setSelectedSchedule(null);
              setSchedCreating(false);
              setSchedulePage(true);
              closeSidebarIfMobile();
            }}
            schedulesActive={schedulePage}
            missedSchedules={missedSchedules.length}
            onSessionMenu={sessionMenu}
            onProjectMenu={projectMenu}
            menuAnchor={menu?.anchor ?? null}
            onRenameSubmit={doRename}
            onRenameCancel={() => setRenaming(null)}
            onCollapse={toggleSidebar}
          />
      </SlidePanel>
      {sidebarOpen ? (
        <Resizer
          axis="x"
          onStart={() => {
            dragFrom.current = sidebarW;
            dragLive.current = sidebarW;
            const avail = window.innerWidth - sidebarW;
            const right = isMobile
              ? null
              : schedRailOpen
                ? { kind: "sched" as const, w: schedDetailW }
                : rightDrawerOpen
                  ? { kind: "drawer" as const, w: drawerW }
                  : null;
            sidebarDragRight.current =
              right && avail > 0 ? { kind: right.kind, ratio: right.w / avail, live: right.w } : null;
          }}
          onDelta={(d) => {
            // 左栏变宽变窄时，主区和右列按按下那一刻的比例一起让、一起回来
            // （见 rightShare）。右列开着时左栏最多拖到给两者都留够下限。
            const right = sidebarDragRight.current;
            const rightMin = right ? (right.kind === "sched" ? SCHED_DETAIL.min : DRAWER_MIN) : 0;
            const w = clamp(dragFrom.current + d, SIDEBAR.min, sidebarDragMax(rightMin));
            dragLive.current = w;
            setSidebarW(w);
            if (right?.kind === "drawer") {
              right.live = rightShare(right.ratio, w, DRAWER_MIN);
              setDrawerW(right.live);
            } else if (right?.kind === "sched") {
              right.live = rightShare(right.ratio, w, SCHED_DETAIL.min, SCHED_DETAIL.max);
              setSchedDetailW(right.live);
            }
          }}
          onEnd={() => {
            savePx(LS.sidebar, dragLive.current);
            const right = sidebarDragRight.current;
            sidebarDragRight.current = null;
            if (right) savePx(right.kind === "sched" ? LS.schedDetail : LS.drawer, right.live);
          }}
          onReset={() => {
            setSidebarW(SIDEBAR.def);
            savePx(LS.sidebar, SIDEBAR.def);
          }}
        />
      ) : null}

      <div className="main">
        {/* 任务页不要这条会话工具栏 —— 标题、设置、面板开关管的都是
            会话。侧栏收起时开关由任务页顶部区承接，开着时在侧栏顶栏。 */}
        {schedulePage ? null : (
          <TopBar
            sidebarOpen={sidebarVisual}
            onToggleSidebar={toggleSidebar}
            session={activeSession}
            permission={activePermission}
            onPermission={pickPermission}
            onSessionMenu={sessionMenu}
            sessionCfgOpen={showSessionCfg}
            sessionCfgEnabled={activeSession !== null}
            onToggleSessionCfg={() => setShowSessionCfg((v) => !v)}
            onOpenBrowser={() => openTab({ kind: "browser" })}
            reserveControls={!drawerVisual}
          />
        )}

        {updateNotice ? (
          <div className="update-banner" role="status">
            <span>{t("app.update.released", { version: updateNotice.latest ?? "" })}</span>
            <button className="ghost" onClick={() => void openInBrowser(updateNotice.url)}>
              {t("app.update.download")}
            </button>
            <button
              className="update-banner-dismiss"
              onClick={update.dismiss}
              title={t("common.close")}
              aria-label={t("common.close")}
            >
              ×
            </button>
          </div>
        ) : null}

        <div className="workarea">
          <div className="chat-col" ref={trackChatColWidth}>
            {schedulePage ? (
              <SchedulesPage
                schedules={schedules}
                missed={missedSchedules}
                selected={selectedSchedule}
                onSelect={(id) => {
                  // 点开一条任务的详情就把创建表单收掉：同一块地方。
                  if (id) setSchedCreating(false);
                  setSelectedSchedule(id);
                }}
                sidebarOpen={sidebarVisual}
                onToggleSidebar={toggleSidebar}
                onMenu={scheduleMenu}
                menuAnchor={menu?.anchor ?? null}
                onCreate={scheduleCreateMenu}
                onClearDone={() => {
                  const done = schedules.filter(isDoneSchedule);
                  if (done.length === 0) return;
                  setConfirm({
                    title: tn("app.schedules.clearDoneTitle", done.length),
                    body: t("app.schedules.clearDoneBody"),
                    confirmLabel: t("app.schedules.clearDone"),
                    action: () =>
                      void Promise.all(done.map((t) => scheduleDelete(t.id)))
                        .then(() => {
                          setSelectedSchedule((id) =>
                            id && done.some((t) => t.id === id) ? null : id,
                          );
                          reloadSchedules();
                        })
                        .catch((err: unknown) => noteError(t("app.error.clearDone"), err)),
                  });
                }}
                onSuggest={scheduleCompose}
                onRerunMissed={rerunMissed}
                onDismissMissed={dismissAllMissed}
              />
            ) : null}
            {activeSession ? (
              mountedSessions.map((s) => {
                const visible = !schedulePage && s.id === activeSession.id;
                return (
                  <div
                    key={s.id}
                    className={visible ? "chat-pane" : "chat-pane is-hidden"}
                    aria-hidden={!visible}
                    inert={!visible}
                  >
                    <Chat
                      sessionId={s.id}
                      visible={visible}
                      expectHistory={s.title != null}
                      config={config}
                      workspace={s.root}
                      workspaceMissing={missing.has(s.root)}
                      onMissingWorkspace={() => setGoneRoot(s.root)}
                      initialMode={s.mode}
                      initialMultitask={s.multitask}
                      sessionProvider={s.provider ?? ""}
                      sessionModel={s.model ?? ""}
                      onSessionEndpoint={(provider, model) =>
                        patchSession(s.id, { provider, model })
                      }
                      sessionThinking={s.thinking}
                      onSessionThinking={(thinking) => patchSession(s.id, { thinking })}
                      onConfig={setConfig}
                      onOpenSettings={() => setShowSettings(true)}
                      permissionPick={permPick?.id === s.id ? permPick.pick : null}
                      onPermissionChange={(m) =>
                        setExecModes((prev) => (prev[s.id] === m ? prev : { ...prev, [s.id]: m }))
                      }
                      execMode={execModes[s.id] ?? (s.mode === "plan" ? "default" : s.mode)}
                      onFirstMessage={onFirstMessage}
                      onSessionEmptied={onSessionEmptied}
                      onAgentBrowser={() => {
                        if (!visible) return;
                        openTab({ kind: "browser" });
                      }}
                      onAgentPreview={(p) => {
                        // 后台会话不抢前台的预览面板 —— 切回来时不补开，
                        // 和浏览器同一个取舍。
                        if (!visible) return;
                        // 模型可能传相对路径（内核按会话目录解析成功了），
                        // 前端拿到的是原文，同样按会话根目录拼绝对路径。
                        const abs = looksAbsPath(p)
                          ? p
                          : `${s.root.replace(/[\\/]+$/, "")}/${p}`;
                        openFilePreview(abs);
                      }}
                      onTurnEnd={() => setChangesRev((n) => n + 1)}
                      onFilesChanged={() => setChangesRev((n) => n + 1)}
                      onBusy={(b) => patchSession(s.id, { busy: b })}
                      onPlanChange={onPlanChange}
                      onPlanOpen={() => openTab({ kind: "plan" })}
                      insertText={visible ? (termSnippet ?? pickSnippet ?? schedSnippet) : null}
                      onInserted={() => {
                        setTermSnippet(null);
                        setPickSnippet(null);
                        setSchedSnippet(null);
                      }}
                    />
                  </div>
                );
              })
            ) : !schedulePage ? (
              <Welcome
                projects={projects}
                missing={missing}
                onNewSession={newSession}
                onOpenProject={openProject}
              />
            ) : null}
          </div>
        </div>

        {showTerm ? (
          <Resizer
            axis="y"
            onStart={() => {
              dragFrom.current = termH;
              dragLive.current = termH;
            }}
            onDelta={(d) => {
              // 终端拖的是上缘：往上（负位移）变高
              const h = clamp(
                dragFrom.current - d,
                TERM.min,
                Math.round(window.innerHeight * 0.65),
              );
              dragLive.current = h;
              setTermH(h);
            }}
            onEnd={() => savePx(LS.term, dragLive.current)}
            onReset={() => {
              setTermH(TERM.def);
              savePx(LS.term, TERM.def);
            }}
          />
        ) : null}
        {/* 常驻挂载（keepMounted）：收起只是壳收到 0，shell 和回滚缓冲
            都留着。visible 用 termPresent —— 收起动画那一拍里内容还得
            显示着，不然是内容先消失、空壳再收起。

            anchor 用默认的 start（内层贴壳顶）：底栏的下缘钉在窗口底，
            收起时动的是上缘，内层贴住上缘才会整块随壳往下滑出窗口。
            规则和取舍见 styles.css 的 .slide-panel.end。
            `[约束]` 这里**不能**用 end。那是"从顶上裁"，而终端的标签栏和
            输出全在上半截：收到一半时它们已经被吃光，剩下一块和对话区
            同色的空矩形在缩，看起来就是"直接消失"而不是收起来了。 */}
        <SlidePanel axis="y" open={showTerm} size={termH} keepMounted>
          <TerminalPanel
            visible={termPresent}
            height={termH}
            sessionId={activeSession?.id ?? null}
            defaultRoot={activeSession?.root ?? projects[0] ?? null}
            onHide={() => setShowTerm(false)}
            onSendSelection={setTermSnippet}
          />
        </SlidePanel>
      </div>

      {/* 抽屉是 main 的兄弟：整列全高（Codex 同款），terminal 只垫在对话
          下面。抽屉和对话共享同一个会话 —— 这正是它存在的意义：你和模型
          看同一个页面。

          里面是多标签工作台：顶部一条统一标签栏，浏览器 / Git 改动 /
          每个预览文件各占一个标签，共存不互斥。整列同一时刻仍只显示
          一个标签的内容 —— 并排铺开会把对话挤成一条缝。宽度所有标签
          共享，拖过一次全都记住。

          任务页前台时这个位置归定时任务（详情或创建表单；进入任务页时
          工作台已被收起，见侧栏的 onSchedules）。 */}
      {schedRailOpen ? (
        <Resizer
          axis="x"
          onStart={() => {
            dragFrom.current = schedDetailW;
            dragLive.current = schedDetailW;
          }}
          onDelta={(d) => {
            // 详情拖的是左缘：往左（负位移）变宽
            const w = clamp(
              dragFrom.current - d,
              SCHED_DETAIL.min,
              Math.min(
                SCHED_DETAIL.max,
                rightPanelMax(sidebarOpen ? sidebarW : 0, SCHED_DETAIL.min),
              ),
            );
            dragLive.current = w;
            setSchedDetailW(w);
          }}
          onEnd={() => savePx(LS.schedDetail, dragLive.current)}
          onReset={() => {
            setSchedDetailW(SCHED_DETAIL.def);
            savePx(LS.schedDetail, SCHED_DETAIL.def);
          }}
        />
      ) : null}
      <SlidePanel
        axis="x"
        className="rail"
        open={schedRailOpen}
        size={schedDetailW}
        keepMounted
      >
        {selSchedule ? (
          <ScheduleDetail
            key={selSchedule.id}
            task={selSchedule}
            width={schedDetailW}
            sessions={sessions}
            projects={projects}
            providers={config?.config.providers ?? []}
            onClose={() => setSelectedSchedule(null)}
            onMenu={scheduleMenu}
            onError={noteError}
            onOpenSession={(id) => {
              setActive(id);
              setSelectedSchedule(null);
              setSchedulePage(false);
            }}
          />
        ) : schedulePage && schedCreating ? (
          <ScheduleCreatePanel
            width={schedDetailW}
            sessions={sessions}
            projects={projects}
            providers={config?.config.providers ?? []}
            defaultRoot={activeSession?.root ?? null}
            onClose={() => setSchedCreating(false)}
            onCreated={(t) => {
              // 宿主也会广播 schedule_changed，这里先把新任务放进列表并
              // 选中：面板原地从表单换成它的详情，不用等那一拍。
              setSchedules((prev) => [...prev.filter((x) => x.id !== t.id), t]);
              setSchedCreating(false);
              setSelectedSchedule(t.id);
              reloadSchedules();
            }}
          />
        ) : null}
      </SlidePanel>

      {!schedRailOpen && drawerVisible && activeSession ? (
        <Resizer
          axis="x"
          onStart={() => {
            dragFrom.current = drawerW;
            dragLive.current = drawerW;
          }}
          onDelta={(d) => {
            // 抽屉拖的是左缘：往左（负位移）变宽。顶到主区下限还继续往左，
            // 就把左栏一点点推出窗口（主区宽度不动），往回拖它跟着回来。
            // 推到红绿灯那一段为止，免得红绿灯压到顶栏标题上。
            const { drawer, sidebarShown: shown } = drawerDragLayout(
              dragFrom.current - d,
              sidebarOpen ? sidebarW : 0,
              sidebarOpen && !isMobile,
              IS_MAC && !fullscreen ? SIDEBAR_PUSH_FLOOR_LIGHTS : 0,
            );
            dragLive.current = drawer;
            sidebarShownLive.current = shown;
            setDrawerW(drawer);
            setSidebarShown(shown);
          }}
          onEnd={() => {
            // 松手时决定被推的左栏去留。这一拍 .dragging 跟着摘掉，面板
            // 过渡恢复，两种结局都从当前位置沿面板曲线走完，不跳。
            const shown = sidebarShownLive.current;
            if (shown !== null) {
              sidebarShownLive.current = null;
              setSidebarShown(null);
              if (sidebarPushCollapses(shown, sidebarW)) {
                // 抽屉留在原宽；左栏收到 0，主区接住腾出来的宽度。
                collapseSidebar();
              } else {
                // 弹回：左栏回全宽，抽屉同步退回主区下限那一档。
                dragLive.current = rightPanelMax(sidebarW, DRAWER_MIN);
                setDrawerW(dragLive.current);
              }
            }
            savePx(LS.drawer, dragLive.current);
          }}
          onReset={() => {
            const w = drawerDefault();
            setDrawerW(w);
            savePx(LS.drawer, w);
          }}
        />
      ) : null}
      {/* anchor 用默认的 start：右列的右缘钉死在窗口右边，收起时动的是
          左缘 —— 内层跟着左缘走，整块才是被主区往右推出去（和侧栏对称）。
          代价是标签栏会从窗口角上那组分栏开关底下滑过，靠开关的渐变底
          接住，见 styles.css 的 .win-controls.docked::before。 */}
      <SlidePanel
        axis="x"
        className="rail"
        open={rightDrawerOpen}
        size={drawerW}
        keepMounted
        onVisualOpen={setDrawerVisual}
      >
        {drawerPresent && activeSession ? (
          <div className="drawer" style={{ width: drawerW }}>
            {/* 标签栏常在（哪怕一个标签都没有）：它同时是窗口右上角那三个
                分栏开关的座位，抽屉开着的时候不能没有它。 */}
            <WorkbenchTabs
              tabs={wb.tabs}
              active={wb.active}
              pages={browserPages}
              {...(() => {
                const name = plans[activeSession.id]?.plan?.name;
                return name ? { planTitle: name } : {};
              })()}
              onSelect={(id) => {
                const t = wb.tabs.find((x) => tabId(x) === id);
                if (t) openTab(t);
              }}
              onClose={closeTab}
              onSelectPage={selectBrowserPage}
              onClosePage={closeBrowserPage}
              onAdd={workbenchAddMenu}
            />
            {/* 空状态即"添加面板"菜单（Codex 同款）。只列侧边标签；
                终端停靠在底部，入口在窗口开关那一组里。 */}
            {showWorkbenchEmpty ? (
              <WorkbenchEmpty
                onChanges={() => openTab({ kind: "changes" })}
                onBrowser={() => openTab({ kind: "browser" })}
                onFiles={() => openTab({ kind: "files" })}
              />
            ) : null}
            {/* 浏览器和改动只在前台时挂载：浏览器切走要停帧流（宿主
                不再白编码 JPEG），改动列表便宜、回来重比对一次就行。 */}
            {/* `[约束]` 这几块的 key 必须带各自的前缀，不能都用会话 id。
                它们是抽屉里的同层兄弟，React 在同层按 key 配对 —— 撞了 key
                的那两个，切换时旧的漏删、新的照建，每切一次就在面板里多叠
                一份（真出过：从预览切到 Git 改动，改动面板越攒越多）。
                会话 id 留在 key 里是为了跨会话整块重挂，各标签组互不串。 */}
            {shownKind === "browser" ? (
              <>
                <BrowserPanel
                  key={`browser:${activeSession.id}`}
                  sessionId={activeSession.id}
                  panel={browserPages}
                  onPanel={applyBrowserPanel}
                  onPatchTab={patchBrowserTab}
                  onSendToComposer={setPickSnippet}
                />
                <ScopePanel sessionId={activeSession.id} />
              </>
            ) : null}
            {shownKind === "changes" ? (
              <GitChangesPanel
                key={`changes:${activeSession.id}`}
                sessionId={activeSession.id}
                refreshKey={changesRev}
              />
            ) : null}
            {/* 计划面板：画这个会话最近那份计划（Chat 上报）。只挂激活的那个，
                切走就卸 —— 内容是从条目派生的，回来重算不花什么。 */}
            {shownKind === "plan" ? (
              (() => {
                const ps = plans[activeSession.id];
                return ps?.plan ? (
                  <PlanPanel
                    key={`plan:${activeSession.id}`}
                    root={activeSession.root}
                    plan={ps.plan}
                    streaming={ps.streaming}
                    // 模型每 Edit 一次文件、每跑完一轮，面板重读一次。
                    refreshKey={`${changesRev}/${ps.edits}`}
                    canBuild={ps.canBuild}
                    todos={ps.todos}
                  />
                ) : (
                  <div className="plan-panel plan-panel-none">{t("app.workbench.planNone")}</div>
                );
              })()
            ) : null}
            {/* 子 agent 的只读会话。只挂激活的那个：切走就卸，回来重拉 ——
                一个子 agent 的会话几十 KB，重拉比保活一排轮询便宜。 */}
            {activeTab?.kind === "subagent" && shownKind === "subagent" ? (
              <SubagentPanel
                key={`subagent:${activeSession.id}:${activeTab.agentId}`}
                sessionId={activeSession.id}
                agentId={activeTab.agentId}
                onTitle={(title) => retitleSubagent(activeTab.agentId, title)}
              />
            ) : null}
            {/* 预览面板显示过之后就常驻挂载（切走 display:none）：
                渲染器、滚动位置、表格列宽都留在原地，切回即所见。
                首挂必须在激活时（previewPanelShown 先成立，previewWarm
                随后才置位）—— 渲染器不能在 display:none 里做首屏适配。
                "文件"标签也落在这个面板上（active 为 null：树 + 占位）。
                跨会话仍整个重挂 —— 标签组每会话独立。 */}
            {(previewPanelShown || previewWarm) && (activePreviewPath || hasFilesTab) ? (
              <FilePreviewPanel
                key={`preview:${activeSession.id}`}
                sessionId={activeSession.id}
                paths={previewPaths}
                active={activePreviewPath}
                visible={previewPanelShown}
                tree={wb.tree}
                onToggleTree={toggleTree}
                refreshKey={changesRev}
                onOpen={openFromTree}
                onTreeContextMenu={treeMenu}
                onPickFromDisk={pickAndPreview}
                filterFocus={treeFilterFocus}
              />
            ) : null}
          </div>
        ) : null}
      </SlidePanel>

      {/* 钉在窗口右上角。任务页没有这条会话工具栏，开关也不露。 */}
      {schedulePage ? null : windowControls}

      {showSettings ? (
        <Settings
          status={config}
          onStatus={setConfig}
          onClose={() => setShowSettings(false)}
          activeRoot={activeSession?.root ?? null}
          appVersion={update.version}
          update={update.info}
          updateChecking={update.checking}
          updateError={update.error}
          onCheckUpdate={() => void update.check()}
          navWidth={sidebarW}
        />
      ) : null}

      {activeSession && showSessionCfg ? (
        // key 让切换会话时弹窗重挂载，草稿不会串到另一个会话头上。
        <SessionSettings
          key={activeSession.id}
          session={activeSession}
          // 会话继承到的是"模型叠在服务方之上"的结果，和宿主 resolve() 同序。
          // 只传服务方的话，模型上单独设过的字段在这里会显示成另一个数。
          inherited={inheritedSampling(
            config.config,
            activeSession.provider || undefined,
            activeSession.model || undefined,
          )}
          presets={config.config.prompts ?? []}
          onSavePreset={savePromptPreset}
          onPatch={(patch) => patchSession(activeSession.id, patch)}
          onClose={() => setShowSessionCfg(false)}
        />
      ) : null}

      {menu ? <ContextMenu menu={menu} onClose={() => setMenu(null)} /> : null}
      <ImageLightboxHost />
      {dirPicker.element}
      {confirm ? <ConfirmDialog c={confirm} onClose={() => setConfirm(null)} /> : null}
      {goneRoot ? (
        <MissingProjectDialog
          root={goneRoot}
          onClose={() => setGoneRoot(null)}
          onRemove={() =>
            void doRemoveProject(goneRoot).catch((err: unknown) =>
              noteError(t("app.error.removeProject"), err),
            )
          }
          onRelocate={() => void relocateGone(goneRoot)}
        />
      ) : null}
    </div>
    </ProjectRootContext.Provider>
  );
}

