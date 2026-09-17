//! 插件的安装侧：注册表、来源、市场、安装/卸载/升级、旧能力包的迁移。
//!
//! 读的那一半（清单、组件发现、运行时注入）在内核 `riot_kernel::plugins`，
//! 宿主和内核共用同一份加载器 —— 装的时候按它校验、预览，跑的时候按它
//! 发现组件，两边看到的必须是同一个解释。
//!
//! 磁盘布局：
//! ```text
//! <config_dir>/riot/plugins/
//!   <id>/                        安装的插件（链接的不在这里，根在 config 里）
//!   <id>.old/                    升级 / 卸载时挪开的旧目录，随手删；删不掉下次再清
//!   .cache/<id>-<version>.tar.zst 压缩包下载的半成品 / 缓存
//!   .staging-<id>-<nonce>/       解压 / clone 中间态，校验通过后原子 rename 过去
//!   .marketplaces/<id>/          非 GitHub 市场仓库的浅 clone
//! <config_dir>/riot/plugin-data/<id>/   PLUGIN_DATA，跨升级保留
//! ```
//!
//! 豁免理由：宿主层，这个模块的职责就是操作真实的网络、磁盘和进程。

#![allow(clippy::disallowed_methods)]

mod download;
mod install;
pub mod market;
pub mod source;

use std::path::{Path, PathBuf};

use riot_kernel::config::{AppConfig, MarketplaceConfig, PluginEntry, PluginSource};
use riot_kernel::plugins::{self as kp, Loaded};
use riot_protocol::UiError;
use riot_protocol::rpc::{McpServerSpec, McpTransport};
use serde::Serialize;

pub use install::InstallError;
pub use market::{MarketEntry, Marketplace};
pub use source::{Pending, PluginPreview, SourceRequest, Staged};

// ── 目录 ──────────────────────────────────────────────

pub fn plugins_dir(config_path: &Path) -> PathBuf {
    riot_kernel::config::plugins_dir(config_path)
}

pub fn data_root(config_path: &Path) -> PathBuf {
    kp::data_root(config_path)
}

fn cache_dir(config_path: &Path) -> PathBuf {
    plugins_dir(config_path).join(".cache")
}

// ── 安装进度 ──────────────────────────────────────────

/// 安装过程推给前端的进度。
///
/// 分这么细是因为各阶段的耗时量级差着数量级:下载几分钟、解压十几秒、
/// 接线一瞬间。只报一个百分比的话,进度条会在 100% 处静止十几秒,
/// 用户以为卡死了。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PluginProgress {
    /// git clone 中。
    Cloning,
    #[serde(rename_all = "camelCase")]
    Downloading {
        received: u64,
        total: u64,
    },
    Verifying,
    Extracting,
    /// 校验二进制在这台机器上真的能跑起来。
    SelfCheck,
    Done {
        version: String,
    },
    Failed {
        error: UiError,
    },
}

// ── 给前端的状态 ──────────────────────────────────────

/// 一个插件在设置页里的样子。安装的、链接的、坏掉的都用它。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginStatus {
    pub id: String,
    pub enabled: bool,
    /// 注册表里记的版本（安装时清单里的）。
    pub version: String,
    pub root: String,
    /// 链接的本地目录（开发模式）。
    pub linked: bool,
    pub source: SourceView,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marketplace: Option<String>,
    /// 清单元数据。清单读不了时为 None，看 `fatal`。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<kp::Meta>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<kp::Format>,
    /// 清单整个读不了的原因。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fatal: Option<UiError>,
    pub problems: Vec<ProblemView>,
    pub unsupported: Vec<kp::Unsupported>,
    /// `dev.riot.platforms` 声明了平台且不含当前平台 → false。
    pub platform_ok: bool,
    pub components: ComponentsView,
    /// 市场里的可装版本（和 `version` 不同 = 可升级）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available_version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceView {
    /// `local` / `git` / `archive` / `legacy`。
    pub kind: String,
    /// 地址 / 路径，给人看。
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProblemView {
    pub path: String,
    pub error: UiError,
}

