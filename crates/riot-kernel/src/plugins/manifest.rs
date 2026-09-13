//! 三种插件清单的读取：Agent Plugins 开放标准、Claude Code、Cursor。
//!
//! 三家的**组件**几乎一样（技能、命令、hooks、MCP），差的只是清单放哪、
//! 叫什么、严不严。这里把它们收成一个 [`Manifest`]：身份信息 + 各组件的
//! 自定义位置 + Riot 自己的扩展数据。目录布局的固定位置在 `mod.rs` 里扫，
//! 不在这里。
//!
//! # 三种清单
//!
//! | 格式 | 位置 | 特点 |
//! | --- | --- | --- |
//! | Agent Plugins | `plugin.json` | 闭合 schema：`$schema` 必填，未知字段报告后忽略，其它违规**整个拒绝** |
//! | Claude Code | `.claude-plugin/plugin.json` | 宽松；可用 `skills` / `commands` / `agents` / `hooks` / `mcpServers` 字段改位置或内联 |
//! | Cursor | `.cursor-plugin/plugin.json` | 同 CC，多 `rules` |
//!
//! 一个目录里可以同时有几份（作者为了多客户端兼容会这么做）。身份按
//! 标准 > CC > Cursor 取第一份；组件位置的覆盖从**每一份**里收 —— 标准
//! 清单里没有 hooks / commands 这些概念，作者只能写在 CC 那份里。
//!
//! 豁免理由：宿主层，读的是用户装到本机的插件目录。

#![allow(clippy::disallowed_methods)]

use std::path::{Path, PathBuf};

use riot_protocol::text::UiError;
use riot_protocol::ui_error;
use serde::Serialize;
use serde_json::Value;

/// 标准清单 `$schema` 的前缀。版本段跟在后面：`1.0.0/plugin.schema.json`。
pub const SCHEMA_PREFIX: &str = "https://agent-plugins.org/schemas/";
/// 我们实现的规范主版本。`1.x.y` 都按 1.0.0 的规则读（显式认作兼容）。
const SUPPORTED_MAJOR: &str = "1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Format {
    AgentPlugins,
    ClaudeCode,
    Cursor,
}

impl Format {
    /// 清单相对插件根的位置。
    pub fn manifest_path(self) -> &'static str {
        match self {
            Self::AgentPlugins => "plugin.json",
            Self::ClaudeCode => ".claude-plugin/plugin.json",
            Self::Cursor => ".cursor-plugin/plugin.json",
        }
    }

    /// 检测顺序 = 身份优先级。
    pub const ALL: [Format; 3] = [Self::AgentPlugins, Self::ClaudeCode, Self::Cursor];
}

/// 插件的身份与元数据。设置页展示用；`name` 同时是 id。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keywords: Vec<String>,
}

/// CC / Cursor 清单里可以给的组件位置覆盖。字符串或字符串数组，都相对
/// 插件根；`hooks` / `mcpServers` 还可以直接内联成对象。
#[derive(Debug, Clone, Default)]
pub struct Overrides {
    pub skills: Vec<String>,
    pub commands: Vec<String>,
    pub agents: Vec<String>,
    pub rules: Vec<String>,
    /// 路径（字符串）。
    pub hooks_paths: Vec<String>,
    /// 内联的 hooks 对象。
    pub hooks_inline: Vec<Value>,
    pub mcp_paths: Vec<String>,
    pub mcp_inline: Vec<Value>,
    /// 出现了但 Riot 不支持的顶层组件字段（`lspServers`、`outputStyles`…）。
    pub unsupported: Vec<String>,
}

/// 读出来的全部清单信息。
#[derive(Debug, Clone)]
pub struct Manifest {
    /// 身份取自哪一份。
    pub format: Format,
    pub meta: Meta,
    pub overrides: Overrides,
    /// `extensions["dev.riot"]`（标准）或同名顶层字段（CC / Cursor）的原始值。
    pub riot_ext: Option<Value>,
    /// 非致命问题（未知字段之类）。
    pub problems: Vec<(PathBuf, UiError)>,
}

/// 清单整个不能用的原因。插件不加载任何组件。
#[derive(Debug, Clone)]
pub struct Fatal {
    pub path: PathBuf,
    pub reason: UiError,
}

