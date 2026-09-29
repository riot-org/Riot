import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  type ConfigStatus,
  type MarketEntry,
  type Marketplace,
  type MarketplaceConfig,
  type PluginPreview,
  type PluginProgress,
  type PluginSourceRequest,
  type PluginStatus,
  pluginsDiscard,
  pluginsMarket,
  pluginsPrepare,
  pluginsSetEnabled,
  pluginsSetMarketplaces,
  pluginsStatus,
  pluginsUninstall,
  renderUiError,
  revealInFinder,
  splitUiError,
} from "../../bridge";
import {
  type PluginInstalls,
  clearDonePluginProgress,
  clearPluginProgress,
  reportPluginFailure,
  startPluginCommit,
  startPluginUpdate,
  usePluginInstalls,
} from "../../hooks/usePluginInstalls";
import { type MessageKey, useT } from "../../i18n";
import { tildify } from "../../pathDisplay";
import { useDirectoryPicker } from "../DirPicker";
import { Modal } from "../Modal";
import { Card, CardBlock, Group, Row } from "./layout";
import { type AskConfirm, Switch } from "./shared";

type Translate = ReturnType<typeof useT>["t"];

/** 字节数写成人话。压缩包是几百 MB 量级，一位小数够用。 */
function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * 安装进度的一句话描述。下载有百分比，其它几步没有 —— 它们相对下载
 * 短得多，硬凑一个总进度只会让进度条在末尾诡异地卡住。
 */
function progressText(p: PluginProgress, t: Translate): string {
  switch (p.kind) {
    case "starting":
      return t("settings.plugins.progress.starting");
    case "cloning":
      return t("settings.plugins.progress.cloning");
    case "downloading":
      return p.total > 0
        ? t("settings.plugins.progress.downloading", {
            received: humanSize(p.received),
            total: humanSize(p.total),
          })
        : t("settings.plugins.progress.downloadingNoTotal", { received: humanSize(p.received) });
    case "verifying":
      return t("settings.plugins.progress.verifying");
    case "extracting":
      return t("settings.plugins.progress.extracting");
    case "selfCheck":
      return t("settings.plugins.progress.selfCheck");
    case "done":
      return t("common.done");
    case "failed":
      return renderUiError(p.error);
  }
}

/**
 * 一条安装进度：下载有进度条，其它阶段只有一句话。失败的那行是唯一
 * 能看到原因的地方，所以留着不自动消失 —— 但得给个「关闭」，否则它会
 * 一直挂到下次操作这个插件为止。
 *
 * 失败拆成两段：一句人话（红）+ 技术细节（淡、等宽）。dyld 的原文能有
 * 八行，整段刷红的话"已回滚"那半句就被淹掉了 —— 细节是给排查用的。
 */
function Progress({ prog, onDismiss, t }: { prog: PluginProgress; onDismiss?: () => void; t: Translate }) {
  if (prog.kind === "failed") {
    const err = splitUiError(prog.error);
    return (
      <div className="plugin-progress">
        <div className="plugin-progress-line">
          <span className="form-error">{err.text}</span>
          {onDismiss ? (
            <button className="ghost btn-compact" onClick={onDismiss}>
              {t("common.close")}
            </button>
          ) : null}
        </div>
        {err.detail ? <code className="market-error-detail">{err.detail}</code> : null}
      </div>
    );
  }
  return (
    <div className="plugin-progress">
      {prog.kind === "downloading" && prog.total > 0 ? (
        <div className="plugin-bar">
          <div
            className="plugin-bar-fill"
            style={{ width: `${Math.round((prog.received / prog.total) * 100)}%` }}
          />
        </div>
      ) : null}
      <span className="hint">{progressText(prog, t)}</span>
    </div>
  );
}

/** 显式提交的表单里回车 = 点主按钮。`blurOnEnter` 是给失焦即存的字段的，这里不是。 */
function submitOnEnter(submit: () => void) {
  return (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    submit();
  };
}

// ── 图块 ──────────────────────────────────────────────

/**
 * 图块的色相表：八个隔开的色相，按名字哈希选一个，同名永远同色。
 * 插件清单里没有图标字段，一格首字母 + 一块颜色就是它的脸 —— 一列灰字
 * 里靠颜色认插件，比读名字快。
 */
const TILE_HUES = [212, 262, 330, 8, 28, 45, 152, 182];

function hueOf(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return TILE_HUES[h % TILE_HUES.length] ?? 212;
}

/** 首字母（按码点取，中文名也是一个字）。 */
function firstGlyph(name: string): string {
  const first = [...name.trim()][0];
  return first ? first.toUpperCase() : "?";
}

function Tile({ label, hue, children }: { label: string; hue?: number; children?: ReactNode }) {
  return (
    <span className="pl-tile" style={{ "--tile-hue": hue ?? hueOf(label) } as CSSProperties} aria-hidden>
      {children ?? firstGlyph(label)}
    </span>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={open ? "pl-chevron open" : "pl-chevron"}
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
    >
      <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg className="pl-spin" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.8" strokeDasharray="28" strokeDashoffset="10" />
    </svg>
  );
}

function GitGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="5" cy="3.5" r="1.7" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="5" cy="12.5" r="1.7" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="11.5" cy="5.5" r="1.7" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5 5.2v5.6M11.5 7.2c0 2.6-6.5 1.6-6.5 3.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function FolderGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2 5.2A1.7 1.7 0 013.7 3.5h2.6l1.6 1.6h4.4A1.7 1.7 0 0114 6.8v4.5a1.7 1.7 0 01-1.7 1.7H3.7A1.7 1.7 0 012 11.3z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ── 行 ────────────────────────────────────────────────