/// 插件带了什么。名字都是**对外的**（带 `<插件>:` 前缀的技能名、
/// `mcp__…` 前缀前的服务器 id）—— 确认页上用户看到的就是装完之后的样子。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentsView {
    pub skills: Vec<String>,
    pub commands: Vec<String>,
    pub hooks: Vec<HookView>,
    pub mcp_servers: Vec<McpView>,
    /// 进 PATH 的目录。
    pub path_dirs: Vec<String>,
    /// 注入的环境变量名。
    pub env_keys: Vec<String>,
    /// 装完要实跑的自检命令。
    pub self_checks: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookView {
    pub event: String,
    pub matcher: String,
    pub command: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpView {
    /// 对外的服务器 id（`<插件>--<名字>`）。
    pub id: String,
    /// `stdio` / `http`。
    pub transport: String,
    /// 命令行或地址，给人看。
    pub detail: String,
}

/// 插件 MCP 服务器的对外 id。进工具名（`mcp__<id>__<tool>`）和权限规则。
///
/// 两段用 `--` 接：`-` 是工具名允许的字符，`__` 是 `tool_name` 的分段符
/// 不能用。用户自己配的服务器 id 撞上这个形状的概率忽略不计。
pub fn mcp_server_id(plugin: &str, server: &str) -> String {
    format!("{plugin}--{server}")
}

/// 把一个读好的插件摊成组件清单。
pub fn components_of(loaded: &Loaded) -> ComponentsView {
    let one = std::slice::from_ref(loaded);
    let skills = riot_kernel::skills::discover_opt(None, one)
        .cards
        .into_iter()
        .filter(|c| c.name.starts_with(&format!("{}:", loaded.id)))
        .map(|c| c.name)
        .collect();
    let commands = riot_kernel::slash::discover(None, one)
        .into_iter()
        .filter(|c| c.source == "plugin")
        .map(|c| c.name)
        .collect();
    let hooks = riot_kernel::hooks::list(None, one)
        .into_iter()
        .filter(|h| h.source == "plugin" && h.error.is_none())
        .map(|h| HookView {
            event: h.event,
            matcher: h.matcher,
            command: h.command,
        })
        .collect();
    let mcp_servers = loaded
        .mcp_servers
        .iter()
        .map(|s| McpView {
            id: mcp_server_id(&loaded.id, &s.name),
            transport: match &s.transport {
                McpTransport::Stdio { .. } => "stdio".into(),
                McpTransport::Http { .. } => "http".into(),
            },
            detail: match &s.transport {
                McpTransport::Stdio { command, args, .. } => {
                    let mut parts = vec![command.clone()];
                    parts.extend(args.iter().cloned());
                    parts.join(" ")
                }
                McpTransport::Http { url, .. } => url.clone(),
            },
        })
        .collect();
    ComponentsView {
        skills,
        commands,
        hooks,
        mcp_servers,
        path_dirs: loaded
            .runtime
            .path_dirs
            .iter()
            .map(|p| p.display().to_string())
            .collect(),
        env_keys: loaded.runtime.env.iter().map(|(k, _)| k.clone()).collect(),
        self_checks: loaded
            .self_checks
            .iter()
            .map(|c| {
                let mut parts = vec![c.command.clone()];
                parts.extend(c.args.iter().cloned());
                parts.join(" ")
            })
            .collect(),
    }
}

fn source_view(source: &PluginSource, linked_path: Option<&str>) -> SourceView {
    match source {
        PluginSource::Local => SourceView {
            kind: "local".into(),
            detail: linked_path.unwrap_or("").to_owned(),
            commit: None,
        },
        PluginSource::Git {
            url,
            git_ref,
            subdir,
            commit,
        } => SourceView {
            kind: "git".into(),
            detail: {
                let mut d = url.clone();
                if let Some(r) = git_ref {
                    d.push('@');
                    d.push_str(r);
                }
                if let Some(s) = subdir {
                    d.push_str(" › ");
                    d.push_str(s);
                }
                d
            },
            commit: commit.clone(),
        },
        PluginSource::Archive { url, .. } => SourceView {
            kind: "archive".into(),
            detail: url.clone(),
            commit: None,
        },
        PluginSource::Legacy => SourceView {
            kind: "legacy".into(),
            detail: String::new(),
            commit: None,
        },
    }
}

/// 读一个目录、摊成状态。注册表信息从 `entry` 来；目录读不了也要返回
/// 一条（带 `fatal`），设置页得能显示"装了但坏了"。
pub fn status_of(entry: &PluginEntry, config_path: &Path, market: &[MarketEntry]) -> PluginStatus {
    let root = entry.root(config_path);
    let available_version = entry.marketplace.as_deref().and_then(|m| {
        market
            .iter()
            .find(|e| e.marketplace == m && e.name == entry.id)
            .and_then(|e| e.version.clone())
    });
    let mut status = PluginStatus {
        id: entry.id.clone(),
        enabled: entry.enabled,
        version: entry.version.clone(),
        root: root.display().to_string(),
        linked: entry.linked_path.is_some(),
        source: source_view(&entry.source, entry.linked_path.as_deref()),
        marketplace: entry.marketplace.clone(),
        meta: None,
        format: None,
        fatal: None,
        problems: Vec::new(),
        unsupported: Vec::new(),
        platform_ok: true,
        components: ComponentsView::default(),
        available_version,
    };
    match kp::load(&root, &data_root(config_path)) {
        Ok(loaded) => fill_from_loaded(&mut status, &loaded),
        Err(f) => status.fatal = Some(f.reason),
    }
    status
}

fn fill_from_loaded(status: &mut PluginStatus, loaded: &Loaded) {
    status.meta = Some(loaded.meta.clone());
    status.format = Some(loaded.format);
    status.platform_ok = loaded.platform_ok;
    status.problems = loaded
        .problems
        .iter()
        .map(|p| ProblemView {
            path: p.path.display().to_string(),
            error: p.reason.clone(),
        })
        .collect();
    status.unsupported = loaded.unsupported.clone();
    status.components = components_of(loaded);
    // 技能 / 命令 / hooks 解析失败的也算问题（内核发现层报出来的）。
    let one = std::slice::from_ref(loaded);
    for s in riot_kernel::skills::list(None, one) {
        if let Some(e) = s.error
            && s.plugin.as_deref() == Some(loaded.id.as_str())
        {
            status.problems.push(ProblemView {
                path: s.path,
                error: e,
            });
        }
    }
}

/// 注册表里每一条的状态。
pub fn status_all(
    config: &AppConfig,
    config_path: &Path,
    market: &[MarketEntry],
) -> Vec<PluginStatus> {
    let mut out: Vec<PluginStatus> = config
        .plugins
        .iter()
        .map(|e| status_of(e, config_path, market))
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// 本轮生效的插件，读好的。宿主列技能 / 命令 / hooks 时用（和内核每轮
/// 读的是同一份加载器）。
pub fn loaded_enabled(config: &AppConfig, config_path: &Path) -> Vec<Loaded> {
    kp::load_all(&config.plugin_refs(config_path), &data_root(config_path))
}

/// 启用中的插件带的 MCP 服务器，拼成 `mcp.reconcile` 要的形状。
pub fn mcp_specs(config: &AppConfig, config_path: &Path) -> Vec<McpServerSpec> {
    mcp_specs_except(config, config_path, &[])
}

/// 同上，但跳过 `skip` 里的插件。装 / 卸 / 升级要动某个插件的目录时，宿主
/// 用它让那个插件的服务器先停下来（见 `AppState::quiesce_plugin_mcp`）——
/// 它们就是从那个目录里起的进程。
pub fn mcp_specs_except(
    config: &AppConfig,
    config_path: &Path,
    skip: &[String],
) -> Vec<McpServerSpec> {
    let mut out = Vec::new();
    for p in loaded_enabled(config, config_path) {
        if skip.contains(&p.id) {
            continue;
        }
        for s in &p.mcp_servers {
            out.push(McpServerSpec {
                id: mcp_server_id(&p.id, &s.name),
                transport: s.transport.clone(),
            });
        }
    }
    out
}

// ── 安装：prepare → commit ────────────────────────────

/// 拉全部启用的市场。网络失败装进各自的 `error`。
pub async fn fetch_markets(
    marketplaces: &[MarketplaceConfig],
    config_path: &Path,
) -> Vec<Marketplace> {
    let cache = plugins_dir(config_path);
    let mut out = Vec::new();
    for m in marketplaces.iter().filter(|m| m.enabled) {
        out.push(market::fetch(m, &cache).await);
    }
    out
}

/// 按请求把插件取到能预览的程度。返回待确认的安装和给确认页的预览。
pub async fn prepare(
    req: SourceRequest,
    config: &AppConfig,
    config_path: &Path,
    markets: &[MarketEntry],
) -> Result<(Pending, PluginPreview), InstallError> {
    let platform = kp::platform_key();
    let data = data_root(config_path);
    let installed_version = |id: &str| -> Option<String> {
        config
            .plugins
            .iter()
            .find(|p| p.id == id)
            .map(|p| p.version.clone())
    };

    match req {
        SourceRequest::Local { path } => {
            let root = PathBuf::from(path.trim());
            let loaded = kp::load(&root, &data).map_err(|f| InstallError::Invalid(f.reason))?;
            let id = loaded.id.clone();
            let version = loaded.meta.version.clone().unwrap_or_default();
            let canon = loaded.root.display().to_string();
            let entry = PluginEntry {
                id: id.clone(),
                enabled: true,
                version: version.clone(),
                source: PluginSource::Local,
                marketplace: None,
                linked_path: Some(canon.clone()),
            };
            let status = status_of(&entry, config_path, markets);
            Ok((
                Pending {
                    id: id.clone(),
                    source: PluginSource::Local,
                    marketplace: None,
                    staged: Staged::Linked(loaded.root.clone()),
                    version,
                },
                PluginPreview {
                    token: token(),
                    plugin: status,
                    contents_verified: true,
                    download_size: 0,
                    installed_size: 0,
                    replaces_version: installed_version(&id),
                },
            ))
        }
        SourceRequest::Git {
            url,
            git_ref,
            subdir,
        } => prepare_git(url, git_ref, subdir, None, config, config_path, markets).await,
        SourceRequest::Market { marketplace, name } => {
            let entry = markets
                .iter()
                .find(|e| e.marketplace == marketplace && e.name == name)
                .ok_or_else(|| InstallError::NotFound(name.clone()))?;
            match &entry.source {
                market::ResolvedSource::Git {
                    url,
                    git_ref,
                    subdir,
                } => {
                    prepare_git(
                        url.clone(),
                        git_ref.clone(),
                        subdir.clone(),
                        Some(marketplace.clone()),
                        config,
                        config_path,
                        markets,
                    )
                    .await
                }
                market::ResolvedSource::Archive { platforms } => {
                    let asset = platforms
                        .get(&platform)
                        .ok_or_else(|| InstallError::Unsupported(platform.clone()))?;
                    let version = entry.version.clone().unwrap_or_default();
                    // 预览只有市场说的：名字、说明、版本、体积。
                    let status = PluginStatus {
                        id: name.clone(),
                        enabled: true,
                        version: version.clone(),
                        root: riot_kernel::config::plugin_dir(config_path, &name)
                            .display()
                            .to_string(),
                        linked: false,
                        source: SourceView {
                            kind: "archive".into(),
                            detail: asset.url.clone(),
                            commit: None,
                        },
                        marketplace: Some(marketplace.clone()),
                        meta: Some(kp::Meta {
                            name: name.clone(),
                            display_name: None,
                            version: entry.version.clone(),
                            description: entry.description.clone(),
                            author: entry.author.clone(),
                            homepage: entry.homepage.clone(),
                            repository: None,
                            license: None,
                            keywords: entry.tags.clone(),
                        }),
                        format: None,
                        fatal: None,
                        problems: Vec::new(),
                        unsupported: Vec::new(),
                        platform_ok: true,
                        components: ComponentsView::default(),
                        available_version: entry.version.clone(),
                    };
                    Ok((
                        Pending {
                            id: name.clone(),
                            source: PluginSource::Archive {
                                url: asset.url.clone(),
                                sha256: asset.sha256.clone(),
                                size: asset.size,
                            },
                            marketplace: Some(marketplace),
                            staged: Staged::Archive {
                                asset: asset.clone(),
                            },
                            version,
                        },
                        PluginPreview {
                            token: token(),
                            plugin: status,
                            contents_verified: false,
                            download_size: asset.size,
                            installed_size: asset.installed_size,
                            replaces_version: installed_version(&name),
                        },
                    ))
                }
            }
        }
    }
}

async fn prepare_git(
    url: String,
    git_ref: Option<String>,
    subdir: Option<String>,
    marketplace: Option<String>,
    config: &AppConfig,
    config_path: &Path,
    markets: &[MarketEntry],
) -> Result<(Pending, PluginPreview), InstallError> {
    let url = url.trim().to_owned();
    if url.is_empty() {
        return Err(InstallError::Git("empty repository url".into()));
    }
    // 先 clone 到一个以来源命名的临时目录；id 要读了清单才知道。
    let staging = install::staging_dir_for(&plugins_dir(config_path).join("pending"))?;
    let result = async {
        let commit =
            source::fetch_git(&url, git_ref.as_deref(), subdir.as_deref(), &staging).await?;
        let loaded = kp::load(&staging, &data_root(config_path))
            .map_err(|f| InstallError::Invalid(f.reason))?;
        Ok::<_, InstallError>((commit, loaded))
    }
    .await;
    let (commit, loaded) = match result {
        Ok(v) => v,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(e);
        }
    };
    let id = loaded.id.clone();
    let version = loaded.meta.version.clone().unwrap_or_default();
    let source = PluginSource::Git {
        url,
        git_ref,
        subdir,
        commit,
    };
    // 预览按 staging 目录读，但显示的 root 是装完之后的位置。
    let mut status = PluginStatus {
        id: id.clone(),
        enabled: true,
        version: version.clone(),
        root: riot_kernel::config::plugin_dir(config_path, &id)
            .display()
            .to_string(),
        linked: false,
        source: source_view(&source, None),
        marketplace: marketplace.clone(),
        meta: None,
        format: None,
        fatal: None,
        problems: Vec::new(),
        unsupported: Vec::new(),
        platform_ok: true,
        components: ComponentsView::default(),
        available_version: None,
    };
    fill_from_loaded(&mut status, &loaded);
    let replaces_version = config
        .plugins
        .iter()
        .find(|p| p.id == id)
        .map(|p| p.version.clone());
    let _ = markets;
    Ok((
        Pending {
            id,
            source,
            marketplace,
            staged: Staged::Dir(staging),
            version,
        },
        PluginPreview {
            token: token(),
            plugin: status,
            contents_verified: true,
            download_size: 0,
            installed_size: 0,
            replaces_version,
        },
    ))
}

/// 用户点了确认之后的第一步：该下载的下载、该解压的解压，全落在临时目录，
/// **不碰** `plugins/<id>/`。非压缩包来源原样返回（git 在 `prepare` 时就
/// 取下来了，链接的没有东西要取）。
///
/// 和 [`commit`] 分开是为了升级：旧版本的目录要被整个挪走，它带的 MCP
/// 服务器得先停（见 `AppState::quiesce_plugin_mcp`）。下载要几分钟，这几
/// 分钟里插件没理由不可用 —— 宿主在这一步之后、`commit` 之前才停进程，
/// 真正不可用的只有搬目录加自检那几秒。
pub async fn fetch(
    pending: Pending,
    config_path: &Path,
    progress: &(impl Fn(PluginProgress) + Send + Sync),
) -> Result<Pending, InstallError> {
    let Staged::Archive { asset } = &pending.staged else {
        return Ok(pending);
    };
    let dest = riot_kernel::config::plugin_dir(config_path, &pending.id);
    let (staging, archive) = source::fetch_archive(
        &pending.id,
        &pending.version,
        asset,
        &cache_dir(config_path),
        &dest,
        progress,
    )
    .await?;
    Ok(Pending {
        staged: Staged::Extracted { staging, archive },
        ..pending
    })
}

/// 用户点了确认：把准备好的东西落到最终位置，返回要写进注册表的条目。
///
/// 已有同 id 的条目时：链接 ↔ 安装可以互换（开发者把本地目录换成正式版
/// 是常见流程），目录整体替换（升级）。调用方负责把返回的条目写进配置，
/// 并在这之前停掉旧版本的进程（升级时）。
///
/// 没先 [`fetch`] 也行 —— 这里会补上；那样压缩包来源的下载就落在停了
/// 进程之后，只是慢，不是错。
pub async fn commit(
    pending: Pending,
    config_path: &Path,
    progress: &(impl Fn(PluginProgress) + Send + Sync),
) -> Result<PluginEntry, InstallError> {
    let pending = fetch(pending, config_path, progress).await?;
    let data = data_root(config_path);
    let dest = riot_kernel::config::plugin_dir(config_path, &pending.id);
    let mut entry = PluginEntry {
        id: pending.id.clone(),
        enabled: true,
        version: pending.version.clone(),
        source: pending.source.clone(),
        marketplace: pending.marketplace.clone(),
        linked_path: None,
    };
    match pending.staged {
        Staged::Linked(root) => {
            // 之前装过一份同 id 的正式版？链接优先，装的那份目录删掉，
            // 否则两份技能同名互相盖。
            if let Err(e) = install::remove_tree(&dest) {
                tracing::warn!(plugin = %pending.id, error = %e, "被链接替掉的旧目录没删掉");
            }
            entry.linked_path = Some(root.display().to_string());
        }
        Staged::Dir(staging) => {
            place(&staging, &dest, &data, progress).await?;
        }
        Staged::Extracted { staging, archive } => {
            let loaded = place(&staging, &dest, &data, progress).await?;
            // 装完就把压缩包删掉。它和解压出来的内容加起来是两份几百 MB,
            // 留着只在"同一版本重装"这一个场景有用,不值这个盘。
            let _ = std::fs::remove_file(&archive);
            // 压缩包里清单的版本比市场说的准。
            if let Some(v) = loaded.meta.version {
                entry.version = v;
            }
        }
        Staged::Archive { .. } => {
            return Err(InstallError::Task(
                "archive was not fetched before commit".into(),
            ));
        }
    }
    progress(PluginProgress::Done {
        version: entry.version.clone(),
    });
    Ok(entry)
}

/// 把暂存目录搬进最终位置并自检。
///
/// 搬不进去收掉暂存目录；自检不过收掉刚搬进去的 —— 留着的话状态显示
/// 已安装，用起来却处处报错。两步都是同步的重活（改名是一瞬间，自检要
/// 真把二进制跑起来），走 spawn_blocking。
async fn place(
    staging: &Path,
    dest: &Path,
    data: &Path,
    progress: &(impl Fn(PluginProgress) + Send + Sync),
) -> Result<Loaded, InstallError> {
    progress(PluginProgress::SelfCheck);
    let (s, d) = (staging.to_path_buf(), dest.to_path_buf());
    let swapped = tokio::task::spawn_blocking(move || install::swap_in(&s, &d))
        .await
        .map_err(|e| InstallError::Task(format!("swap task did not finish: {e}")))?;
    if let Err(e) = swapped {
        let _ = std::fs::remove_dir_all(staging);
        return Err(e);
    }
    let (d, data2) = (dest.to_path_buf(), data.to_path_buf());
    let finalized = tokio::task::spawn_blocking(move || install::finalize(&d, &data2))
        .await
        .map_err(|e| InstallError::Task(format!("self-check task did not finish: {e}")))?;
    match finalized {
        Ok(loaded) => Ok(loaded),
        Err(e) => {
            let _ = std::fs::remove_dir_all(dest);
            Err(e)
        }
    }
}

/// 放弃一次准备好的安装：收掉临时目录。
pub fn discard(pending: Pending) {
    match pending.staged {
        Staged::Dir(staging) | Staged::Extracted { staging, .. } => {
            let _ = std::fs::remove_dir_all(staging);
        }
        Staged::Linked(_) | Staged::Archive { .. } => {}
    }
}

/// 卸载：删目录（链接的不删用户自己的目录）、删数据目录。幂等。
///
/// 只动磁盘。它带的 MCP 服务器是从这个目录里起的（可执行文件、工作目录
/// 都在里面），调用方得先让内核把进程停掉再来 —— Windows 上删一个还在跑
/// 的 exe、挪一个被当作工作目录的文件夹，都是 Access denied（见
/// `AppState::plugins_uninstall`）。
pub fn uninstall(entry: &PluginEntry, config_path: &Path) -> Result<(), InstallError> {
    if entry.linked_path.is_none() {
        install::remove_tree(&riot_kernel::config::plugin_dir(config_path, &entry.id))?;
    }
    // 数据目录删不掉不算卸载失败：插件本体已经不在了，留几个状态文件
    // 不影响任何功能，下次装回来还接着用。
    if let Err(e) = install::remove_tree(&data_root(config_path).join(&entry.id)) {
        tracing::warn!(plugin = %entry.id, error = %e, "插件数据目录没删掉");
    }
    Ok(())
}

/// 把已装插件的来源变成一次可以重新 `prepare` 的请求。市场来源的按市场
/// 里的同名条目重新解析（地址换了也跟得上）；直接 git 装的照原地址；
/// 链接的和迁移来的（没市场时）没有升级这回事。
pub fn update_request(entry: &PluginEntry) -> Option<SourceRequest> {
    if let Some(m) = &entry.marketplace {
        return Some(SourceRequest::Market {
            marketplace: m.clone(),
            name: entry.id.clone(),
        });
    }
    match &entry.source {
        PluginSource::Git {
            url,
            git_ref,
            subdir,
            ..
        } => Some(SourceRequest::Git {
            url: url.clone(),
            git_ref: git_ref.clone(),
            subdir: subdir.clone(),
        }),
        PluginSource::Local | PluginSource::Archive { .. } | PluginSource::Legacy => None,
    }
}

fn token() -> String {
    format!("{:016x}", rand::random::<u64>())
}

// ── 旧能力包迁移 ──────────────────────────────────────

/// 把 `<config>/packs/<id>/pack.json` 那一代的目录迁成插件。返回配置是否
/// 改动（要存盘 + 重连 MCP）。
///
/// 用户是无感的：目录挪位置、补一份标准清单、原来自动注册进配置的 MCP
/// 条目摘掉（现在由插件派生）、数据目录跟着走。迁不动的（读不出 pack.json）
/// 留在原地不碰 —— 删掉几百 MB 用户可能还想手工救回来的东西不是我们的事。
pub fn migrate_legacy_packs(config: &mut AppConfig, config_path: &Path) -> bool {
    let legacy = riot_kernel::config::legacy_packs_dir(config_path);
    let Ok(rd) = std::fs::read_dir(&legacy) else {
        return false;
    };
    let mut changed = false;
    let mut ids: Vec<(String, PathBuf)> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.join("pack.json").is_file())
        .filter_map(|p| Some((p.file_name()?.to_str()?.to_owned(), p)))
        .collect();
    ids.sort();
    for (id, old_root) in ids {
        match migrate_one(&id, &old_root, config, config_path) {
            Ok(()) => {
                tracing::info!(plugin = %id, "旧能力包已迁成插件");
                changed = true;
            }
            Err(e) => tracing::warn!(plugin = %id, error = %e, "旧能力包迁移失败，留在原地"),
        }
    }
    // 自动注册进配置的那些 MCP 条目（command 落在旧目录下）现在由插件派生。
    let before = config.mcp_servers.len();
    config
        .mcp_servers
        .retain(|s| !Path::new(&s.command).starts_with(&legacy));
    if config.mcp_servers.len() != before {
        changed = true;
    }
    // 下载缓存和空壳收掉。
    let _ = std::fs::remove_dir_all(legacy.join(".cache"));
    let _ = std::fs::remove_dir_all(legacy.join(".data"));
    let _ = std::fs::remove_dir(&legacy);
    changed
}

