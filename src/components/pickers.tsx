/**
 * 通用下拉选择件：模式菜单（ModeMenu）、单选下拉（Picker），以及
 * 它们共用的开合/键盘导航逻辑（useDropdown）。从 App.tsx 拆出。
 */

import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";

import type { PermissionMode, ProviderConfig } from "../bridge";
import { type MessageKey, useT } from "../i18n";
import { Chevron } from "./Chevron";
import { ConfirmDialog, type ConfirmRequest } from "./ConfirmDialog";
import { AgentModeIcon, EyeIcon, MenuPickCheck, MultitaskIcon, PlanModeIcon } from "./icons";

/** 权限档名的词典键。渲染时 `t()`，不缓存翻译结果。 */
export const MODE_LABEL_KEY: Record<string, MessageKey> = {
  default: "composer.perm.default",
  acceptEdits: "composer.perm.acceptEdits",
  plan: "composer.perm.plan",
  auto: "composer.perm.auto",
  bypassPermissions: "composer.perm.bypassPermissions",
  unattended: "composer.perm.unattended",
};

/**
 * 权限档位：执行前问多少。在顶栏的权限下拉里选。
 * 后端把 plan 也收在 PermissionMode 里，但它是「工作方式」，不在这一列。
 */
export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "unattended",
] as const satisfies readonly PermissionMode[];

/** 跟在权限档名后面的警示语（词典键）。没有就是不需要提醒。 */
export const MODE_WARN_KEY: Record<string, MessageKey> = {
  bypassPermissions: "composer.perm.bypassPermissions.warn",
  unattended: "composer.perm.unattended.warn",
};

/** 后端 PermissionMode 里真正表示「执行前问多少」的档位（不含 plan）。 */
export function isExecPermissionMode(m: PermissionMode): boolean {
  return (PERMISSION_MODES as readonly PermissionMode[]).includes(m);
}

/**
 * 工作方式：agent 怎么干活。和权限档是两个维度 —— 权限管"做之前问不问"，
 * 工作方式管"先想还是先做、自己做还是派人做"。互斥单选。
 */
export type WorkMode = "agent" | "plan" | "multitask";

const WORK_MODES: { id: WorkMode; labelKey: MessageKey; titleKey: MessageKey }[] = [
  { id: "agent", labelKey: "composer.mode.agent", titleKey: "composer.mode.agent.hint" },
  { id: "plan", labelKey: "composer.mode.plan", titleKey: "composer.mode.plan.hint" },
  { id: "multitask", labelKey: "composer.mode.multitask", titleKey: "composer.mode.multitask.hint" },
];

/**
 * 每个会话的未发送草稿。挂在模块级：Chat 按会话 id 重挂载，组件内
 * state 活不过切换 —— 用户打了一半的字换个会话再回来就没了，那是
 * 真实的内容损失。进程内存足够，不值得为草稿上持久化。
 */

export function modelLabel(p: ProviderConfig | null, id: string): string {
  return p?.models.find((m) => m.id === id)?.name?.trim() || id;
}

/**
 * 上拉菜单的公共行为：点外面关、Esc 关（焦点还给 pill）、上下键在
 * 菜单项间移动。三个 pill 菜单（模式/服务方/模型）共用，键盘模型
 * 才能一致。
 */
export function useDropdown(open: boolean, setOpen: (v: boolean) => void) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open, setOpen]);

  // 打开后把焦点放到当前选中项，键盘用户不用先按好几下 Tab
  useEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    const target =
      root?.querySelector<HTMLButtonElement>(".menu-item.active") ??
      root?.querySelector<HTMLButtonElement>(".menu-item");
    target?.focus();
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      rootRef.current?.querySelector<HTMLButtonElement>(".picker-pill")?.focus();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      // 只在焦点所在的那一层菜单里走：二级菜单（模型菜单的 Effort）嵌在
      // 主菜单里，不分层的话上下键会从主菜单一路走进子菜单。
      const scope =
        (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[role=menu]") ??
        rootRef.current?.querySelector<HTMLElement>("[role=menu]");
      const items = [...(scope?.querySelectorAll<HTMLButtonElement>(".menu-item") ?? [])].filter(
        (el) => el.closest("[role=menu]") === scope,
      );
      if (!items.length) return;
      const cur = items.indexOf(document.activeElement as HTMLButtonElement);
      const n = items.length;
      const next = e.key === "ArrowDown" ? (cur + 1) % n : (cur - 1 + n) % n;
      items[next]?.focus();
    }
  };

  return { rootRef, onKeyDown };
}