/**
 * 一行的主体：图块 + 名字（+ 版本、标签）+ 一句说明，右侧一个动作。
 * 有 `toggle` 时主体是个按钮，点了展开详情（已装的插件）；没有就是普通块。
 */
function RowMain({
  tile,
  title,
  meta,
  tags,
  desc,
  side,
  toggle,
}: {
  tile: ReactNode;
  title: string;
  meta?: string | undefined;
  tags?: ReactNode;
  desc?: string | undefined;
  side?: ReactNode;
  toggle?: { open: boolean; onToggle: () => void } | undefined;
}) {
  const body = (
    <>
      {tile}
      <span className="pl-text">
        <span className="pl-title">
          <span className="pl-name">{title}</span>
          {meta ? <span className="pl-meta">{meta}</span> : null}
          {tags}
        </span>
        {desc ? <span className="pl-desc">{desc}</span> : null}
      </span>
      {toggle ? <Chevron open={toggle.open} /> : null}
    </>
  );
  return (
    <div className={toggle ? "pl-main is-hit" : "pl-main"}>
      {toggle ? (
        <button className="pl-hit" aria-expanded={toggle.open} onClick={toggle.onToggle}>
          {body}
        </button>
      ) : (
        <div className="pl-hit">{body}</div>
      )}
      {side ? <div className="pl-side">{side}</div> : null}
    </div>
  );
}

const SOURCE_LABEL: Record<PluginStatus["source"]["kind"], MessageKey> = {
  local: "settings.plugins.source.local",
  git: "settings.plugins.source.git",
  archive: "settings.plugins.source.archive",
  legacy: "settings.plugins.source.legacy",
};

const FORMAT_LABEL: Record<NonNullable<PluginStatus["format"]>, MessageKey> = {
  "agent-plugins": "settings.plugins.format.agent-plugins",
  "claude-code": "settings.plugins.format.claude-code",
  cursor: "settings.plugins.format.cursor",
};

function titleOf(p: PluginStatus): string {
  return p.meta?.displayName || p.meta?.name || p.id;
}

/** `prefix` 是每条都一样的命名空间（技能的 `插件名:`），压淡，让后半截的差别跳出来。 */
function Chips({ items, prefix }: { items: string[]; prefix?: string }) {
  return (
    <ul className="plugin-chips">
      {items.map((it, i) => (
        <li key={i}>
          <code>
            {prefix && it.startsWith(prefix) ? (
              <>
                <span className="plugin-chip-ns">{prefix}</span>
                {it.slice(prefix.length)}
              </>
            ) : (
              it
            )}
          </code>
        </li>
      ))}
    </ul>
  );
}

function CodeLines({ items, rel, prompt }: { items: string[]; rel: (s: string) => string; prompt?: boolean }) {
  return (
    <ul className={prompt ? "plugin-code is-prompt" : "plugin-code"}>
      {items.map((it, i) => (
        <li key={i} title={it}>
          {rel(it)}
        </li>
      ))}
    </ul>
  );
}

/**
 * 插件目录里的绝对路径换成 `./` 开头：详情顶上已经写了目录在哪，每条都
 * 重复一遍 `~/Library/Application Support/...` 只会把真正的差别挤到行尾。
 */
function relativize(text: string, root: string | undefined): string {
  if (!root) return text;
  const base = root.replace(/[\\/]+$/, "");
  return text.split(`${base}/`).join("./").split(`${base}\\`).join(".\\");
}

/**
 * 组件清单：确认页和详情共用。名字都是装完之后对外的样子。
 * 短名（技能、命令、环境变量）排成一簇标签；命令行、路径一条一行放进代码框。
 * 传了 `root` 就把插件目录下的路径写成相对路径。
 */