/// 读一个插件目录里的清单。`root` 已 canonicalize。
pub fn read(root: &Path, ext_namespace: &str) -> Result<Manifest, Fatal> {
    let present: Vec<Format> = Format::ALL
        .into_iter()
        .filter(|f| root.join(f.manifest_path()).is_file())
        .collect();
    let Some(&primary) = present.first() else {
        return Err(Fatal {
            path: root.to_path_buf(),
            reason: ui_error!("kernel.plugin.noManifest"),
        });
    };

    let mut problems = Vec::new();
    let mut overrides = Overrides::default();
    let mut riot_ext = None;
    let mut meta = None;

    for format in present {
        let path = root.join(format.manifest_path());
        let value = load_json(&path).map_err(|reason| Fatal {
            path: path.clone(),
            reason,
        })?;
        let Some(obj) = value.as_object() else {
            return Err(Fatal {
                path,
                reason: ui_error!("kernel.plugin.badField", field = "(root)"),
            });
        };

        // 身份只取第一份；后面的只贡献组件位置。
        if format == primary {
            meta = Some(match format {
                Format::AgentPlugins => read_standard(obj, &path, &mut problems)?,
                Format::ClaudeCode | Format::Cursor => read_loose_meta(obj, &path)?,
            });
        }

        match format {
            Format::AgentPlugins => {
                // 标准清单不允许组件字段；扩展数据在 extensions 下。
                if let Some(ext) = obj.get("extensions").and_then(|e| e.as_object())
                    && let Some(v) = ext.get(ext_namespace)
                {
                    riot_ext = Some(v.clone());
                }
            }
            Format::ClaudeCode | Format::Cursor => {
                collect_overrides(obj, &mut overrides);
                // 给 CC / Cursor 格式的插件也留一个放 Riot 扩展的地方：
                // 同名顶层字段。它们的清单不是闭合 schema，多一个字段无害。
                if riot_ext.is_none() {
                    riot_ext = obj
                        .get("extensions")
                        .and_then(|e| e.get(ext_namespace))
                        .cloned();
                }
            }
        }
    }

    Ok(Manifest {
        format: primary,
        meta: meta.expect("primary 一定被读过"),
        overrides,
        riot_ext,
        problems,
    })
}

fn load_json(path: &Path) -> Result<Value, UiError> {
    let raw =
        std::fs::read_to_string(path).map_err(|e| ui_error!("kernel.config.unreadable"; e))?;
    serde_json::from_str(&raw).map_err(|e| ui_error!("kernel.plugin.badJson"; e))
}

