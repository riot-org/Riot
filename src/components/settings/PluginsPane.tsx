import { useCallback, useEffect, useMemo, useState } from "react";

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
} from "../../bridge";
import {
  clearDonePluginProgress,
  clearPluginProgress,
  reportPluginFailure,
  startPluginCommit,
  startPluginUpdate,
  usePluginInstalls,
} from "../../hooks/usePluginInstalls";
import { type MessageKey, useT } from "../../i18n";
import { useDirectoryPicker } from "../DirPicker";
import { Card, CardBlock, Group, Row } from "./layout";
import { type AskConfirm, Switch, blurOnEnter } from "./shared";

type Translate = ReturnType<typeof useT>["t"];

/** 字节数写成人话。压缩包是几百 MB 量级，一位小数够用。 */
function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * 安装进度的一句话描述。下载有百分比，其它几步没有 —— 它们相对下载
 * 短得多，硬凑一个总进度只会让进度条在末尾诡异地卡住。
 */
function progressText(p: PluginProgress, t: Translate): string {
  switch (p.kind) {
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

/** 组件清单：确认页和详情共用。名字都是装完之后对外的样子。 */
function Components({ plugin, t }: { plugin: PluginStatus; t: Translate }) {
  const c = plugin.components;
  const all: { key: MessageKey; items: string[] }[] = [
    { key: "settings.plugins.components.skills", items: c.skills },
    { key: "settings.plugins.components.commands", items: c.commands.map((x) => `/${x}`) },
    {
      key: "settings.plugins.components.hooks",
      items: c.hooks.map((h) => `${h.event}${h.matcher ? ` [${h.matcher}]` : ""} → ${h.command}`),
    },
    { key: "settings.plugins.components.mcp", items: c.mcpServers.map((m) => `${m.id} (${m.transport}) ${m.detail}`) },
    { key: "settings.plugins.components.path", items: c.pathDirs },
    { key: "settings.plugins.components.env", items: c.envKeys },
    { key: "settings.plugins.components.selfCheck", items: c.selfChecks },
  ];
  const sections = all.filter((s) => s.items.length > 0);

  return (
    <div className="plugin-components">
      {sections.length === 0 ? (
        <p className="hint" style={{ margin: 0 }}>
          {t("settings.plugins.components.none")}
        </p>
      ) : (
        sections.map((s) => (
          <div key={s.key} className="plugin-component">
            <span className="plugin-component-title">{t(s.key)}</span>
            <ul>
              {s.items.map((it, i) => (
                <li key={i}>
                  <code>{it}</code>
                </li>
              ))}
            </ul>
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

type View = "list" | "market" | "git" | "local" | "marketplaces";

export function PluginsPane({ askConfirm, status }: { askConfirm: AskConfirm; status: ConfigStatus }) {
  const { t } = useT();
  const [plugins, setPlugins] = useState<PluginStatus[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [view, setView] = useState<View>("list");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  /** 安装进度和"正在装"标记在模块级 —— 关掉设置面板不该把它们连同组件一起丢掉。 */
  const installs = usePluginInstalls();

  // 市场
  const [markets, setMarkets] = useState<Marketplace[] | null>(null);
  const [marketLoading, setMarketLoading] = useState(false);
  const [query, setQuery] = useState("");

  // 确认页
  const [preview, setPreview] = useState<PluginPreview | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState("");

  // 表单
  const [gitUrl, setGitUrl] = useState("");
  const [gitRef, setGitRef] = useState("");
  const [gitSubdir, setGitSubdir] = useState("");
  const [localPath, setLocalPath] = useState("");
  const dirPicker = useDirectoryPicker();

  // 市场列表编辑
  const marketplaces = status.config.pluginMarketplaces ?? [];
  const [newMarketId, setNewMarketId] = useState("");
  const [newMarketSource, setNewMarketSource] = useState("");
  const [marketError, setMarketError] = useState("");

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
    try {
      setMarkets(await pluginsMarket(force));
    } catch (e) {
      setMarkets([]);
      setLoadError(String(e));
    } finally {
      setMarketLoading(false);
    }
  }, []);

  useEffect(() => {
    if (view === "market" && markets === null) void loadMarket(false);
  }, [view, markets, loadMarket]);

  const installedIds = useMemo(() => new Set((plugins ?? []).map((p) => p.id)), [plugins]);

  const prepare = async (source: PluginSourceRequest) => {
    setPreparing(true);
    setPrepareError("");
    try {
      const p = await pluginsPrepare(source);
      setPreview(p);
      setView("list");
    } catch (e) {
      setPrepareError(String(e));
    } finally {
      setPreparing(false);
    }
  };

  const cancelPreview = () => {
    if (preview) void pluginsDiscard(preview.token).catch(() => {});
    setPreview(null);
  };

  const confirmInstall = () => {
    if (!preview) return;
    startPluginCommit(preview.plugin.id, preview.token);
    setPreview(null);
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

  const saveMarketplaces = async (next: MarketplaceConfig[]) => {
    setMarketError("");
    try {
      await pluginsSetMarketplaces(next);
      setMarkets(null);
    } catch (e) {
      setMarketError(String(e));
    }
  };

  // ── 确认页 ────────────────────────────────────────────
  if (preview) {
    const p = preview.plugin;
    return (
      <Group title={t("settings.plugins.confirm.title", { name: titleOf(p) })}>
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
            {preview.replacesVersion ? (
              <p className="hint" style={{ margin: "6px 0 0" }}>
                {t("settings.plugins.confirm.replaces", { version: preview.replacesVersion || "?" })}
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
          <CardBlock>
            <Components plugin={p} t={t} />
          </CardBlock>
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

  return (
    <>
      {dirPicker.element}
      <Group
        title={t("settings.plugins.installed")}
        desc={t("settings.plugins.installed.desc")}
        action={
          <div className="set-group-actions">
            <button className="btn-compact" onClick={() => setView(view === "market" ? "list" : "market")}>
              {t("settings.plugins.add.market")}
            </button>
            <button className="btn-compact" onClick={() => setView(view === "git" ? "list" : "git")}>
              {t("settings.plugins.add.git")}
            </button>
            <button className="btn-compact" onClick={() => setView(view === "local" ? "list" : "local")}>
              {t("settings.plugins.add.local")}
            </button>
          </div>
        }
      >
        <div className="plugin-stack">
        {view === "git" ? (
          <Card>
            <Row title={t("settings.plugins.git.url")} stack>
              <input
                value={gitUrl}
                onChange={(e) => setGitUrl(e.target.value)}
                placeholder={t("settings.plugins.git.url.placeholder")}
                spellCheck={false}
                onKeyDown={blurOnEnter}
              />
            </Row>
            <Row title={t("settings.plugins.git.ref")}>
              <input value={gitRef} onChange={(e) => setGitRef(e.target.value)} spellCheck={false} />
            </Row>
            <Row title={t("settings.plugins.git.subdir")}>
              <input value={gitSubdir} onChange={(e) => setGitSubdir(e.target.value)} spellCheck={false} />
            </Row>
            <CardBlock>
              <div className="editor-foot">
                {prepareError ? <span className="form-error">{prepareError}</span> : <span />}
                <div className="editor-foot-actions">
                  <button onClick={() => setView("list")}>{t("common.cancel")}</button>
                  <button
                    className="primary"
                    disabled={preparing || !gitUrl.trim()}
                    onClick={() =>
                      void prepare({
                        kind: "git",
                        url: gitUrl.trim(),
                        ...(gitRef.trim() ? { gitRef: gitRef.trim() } : {}),
                        ...(gitSubdir.trim() ? { subdir: gitSubdir.trim() } : {}),
                      })
                    }
                  >
                    {preparing ? t("settings.plugins.preparing") : t("settings.plugins.prepare")}
                  </button>
                </div>
              </div>
            </CardBlock>
          </Card>
        ) : null}

        {view === "local" ? (
          <Card>
            <Row title={t("settings.plugins.local.path")} desc={t("settings.plugins.local.hint")} stack>
              <div className="input-with-btn">
                <input
                  value={localPath}
                  onChange={(e) => setLocalPath(e.target.value)}
                  placeholder={t("settings.plugins.local.path.placeholder")}
                  spellCheck={false}
                  onKeyDown={blurOnEnter}
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
            </Row>
            <CardBlock>
              <div className="editor-foot">
                {prepareError ? <span className="form-error">{prepareError}</span> : <span />}
                <div className="editor-foot-actions">
                  <button onClick={() => setView("list")}>{t("common.cancel")}</button>
                  <button
                    className="primary"
                    disabled={preparing || !localPath.trim()}
                    onClick={() => void prepare({ kind: "local", path: localPath.trim() })}
                  >
                    {preparing ? t("settings.plugins.preparing") : t("settings.plugins.prepare")}
                  </button>
                </div>
              </div>
            </CardBlock>
          </Card>
        ) : null}

        {loadError ? (
          <div className="empty-state">
            <p className="form-error" style={{ margin: 0 }}>
              {t("settings.ext.loadFailed", { error: loadError })}
            </p>
            <button onClick={() => void refresh()}>{t("common.retry")}</button>
          </div>
        ) : plugins === null ? (
          <Card>
            <CardBlock>
              <p className="hint" style={{ margin: 0 }}>
                {t("settings.ext.loading")}
              </p>
            </CardBlock>
          </Card>
        ) : plugins.length === 0 && view === "list" && Object.keys(installs.progress).length === 0 ? (
          <div className="empty-state">
            <p className="hint">{t("settings.plugins.empty")}</p>
          </div>
        ) : (
          <ul className="plugin-list">
            {/* 还没进注册表、正在装的：几百 MB 的下载要几分钟，没有这一行
                用户看不到任何进度，会以为没点上、再点一次。 */}
            {Object.entries(installs.progress)
              .filter(([id]) => !installedIds.has(id))
              .map(([id, prog]) => (
                <li key={`pending-${id}`} className="plugin-item">
                  <div className="plugin-head">
                    <span className="plugin-name">{id}</span>
                  </div>
                  <div className="plugin-progress">
                    {prog.kind === "downloading" && prog.total > 0 ? (
                      <div className="plugin-bar">
                        <div
                          className="plugin-bar-fill"
                          style={{ width: `${Math.round((prog.received / prog.total) * 100)}%` }}
                        />
                      </div>
                    ) : null}
                    <span className={prog.kind === "failed" ? "form-error" : "hint"}>{progressText(prog, t)}</span>
                  </div>
                  {prog.kind === "failed" ? (
                    <div className="plugin-actions">
                      <button className="ghost" onClick={() => clearPluginProgress(id)}>
                        {t("common.done")}
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
            {plugins.map((p) => {
              const prog = installs.progress[p.id];
              const running = Boolean(installs.running[p.id]);
              const isBusy = running || busy === p.id;
              const upgradable = Boolean(p.availableVersion) && p.availableVersion !== p.version;
              const open = Boolean(expanded[p.id]);
              return (
                <li key={p.id} className={p.fatal ? "plugin-item bad" : "plugin-item"}>
                  <div className="plugin-head">
                    <span className="plugin-name">{titleOf(p)}</span>
                    {p.version ? <span className="plugin-badge">{p.version}</span> : null}
                    <span className={p.enabled ? "plugin-badge on" : "plugin-badge"}>
                      {p.enabled ? t("settings.plugins.enabled") : t("settings.plugins.disabled")}
                    </span>
                    {p.linked ? <span className="plugin-badge">{t("settings.plugins.linked")}</span> : null}
                    {p.format ? <span className="plugin-badge">{t(FORMAT_LABEL[p.format])}</span> : null}
                    {upgradable ? (
                      <span className="plugin-badge">
                        {t("settings.plugins.upgradable", { version: p.availableVersion ?? "" })}
                      </span>
                    ) : null}
                    {!p.platformOk ? <span className="plugin-badge bad">{t("settings.plugins.platformNo")}</span> : null}
                    <span className="plugin-spacer" />
                    <Switch
                      on={p.enabled}
                      disabled={isBusy || Boolean(p.fatal)}
                      onChange={(v) => void toggle(p, v)}
                      label={p.enabled ? t("settings.plugins.action.disable") : t("settings.plugins.action.enable")}
                    />
                  </div>
                  {p.meta?.description ? (
                    <p className="hint" style={{ margin: "2px 0 0" }}>
                      {p.meta.description}
                    </p>
                  ) : null}
                  <p className="hint plugin-source" style={{ margin: "4px 0 0" }}>
                    {t(SOURCE_LABEL[p.source.kind])}
                    {p.source.detail ? ` · ${p.source.detail}` : ""}
                    {p.source.commit ? ` @ ${p.source.commit.slice(0, 8)}` : ""}
                  </p>
                  {p.fatal ? (
                    <p className="form-error" style={{ margin: "6px 0 0" }}>
                      {t("settings.plugins.fatal")}: {renderUiError(p.fatal)}
                    </p>
                  ) : null}
                  {!open && p.problems.length > 0 ? (
                    <p className="form-error" style={{ margin: "6px 0 0" }}>
                      {p.problems.length} {t("settings.plugins.problems")}
                    </p>
                  ) : null}

                  {prog ? (
                    <div className="plugin-progress">
                      {prog.kind === "downloading" && prog.total > 0 ? (
                        <div className="plugin-bar">
                          <div
                            className="plugin-bar-fill"
                            style={{ width: `${Math.round((prog.received / prog.total) * 100)}%` }}
                          />
                        </div>
                      ) : null}
                      <span className={prog.kind === "failed" ? "form-error" : "hint"}>{progressText(prog, t)}</span>
                    </div>
                  ) : null}

                  {open ? <Components plugin={p} t={t} /> : null}

                  <div className="plugin-actions">
                    <button
                      className="ghost"
                      onClick={() => setExpanded((e) => ({ ...e, [p.id]: !open }))}
                    >
                      {open ? t("settings.plugins.action.collapse") : t("settings.plugins.action.details")}
                    </button>
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
                </li>
              );
            })}
          </ul>
        )}
        </div>
      </Group>

      {view === "market" ? (
        <Group
          title={t("settings.plugins.market")}
          desc={t("settings.plugins.market.desc")}
          action={
            <div className="set-group-actions">
              <button className="btn-compact" disabled={marketLoading} onClick={() => void loadMarket(true)}>
                {t("common.refresh")}
              </button>
              <button className="btn-compact" onClick={() => setView("marketplaces")}>
                {t("settings.plugins.marketplaces")}
              </button>
            </div>
          }
        >
          <div className="plugin-stack">
            <input
              className="plugin-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("settings.plugins.market.search")}
              spellCheck={false}
            />
            {prepareError ? <p className="form-error">{prepareError}</p> : null}
            {markets === null || marketLoading ? (
              <Card>
                <CardBlock>
                  <p className="hint" style={{ margin: 0 }}>
                    {t("settings.ext.loading")}
                  </p>
                </CardBlock>
              </Card>
            ) : (
              <MarketList
                markets={markets}
                query={query}
                installedIds={installedIds}
                preparing={preparing}
                onInstall={(e) => void prepare({ kind: "market", marketplace: e.marketplace, name: e.name })}
                t={t}
              />
            )}
          </div>
        </Group>
      ) : null}

      {view === "marketplaces" ? (
        <Group title={t("settings.plugins.marketplaces")} desc={t("settings.plugins.marketplaces.desc")}>
          <Card>
            {marketplaces.map((m) => (
              <Row key={m.id} title={m.id} desc={<code>{m.source}</code>}>
                <Switch
                  on={m.enabled}
                  onChange={(v) =>
                    void saveMarketplaces(marketplaces.map((x) => (x.id === m.id ? { ...x, enabled: v } : x)))
                  }
                  label={m.enabled ? t("common.disabled") : t("common.enabled")}
                />
                <button
                  className="ghost btn-compact"
                  onClick={() => void saveMarketplaces(marketplaces.filter((x) => x.id !== m.id))}
                >
                  {t("settings.plugins.marketplaces.remove")}
                </button>
              </Row>
            ))}
            <Row title={t("settings.plugins.marketplaces.add")} stack>
              <div className="plugin-market-add">
                <input
                  value={newMarketId}
                  onChange={(e) => setNewMarketId(e.target.value)}
                  placeholder={t("settings.plugins.marketplaces.id")}
                  spellCheck={false}
                />
                <input
                  value={newMarketSource}
                  onChange={(e) => setNewMarketSource(e.target.value)}
                  placeholder="owner/repo · https://…/marketplace.json"
                  spellCheck={false}
                />
                <button
                  className="btn-compact"
                  disabled={!newMarketId.trim() || !newMarketSource.trim()}
                  onClick={() => {
                    void saveMarketplaces([
                      ...marketplaces,
                      { id: newMarketId.trim(), source: newMarketSource.trim(), enabled: true },
                    ]).then(() => {
                      setNewMarketId("");
                      setNewMarketSource("");
                    });
                  }}
                >
                  {t("common.add")}
                </button>
              </div>
              {marketError ? <p className="form-error">{marketError}</p> : null}
            </Row>
          </Card>
          <div className="editor-foot">
            <span />
            <div className="editor-foot-actions">
              <button onClick={() => setView("market")}>{t("common.back")}</button>
            </div>
          </div>
        </Group>
      ) : null}

      <Group title={t("settings.plugins.howTo")} desc={t("settings.plugins.howTo.desc")}>
        <span />
      </Group>
    </>
  );
}

function MarketList({
  markets,
  query,
  installedIds,
  preparing,
  onInstall,
  t,
}: {
  markets: Marketplace[];
  query: string;
  installedIds: Set<string>;
  preparing: boolean;
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
    <>
      {failed.map((m) => (
        <p key={m.id} className="form-error">
          {t("settings.plugins.market.error", { name: m.name || m.id, error: m.error ? renderUiError(m.error) : "" })}
        </p>
      ))}
      {entries.length === 0 ? (
        <Card>
          <CardBlock>
            <p className="hint" style={{ margin: 0 }}>
              {t("settings.plugins.market.empty")}
            </p>
          </CardBlock>
        </Card>
      ) : (
        <ul className="plugin-list">
          {entries.map((e) => {
            const installed = installedIds.has(e.name);
            return (
              <li key={`${e.marketplace}/${e.name}`} className="plugin-item">
                <div className="plugin-head">
                  <span className="plugin-name">{e.name}</span>
                  {e.version ? <span className="plugin-badge">{e.version}</span> : null}
                  <span className="plugin-badge">{e.marketplace}</span>
                  {e.category ? <span className="plugin-badge">{e.category}</span> : null}
                  {installed ? <span className="plugin-badge on">{t("settings.plugins.market.installed")}</span> : null}
                </div>
                {e.description ? (
                  <p className="hint" style={{ margin: "2px 0 0" }}>
                    {e.description}
                  </p>
                ) : null}
                {e.author ? (
                  <p className="hint" style={{ margin: "2px 0 0" }}>
                    {e.author}
                  </p>
                ) : null}
                <div className="plugin-actions">
                  {e.supported ? (
                    <button disabled={preparing} onClick={() => onInstall(e)}>
                      {installed ? t("settings.plugins.action.update") : t("settings.plugins.market.install")}
                      {e.downloadSize > 0 ? t("settings.plugins.market.size", { size: humanSize(e.downloadSize) }) : null}
                    </button>
                  ) : (
                    <span className="hint">{t("settings.plugins.market.unsupported")}</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