fn migrate_one(
    id: &str,
    old_root: &Path,
    config: &mut AppConfig,
    config_path: &Path,
) -> Result<(), String> {
    let raw = std::fs::read_to_string(old_root.join("pack.json")).map_err(|e| e.to_string())?;
    let pack: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let version = pack
        .get("version")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_owned();
    let platform = pack
        .get("platform")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);

    // 数据目录：旧的在 packs/.data/<id>，新的在 plugin-data/<id>。
    let old_data = old_root
        .parent()
        .map(|p| p.join(".data").join(id))
        .filter(|p| p.is_dir());
    let new_data = data_root(config_path).join(id);
    if let Some(od) = old_data
        && !new_data.exists()
    {
        let _ = std::fs::create_dir_all(new_data.parent().unwrap_or(Path::new(".")));
        let _ = std::fs::rename(&od, &new_data);
    }

    // 标准清单 + dev.riot 扩展。路径都是相对包根的，改成 `./x` / `${PLUGIN_ROOT}/x`。
    let rel = |s: &str| -> String {
        let s = s.trim_start_matches("./");
        format!("./{s}")
    };
    let mut ext = serde_json::Map::new();
    if let Some(p) = &platform {
        ext.insert("platforms".into(), serde_json::json!([p]));
    }
    if let Some(env) = pack.get("env").and_then(serde_json::Value::as_object) {
        let m: serde_json::Map<String, serde_json::Value> = env
            .iter()
            .filter_map(|(k, v)| Some((k.clone(), serde_json::Value::String(rel(v.as_str()?)))))
            .collect();
        ext.insert("env".into(), serde_json::Value::Object(m));
    }
    if let Some(pp) = pack
        .get("pathPrepend")
        .and_then(serde_json::Value::as_array)
    {
        let list: Vec<serde_json::Value> = pp
            .iter()
            .filter_map(|v| Some(serde_json::Value::String(rel(v.as_str()?))))
            .collect();
        ext.insert("pathPrepend".into(), serde_json::Value::Array(list));
    }
    if let Some(sc) = pack.get("selfCheck").and_then(serde_json::Value::as_array) {
        let list: Vec<serde_json::Value> = sc
            .iter()
            .filter_map(|c| {
                Some(serde_json::json!({
                    "command": rel(c.get("command")?.as_str()?),
                    "args": c.get("args").cloned().unwrap_or(serde_json::json!([])),
                }))
            })
            .collect();
        ext.insert("selfCheck".into(), serde_json::Value::Array(list));
    }
    let manifest = serde_json::json!({
        "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        "name": id,
        "version": version,
        "description": pack.get("description").cloned().unwrap_or(serde_json::Value::Null),
        "extensions": { kp::NAMESPACE: serde_json::Value::Object(ext) }
    });
    let mut manifest = manifest;
    if manifest["description"].is_null() {
        manifest.as_object_mut().map(|m| m.remove("description"));
    }

    // MCP：旧的 args 里相对路径按存在性展开过；这里存在的写成 ${PLUGIN_ROOT}/…。
    let mut servers = serde_json::Map::new();
    for s in pack
        .get("mcpServers")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
    {
        let (Some(sid), Some(cmd)) = (
            s.get("id").and_then(serde_json::Value::as_str),
            s.get("command").and_then(serde_json::Value::as_str),
        ) else {
            continue;
        };
        let args: Vec<serde_json::Value> = s
            .get("args")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|a| a.as_str())
            .map(|a| {
                if old_root.join(a).exists() {
                    serde_json::Value::String(format!(
                        "${{PLUGIN_ROOT}}/{}",
                        a.trim_start_matches("./")
                    ))
                } else {
                    serde_json::Value::String(a.to_owned())
                }
            })
            .collect();
        let mut server = serde_json::json!({ "type": "stdio", "command": rel(cmd), "args": args });
        if let Some(env) = s.get("env").and_then(serde_json::Value::as_object)
            && !env.is_empty()
        {
            server["env"] = serde_json::Value::Object(env.clone());
        }
        servers.insert(sid.to_owned(), server);
    }

    // 搬目录。目标已存在（用户已经装了插件版）就只删旧的。
    let new_root = riot_kernel::config::plugin_dir(config_path, id);
    if new_root.exists() {
        let _ = std::fs::remove_dir_all(old_root);
    } else {
        std::fs::create_dir_all(new_root.parent().unwrap_or(Path::new(".")))
            .map_err(|e| e.to_string())?;
        std::fs::rename(old_root, &new_root).map_err(|e| e.to_string())?;
        std::fs::write(
            new_root.join("plugin.json"),
            format!(
                "{}\n",
                serde_json::to_string_pretty(&manifest).unwrap_or_default()
            ),
        )
        .map_err(|e| e.to_string())?;
        if !servers.is_empty() {
            std::fs::write(
                new_root.join("mcp.json"),
                format!(
                    "{}\n",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
                        "mcpServers": serde_json::Value::Object(servers),
                    }))
                    .unwrap_or_default()
                ),
            )
            .map_err(|e| e.to_string())?;
        }
        let _ = std::fs::remove_file(new_root.join("pack.json"));
    }

    if !config.plugins.iter().any(|p| p.id == id) {
        config.plugins.push(PluginEntry {
            id: id.to_owned(),
            enabled: true,
            version,
            source: PluginSource::Legacy,
            marketplace: Some(riot_kernel::config::OFFICIAL_MARKETPLACE.to_owned()),
            linked_path: None,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, rel: &str, body: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().expect("有父目录")).expect("建目录");
        std::fs::write(p, body).expect("写");
    }

    #[test]
    fn 旧能力包迁成插件_清单_mcp_数据目录_配置条目() {
        let t = tempfile::tempdir().expect("临时目录");
        let config_path = t.path().join("riot/config.json");
        std::fs::create_dir_all(config_path.parent().unwrap()).expect("建目录");
        let packs = riot_kernel::config::legacy_packs_dir(&config_path);
        let old = packs.join("doc-runtime");
        write(&old, "bin/node", "#!/bin/sh\n");
        write(&old, "path/soffice", "#!/bin/sh\n");
        write(&old, "node/server.mjs", "//");
        write(
            &old,
            "skills/documents/SKILL.md",
            "---\ndescription: d\n---\nx\n",
        );
        write(
            &old,
            "pack.json",
            &serde_json::json!({
                "name": "doc-runtime",
                "version": "0.1.0",
                "platform": kp::platform_key(),
                "env": { "RUNTIME_BIN_DIR": "bin" },
                "pathPrepend": ["path"],
                "selfCheck": [{ "command": "bin/node", "args": ["-v"] }],
                "mcpServers": [{ "id": "doc-artifact-tool", "command": "bin/node", "args": ["node/server.mjs", "--stdio"] }],
                "skills": ["documents"],
            })
            .to_string(),
        );
        write(&packs.join(".data/doc-runtime"), "state.json", "{}");

        let mut config = AppConfig::default();
        // 旧 sync_mcp 写进配置的那条要被摘掉。
        config
            .mcp_servers
            .push(riot_kernel::config::McpServerConfig {
                id: "doc-artifact-tool".into(),
                name: "doc-runtime".into(),
                command: old.join("bin/node").display().to_string(),
                args: vec![],
                env: Default::default(),
                enabled: true,
            });

        assert!(
            migrate_legacy_packs(&mut config, &config_path),
            "该报告改动"
        );

        let new_root = riot_kernel::config::plugin_dir(&config_path, "doc-runtime");
        assert!(new_root.join("plugin.json").is_file(), "要补标准清单");
        assert!(new_root.join("mcp.json").is_file());
        assert!(!new_root.join("pack.json").exists(), "旧清单不留");
        assert!(!old.exists(), "旧目录挪走了");
        assert!(
            data_root(&config_path)
                .join("doc-runtime/state.json")
                .is_file(),
            "数据目录跟着走"
        );
        assert!(config.mcp_servers.is_empty(), "旧的自动注册条目要摘掉");
        assert_eq!(config.plugins.len(), 1);
        assert_eq!(config.plugins[0].id, "doc-runtime");
        assert!(matches!(config.plugins[0].source, PluginSource::Legacy));

        // 迁出来的东西要能被加载器读懂，且组件齐全。
        let loaded = kp::load(&new_root, &data_root(&config_path)).expect("能读");
        // 路径比对用 canonicalize 过的根（macOS 的 /var → /private/var）。
        let new_root = loaded.root.clone();
        assert_eq!(loaded.skill_dirs.len(), 1);
        assert_eq!(loaded.mcp_servers.len(), 1);
        let McpTransport::Stdio { command, args, .. } = &loaded.mcp_servers[0].transport else {
            panic!("stdio");
        };
        assert_eq!(Path::new(command), new_root.join("bin/node"));
        assert_eq!(
            Path::new(&args[0]),
            new_root.join("node/server.mjs"),
            "存在的相对路径展开成绝对"
        );
        assert_eq!(args[1], "--stdio", "不是路径的参数原样");
        assert_eq!(
            loaded.runtime.path_dirs,
            vec![new_root.join("bin"), new_root.join("path")]
        );
        assert!(
            loaded
                .runtime
                .env
                .iter()
                .any(|(k, v)| k == "RUNTIME_BIN_DIR" && Path::new(v) == new_root.join("bin"))
        );
        assert_eq!(loaded.self_checks.len(), 1);
        assert!(loaded.platform_ok);

        // 再跑一次什么都不做。
        assert!(!migrate_legacy_packs(&mut config, &config_path));

        // 派生的 MCP 服务器 id 带插件前缀。
        let specs = mcp_specs(&config, &config_path);
        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].id, "doc-runtime--doc-artifact-tool");
    }

    #[test]
    fn 组件清单按对外名字列() {
        let t = tempfile::tempdir().expect("临时目录");
        let root = t.path().join("p");
        write(
            &root,
            ".claude-plugin/plugin.json",
            r#"{ "name": "acme", "version": "1.0.0", "hooks": { "PostToolUse": [ { "matcher": "Write", "hooks": [ { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/x.sh" } ] } ] } }"#,
        );
        write(
            &root,
            "skills/review/SKILL.md",
            "---\ndescription: d\n---\nx\n",
        );
        write(&root, "commands/deploy.md", "deploy");
        write(
            &root,
            ".mcp.json",
            r#"{ "mcpServers": { "db": { "command": "npx", "args": ["x"] } } }"#,
        );
        let loaded = kp::load(&root, &t.path().join("data")).expect("能读");
        let c = components_of(&loaded);
        assert_eq!(c.skills, vec!["acme:review"]);
        assert_eq!(c.commands, vec!["acme:deploy"]);
        assert_eq!(c.hooks.len(), 1);
        assert!(
            c.hooks[0].command.ends_with("/x.sh"),
            "hook 命令展开了插件根：{}",
            c.hooks[0].command
        );
        assert_eq!(c.mcp_servers[0].id, "acme--db");
        assert_eq!(c.mcp_servers[0].transport, "stdio");
    }

    #[test]
    fn 升级请求按来源推() {
        let git = PluginEntry {
            id: "a".into(),
            enabled: true,
            version: "1".into(),
            source: PluginSource::Git {
                url: "https://x/y.git".into(),
                git_ref: None,
                subdir: None,
                commit: None,
            },
            marketplace: None,
            linked_path: None,
        };
        assert!(matches!(
            update_request(&git),
            Some(SourceRequest::Git { .. })
        ));
        let linked = PluginEntry {
            source: PluginSource::Local,
            linked_path: Some("/x".into()),
            ..git.clone()
        };
        assert!(update_request(&linked).is_none(), "链接的没有升级这回事");
        let market = PluginEntry {
            marketplace: Some("riot".into()),
            source: PluginSource::Legacy,
            ..git
        };
        assert!(
            matches!(update_request(&market), Some(SourceRequest::Market { .. })),
            "有市场就按市场条目"
        );
    }
}
