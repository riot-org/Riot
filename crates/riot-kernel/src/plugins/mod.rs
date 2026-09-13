//! 插件：把技能、斜杠命令、hooks、MCP 服务器、PATH 里的可执行文件打成
//! 一个可安装、可启停、可升级的目录。
//!
//! # 为什么不自造格式
//!
//! 生态的成本在开发者那边：每多一种格式，他就得多维护一份拷贝。所以 Riot
//! **读现成的三种**（Agent Plugins 开放标准、Claude Code、Cursor），自己
//! 的额外能力放在标准规定的扩展命名空间 `dev.riot` 下。一个已经为 CC 或
//! Cursor 写好的插件，零改造装进 Riot。清单的三种形态见 [`manifest`]。
//!
//! # 这里只做"读"
//!
//! 下载、解压、注册表、启停都在宿主（`src-tauri/src/plugins`）。内核每轮
//! 从宿主拿到"哪些插件目录生效"（[`riot_protocol::PluginRef`]），在这里
//! 读出组件；宿主装插件时也用这一份加载器做校验和预览 —— 两边看到的必须
//! 是同一个解释，否则"安装时说没问题、用起来却不生效"没人查得出来。
//!
//! # 固定位置
//!
//! ```text
//! <插件根>/
//!   plugin.json                        标准清单（或 .claude-plugin/ 与 .cursor-plugin/ 下的）
//!   skills/<名>/SKILL.md               技能（三家同构）
//!   commands/**/*.md                   斜杠命令（CC / Cursor）
//!   hooks/hooks.json                   hooks（CC / Cursor）
//!   dev.riot/hooks/hooks.json          hooks（标准插件的扩展目录）
//!   mcp.json | .mcp.json               MCP 服务器
//!   bin/                               进 Bash 的 PATH（CC 同款）
//!   agents/ rules/                     暂不支持，报告给设置页
//! ```
//!
//! 每一条路径解析后都必须仍在插件根内（[`paths::contain`]）。
//!
//! # 命名空间
//!
//! 插件的技能和命令一律加 `<插件>:` 前缀（和 CC 一致）。两个插件带同名
//! 技能是常态（都叫 `review`），不加前缀的话先装的赢、后装的静默消失。
//!
//! 豁免理由：宿主层，读的是用户装到本机的插件目录。

#![allow(clippy::disallowed_methods)]

pub mod manifest;
pub mod mcp;
pub mod paths;

use std::path::{Path, PathBuf};

use riot_protocol::text::UiError;
use riot_protocol::turn::PluginRef;
use riot_protocol::ui_error;
use serde::Serialize;
use serde_json::Value;

pub use manifest::{Fatal, Format, Meta};
pub use mcp::McpServer;
pub use paths::Vars;

/// Riot 的扩展命名空间（Agent Plugins §8）。反写的是应用标识 `dev.riot.desktop`
/// 的域。既是 `plugin.json` 里 `extensions` 的键，也是同名顶层目录。
pub const NAMESPACE: &str = "dev.riot";

/// 当前平台在插件清单里的键。必须和构建脚本产出的一致。
pub fn platform_key() -> String {
    let os = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    };
    format!("{os}-{arch}")
}

/// 一份 hooks 配置的来源：文件或清单内联。`value` 是原始 JSON，
/// 占位符展开和解析在 `hooks` 模块里做（那里知道 HooksFile 的形状）。
#[derive(Debug, Clone)]
pub struct HooksSource {
    /// 文件路径；内联的给清单路径。
    pub path: PathBuf,
    pub value: Value,
}

/// 注入给工具子进程的东西：环境变量 + 拼到 PATH 前面的目录。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Runtime {
    pub env: Vec<(String, String)>,
    pub path_dirs: Vec<PathBuf>,
}

/// 装完要实跑一遍的命令（`dev.riot` 扩展的 `selfCheck`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SelfCheck {
    /// 解析后的绝对路径，或裸命令名。
    pub command: String,
    pub args: Vec<String>,
}