/// 标准清单（规范 §5）。闭合 schema：未知顶层字段报告后忽略；`extensions`
/// 不是对象报告后忽略；其余任何违规都是致命的。
fn read_standard(
    obj: &serde_json::Map<String, Value>,
    path: &Path,
    problems: &mut Vec<(PathBuf, UiError)>,
) -> Result<Meta, Fatal> {
    const ALLOWED: &[&str] = &[
        "$schema",
        "name",
        "version",
        "description",
        "author",
        "homepage",
        "repository",
        "license",
        "keywords",
        "extensions",
    ];
    let fatal = |reason: UiError| Fatal {
        path: path.to_path_buf(),
        reason,
    };

    for key in obj.keys() {
        if !ALLOWED.contains(&key.as_str()) {
            problems.push((
                path.to_path_buf(),
                ui_error!("kernel.plugin.unknownField", field = key),
            ));
        }
    }

    let schema = obj
        .get("$schema")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| fatal(ui_error!("kernel.plugin.missingSchema")))?;
    if !schema_supported(schema, "plugin.schema.json") {
        return Err(fatal(ui_error!("kernel.plugin.badSchema", schema = schema)));
    }

    let name = obj
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| fatal(ui_error!("kernel.plugin.badField", field = "name")))?;
    if !valid_name(name) {
        return Err(fatal(ui_error!("kernel.plugin.badName", name = name)));
    }

    // 元数据字段只查类型（规范 §5.4），不查内容。
    let opt_str = |key: &str| -> Result<Option<String>, Fatal> {
        match obj.get(key) {
            None => Ok(None),
            Some(Value::String(s)) => Ok(Some(s.clone())),
            Some(_) => Err(fatal(ui_error!("kernel.plugin.badField", field = key))),
        }
    };
    let author = match obj.get("author") {
        None => None,
        Some(Value::Object(a)) => {
            for (k, v) in a {
                if !matches!(k.as_str(), "name" | "email" | "url") || !v.is_string() {
                    return Err(fatal(ui_error!("kernel.plugin.badField", field = "author")));
                }
            }
            a.get("name").and_then(Value::as_str).map(str::to_owned)
        }
        Some(_) => return Err(fatal(ui_error!("kernel.plugin.badField", field = "author"))),
    };
    let keywords = match obj.get("keywords") {
        None => Vec::new(),
        Some(Value::Array(items)) => {
            let mut out = Vec::new();
            for it in items {
                match it {
                    Value::String(s) => out.push(s.clone()),
                    _ => {
                        return Err(fatal(ui_error!(
                            "kernel.plugin.badField",
                            field = "keywords"
                        )));
                    }
                }
            }
            out
        }
        Some(_) => {
            return Err(fatal(ui_error!(
                "kernel.plugin.badField",
                field = "keywords"
            )));
        }
    };
    if let Some(ext) = obj.get("extensions")
        && !ext.is_object()
    {
        problems.push((
            path.to_path_buf(),
            ui_error!("kernel.plugin.badField", field = "extensions"),
        ));
    }

    Ok(Meta {
        name: name.to_owned(),
        display_name: None,
        version: opt_str("version")?,
        description: opt_str("description")?,
        author,
        homepage: opt_str("homepage")?,
        repository: opt_str("repository")?,
        license: opt_str("license")?,
        keywords,
    })
}

/// CC / Cursor 清单：只要 `name` 是非空字符串就收。它们的清单不是闭合
/// schema，别的字段类型不对只是不采用，不拒绝整个插件。
fn read_loose_meta(obj: &serde_json::Map<String, Value>, path: &Path) -> Result<Meta, Fatal> {
    let name = obj
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .ok_or_else(|| Fatal {
            path: path.to_path_buf(),
            reason: ui_error!("kernel.plugin.badField", field = "name"),
        })?;
    // 名字要能进目录名和技能前缀。CC 允许的字符和标准一致（kebab-case），
    // 这里宽一点：大小写字母、数字、`-`、`_`、`.`，别的都拒。
    let ok = !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && !name.starts_with('.')
        && !name.contains("..");
    if !ok {
        return Err(Fatal {
            path: path.to_path_buf(),
            reason: ui_error!("kernel.plugin.badName", name = name),
        });
    }
    let s = |k: &str| obj.get(k).and_then(Value::as_str).map(str::to_owned);
    let author = match obj.get("author") {
        Some(Value::Object(a)) => a.get("name").and_then(Value::as_str).map(str::to_owned),
        Some(Value::String(a)) => Some(a.clone()),
        _ => None,
    };
    Ok(Meta {
        name: name.to_owned(),
        display_name: s("displayName"),
        version: s("version"),
        description: s("description"),
        author,
        homepage: s("homepage"),
        repository: match obj.get("repository") {
            Some(Value::String(r)) => Some(r.clone()),
            Some(Value::Object(r)) => r.get("url").and_then(Value::as_str).map(str::to_owned),
            _ => None,
        },
        license: s("license"),
        keywords: obj
            .get("keywords")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
    })
}