function ModeMenuItem({
  label,
  active,
  icon,
  warn,
  title,
  onPick,
}: {
  label: string;
  active: boolean;
  /** 跟在名字前面的记号，和 pill 上的同一个。 */
  icon?: ReactNode;
  warn?: string;
  title?: string;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      className={active ? "menu-item menu-pick active" : "menu-item menu-pick"}
      title={title}
      onClick={onPick}
    >
      <span className="menu-pick-body">
        <span className="menu-pick-label">
          {icon}
          {label}
        </span>
        {warn ? <span className="menu-warn">{warn}</span> : null}
      </span>
      <MenuPickCheck active={active} />
    </button>
  );
}

/**
 * 工作方式的记号（Cursor 同款）：Agent 是 ∞，Plan 是清单，多任务是分叉。
 * pill 和菜单项共用，换了方式一眼能对上。
 */
function WorkModeMark({ mode }: { mode: WorkMode }) {
  if (mode === "plan") {
    return (
      <span className="pill-mark pill-plan" aria-hidden>
        <PlanModeIcon />
      </span>
    );
  }
  if (mode === "multitask") {
    return (
      <span className="pill-mark pill-multitask" aria-hidden>
        <MultitaskIcon />
      </span>
    );
  }
  return (
    <span className="pill-mark pill-agent" aria-hidden>
      <AgentModeIcon />
    </span>
  );
}

/**
 * 工作方式菜单：Agent / Plan / 多任务，互斥单选，右侧勾号（Cursor 同款）。
 *
 * 只管工作方式，不管权限 —— 权限是"设一次长期不动"的，混进每条消息都
 * 可能切的菜单里，每次切 Plan 都要扫过五个权限档。后端仍把 plan 收在
 * PermissionMode 里，多任务是独立开关，两者的互斥在 Composer 里做。
 */