/// 出现了、但 Riot 这一版不支持的组件。设置页要列出来 —— 静默丢掉的话，
/// 开发者只会觉得"我的 agents 怎么没生效"。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Unsupported {
    /// `agents` / `rules` / `lspServers` / `hookEvent:SessionStart` …
    pub component: String,
    /// 数量或具体项，给人看。
    pub detail: String,
}

/// 加载过程中的非致命问题。
#[derive(Debug, Clone)]
pub struct Problem {
    pub path: PathBuf,
    pub reason: UiError,
}

/// 一个读完的插件。组件都是路径或已解析好的结构，交给各自的发现层去用。
#[derive(Debug, Clone)]
pub struct Loaded {
    pub id: String,
    /// canonicalize 过的根。
    pub root: PathBuf,
    pub vars: Vars,
    pub format: Format,
    pub meta: Meta,
    /// 每个元素是一个含 `SKILL.md` 的技能目录。
    pub skill_dirs: Vec<PathBuf>,
    /// 命令目录（整棵扫，子目录是命名空间）。
    pub command_dirs: Vec<PathBuf>,
    /// 单个命令文件（CC 清单里可以逐个指定）。
    pub command_files: Vec<PathBuf>,
    pub hooks: Vec<HooksSource>,
    pub mcp_servers: Vec<McpServer>,
    pub runtime: Runtime,
    pub self_checks: Vec<SelfCheck>,
    /// `dev.riot.platforms` 声明了平台、且当前平台不在其中 → false。
    /// 这时组件照常读出来给设置页看，但不该被激活（调用方判）。
    pub platform_ok: bool,
    pub problems: Vec<Problem>,
    pub unsupported: Vec<Unsupported>,
}

impl Loaded {
    /// 展示名：`displayName` > `name`。
    pub fn title(&self) -> &str {
        self.meta.display_name.as_deref().unwrap_or(&self.meta.name)
    }
}

/// 数据目录的根：`<配置目录>/plugin-data/`。每个插件一个子目录，跨升级保留。
///
/// 不放在插件目录**里面**：升级是整目录替换，放里面就一起没了；也不放
/// `plugins/` 下面：那里一个子目录就是一个插件，多一个 `.data` 会被当成
/// 半个插件扫到。
pub fn data_root(config_path: &Path) -> PathBuf {
    config_path
        .parent()
        .unwrap_or(Path::new("."))
        .join("plugin-data")
}