fn collect_overrides(obj: &serde_json::Map<String, Value>, out: &mut Overrides) {
    let paths = |v: &Value| -> Vec<String> {
        match v {
            Value::String(s) => vec![s.clone()],
            Value::Array(a) => a
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
            _ => Vec::new(),
        }
    };
    if let Some(v) = obj.get("skills") {
        out.skills.extend(paths(v));
    }
    if let Some(v) = obj.get("commands") {
        out.commands.extend(paths(v));
    }
    if let Some(v) = obj.get("agents") {
        out.agents.extend(paths(v));
    }
    if let Some(v) = obj.get("rules") {
        out.rules.extend(paths(v));
    }
    match obj.get("hooks") {
        Some(Value::Object(_)) => out.hooks_inline.push(obj["hooks"].clone()),
        Some(v) => out.hooks_paths.extend(paths(v)),
        None => {}
    }
    match obj.get("mcpServers") {
        Some(Value::Object(_)) => out.mcp_inline.push(obj["mcpServers"].clone()),
        Some(Value::Array(items)) => {
            for it in items {
                match it {
                    Value::String(p) => out.mcp_paths.push(p.clone()),
                    Value::Object(_) => out.mcp_inline.push(it.clone()),
                    _ => {}
                }
            }
        }
        Some(v) => out.mcp_paths.extend(paths(v)),
        None => {}
    }
    for key in [
        "lspServers",
        "outputStyles",
        "monitors",
        "themes",
        "dependencies",
        "variables",
    ] {
        if obj.contains_key(key) {
            out.unsupported.push(key.to_owned());
        }
    }
    if let Some(exp) = obj.get("experimental").and_then(Value::as_object) {
        for key in exp.keys() {
            out.unsupported.push(format!("experimental.{key}"));
        }
    }
}

/// `$schema` 是不是我们认的版本。`kind` 是 `plugin.schema.json` 或
/// `mcp.schema.json`。返回 false 的两种情况：不是这个前缀（不是标准清单），
/// 或主版本不是我们实现的那个。
pub fn schema_supported(schema: &str, kind: &str) -> bool {
    schema_version(schema, kind).is_some_and(|v| v.split('.').next() == Some(SUPPORTED_MAJOR))
}

/// 从 `$schema` 里取版本段。不是标准形态返回 None。
pub fn schema_version<'a>(schema: &'a str, kind: &str) -> Option<&'a str> {
    let rest = schema.strip_prefix(SCHEMA_PREFIX)?;
    let (version, tail) = rest.split_once('/')?;
    (tail == kind && !version.is_empty()).then_some(version)
}

/// 规范 §5.5 的名字约束。
pub fn valid_name(name: &str) -> bool {
    let len = name.chars().count();
    if !(1..=64).contains(&len) {
        return false;
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.')
    {
        return false;
    }
    let first = name
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric());
    let last = name
        .chars()
        .next_back()
        .is_some_and(|c| c.is_ascii_alphanumeric());
    first && last && !name.contains("--") && !name.contains("..")
}

#[cfg(test)]
mod tests {
    use super::*;

    const NS: &str = "dev.riot";

    fn root() -> (tempfile::TempDir, PathBuf) {
        let t = tempfile::tempdir().expect("临时目录");
        let r = std::fs::canonicalize(t.path()).expect("canon");
        (t, r)
    }