export function ModeMenu({
  value,
  onChange,
  canMultitask = true,
}: {
  value: WorkMode;
  onChange: (m: WorkMode) => void;
  canMultitask?: boolean;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const { rootRef, onKeyDown } = useDropdown(open, setOpen);
  const items = canMultitask ? WORK_MODES : WORK_MODES.filter((w) => w.id !== "multitask");
  const cur = WORK_MODES.find((w) => w.id === value) ?? WORK_MODES[0]!;
  const curLabel = t(cur.labelKey);

  return (
    <div className="mode-menu" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        // Cursor 的做法：整个 pill 跟着模式换色，不只是图标。Agent 是常态，
        // 保持默认灰；Plan 黄、多任务绿，扫一眼就知道现在在哪种方式里。
        className={`pill picker-pill pill-mode-${value}`}
        title={t("composer.mode.title", { mode: curLabel })}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {/* 对齐做在内层：WebKit 的 button 会套一层匿名盒，align-items
            落不到子项上，图标就贴着汉字上沿。span 没有这个问题。 */}
        <span className="picker-pill-row">
          <WorkModeMark mode={value} />
          <span className="pick-label">{curLabel}</span>
          <Chevron down open={open} />
        </span>
      </button>
      {open ? (
        <div className="menu" role="menu">
          <div className="menu-group-title">{t("composer.mode.group")}</div>
          {items.map((w) => (
            <ModeMenuItem
              key={w.id}
              label={t(w.labelKey)}
              active={w.id === value}
              icon={<WorkModeMark mode={w.id} />}
              title={t(w.titleKey)}
              onPick={() => {
                onChange(w.id);
                setOpen(false);
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 顶栏里跟在会话标题后面的权限下拉：既是状态也是唯一的切换入口。
 *
 * 危险档（全部放行 / 无人值守）常驻警示色和黄点，安全档淡灰 —— 它和
 * 标题同一行，一直在视野里，开着无人值守不至于忘掉。菜单向下展开
 * （输入框里那几个是向上）。无人值守要二次确认：它关掉的是最后一层
 * 保护，不能一次点击就生效。
 */
export function PermissionMenu({
  mode,
  onChange,
}: {
  mode: PermissionMode;
  onChange: (m: PermissionMode) => void;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const { rootRef, onKeyDown } = useDropdown(open, setOpen);
  const labelKey = MODE_LABEL_KEY[mode];
  const label = labelKey ? t(labelKey) : mode;
  const warnKey = MODE_WARN_KEY[mode];
  const warn = warnKey ? t(warnKey) : undefined;

  const pick = (m: PermissionMode) => {
    setOpen(false);
    if (m === mode) return;
    if (m === "unattended") {
      setConfirm({
        title: t("composer.perm.unattended.confirm.title"),
        body: t("composer.perm.unattended.confirm.body"),
        confirmLabel: t("composer.perm.unattended.confirm.ok"),
        action: () => onChange(m),
      });
      return;
    }
    onChange(m);
  };

  return (
    <div className="mode-menu" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        className={warn ? "pill picker-pill perm-flag pill-danger" : "pill picker-pill perm-flag"}
        title={
          warn
            ? t("composer.perm.titleWarn", { mode: label, warn })
            : t("composer.perm.title", { mode: label })
        }
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="picker-pill-row">
          {warn ? <span className="pill-danger-dot" aria-hidden /> : null}
          <span className="pick-label">{label}</span>
          <Chevron down open={open} />
        </span>
      </button>
      {open ? (
        <div className="menu menu-down" role="menu">
          <div className="menu-group-title">{t("composer.perm.group")}</div>
          {PERMISSION_MODES.map((m) => {
            const lk = MODE_LABEL_KEY[m];
            const wk = MODE_WARN_KEY[m];
            return (
              <ModeMenuItem
                key={m}
                label={lk ? t(lk) : m}
                {...(wk ? { warn: t(wk) } : {})}
                active={m === mode}
                onPick={() => pick(m)}
              />
            );
          })}
        </div>
      ) : null}
      {/* portal：顶栏是窄条，遮罩要罩住整个窗口，不能就地渲染在它里面。 */}
      {confirm ? <ConfirmDialog c={confirm} portal onClose={() => setConfirm(null)} /> : null}
    </div>
  );
}

/**
 * 模型 pill 菜单里的一个选项。样式沿用 ModeMenu 的 pill + 上拉菜单，
 * 长文本（模型名）截断，避免把整条工具栏撑开。
 */
export interface PickerItem {
  id: string;
  label: string;
  active?: boolean;
  /** 次要说明，靠右。默认淡灰；`warn` 才用黄，留给"未配置 key"这类。 */
  note?: string;
  warn?: boolean;
  /** 能收图片。图标跟在名字后面，不单独占一列。 */
  vision?: boolean;
  /** 跟在名字后面的小标签（Claude 菜单里的 Recommended 那种）。`warn` 时用黄底。 */
  badge?: string;
  /** 悬停说明。 */
  tip?: string;
}

/**
 * 菜单里的一行「名字  当前值 >」，展开成右侧的二级菜单（Cursor 模型菜单
 * 同款）。触发行和子菜单是兄弟节点，不嵌套 `button`。
 *
 * 模型列表也住在这样一行里：主菜单只剩几行设置，不随模型数量变高；
 * 列表长了在二级菜单里滚、在那里搜。
 */
export interface PickerSubmenu {
  id: string;
  label: string;
  /** 当前值，灰字跟在触发行右侧。 */
  value: string;
  items?: PickerItem[];
  /** 给了就按组排，`items` 不再用。 */
  groups?: PickerGroup[];
  onPick: (id: string) => void;
  /** 这一行前面画分隔线。 */
  sepBefore?: boolean;
  /** 给了且项数够多才出搜索框。 */
  searchPlaceholder?: string;
  noMatch?: string;
}

/**
 * 主列表按组排（模型菜单按服务方分）。组标题行可以带说明和一个动作，
 * 比如「未配置 key · 设置」。
 */
export interface PickerGroup {
  id: string;
  title: string;
  items: PickerItem[];
  /** 标题右侧的说明。`warn` 用黄字。 */
  note?: string;
  warn?: boolean;
  /** 整组暗一档：还能选，但选了发不出去（服务方没配 key）。 */
  dim?: boolean;
  action?: { label: string; onClick: () => void };
  /** 搜索时不出现。「最近使用」是别的组的重复，搜出来会成对。 */
  hideOnSearch?: boolean;
}

/** 总项数到这个数才出搜索框。几项的菜单扫一眼就够，框子反而占地方。 */
const SEARCH_MIN = 8;

function matches(q: string, ...texts: string[]): boolean {
  return texts.some((s) => s.toLowerCase().includes(q));
}

function PickerRow({ item, onPick }: { item: PickerItem; onPick: () => void }) {
  const { t } = useT();
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={Boolean(item.active)}
      className={item.active ? "menu-item menu-pick picker-item active" : "menu-item menu-pick picker-item"}
      title={item.tip}
      onClick={onPick}
    >
      <span className="menu-pick-body">
        <span className="pick-main">
          <span className="pick-label">{item.label}</span>
          {item.vision ? (
            <span
              className="cap-icon"
              role="img"
              aria-label={t("composer.model.vision")}
              title={t("composer.model.vision")}
            >
              <EyeIcon />
            </span>
          ) : null}
          {item.badge ? (
            <span className={item.warn ? "pick-badge warn" : "pick-badge"}>{item.badge}</span>
          ) : null}
        </span>
        {item.note && !item.badge ? (
          <span className={item.warn ? "menu-warn" : "menu-hint"}>{item.note}</span>
        ) : null}
      </span>
      <MenuPickCheck active={Boolean(item.active)} />
    </button>
  );
}

/** 二级菜单的内容：可选的搜索框 + 分组列表。卸载即清空搜索。 */
function PickerList({ menu, onPick, onClose }: {
  menu: PickerSubmenu;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const groups: PickerGroup[] = menu.groups ?? [{ id: "", title: "", items: menu.items ?? [] }];
  const total = groups.reduce((n, g) => n + (g.hideOnSearch ? 0 : g.items.length), 0);
  const searchable = Boolean(menu.searchPlaceholder) && total >= SEARCH_MIN;
  const q = query.trim().toLowerCase();
  const shown = q
    ? groups
        .filter((g) => !g.hideOnSearch)
        .map((g) =>
          matches(q, g.title) ? g : { ...g, items: g.items.filter((it) => matches(q, it.label, it.id)) },
        )
        .filter((g) => g.items.length > 0)
    : groups;

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(".menu-item.active")?.scrollIntoView({ block: "nearest" });
  }, []);

  return (
    <>
      {searchable ? (
        <input
          className="picker-search"
          type="text"
          value={query}
          placeholder={menu.searchPlaceholder}
          aria-label={menu.searchPlaceholder}
          spellCheck={false}
          autoComplete="off"
          // 悬停展开也给焦点：看到搜索框就能直接打字，不用再点一下。
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || !q) return;
            e.preventDefault();
            const first = shown[0]?.items[0];
            if (first) onPick(first.id);
          }}
        />
      ) : null}
      <div className="picker-list" ref={listRef}>
        {shown.map((g, gi) => (
          <div
            key={g.id}
            className={g.dim ? "picker-group dim" : "picker-group"}
            {...(g.title ? { role: "group", "aria-label": g.title } : {})}
          >
            {gi > 0 ? <div className="menu-sep" role="separator" /> : null}
            {g.title ? (
              <div className="picker-group-head">
                <span className="menu-group-title">{g.title}</span>
                {g.note ? <span className={g.warn ? "menu-warn" : "menu-hint"}>{g.note}</span> : null}
                {g.action ? (
                  <button
                    type="button"
                    className="picker-group-action"
                    onClick={() => {
                      onClose();
                      g.action?.onClick();
                    }}
                  >
                    {g.action.label}
                  </button>
                ) : null}
              </div>
            ) : null}
            {g.items.map((it) => (
              <PickerRow key={it.id} item={it} onPick={() => onPick(it.id)} />
            ))}
          </div>
        ))}
        {shown.length === 0 ? <div className="picker-empty">{menu.noMatch}</div> : null}
      </div>
    </>
  );
}

/**
 * 输入框里的模型 pill。点开是几行设置（上下文窗口 / Effort / 模型），
 * 每行展开成右侧的二级菜单。
 */
export function Picker({
  label,
  hint,
  title,
  tip,
  rows,
  empty,
  emptyHint,
  onEmpty,
}: {
  label: string;
  /** pill 上跟在名字后面的淡色后缀。 */
  hint?: string;
  title?: string;
  /** pill 的悬停说明，默认就是 label。 */
  tip?: string;
  rows: PickerSubmenu[];
  /** 没东西可选：点 pill 不开菜单，走 `onEmpty`（一般是打开设置补模型）。 */
  empty?: boolean;
  emptyHint?: string;
  onEmpty?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState<string | null>(null);
  const { rootRef, onKeyDown } = useDropdown(open, setOpen);
  const subTimer = useRef(0);
  const lastSub = useRef<string | null>(null);

  useEffect(() => {
    if (!open) setSub(null);
  }, [open]);
  useEffect(() => () => window.clearTimeout(subTimer.current), []);

  // 二级菜单因为鼠标移走而关掉时，焦点可能还在它（已卸载）的搜索框里，
  // 落到 body 上 —— Esc 和上下键就不归这个菜单管了。还给它的触发行。
  useEffect(() => {
    if (!open || sub) return;
    const a = document.activeElement;
    if (a && a !== document.body) return;
    const id = lastSub.current;
    if (!id) return;
    rootRef.current
      ?.querySelector<HTMLButtonElement>(`.picker-sub-trigger[data-sub="${CSS.escape(id)}"]`)
      ?.focus({ preventScroll: true });
  }, [open, sub, rootRef]);

  const triggerOf = (id: string) =>
    rootRef.current?.querySelector<HTMLButtonElement>(`.picker-sub-trigger[data-sub="${CSS.escape(id)}"]`);

  const showSub = (id: string) => {
    lastSub.current = id;
    setSub(id);
  };

  /** 悬停开合。关要晚一点：鼠标斜着往子菜单走时会擦过主菜单的别的行。 */
  const hoverSub = (id: string | null) => {
    window.clearTimeout(subTimer.current);
    if (id) showSub(id);
    else subTimer.current = window.setTimeout(() => setSub(null), 250);
  };

  /** 键盘 / 点击打开子菜单：焦点给搜索框，没有就给当前档。 */
  const enterSub = (id: string) => {
    window.clearTimeout(subTimer.current);
    showSub(id);
    requestAnimationFrame(() => {
      const fly = rootRef.current?.querySelector<HTMLElement>(".picker-sub-flyout");
      (
        fly?.querySelector<HTMLElement>(".picker-search") ??
        fly?.querySelector<HTMLElement>(".menu-item.active") ??
        fly?.querySelector<HTMLElement>(".menu-item")
      )?.focus();
    });
  };

  const leaveSub = () => {
    const id = sub;
    setSub(null);
    if (id) triggerOf(id)?.focus();
  };

  return (
    <div className="mode-menu" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        className="pill picker-pill"
        title={empty ? (emptyHint ?? title) : (tip ?? label)}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (empty ? onEmpty?.() : setOpen(!open))}
      >
        <span className="picker-pill-row">
          <span className="pick-label">{label}</span>
          {hint ? <span className="pick-hint">{hint}</span> : null}
          <Chevron down open={open} />
        </span>
      </button>
      {open && !empty ? (
        <div className="menu picker-menu" role="menu">
          {rows.map((r) => (
            <Fragment key={r.id}>
              {r.sepBefore ? <div className="menu-sep" role="separator" /> : null}
              <div
                className="picker-sub"
                onMouseEnter={() => hoverSub(r.id)}
                onMouseLeave={() => hoverSub(null)}
              >
                <button
                  type="button"
                  role="menuitem"
                  aria-haspopup="menu"
                  aria-expanded={sub === r.id}
                  data-sub={r.id}
                  className={
                    sub === r.id
                      ? "menu-item menu-pick picker-sub-trigger open"
                      : "menu-item menu-pick picker-sub-trigger"
                  }
                  onMouseEnter={(e) => e.currentTarget.focus({ preventScroll: true })}
                  onClick={() => (sub === r.id ? setSub(null) : enterSub(r.id))}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowRight") {
                      e.preventDefault();
                      enterSub(r.id);
                    }
                  }}
                >
                  <span className="menu-pick-body">
                    <span className="pick-label">{r.label}</span>
                  </span>
                  <span className="picker-sub-value">{r.value}</span>
                  <Chevron />
                </button>
                {sub === r.id ? (
                  <div
                    className="picker-sub-flyout"
                    onKeyDown={(e) => {
                      const inInput = (e.target as HTMLElement).tagName === "INPUT";
                      if (e.key === "Escape" || (e.key === "ArrowLeft" && !inInput)) {
                        e.preventDefault();
                        e.stopPropagation();
                        leaveSub();
                      }
                    }}
                  >
                    <div className="menu picker-submenu" role="menu" aria-label={r.label}>
                      <PickerList
                        menu={r}
                        onPick={(id) => {
                          r.onPick(id);
                          setOpen(false);
                        }}
                        onClose={() => setOpen(false)}
                      />
                    </div>
                  </div>
                ) : null}
              </div>
            </Fragment>
          ))}
        </div>
      ) : null}
    </div>
  );
}