/// 读一个插件目录。清单坏了整个拒绝（[`Fatal`]）；组件坏了逐个报告。
pub fn load(root: &Path, data_root: &Path) -> Result<Loaded, Fatal> {
    let canon = paths::canonical(root).map_err(|e| Fatal {
        path: root.to_path_buf(),
        reason: ui_error!("kernel.plugin.pathUnreadable", path = root.display().to_string(); e),
    })?;
    let m = manifest::read(&canon, NAMESPACE)?;
    let id = m.meta.name.clone();
    let vars = Vars {
        root: canon.clone(),
        data: data_root.join(&id),
    };

    let mut problems: Vec<Problem> = m
        .problems
        .iter()
        .map(|(path, reason)| Problem {
            path: path.clone(),
            reason: reason.clone(),
        })
        .collect();
    let mut unsupported: Vec<Unsupported> = m
        .overrides
        .unsupported
        .iter()
        .map(|c| Unsupported {
            component: c.clone(),
            detail: String::new(),
        })
        .collect();

    // ── 技能 ────────────────────────────────────────────
    let mut skill_roots: Vec<PathBuf> = Vec::new();
    push_fixed_dir(&canon, "skills", &mut skill_roots, &mut problems);
    for rel in &m.overrides.skills {
        push_contained_dir(&vars, rel, &mut skill_roots, &mut problems);
    }
    let mut skill_dirs = Vec::new();
    for skills in skill_roots {
        let Ok(rd) = std::fs::read_dir(&skills) else {
            continue;
        };
        let mut entries: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
        entries.sort();
        for entry in entries {
            let md = entry.join("SKILL.md");
            if !md.is_file() {
                continue;
            }
            // 规范 §7.1：SKILL.md 解析后逃出根的跳过。
            match paths::contain(&canon, &md.display().to_string()) {
                Ok(_) => skill_dirs.push(entry),
                Err(reason) => problems.push(Problem { path: md, reason }),
            }
        }
    }

    // ── 命令（CC / Cursor 的 commands/）───────────────────
    let mut command_dirs = Vec::new();
    let mut command_files = Vec::new();
    push_fixed_dir(&canon, "commands", &mut command_dirs, &mut problems);
    for rel in &m.overrides.commands {
        match paths::contain(&canon, rel) {
            Ok(p) if p.is_dir() => command_dirs.push(p),
            Ok(p) if p.is_file() => command_files.push(p),
            Ok(p) => problems.push(Problem {
                path: p,
                reason: ui_error!("kernel.plugin.componentNotFound", path = rel),
            }),
            Err(reason) => problems.push(Problem {
                path: canon.join(rel),
                reason,
            }),
        }
    }

    // ── hooks ───────────────────────────────────────────
    let mut hooks = Vec::new();
    for fixed in ["hooks/hooks.json", &format!("{NAMESPACE}/hooks/hooks.json")] {
        let p = canon.join(fixed);
        if p.is_file() {
            read_hooks_file(&canon, &p, &mut hooks, &mut problems);
        }
    }
    for rel in &m.overrides.hooks_paths {
        match paths::contain(&canon, rel) {
            Ok(p) => read_hooks_file(&canon, &p, &mut hooks, &mut problems),
            Err(reason) => problems.push(Problem {
                path: canon.join(rel),
                reason,
            }),
        }
    }
    let manifest_path = canon.join(m.format.manifest_path());
    for inline in &m.overrides.hooks_inline {
        hooks.push(HooksSource {
            path: manifest_path.clone(),
            value: inline.clone(),
        });
    }
    // 用到了我们没有的事件？报出来。四个支持的以外全算。
    for h in &hooks {
        let table = h.value.get("hooks").unwrap_or(&h.value);
        if let Some(obj) = table.as_object() {
            for event in obj.keys() {
                if !matches!(
                    event.as_str(),
                    "PreToolUse" | "PostToolUse" | "Stop" | "UserPromptSubmit"
                ) {
                    unsupported.push(Unsupported {
                        component: format!("hookEvent:{event}"),
                        detail: h.path.display().to_string(),
                    });
                }
            }
        }
    }

    // ── MCP ─────────────────────────────────────────────
    let mut mcp_servers = Vec::new();
    let plugin_schema_version = std::fs::read_to_string(canon.join("plugin.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|v| v.get("$schema").and_then(Value::as_str).map(str::to_owned))
        .and_then(|s| manifest::schema_version(&s, "plugin.schema.json").map(str::to_owned));
    let mut mcp_problems: Vec<(PathBuf, UiError)> = Vec::new();
    for fixed in ["mcp.json", ".mcp.json"] {
        let p = canon.join(fixed);
        if !p.is_file() {
            continue;
        }
        match read_json(&p) {
            Ok(v) => mcp_servers.extend(mcp::parse(
                &v,
                &vars,
                &p,
                plugin_schema_version.as_deref(),
                &mut mcp_problems,
            )),
            Err(reason) => mcp_problems.push((p, reason)),
        }
    }
    for rel in &m.overrides.mcp_paths {
        match paths::contain(&canon, rel) {
            Ok(p) => match read_json(&p) {
                Ok(v) => mcp_servers.extend(mcp::parse(
                    &v,
                    &vars,
                    &p,
                    plugin_schema_version.as_deref(),
                    &mut mcp_problems,
                )),
                Err(reason) => mcp_problems.push((p, reason)),
            },
            Err(reason) => mcp_problems.push((canon.join(rel), reason)),
        }
    }
    for inline in &m.overrides.mcp_inline {
        mcp_servers.extend(mcp::parse(
            inline,
            &vars,
            &manifest_path,
            plugin_schema_version.as_deref(),
            &mut mcp_problems,
        ));
    }
    problems.extend(
        mcp_problems
            .into_iter()
            .map(|(path, reason)| Problem { path, reason }),
    );
    // 同名服务器（两份配置都写了）只留第一份。
    {
        let mut seen = std::collections::HashSet::new();
        mcp_servers.retain(|s| seen.insert(s.name.clone()));
    }

    // ── 不支持的目录 ─────────────────────────────────────
    for (dir, what) in [("agents", "agents"), ("rules", "rules")] {
        let p = canon.join(dir);
        let n = count_files(&p, |name| name.ends_with(".md") || name.ends_with(".mdc"));
        let declared = match what {
            "agents" => !m.overrides.agents.is_empty(),
            _ => !m.overrides.rules.is_empty(),
        };
        if n > 0 || declared {
            unsupported.push(Unsupported {
                component: what.to_owned(),
                detail: n.to_string(),
            });
        }
    }
    for fixed in [".lsp.json", "settings.json", "monitors/monitors.json"] {
        if canon.join(fixed).is_file() {
            unsupported.push(Unsupported {
                component: fixed.to_owned(),
                detail: String::new(),
            });
        }
    }

    // ── 运行时：bin/ + dev.riot 扩展 ─────────────────────
    let mut runtime = Runtime::default();
    let mut self_checks = Vec::new();
    let mut platform_ok = true;
    let bin = canon.join("bin");
    if bin.is_dir() {
        runtime.path_dirs.push(bin);
    }
    let ext = m
        .riot_ext
        .clone()
        .or_else(|| read_json(&canon.join(NAMESPACE).join("riot.json")).ok());
    if let Some(ext) = ext {
        read_extension(
            &ext,
            &vars,
            &manifest_path,
            &mut runtime,
            &mut self_checks,
            &mut platform_ok,
            &mut problems,
        );
    }

    Ok(Loaded {
        id,
        root: canon,
        vars,
        format: m.format,
        meta: m.meta,
        skill_dirs,
        command_dirs,
        command_files,
        hooks,
        mcp_servers,
        runtime,
        self_checks,
        platform_ok,
        problems,
        unsupported,
    })
}

/// 按宿主给的清单读全部生效插件。清单坏的整个跳过（记日志）；不支持
/// 当前平台的也跳过 —— 它的技能会让模型去调一个不存在的运行时。
pub fn load_all(refs: &[PluginRef], data_root: &Path) -> Vec<Loaded> {
    let mut out = Vec::new();
    for r in refs {
        match load(&r.root, data_root) {
            Ok(p) if !p.platform_ok => {
                tracing::debug!(plugin = %r.id, "插件不支持当前平台，本轮不激活");
            }
            Ok(mut p) => {
                // 宿主登记的 id 和清单里的名字对不上：多半是用户改了目录里
                // 的清单。按登记的 id 走（权限规则、命名空间都按它存的）。
                if p.id != r.id {
                    tracing::warn!(registered = %r.id, manifest = %p.id, "插件 id 与清单不一致，按登记的走");
                    p.id = r.id.clone();
                }
                out.push(p);
            }
            Err(f) => {
                tracing::warn!(plugin = %r.id, path = %f.path.display(), reason = %f.reason, "插件清单读不了，跳过");
            }
        }
    }
    out
}

/// 全部生效插件合起来注入给工具子进程的环境。顺序按插件 id（`refs` 已排好）。
pub fn runtime_of(plugins: &[Loaded]) -> Runtime {
    let mut rt = Runtime::default();
    for p in plugins {
        for (k, v) in &p.runtime.env {
            // 先到先得：两个插件都设同一个变量时，id 排前面的赢，且可预期。
            if !rt.env.iter().any(|(ek, _)| ek == k) {
                rt.env.push((k.clone(), v.clone()));
            }
        }
        rt.path_dirs.extend(p.runtime.path_dirs.iter().cloned());
    }
    rt
}

fn read_json(path: &Path) -> Result<Value, UiError> {
    let raw =
        std::fs::read_to_string(path).map_err(|e| ui_error!("kernel.config.unreadable"; e))?;
    serde_json::from_str(&raw).map_err(|e| ui_error!("kernel.plugin.badJson"; e))
}

fn read_hooks_file(
    root: &Path,
    path: &Path,
    out: &mut Vec<HooksSource>,
    problems: &mut Vec<Problem>,
) {
    // 文件本身也要在根内（清单里的 hooks 路径可能是个 symlink）。
    if let Err(reason) = paths::contain(root, &path.display().to_string()) {
        problems.push(Problem {
            path: path.to_path_buf(),
            reason,
        });
        return;
    }
    match read_json(path) {
        Ok(value) => out.push(HooksSource {
            path: path.to_path_buf(),
            value,
        }),
        Err(reason) => problems.push(Problem {
            path: path.to_path_buf(),
            reason,
        }),
    }
}

/// 固定位置的目录：不存在不是错；存在但不是目录要报（规范 §6.2）。
fn push_fixed_dir(root: &Path, name: &str, out: &mut Vec<PathBuf>, problems: &mut Vec<Problem>) {
    let p = root.join(name);
    if !p.exists() {
        return;
    }
    match paths::contain(root, name) {
        Ok(resolved) if resolved.is_dir() => out.push(resolved),
        Ok(resolved) => problems.push(Problem {
            path: resolved,
            reason: ui_error!("kernel.plugin.componentNotDir", path = name),
        }),
        Err(reason) => problems.push(Problem { path: p, reason }),
    }
}

fn push_contained_dir(vars: &Vars, rel: &str, out: &mut Vec<PathBuf>, problems: &mut Vec<Problem>) {
    match paths::contain(&vars.root, &vars.expand(rel)) {
        Ok(p) if p.is_dir() => out.push(p),
        Ok(p) => problems.push(Problem {
            path: p,
            reason: ui_error!("kernel.plugin.componentNotDir", path = rel),
        }),
        Err(reason) => problems.push(Problem {
            path: vars.root.join(rel),
            reason,
        }),
    }
}

fn count_files(dir: &Path, pred: impl Fn(&str) -> bool) -> usize {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return 0;
    };
    rd.flatten()
        .filter(|e| {
            e.file_name()
                .to_str()
                .is_some_and(|n| pred(n) && e.path().is_file())
        })
        .count()
}

/// `dev.riot` 扩展：
///
/// ```json
/// {
///   "platforms": ["darwin-arm64", "win-x64"],
///   "env": { "RUNTIME_BIN_DIR": "${PLUGIN_ROOT}/bin" },
///   "pathPrepend": ["./path"],
///   "selfCheck": [{ "command": "./bin/python3", "args": ["-c", "import docx"] }]
/// }
/// ```
///
/// `env` 的值展开占位符；`./` 开头的按插件根解析。`pathPrepend` 必须在根内。
/// `selfCheck` 的 `command` 同 MCP 的规则：包内路径做包含检查，裸名走 PATH。
fn read_extension(
    ext: &Value,
    vars: &Vars,
    manifest_path: &Path,
    runtime: &mut Runtime,
    self_checks: &mut Vec<SelfCheck>,
    platform_ok: &mut bool,
    problems: &mut Vec<Problem>,
) {
    let Some(obj) = ext.as_object() else {
        problems.push(Problem {
            path: manifest_path.to_path_buf(),
            reason: ui_error!("kernel.plugin.extInvalid"; "extension data is not an object"),
        });
        return;
    };
    fn bad(problems: &mut Vec<Problem>, manifest_path: &Path, detail: String) {
        problems.push(Problem {
            path: manifest_path.to_path_buf(),
            reason: ui_error!("kernel.plugin.extInvalid"; detail),
        });
    }

    if let Some(v) = obj.get("platforms") {
        match v.as_array() {
            Some(list) => {
                let here = platform_key();
                let names: Vec<&str> = list.iter().filter_map(Value::as_str).collect();
                if !names.is_empty() && !names.contains(&here.as_str()) {
                    *platform_ok = false;
                }
            }
            None => bad(
                problems,
                manifest_path,
                "`platforms` must be an array".into(),
            ),
        }
    }

    if let Some(v) = obj.get("env") {
        match v.as_object() {
            Some(map) => {
                let mut keys: Vec<&String> = map.keys().collect();
                keys.sort();
                for k in keys {
                    if paths::is_reserved_env(k) {
                        bad(problems, manifest_path, format!("`env.{k}` is reserved"));
                        continue;
                    }
                    let Some(raw) = map[k].as_str() else {
                        bad(
                            problems,
                            manifest_path,
                            format!("`env.{k}` must be a string"),
                        );
                        continue;
                    };
                    let expanded = vars.expand(raw);
                    let value = if let Some(rel) = expanded.strip_prefix("./") {
                        match paths::contain(&vars.root, rel) {
                            Ok(p) => p.display().to_string(),
                            Err(reason) => {
                                problems.push(Problem {
                                    path: manifest_path.to_path_buf(),
                                    reason,
                                });
                                continue;
                            }
                        }
                    } else {
                        expanded
                    };
                    runtime.env.push((k.clone(), value));
                }
            }
            None => bad(problems, manifest_path, "`env` must be an object".into()),
        }
    }

    if let Some(v) = obj.get("pathPrepend") {
        match v.as_array() {
            Some(list) => {
                for item in list {
                    let Some(rel) = item.as_str() else {
                        bad(
                            problems,
                            manifest_path,
                            "`pathPrepend` entries must be strings".into(),
                        );
                        continue;
                    };
                    match paths::contain(&vars.root, &vars.expand(rel)) {
                        Ok(p) if p.is_dir() => runtime.path_dirs.push(p),
                        Ok(_) => problems.push(Problem {
                            path: manifest_path.to_path_buf(),
                            reason: ui_error!("kernel.plugin.componentNotDir", path = rel),
                        }),
                        Err(reason) => problems.push(Problem {
                            path: manifest_path.to_path_buf(),
                            reason,
                        }),
                    }
                }
            }
            None => bad(
                problems,
                manifest_path,
                "`pathPrepend` must be an array".into(),
            ),
        }
    }

    if let Some(v) = obj.get("selfCheck") {
        match v.as_array() {
            Some(list) => {
                for item in list {
                    let Some(cmd) = item.get("command").and_then(Value::as_str) else {
                        bad(
                            problems,
                            manifest_path,
                            "`selfCheck[].command` is required".into(),
                        );
                        continue;
                    };
                    let cmd = vars.expand(cmd);
                    let looks_like_path =
                        cmd.contains('/') || cmd.contains('\\') || cmd.starts_with('.');
                    let command = if looks_like_path {
                        match paths::contain(&vars.root, &cmd) {
                            Ok(p) => p.display().to_string(),
                            Err(reason) => {
                                problems.push(Problem {
                                    path: manifest_path.to_path_buf(),
                                    reason,
                                });
                                continue;
                            }
                        }
                    } else {
                        cmd
                    };
                    let args = item
                        .get("args")
                        .and_then(Value::as_array)
                        .map(|a| {
                            a.iter()
                                .filter_map(Value::as_str)
                                .map(|s| vars.expand(s))
                                .collect()
                        })
                        .unwrap_or_default();
                    self_checks.push(SelfCheck { command, args });
                }
            }
            None => bad(
                problems,
                manifest_path,
                "`selfCheck` must be an array".into(),
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, rel: &str, body: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().expect("有父目录")).expect("建目录");
        std::fs::write(p, body).expect("写");
    }

    fn standard_manifest(name: &str, extra: &str) -> String {
        format!(
            r#"{{ "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", "name": "{name}", "version": "1.0.0"{extra} }}"#
        )
    }

    /// 铺一个"什么都有"的标准插件。
    fn full_plugin(t: &tempfile::TempDir) -> PathBuf {
        let root = t.path().join("full");
        write(
            &root,
            "plugin.json",
            &standard_manifest(
                "full",
                r#", "extensions": { "dev.riot": {
                    "env": { "RUNTIME_BIN_DIR": "./bin", "GREETING": "hi ${PLUGIN_DATA}" },
                    "pathPrepend": ["./path"],
                    "selfCheck": [{ "command": "./bin/tool", "args": ["--version"] }]
                } }"#,
            ),
        );
        write(
            &root,
            "skills/alpha/SKILL.md",
            "---\nname: alpha\ndescription: a\n---\n正文\n",
        );
        write(
            &root,
            "skills/beta/SKILL.md",
            "---\ndescription: b\n---\n正文\n",
        );
        write(&root, "skills/not-a-skill/README.md", "x");
        write(&root, "commands/deploy.md", "部署 $ARGUMENTS");
        write(&root, "commands/git/pr.md", "PR");
        write(
            &root,
            "hooks/hooks.json",
            r#"{ "PostToolUse": [ { "matcher": "Write", "hooks": [ { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/bin/tool" } ] } ], "SessionStart": [] }"#,
        );
        write(
            &root,
            "mcp.json",
            r#"{ "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
                 "mcpServers": { "srv": { "type": "stdio", "command": "./bin/tool", "args": ["serve"] } } }"#,
        );
        write(&root, "bin/tool", "#!/bin/sh\n");
        std::fs::create_dir_all(root.join("path")).expect("建 path");
        write(&root, "agents/reviewer.md", "---\nname: reviewer\n---\n");
        root
    }

    #[test]
    fn 标准插件_全部组件都读出来() {
        let t = tempfile::tempdir().expect("临时目录");
        let root = full_plugin(&t);
        let data = t.path().join("data");
        let p = load(&root, &data).expect("该能读");

        assert_eq!(p.id, "full");
        assert_eq!(p.format, Format::AgentPlugins);
        assert!(
            p.problems.is_empty(),
            "{:?}",
            p.problems
                .iter()
                .map(|x| x.reason.to_string())
                .collect::<Vec<_>>()
        );

        // 技能：只认直接子目录里的 SKILL.md。
        let names: Vec<_> = p
            .skill_dirs
            .iter()
            .map(|d| d.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["alpha", "beta"]);

        assert_eq!(p.command_dirs.len(), 1);
        assert_eq!(p.hooks.len(), 1);
        assert_eq!(p.mcp_servers.len(), 1);
        assert_eq!(p.mcp_servers[0].name, "srv");

        // 运行时：bin/ 自动进 PATH，扩展里的 pathPrepend 也进；env 解析 `./`。
        assert_eq!(
            p.runtime.path_dirs,
            vec![p.root.join("bin"), p.root.join("path")]
        );
        let env: std::collections::HashMap<_, _> = p.runtime.env.iter().cloned().collect();
        assert_eq!(
            env["RUNTIME_BIN_DIR"],
            p.root.join("bin").display().to_string()
        );
        assert_eq!(
            env["GREETING"],
            format!("hi {}", data.join("full").display())
        );
        assert_eq!(p.self_checks.len(), 1);
        assert_eq!(
            Path::new(&p.self_checks[0].command),
            p.root.join("bin/tool")
        );

        // 不支持的要报出来，不能静默：agents 目录、SessionStart 事件。
        let comps: Vec<&str> = p.unsupported.iter().map(|u| u.component.as_str()).collect();
        assert!(comps.contains(&"agents"), "{comps:?}");
        assert!(comps.contains(&"hookEvent:SessionStart"), "{comps:?}");
        assert!(p.platform_ok);
    }

    #[test]
    fn cc_插件_固定位置与清单覆盖() {
        let t = tempfile::tempdir().expect("临时目录");
        let root = t.path().join("cc");
        write(
            &root,
            ".claude-plugin/plugin.json",
            r#"{ "name": "cc", "version": "0.1.0",
                 "skills": "./custom/skills",
                 "commands": ["./custom/one.md"],
                 "mcpServers": { "inline": { "command": "npx", "args": ["-y", "x"] } } }"#,
        );
        write(
            &root,
            "skills/default/SKILL.md",
            "---\ndescription: d\n---\nx\n",
        );
        write(
            &root,
            "custom/skills/extra/SKILL.md",
            "---\ndescription: e\n---\nx\n",
        );
        write(&root, "custom/one.md", "one");
        write(
            &root,
            ".mcp.json",
            r#"{ "mcpServers": { "file": { "command": "uvx", "args": ["y"] } } }"#,
        );

        let p = load(&root, &t.path().join("data")).expect("该能读");
        assert_eq!(p.format, Format::ClaudeCode);
        assert_eq!(p.skill_dirs.len(), 2, "固定位置 + 覆盖位置都扫");
        assert_eq!(p.command_files.len(), 1);
        let names: Vec<_> = p.mcp_servers.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["file", "inline"], ".mcp.json 和内联的都要");
        assert!(
            p.problems.is_empty(),
            "{:?}",
            p.problems
                .iter()
                .map(|x| x.reason.to_string())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn 平台不匹配的插件_load_all_跳过() {
        let t = tempfile::tempdir().expect("临时目录");
        let root = t.path().join("other-os");
        write(
            &root,
            "plugin.json",
            &standard_manifest(
                "other-os",
                r#", "extensions": { "dev.riot": { "platforms": ["nonexistent-cpu"] } }"#,
            ),
        );
        let p = load(&root, &t.path().join("data")).expect("能读");
        assert!(!p.platform_ok);

        let all = load_all(
            &[PluginRef {
                id: "other-os".into(),
                root: root.clone(),
            }],
            &t.path().join("data"),
        );
        assert!(all.is_empty(), "不支持当前平台的不激活");
    }

    #[test]
    fn 坏清单的插件_load_all_跳过其它照常() {
        let t = tempfile::tempdir().expect("临时目录");
        let good = t.path().join("good");
        write(&good, "plugin.json", &standard_manifest("good", ""));
        let bad = t.path().join("bad");
        write(&bad, "plugin.json", "{ 不是 json");

        let all = load_all(
            &[
                PluginRef {
                    id: "bad".into(),
                    root: bad,
                },
                PluginRef {
                    id: "good".into(),
                    root: good,
                },
            ],
            &t.path().join("data"),
        );
        assert_eq!(
            all.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            vec!["good"]
        );
    }

    #[test]
    fn 逃出根的组件路径被报告而不是加载() {
        let t = tempfile::tempdir().expect("临时目录");
        let root = t.path().join("esc");
        write(
            &root,
            ".claude-plugin/plugin.json",
            r#"{ "name": "esc", "skills": "../outside" }"#,
        );
        std::fs::create_dir_all(t.path().join("outside/s")).expect("建目录");
        write(
            t.path(),
            "outside/s/SKILL.md",
            "---\ndescription: d\n---\nx\n",
        );

        let p = load(&root, &t.path().join("data")).expect("能读");
        assert!(p.skill_dirs.is_empty(), "根外的技能一个都不能进");
        assert_eq!(p.problems.len(), 1);
        assert_eq!(p.problems[0].reason.key(), "kernel.plugin.pathEscapes");
    }

    #[test]
    fn 运行时合并_先到先得() {
        let t = tempfile::tempdir().expect("临时目录");
        let mk = |name: &str, val: &str| {
            let root = t.path().join(name);
            write(
                &root,
                "plugin.json",
                &standard_manifest(
                    name,
                    &format!(
                        r#", "extensions": {{ "dev.riot": {{ "env": {{ "SHARED": "{val}" }} }} }}"#
                    ),
                ),
            );
            std::fs::create_dir_all(root.join("bin")).expect("建 bin");
            load(&root, &t.path().join("data")).expect("能读")
        };
        let a = mk("a", "from-a");
        let b = mk("b", "from-b");
        let rt = runtime_of(&[a.clone(), b.clone()]);
        assert_eq!(rt.env, vec![("SHARED".to_owned(), "from-a".to_owned())]);
        assert_eq!(rt.path_dirs, vec![a.root.join("bin"), b.root.join("bin")]);
    }

    #[test]
    fn 平台键在已知集合里() {
        let k = platform_key();
        assert!(
            [
                "darwin-arm64",
                "darwin-x64",
                "win-x64",
                "win-arm64",
                "linux-x64",
                "linux-arm64"
            ]
            .contains(&k.as_str()),
            "平台键 {k} 不在已知集合里"
        );
    }
}