function Components({ plugin, root, t }: { plugin: PluginStatus; root?: string; t: Translate }) {
  const c = plugin.components;
  const rel = (s: string) => relativize(s, root);
  const all: { key: MessageKey; count: number; body: ReactNode }[] = [
    {
      key: "settings.plugins.components.skills",
      count: c.skills.length,
      body: <Chips items={c.skills} prefix={`${plugin.id}:`} />,
    },
    {
      key: "settings.plugins.components.commands",
      count: c.commands.length,
      body: <Chips items={c.commands.map((x) => `/${x}`)} />,
    },
    {
      key: "settings.plugins.components.env",
      count: c.envKeys.length,
      body: <Chips items={c.envKeys} />,
    },
    {
      key: "settings.plugins.components.mcp",
      count: c.mcpServers.length,
      body: (
        <ul className="plugin-code">
          {c.mcpServers.map((m) => (
            <li key={m.id} className="plugin-code-mcp">
              <span className="plugin-code-head">
                <span className="plugin-code-name">{m.id}</span>
                <span className="plugin-code-tag">{m.transport}</span>
              </span>
              <span title={m.detail}>{rel(m.detail)}</span>
            </li>
          ))}
        </ul>
      ),
    },
    {
      key: "settings.plugins.components.hooks",
      count: c.hooks.length,
      body: (
        <ul className="plugin-code">
          {c.hooks.map((h, i) => (
            <li key={i} className="plugin-code-mcp">
              <span className="plugin-code-head">
                <span className="plugin-code-name">{h.event}</span>
                {h.matcher ? <span className="plugin-code-tag">{h.matcher}</span> : null}
              </span>
              <span title={h.command}>{rel(h.command)}</span>
            </li>
          ))}
        </ul>
      ),
    },
    {
      key: "settings.plugins.components.path",
      count: c.pathDirs.length,
      body: <CodeLines items={c.pathDirs} rel={rel} />,
    },
    {
      key: "settings.plugins.components.selfCheck",
      count: c.selfChecks.length,
      body: <CodeLines items={c.selfChecks} rel={rel} prompt />,
    },
  ];
  const sections = all.filter((s) => s.count > 0);

  return (
    <div className="plugin-components">
      {sections.length === 0 ? (
        <p className="hint" style={{ margin: 0 }}>
          {t("settings.plugins.components.none")}
        </p>
      ) : (
        sections.map((s) => (
          <div key={s.key} className="plugin-component">
            <span className="plugin-component-title">
              {t(s.key)}
              <span className="plugin-component-count">{s.count}</span>
            </span>
            {s.body}
          </div>
        ))
      )}
      {plugin.unsupported.length > 0 ? (
        <div className="plugin-component">
          <span className="plugin-component-title">{t("settings.plugins.unsupported")}</span>
          <ul>
            {plugin.unsupported.map((u, i) => (
              <li key={i} className="hint">
                <code>{u.component}</code>
                {u.detail ? ` ${u.detail}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {plugin.problems.length > 0 ? (
        <div className="plugin-component">
          <span className="plugin-component-title">{t("settings.plugins.problems")}</span>
          <ul>
            {plugin.problems.map((p, i) => (
              <li key={i} className="form-error">
                {renderUiError(p.error)}
                <span className="hint"> — {p.path}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** 页面上同时最多开一块编辑区：Git 表单、本地目录表单、市场列表编辑。 */
type Panel = "none" | "git" | "local" | "marketplaces";
/** prepare 是从哪里发起的 —— 错误只回到发起它的地方显示。 */
type PrepareFrom = "git" | "local" | "market";

export function PluginsPane({
  askConfirm,
  status,
  onStatus,
  onSaved,
}: {
  askConfirm: AskConfirm;
  status: ConfigStatus;
  /** 市场列表存进配置后回新的 `ConfigStatus`；不回的话这页拿的还是打开设置时那份。 */
  onStatus: (s: ConfigStatus) => void;
  onSaved: () => void;
}) {
  const { t } = useT();
  const [plugins, setPlugins] = useState<PluginStatus[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [panel, setPanel] = useState<Panel>("none");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  /** 安装进度和"正在装"标记在模块级 —— 关掉设置面板不该把它们连同组件一起丢掉。 */
  const installs = usePluginInstalls();

  // 市场
  const [markets, setMarkets] = useState<Marketplace[] | null>(null);
  const [marketLoading, setMarketLoading] = useState(false);
  /** 市场清单这条命令本身失败了（不是某个市场拉不到 —— 那个在各市场的 error 里）。 */
  const [marketLoadError, setMarketLoadError] = useState("");
  const [query, setQuery] = useState("");

  // 确认页
  const [preview, setPreview] = useState<PluginPreview | null>(null);
  /** 正在 prepare 的是谁：表单用 "git" / "local"，市场条目用 `市场/名字`。null = 没在准备。 */
  const [preparing, setPreparing] = useState<string | null>(null);
  const [prepareError, setPrepareError] = useState<{ from: PrepareFrom; text: string } | null>(null);
  /**
   * 确认页上那份预览的令牌。组件卸载（切分区、Esc 关设置）时要拿它去
   * discard —— 不然宿主那边的待装记录和 clone 出来的暂存目录就永远留着
   * 了。放 ref 而不是读 state：卸载时的 cleanup 拿不到最新的 state。
   */
  const previewToken = useRef<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (previewToken.current) {
        void pluginsDiscard(previewToken.current).catch(() => {});
        previewToken.current = null;
      }
    };
  }, []);

  // 表单
  const [gitUrl, setGitUrl] = useState("");
  const [gitRef, setGitRef] = useState("");
  const [gitSubdir, setGitSubdir] = useState("");
  const [localPath, setLocalPath] = useState("");
  const dirPicker = useDirectoryPicker();

  // 市场列表编辑
  const marketplaces = status.config.pluginMarketplaces ?? [];
  const enabledMarketplaces = marketplaces.filter((m) => m.enabled).length;
  const [newMarketId, setNewMarketId] = useState("");
  const [newMarketSource, setNewMarketSource] = useState("");
  const [marketError, setMarketError] = useState("");
  /** 市场列表正在写配置。期间开关和「移除」禁掉：连点两下会拿同一份旧列表各算一次。 */
  const [marketSaving, setMarketSaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setPlugins(await pluginsStatus());
      setLoadError("");
    } catch (e) {
      setPlugins(null);
      setLoadError(String(e));
    }
  }, []);

  // completed 变了 = 有安装刚跑完，清单得重拉。它可能是在面板关着的时候
  // 完成的，所以这里既管首次挂载，也管"装完了但没人看着"。
  useEffect(() => {
    void refresh().then(clearDonePluginProgress);
  }, [refresh, installs.completed]);

  const loadMarket = useCallback(async (force: boolean) => {
    setMarketLoading(true);
    setMarketLoadError("");
    try {
      setMarkets(await pluginsMarket(force));
    } catch (e) {
      // 宿主按市场分别装 error、整体不 reject；走到这里是命令本身超时之类。
      // 报在市场这一段里，别碰已安装清单那一格 —— 那边的「重试」重拉的是插件。
      // 给 [] 而不是 null：null 会让下面的 effect 再拉一次，失败了再拉，没完。
      setMarkets([]);
      setMarketLoadError(String(e));
    } finally {
      setMarketLoading(false);
    }
  }, []);

  // 市场直接摆在页面上，打开这页就拉（宿主有缓存，不是每次都走网络）。
  useEffect(() => {
    if (markets === null) void loadMarket(false);
  }, [markets, loadMarket]);

  const installedById = useMemo(() => new Map((plugins ?? []).map((p) => [p.id, p])), [plugins]);
  const marketNames = useMemo(
    () => new Set((markets ?? []).flatMap((m) => m.plugins.map((e) => e.name))),
    [markets],
  );

  const totalEntries = useMemo(() => (markets ?? []).reduce((n, m) => n + m.plugins.length, 0), [markets]);
  // 一屏装得下的清单不需要搜索框；长了才出。
  const showSearch = totalEntries > 6;
  useEffect(() => {
    if (!showSearch && query) setQuery("");
  }, [showSearch, query]);

  /** 开合一块编辑区。prepare 的错误跟着来源，切走就清掉。 */
  const togglePanel = (p: Exclude<Panel, "none">) => {
    setPanel((cur) => (cur === p ? "none" : p));
    setPrepareError(null);
  };

  const prepare = async (key: string, from: PrepareFrom, source: PluginSourceRequest) => {
    setPreparing(key);
    setPrepareError(null);
    try {
      const p = await pluginsPrepare(source);
      if (!alive.current) {
        // 等 clone 的这几十秒里用户已经离开了这一页：预览没人看，令牌得还回去。
        void pluginsDiscard(p.token).catch(() => {});
        return;
      }
      previewToken.current = p.token;
      setPreview(p);
    } catch (e) {
      setPrepareError({ from, text: String(e) });
    } finally {
      setPreparing(null);
    }
  };

  const cancelPreview = () => {
    if (previewToken.current) void pluginsDiscard(previewToken.current).catch(() => {});
    previewToken.current = null;
    setPreview(null);
  };

  const confirmInstall = () => {
    if (!preview) return;
    // 令牌交给 commit 消费，卸载时不能再拿它去 discard。
    previewToken.current = null;
    startPluginCommit(preview.plugin.id, preview.token);
    setPreview(null);
    // 表单装完就收起、清空：留着填好的地址，下次打开容易再装一遍。
    if (panel === "git") {
      setGitUrl("");
      setGitRef("");
      setGitSubdir("");
      setPanel("none");
    } else if (panel === "local") {
      setLocalPath("");
      setPanel("none");
    }
  };

  const canPrepareGit = preparing === null && gitUrl.trim().length > 0;
  const prepareGit = () => {
    if (!canPrepareGit) return;
    void prepare("git", "git", {
      kind: "git",
      url: gitUrl.trim(),
      ...(gitRef.trim() ? { gitRef: gitRef.trim() } : {}),
      ...(gitSubdir.trim() ? { subdir: gitSubdir.trim() } : {}),
    });
  };

  const canPrepareLocal = preparing === null && localPath.trim().length > 0;
  const prepareLocal = () => {
    if (!canPrepareLocal) return;
    void prepare("local", "local", { kind: "local", path: localPath.trim() });
  };

  const toggle = async (p: PluginStatus, on: boolean) => {
    setBusy(p.id);
    try {
      await pluginsSetEnabled(p.id, on);
      await refresh();
    } catch (e) {
      reportPluginFailure(p.id, e);
    } finally {
      setBusy(null);
    }
  };

  const uninstall = (p: PluginStatus) => {
    askConfirm({
      title: t("settings.plugins.uninstall.title", { name: titleOf(p) }),
      body: t("settings.plugins.uninstall.body"),
      confirmLabel: t("settings.plugins.action.uninstall"),
      action: () => {
        setBusy(p.id);
        void (async () => {
          try {
            await pluginsUninstall(p.id);
            clearPluginProgress(p.id);
            await refresh();
          } catch (e) {
            reportPluginFailure(p.id, e);
          } finally {
            setBusy(null);
          }
        })();
      },
    });
  };

  /** 存市场列表。成功回 true；失败把原因放在编辑区底部，不 reject。 */
  const saveMarketplaces = async (next: MarketplaceConfig[]): Promise<boolean> => {
    setMarketError("");
    setMarketSaving(true);
    try {
      // 宿主回保存后的配置。这页的市场列表就是从 status 里读的，不把它
      // 交回去，开关和「移除」点了在界面上没有任何反应。
      onStatus(await pluginsSetMarketplaces(next));
      onSaved();
      // 市场清单缓存跟着列表走，重拉。
      setMarkets(null);
      return true;
    } catch (e) {
      setMarketError(String(e));
      return false;
    } finally {
      setMarketSaving(false);
    }
  };

  const canAddMarket = !marketSaving && newMarketId.trim().length > 0 && newMarketSource.trim().length > 0;
  const addMarketplace = () => {
    if (!canAddMarket) return;
    void saveMarketplaces([
      ...marketplaces,
      { id: newMarketId.trim(), source: newMarketSource.trim(), enabled: true },
    ]).then((ok) => {
      // 失败（标识重复之类）时留着输入，改一个字就能重试。
      if (!ok) return;
      setNewMarketId("");
      setNewMarketSource("");
    });
  };

  /** 移除市场要问一句：来源地址不一定记得住，装自它的插件也会失去升级路径。 */
  const removeMarketplace = (m: MarketplaceConfig) => {
    askConfirm({
      title: t("settings.plugins.marketplaces.remove.title", { id: m.id }),
      body: t("settings.plugins.marketplaces.remove.body"),
      confirmLabel: t("settings.plugins.marketplaces.remove"),
      action: () => void saveMarketplaces(marketplaces.filter((x) => x.id !== m.id)),
    });
  };

  // ── 确认页 ────────────────────────────────────────────
  if (preview) {
    const p = preview.plugin;
    const name = titleOf(p);
    // 空串也是"有已装的"：没写版本号的插件在注册表里就是空串。
    const replaces = preview.replacesVersion;
    return (
      <Group
        title={
          <span className="pl-confirm-title">
            <Tile label={p.id} />
            {t("settings.plugins.confirm.title", { name })}
          </span>
        }
      >
        <Card>
          <CardBlock>
            {p.meta?.description ? <p style={{ margin: "0 0 6px" }}>{p.meta.description}</p> : null}
            <p className="hint" style={{ margin: 0 }}>
              {p.version ? t("settings.plugins.version", { version: p.version }) : null}
              {p.meta?.author ? ` · ${p.meta.author}` : ""}
              {" · "}
              {t(SOURCE_LABEL[p.source.kind])}
              {p.source.detail ? ` · ${p.source.detail}` : ""}
            </p>
            {replaces !== undefined ? (
              <p className="hint" style={{ margin: "6px 0 0" }}>
                {replaces
                  ? t("settings.plugins.confirm.replaces", { version: replaces })
                  : t("settings.plugins.confirm.replacesNoVersion")}
              </p>
            ) : null}
            {!preview.contentsVerified ? (
              <p className="hint" style={{ margin: "6px 0 0" }}>
                {t("settings.plugins.confirm.unverified")}
                {preview.downloadSize > 0
                  ? ` ${t("settings.plugins.market.size", { size: humanSize(preview.downloadSize) })}`
                  : null}
              </p>
            ) : null}
          </CardBlock>
          {/* 压缩包还没下载，组件清单是空的默认值 —— 列出来会写"没有可用
              组件"，和上面那句"下载解压后校验"打架。 */}
          {preview.contentsVerified ? (
            <CardBlock>
              <Components plugin={p} t={t} />
            </CardBlock>
          ) : null}
          <CardBlock>
            <p className="hint" style={{ margin: 0 }}>
              {t("settings.plugins.confirm.trust")}
            </p>
          </CardBlock>
        </Card>
        <div className="editor-foot">
          {!p.platformOk ? <span className="form-error">{t("settings.plugins.platformNo")}</span> : <span />}
          <div className="editor-foot-actions">
            <button onClick={cancelPreview}>{t("common.cancel")}</button>
            <button className="primary" onClick={confirmInstall} disabled={!p.platformOk}>
              {t("settings.plugins.confirm.install")}
            </button>
          </div>
        </div>
      </Group>
    );
  }

  const errorFrom = (from: PrepareFrom) => (prepareError?.from === from ? prepareError.text : "");
  // 进度只显示在一个地方：装好的在已装那行；市场里点的在市场那行；两处都
  // 没有（Git / 本地目录来的新装）才在已装区补一行。两边同时显示同一条
  // "解压中…"看着像装了两遍。
  const pendingRows = Object.entries(installs.progress).filter(
    ([id]) => !installedById.has(id) && !marketNames.has(id),
  );

  return (
    <>
      {dirPicker.element}

      {/* ── 已安装 ─────────────────────────────────── */}
      <Group title={t("settings.plugins.installed")}>
        {loadError ? (
          <div className="plugin-inline-note pl-note">
            <p className="form-error" style={{ margin: 0 }}>
              {t("settings.ext.loadFailed", { error: loadError })}
            </p>
            <button className="btn-compact" onClick={() => void refresh()}>
              {t("common.retry")}
            </button>
          </div>
        ) : plugins === null ? (
          <p className="hint pl-note">{t("settings.ext.loading")}</p>
        ) : plugins.length === 0 && pendingRows.length === 0 ? (
          <p className="hint pl-note">{t("settings.plugins.empty")}</p>
        ) : (
          <ul className="pl-list">
            {/* 还没进注册表、正在装的：几百 MB 的下载要几分钟，没有这一行
                用户看不到任何进度，会以为没点上、再点一次。 */}
            {pendingRows.map(([id, prog]) => (
              <li key={`pending-${id}`} className="pl-row">
                <RowMain tile={<Tile label={id} />} title={id} />
                <div className="pl-sub">
                  <Progress prog={prog} onDismiss={() => clearPluginProgress(id)} t={t} />
                </div>
              </li>
            ))}
            {plugins.map((p) => {
              const prog = installs.progress[p.id];
              const running = Boolean(installs.running[p.id]);
              const isBusy = running || busy === p.id;
              const upgradable = Boolean(p.availableVersion) && p.availableVersion !== p.version;
              const open = Boolean(expanded[p.id]);
              // 名字旁只挂要人处理的状态；版本、格式、来源这些放进详情。
              const tags = (
                <>
                  {upgradable ? (
                    <span className="plugin-badge up">
                      {t("settings.plugins.upgradable", { version: p.availableVersion ?? "" })}
                    </span>
                  ) : null}
                  {p.fatal ? <span className="plugin-badge bad">{t("settings.plugins.fatal")}</span> : null}
                  {!p.platformOk ? <span className="plugin-badge bad">{t("settings.plugins.platformNo")}</span> : null}
                  {p.problems.length > 0 ? (
                    <span className="plugin-badge bad">
                      {p.problems.length} {t("settings.plugins.problems")}
                    </span>
                  ) : null}
                </>
              );
              return (
                <li key={p.id} className={`pl-row${p.enabled ? "" : " off"}${open ? " open" : ""}`}>
                  <RowMain
                    tile={<Tile label={p.id} />}
                    title={titleOf(p)}
                    meta={p.version || undefined}
                    tags={tags}
                    desc={p.meta?.description}
                    toggle={{ open, onToggle: () => setExpanded((e) => ({ ...e, [p.id]: !open })) }}
                    side={
                      // 清单读不了的插件不让启用（启用了也起不来），但开着的要能关掉。
                      <Switch
                        on={p.enabled}
                        disabled={isBusy || (Boolean(p.fatal) && !p.enabled)}
                        onChange={(v) => void toggle(p, v)}
                        label={p.enabled ? t("settings.plugins.action.disable") : t("settings.plugins.action.enable")}
                      />
                    }
                  />
                  {prog ? (
                    <div className="pl-sub">
                      <Progress prog={prog} onDismiss={() => clearPluginProgress(p.id)} t={t} />
                    </div>
                  ) : null}
                  {open ? (
                    <div className="pl-sub pl-details">
                      <dl className="plugin-facts">
                        <dt>{t("settings.plugins.detail.source")}</dt>
                        <dd>
                          <span>{t(SOURCE_LABEL[p.source.kind])}</span>
                          {p.linked ? <span className="plugin-code-tag">{t("settings.plugins.linked")}</span> : null}
                          {p.source.detail ? (
                            <code className="plugin-facts-long" title={p.source.detail}>
                              {p.source.detail}
                              {p.source.commit ? ` @ ${p.source.commit.slice(0, 8)}` : ""}
                            </code>
                          ) : null}
                        </dd>
                        {p.format ? (
                          <>
                            <dt>{t("settings.plugins.detail.format")}</dt>
                            <dd>{t(FORMAT_LABEL[p.format])}</dd>
                          </>
                        ) : null}
                        <dt>{t("settings.plugins.detail.location")}</dt>
                        <dd>
                          <code className="plugin-facts-long" title={p.root}>
                            {tildify(p.root)}
                          </code>
                        </dd>
                      </dl>
                      {p.fatal ? (
                        <p className="form-error" style={{ margin: 0 }}>
                          {t("settings.plugins.fatal")}: {renderUiError(p.fatal)}
                        </p>
                      ) : null}
                      <Components plugin={p} root={p.root} t={t} />
                      <div className="plugin-actions">
                        {upgradable ? (
                          <button disabled={isBusy} onClick={() => startPluginUpdate(p.id)}>
                            {t("settings.plugins.action.update")}
                          </button>
                        ) : null}
                        <button className="ghost" onClick={() => void revealInFinder(p.root)}>
                          {t("settings.plugins.action.reveal")}
                        </button>
                        <button className="ghost" disabled={isBusy} onClick={() => uninstall(p)}>
                          {t("settings.plugins.action.uninstall")}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Group>

      {/* ── 市场 ───────────────────────────────────── */}
      <Group
        title={panel === "marketplaces" ? t("settings.plugins.marketplaces") : t("settings.plugins.market")}
        action={
          <div className="set-group-actions">
            {panel === "marketplaces" ? (
              <button className="ghost btn-compact" onClick={() => setPanel("none")}>
                {t("common.done")}
              </button>
            ) : (
              <>
                {showSearch ? (
                  <input
                    className="pl-search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t("settings.plugins.market.search")}
                    spellCheck={false}
                  />
                ) : null}
                <button className="ghost btn-compact" disabled={marketLoading} onClick={() => void loadMarket(true)}>
                  {t("common.refresh")}
                </button>
                <button className="ghost btn-compact" onClick={() => togglePanel("marketplaces")}>
                  {t("settings.plugins.marketplaces.manage")}
                </button>
              </>
            )}
          </div>
        }
      >
        {panel === "marketplaces" ? (
          <Card>
            <CardBlock>
              <p className="hint" style={{ margin: 0 }}>
                {t("settings.plugins.marketplaces.desc")}
              </p>
            </CardBlock>
            {marketplaces.map((m) => {
              // 官方市场只能停用不能移除（宿主也会拒绝没有它的列表）。
              const official = m.id === status.officialMarketplace;
              return (
                <Row
                  key={m.id}
                  title={
                    official ? (
                      <>
                        {m.id}
                        <span className="plugin-badge">{t("settings.plugins.marketplaces.official")}</span>
                      </>
                    ) : (
                      m.id
                    )
                  }
                  desc={<code>{m.source}</code>}
                >
                  <Switch
                    on={m.enabled}
                    disabled={marketSaving}
                    onChange={(v) =>
                      void saveMarketplaces(marketplaces.map((x) => (x.id === m.id ? { ...x, enabled: v } : x)))
                    }
                    label={m.enabled ? t("settings.plugins.action.disable") : t("settings.plugins.action.enable")}
                  />
                  {official ? null : (
                    <button className="ghost btn-compact" disabled={marketSaving} onClick={() => removeMarketplace(m)}>
                      {t("settings.plugins.marketplaces.remove")}
                    </button>
                  )}
                </Row>
              );
            })}
            <Row title={t("settings.plugins.marketplaces.add")} stack>
              <div className="plugin-market-add">
                <input
                  value={newMarketId}
                  onChange={(e) => setNewMarketId(e.target.value)}
                  aria-label={t("settings.plugins.marketplaces.id")}
                  placeholder={t("settings.plugins.marketplaces.id")}
                  spellCheck={false}
                  onKeyDown={submitOnEnter(addMarketplace)}
                />
                <input
                  value={newMarketSource}
                  onChange={(e) => setNewMarketSource(e.target.value)}
                  aria-label={t("settings.plugins.marketplaces.source")}
                  placeholder={t("settings.plugins.marketplaces.source.placeholder")}
                  spellCheck={false}
                  onKeyDown={submitOnEnter(addMarketplace)}
                />
                <button className="btn-compact" disabled={!canAddMarket} onClick={addMarketplace}>
                  {t("common.add")}
                </button>
              </div>
              {marketError ? <p className="form-error">{marketError}</p> : null}
            </Row>
          </Card>
        ) : (
          <>
            {errorFrom("market") ? (
              <p className="form-error pl-note" style={{ margin: 0 }}>
                {errorFrom("market")}
              </p>
            ) : null}
            {marketLoadError ? (
              <div className="plugin-inline-note pl-note">
                <p className="form-error" style={{ margin: 0 }}>
                  {t("settings.ext.loadFailed", { error: marketLoadError })}
                </p>
                <button className="btn-compact" onClick={() => void loadMarket(true)}>
                  {t("common.retry")}
                </button>
              </div>
            ) : enabledMarketplaces === 0 ? (
              // 一个市场都没开和"市场里没插件"是两回事：前者要去管理市场，
              // 后者什么都不用做。混成一句用户会以为目录空了。
              <div className="plugin-inline-note pl-note">
                <p className="hint" style={{ margin: 0 }}>
                  {t("settings.plugins.market.noMarketplaces")}
                </p>
                <button className="btn-compact" onClick={() => togglePanel("marketplaces")}>
                  {t("settings.plugins.marketplaces.manage")}
                </button>
              </div>
            ) : markets === null ? (
              <p className="hint pl-note">{t("settings.ext.loading")}</p>
            ) : (
              <MarketList
                markets={markets}
                query={query}
                loading={marketLoading}
                installed={installedById}
                installs={installs}
                preparing={preparing}
                onInstall={(e) =>
                  void prepare(`${e.marketplace}/${e.name}`, "market", {
                    kind: "market",
                    marketplace: e.marketplace,
                    name: e.name,
                  })
                }
                t={t}
              />
            )}
          </>
        )}
      </Group>

      {/* ── 其他来源 ───────────────────────────────── */}
      <Group title={t("settings.plugins.otherSources")}>
        <ul className="pl-list">
          <li className="pl-row">
            <RowMain
              tile={
                <Tile label="git" hue={14}>
                  <GitGlyph />
                </Tile>
              }
              title={t("settings.plugins.add.git")}
              desc={t("settings.plugins.git.desc")}
              side={
                <button
                  className="pl-icon-btn"
                  aria-haspopup="dialog"
                  aria-label={t("settings.plugins.add.git")}
                  onClick={() => togglePanel("git")}
                >
                  <PlusIcon />
                </button>
              }
            />
          </li>
          <li className="pl-row">
            <RowMain
              tile={
                <Tile label="local" hue={42}>
                  <FolderGlyph />
                </Tile>
              }
              title={t("settings.plugins.add.local")}
              desc={t("settings.plugins.local.hint")}
              side={
                <button
                  className="pl-icon-btn"
                  aria-haspopup="dialog"
                  aria-label={t("settings.plugins.add.local")}
                  onClick={() => togglePanel("local")}
                >
                  <PlusIcon />
                </button>
              }
            />
          </li>
        </ul>
      </Group>

      <p className="hint pl-foot">{t("settings.plugins.howTo.desc")}</p>

      {/* 两个表单开在弹窗里。读取中（clone 停不下来）不让关：关了预览稍后
          会凭空弹出，用户对不上是哪次操作的结果。 */}
      {panel === "git" ? (
        <SourceDialog
          title={t("settings.plugins.add.git")}
          error={errorFrom("git")}
          busy={preparing !== null}
          reading={preparing === "git"}
          canSubmit={canPrepareGit}
          onSubmit={prepareGit}
          onClose={() => setPanel("none")}
          t={t}
        >
          <label className="pl-field">
            <span>{t("settings.plugins.git.url")}</span>
            <input
              value={gitUrl}
              onChange={(e) => setGitUrl(e.target.value)}
              placeholder={t("settings.plugins.git.url.placeholder")}
              spellCheck={false}
              autoFocus
              onKeyDown={submitOnEnter(prepareGit)}
            />
          </label>
          <label className="pl-field">
            <span>{t("settings.plugins.git.ref")}</span>
            <input
              value={gitRef}
              onChange={(e) => setGitRef(e.target.value)}
              spellCheck={false}
              onKeyDown={submitOnEnter(prepareGit)}
            />
          </label>
          <label className="pl-field">
            <span>{t("settings.plugins.git.subdir")}</span>
            <input
              value={gitSubdir}
              onChange={(e) => setGitSubdir(e.target.value)}
              spellCheck={false}
              onKeyDown={submitOnEnter(prepareGit)}
            />
          </label>
        </SourceDialog>
      ) : null}

      {panel === "local" ? (
        <SourceDialog
          title={t("settings.plugins.add.local")}
          error={errorFrom("local")}
          busy={preparing !== null}
          reading={preparing === "local"}
          canSubmit={canPrepareLocal}
          onSubmit={prepareLocal}
          onClose={() => setPanel("none")}
          t={t}
        >
          <label className="pl-field">
            <span>{t("settings.plugins.local.path")}</span>
            <div className="input-with-btn">
              <input
                value={localPath}
                onChange={(e) => setLocalPath(e.target.value)}
                placeholder={t("settings.plugins.local.path.placeholder")}
                spellCheck={false}
                autoFocus
                onKeyDown={submitOnEnter(prepareLocal)}
              />
              <button
                className="btn-compact"
                onClick={() =>
                  void dirPicker.pick(localPath || undefined).then((d) => {
                    if (d) setLocalPath(d);
                  })
                }
              >
                {t("composer.sessionSettings.venv.pick")}
              </button>
            </div>
          </label>
          <p className="hint pl-field-hint">{t("settings.plugins.local.hint")}</p>
        </SourceDialog>
      ) : null}
    </>
  );
}

/** Git / 本地目录两个表单共用的弹窗壳：标题栏、字段区、底部「取消 / 下一步」。 */
function SourceDialog({
  title,
  error,
  busy,
  reading,
  canSubmit,
  onSubmit,
  onClose,
  t,
  children,
}: {
  title: string;
  error: string;
  /** 有 prepare 在跑（不一定是这个表单的）：不让关、不让再提交。 */
  busy: boolean;
  /** 跑的是这个表单的 prepare：主按钮显示「读取中…」。 */
  reading: boolean;
  canSubmit: boolean;
  onSubmit: () => void;
  onClose: () => void;
  t: Translate;
  children: ReactNode;
}) {
  const close = () => {
    if (!busy) onClose();
  };
  return (
    <Modal className="model-dialog pl-dialog" label={title} portal onClose={close}>
      <div className="modal-head">
        <span className="modal-title">{title}</span>
        <span className="bar-spacer" />
        <button className="ghost" onClick={close} disabled={busy} aria-label={t("common.close")}>
          ✕
        </button>
      </div>
      <div className="model-dialog-body">{children}</div>
      <div className="editor-foot">
        {error ? <span className="form-error">{error}</span> : <span />}
        <div className="editor-foot-actions">
          <button onClick={close} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button className="primary" disabled={!canSubmit} onClick={onSubmit}>
            {reading ? t("settings.plugins.preparing") : t("settings.plugins.prepare")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function MarketList({
  markets,
  query,
  loading,
  installed,
  installs,
  preparing,
  onInstall,
  t,
}: {
  markets: Marketplace[];
  query: string;
  /** 正在重拉。旧清单留在屏上淡一档，别整块换成"读取中"闪一下。 */
  loading: boolean;
  installed: Map<string, PluginStatus>;
  installs: PluginInstalls;
  /** 正在 prepare 的条目键（`市场/名字`），或别处的表单在准备。有值时所有安装键禁掉。 */
  preparing: string | null;
  onInstall: (e: MarketEntry) => void;
  t: Translate;
}) {
  const q = query.trim().toLowerCase();
  const entries = markets
    .flatMap((m) => m.plugins)
    .filter(
      (e) =>
        !q ||
        e.name.toLowerCase().includes(q) ||
        (e.description ?? "").toLowerCase().includes(q) ||
        (e.tags ?? []).some((tag) => tag.toLowerCase().includes(q)),
    );
  const failed = markets.filter((m) => m.error);
  return (
    <div className={loading ? "pl-market is-loading" : "pl-market"}>
      {/* 人话一行、技术细节一行。拼成一句的话，DNS 错误原文会把"该查网络"
          那半句淹掉 —— 细节是给排查用的，淡一档、等宽、可选中。 */}
      {failed.map((m) => {
        const err = m.error ? splitUiError(m.error) : null;
        return (
          <div key={m.id} className="market-error pl-note">
            <p className="form-error">
              {t("settings.plugins.market.error", { name: m.name || m.id, error: err?.text ?? "" })}
            </p>
            {err?.detail ? <code className="market-error-detail">{err.detail}</code> : null}
          </div>
        );
      })}
      {entries.length === 0 ? (
        <p className="hint pl-note">{q ? t("settings.plugins.market.noMatch") : t("settings.plugins.market.empty")}</p>
      ) : (
        <ul className="pl-list">
          {entries.map((e) => {
            const key = `${e.marketplace}/${e.name}`;
            const inst = installed.get(e.name);
            const prog = installs.progress[e.name];
            const running = Boolean(installs.running[e.name]);
            const upgradable = Boolean(inst) && Boolean(e.version) && e.version !== inst?.version;
            // 右侧只放一个东西：装 / 升级 / 已装的勾 / 不支持。
            let side: ReactNode;
            if (running) {
              side = (
                <span className="pl-check pl-busy" aria-hidden>
                  <Spinner />
                </span>
              );
            } else if (!e.supported) {
              side = <span className="pl-meta">{t("settings.plugins.market.unsupported")}</span>;
            } else if (inst && !upgradable) {
              side = (
                <span className="pl-check" title={t("settings.plugins.market.installed")}>
                  <CheckIcon />
                </span>
              );
            } else {
              const label = upgradable ? t("settings.plugins.action.update") : t("settings.plugins.market.install");
              side = (
                <>
                  {e.downloadSize > 0 ? <span className="pl-meta">{humanSize(e.downloadSize)}</span> : null}
                  {upgradable ? (
                    <button className="btn-compact" disabled={preparing !== null} onClick={() => onInstall(e)}>
                      {preparing === key ? t("settings.plugins.preparing") : label}
                    </button>
                  ) : (
                    <button
                      className="pl-icon-btn"
                      disabled={preparing !== null}
                      aria-label={label}
                      title={label}
                      onClick={() => onInstall(e)}
                    >
                      {preparing === key ? <Spinner /> : <PlusIcon />}
                    </button>
                  )}
                </>
              );
            }
            return (
              <li key={key} className="pl-row">
                <RowMain
                  tile={<Tile label={e.name} />}
                  title={e.name}
                  meta={e.version}
                  desc={e.description}
                  side={side}
                />
                {/* 新装的进度显示在点了安装的这一条上；已装的（升级）在上面
                    已安装那行显示，这里只在右侧转圈，不重复一份。 */}
                {prog && !inst ? (
                  <div className="pl-sub">
                    <Progress prog={prog} onDismiss={() => clearPluginProgress(e.name)} t={t} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