    fn write(root: &Path, rel: &str, body: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().expect("有父目录")).expect("建目录");
        std::fs::write(p, body).expect("写");
    }

    #[test]
    fn 名字约束按规范() {
        for ok in ["my-plugin", "acme.tools", "lint3r", "a"] {
            assert!(valid_name(ok), "{ok} 该合法");
        }
        for bad in [
            "My-Plugin",
            "-start",
            "has--double",
            "too.many..dots",
            "",
            "end-",
        ] {
            assert!(!valid_name(bad), "{bad} 该非法");
        }
    }

    #[test]
    fn 标准清单_闭合_schema() {
        let (_t, r) = root();
        write(
            &r,
            "plugin.json",
            r#"{
              "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
              "name": "demo",
              "version": "1.2.0",
              "author": { "name": "A", "url": "https://a.example" },
              "keywords": ["x"],
              "somethingNew": true,
              "extensions": { "dev.riot": { "pathPrepend": ["./bin"] }, "com.other": 1 }
            }"#,
        );
        let m = read(&r, NS).expect("该能读");
        assert_eq!(m.format, Format::AgentPlugins);
        assert_eq!(m.meta.name, "demo");
        assert_eq!(m.meta.version.as_deref(), Some("1.2.0"));
        assert_eq!(m.meta.author.as_deref(), Some("A"));
        assert_eq!(
            m.problems.len(),
            1,
            "未知顶层字段是非致命问题：报告后继续加载"
        );
        assert_eq!(m.problems[0].1.key(), "kernel.plugin.unknownField");
        assert!(m.riot_ext.is_some(), "只取我们自己的命名空间");
    }

    #[test]
    fn 标准清单缺_schema_或版本不认_整个拒绝() {
        let (_t, r) = root();
        write(&r, "plugin.json", r#"{ "name": "demo" }"#);
        let err = read(&r, NS).expect_err("缺 $schema 是致命的");
        assert_eq!(err.reason.key(), "kernel.plugin.missingSchema");

        write(
            &r,
            "plugin.json",
            r#"{ "$schema": "https://agent-plugins.org/schemas/2.0.0/plugin.schema.json", "name": "demo" }"#,
        );
        let err = read(&r, NS).expect_err("不认的主版本要拒绝");
        assert_eq!(err.reason.key(), "kernel.plugin.badSchema");

        // 1.x 都按 1.0.0 读（显式认作兼容）。
        write(
            &r,
            "plugin.json",
            r#"{ "$schema": "https://agent-plugins.org/schemas/1.3.0/plugin.schema.json", "name": "demo" }"#,
        );
        assert!(read(&r, NS).is_ok());
    }

    #[test]
    fn 标准清单元数据类型错是致命的_名字非法也是() {
        let (_t, r) = root();
        write(
            &r,
            "plugin.json",
            r#"{ "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", "name": "demo", "version": 3 }"#,
        );
        assert_eq!(
            read(&r, NS).expect_err("类型错").reason.key(),
            "kernel.plugin.badField"
        );
        write(
            &r,
            "plugin.json",
            r#"{ "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", "name": "Bad Name" }"#,
        );
        assert_eq!(
            read(&r, NS).expect_err("名字非法").reason.key(),
            "kernel.plugin.badName"
        );
    }

    #[test]
    fn claude_code_清单_收组件覆盖与内联() {
        let (_t, r) = root();
        write(
            &r,
            ".claude-plugin/plugin.json",
            r#"{
              "name": "cc-plugin",
              "displayName": "CC Plugin",
              "version": "0.1.0",
              "author": { "name": "Someone" },
              "skills": "./custom/skills/",
              "commands": ["./custom/commands/a.md"],
              "hooks": { "PostToolUse": [] },
              "mcpServers": { "db": { "command": "npx", "args": ["x"] } },
              "lspServers": "./.lsp.json"
            }"#,
        );
        let m = read(&r, NS).expect("该能读");
        assert_eq!(m.format, Format::ClaudeCode);
        assert_eq!(m.meta.display_name.as_deref(), Some("CC Plugin"));
        assert_eq!(m.overrides.skills, vec!["./custom/skills/"]);
        assert_eq!(m.overrides.commands, vec!["./custom/commands/a.md"]);
        assert_eq!(m.overrides.hooks_inline.len(), 1);
        assert_eq!(m.overrides.mcp_inline.len(), 1);
        assert_eq!(m.overrides.unsupported, vec!["lspServers"]);
    }

    #[test]
    fn 同时有标准与_cc_清单时_身份取标准_组件覆盖取_cc() {
        let (_t, r) = root();
        write(
            &r,
            "plugin.json",
            r#"{ "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", "name": "both", "version": "2.0.0" }"#,
        );
        write(
            &r,
            ".claude-plugin/plugin.json",
            r#"{ "name": "both-cc", "version": "1.0.0", "hooks": "./hooks/extra.json" }"#,
        );
        let m = read(&r, NS).expect("该能读");
        assert_eq!(m.format, Format::AgentPlugins);
        assert_eq!(m.meta.name, "both", "身份取标准那份");
        assert_eq!(
            m.overrides.hooks_paths,
            vec!["./hooks/extra.json"],
            "标准清单里写不了 hooks，只能从 CC 那份收"
        );
    }

    #[test]
    fn 没有任何清单() {
        let (_t, r) = root();
        assert_eq!(
            read(&r, NS).expect_err("空目录").reason.key(),
            "kernel.plugin.noManifest"
        );
    }

    #[test]
    fn schema_版本解析() {
        assert_eq!(
            schema_version(
                "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
                "mcp.schema.json"
            ),
            Some("1.0.0")
        );
        assert_eq!(
            schema_version(
                "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
                "plugin.schema.json"
            ),
            None,
            "文件名对不上不算"
        );
        assert!(!schema_supported(
            "https://example.com/x.json",
            "plugin.schema.json"
        ));
    }
}
