//! 插件带的 MCP 服务器配置：`mcp.json`（标准）/ `.mcp.json`（CC）/
//! `mcp.json`（Cursor）/ 清单里内联的 `mcpServers`。读出来统一成协议里的
//! [`McpTransport`]，宿主拿去拼 `mcp.reconcile` 的清单。
//!
//! 标准格式（规范 §7.2）是闭合的：`$schema` + `mcpServers`，每个服务器有
//! `type`，字段不许多不许混。CC / Cursor 的形态宽松：没有 `type` 就是
//! stdio，`command` 里允许写 `${CLAUDE_PLUGIN_ROOT}`。两种按有没有标准
//! `$schema` 区分 —— Cursor 和标准都叫 `mcp.json`，只能看内容。
//!
//! 安全上的两条硬线，两种格式都守：
//!
//! - `command` 是包内路径时必须落在插件根内（§4.1）；
//! - 插件自己的 `env` 不许设 `PLUGIN_ROOT` / `PLUGIN_DATA`（§9.2）——
//!   那两个由我们提供，让插件改写等于让它谎报自己在哪。
//!
//! 豁免理由：宿主层，读的是用户装到本机的插件目录。

#![allow(clippy::disallowed_methods)]

use std::path::{Path, PathBuf};

use riot_protocol::rpc::McpTransport;
use riot_protocol::text::UiError;
use riot_protocol::ui_error;
use serde_json::Value;

use super::manifest;
use super::paths::{self, Vars};

/// 一个已经解析好的服务器：名字（配置里的键）+ 传输。
#[derive(Debug, Clone, PartialEq)]
pub struct McpServer {
    pub name: String,
    pub transport: McpTransport,
}

/// 解析一份 MCP 配置（文件内容或内联对象）。问题按服务器隔离：一条坏了
/// 不影响同文件里的其它条（§11.3）；但标准格式的顶层不合规时整份作废。
pub fn parse(
    value: &Value,
    vars: &Vars,
    source: &Path,
    plugin_version: Option<&str>,
    problems: &mut Vec<(PathBuf, UiError)>,
) -> Vec<McpServer> {
    let Some(obj) = value.as_object() else {
        problems.push((
            source.to_path_buf(),
            ui_error!("kernel.plugin.mcpInvalid"; "not an object"),
        ));
        return Vec::new();
    };

    // 内联的 `mcpServers: {…}` 传进来的是服务器表本身；文件传进来的是外层。
    let (servers, strict) = match (obj.get("mcpServers"), obj.get("$schema")) {
        (Some(servers), Some(Value::String(schema))) => {
            if !manifest::schema_supported(schema, "mcp.schema.json") {
                problems.push((
                    source.to_path_buf(),
                    ui_error!("kernel.plugin.badSchema", schema = schema),
                ));
                return Vec::new();
            }
            // §10.1：mcp.json 的版本必须和 plugin.json 的一致。
            if let (Some(mv), Some(pv)) = (
                manifest::schema_version(schema, "mcp.schema.json"),
                plugin_version,
            ) && mv != pv
            {
                problems.push((
                    source.to_path_buf(),
                    ui_error!("kernel.plugin.mcpInvalid"; format!("mcp.json targets {mv}, plugin.json targets {pv}")),
                ));
                return Vec::new();
            }
            for key in obj.keys() {
                if key != "$schema" && key != "mcpServers" {
                    problems.push((
                        source.to_path_buf(),
                        ui_error!("kernel.plugin.mcpInvalid"; format!("unexpected top-level field `{key}`")),
                    ));
                    return Vec::new();
                }
            }
            (servers, true)
        }
        (Some(servers), None) => (servers, false),
        (Some(_), Some(_)) => {
            problems.push((
                source.to_path_buf(),
                ui_error!("kernel.plugin.mcpInvalid"; "`$schema` must be a string"),
            ));
            return Vec::new();
        }
        // 没有 mcpServers：整个对象就是服务器表（清单里内联的形态）。
        (None, _) => (value, false),
    };
    let Some(table) = servers.as_object() else {
        problems.push((
            source.to_path_buf(),
            ui_error!("kernel.plugin.mcpInvalid"; "`mcpServers` is not an object"),
        ));
        return Vec::new();
    };

    let mut out = Vec::new();
    let mut names: Vec<&String> = table.keys().collect();
    names.sort();
    for name in names {
        let entry = &table[name];
        match parse_server(name, entry, vars, strict) {
            Ok(transport) => out.push(McpServer {
                name: name.clone(),
                transport,
            }),
            Err(detail) => problems.push((
                source.to_path_buf(),
                ui_error!("kernel.plugin.mcpServerInvalid", name = name; detail),
            )),
        }
    }
    out
}

fn parse_server(
    name: &str,
    entry: &Value,
    vars: &Vars,
    strict: bool,
) -> Result<McpTransport, String> {
    let obj = entry
        .as_object()
        .ok_or_else(|| format!("server `{name}` is not an object"))?;
    let kind = obj.get("type").and_then(Value::as_str);

    match kind {
        None | Some("stdio") => parse_stdio(obj, vars, strict, kind.is_none()),
        Some("streamable-http") | Some("http") => parse_http(obj, strict, false),
        Some("sse") => parse_http(obj, strict, true),
        Some(other) => Err(format!("unknown transport type `{other}`")),
    }
}

fn parse_stdio(
    obj: &serde_json::Map<String, Value>,
    vars: &Vars,
    strict: bool,
    type_omitted: bool,
) -> Result<McpTransport, String> {
    if strict {
        if type_omitted {
            return Err("`type` is required".into());
        }
        for key in obj.keys() {
            if !matches!(key.as_str(), "type" | "command" | "args" | "env" | "cwd") {
                return Err(format!("unexpected field `{key}` in a stdio server"));
            }
        }
    }
    let command = obj
        .get("command")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .ok_or("`command` is required")?;

    // 标准：command 不做占位符展开、必须是单个 token。CC：允许
    // `${CLAUDE_PLUGIN_ROOT}/servers/x`，先展开再看。
    let command = if strict {
        if command.contains("${") {
            return Err("placeholders are not allowed in `command`".into());
        }
        command.to_owned()
    } else {
        vars.expand(command)
    };
    let command = resolve_command(&command, vars)?;

    let args: Vec<String> = match obj.get("args") {
        None => Vec::new(),
        Some(Value::Array(a)) => a
            .iter()
            .map(|v| {
                v.as_str()
                    .map(|s| vars.expand(s))
                    .ok_or_else(|| "`args` must be strings".to_owned())
            })
            .collect::<Result<_, _>>()?,
        Some(_) => return Err("`args` must be an array".into()),
    };

    let mut env: Vec<(String, String)> = match obj.get("env") {
        None => Vec::new(),
        Some(Value::Object(e)) => {
            let mut out = Vec::new();
            for (k, v) in e {
                if paths::is_reserved_env(k) {
                    return Err(format!("`env.{k}` is reserved; the client provides it"));
                }
                let v = v
                    .as_str()
                    .ok_or_else(|| format!("`env.{k}` must be a string"))?;
                out.push((k.clone(), vars.expand(v)));
            }
            out
        }
        Some(_) => return Err("`env` must be an object".into()),
    };
    // 保留变量由我们盖上（§9.1）。
    env.extend(vars.env());

    let cwd = match obj.get("cwd") {
        None => vars.root.clone(),
        Some(Value::String(c)) => {
            let c = c.trim();
            // 三种允许的形态：`./x`、`${PLUGIN_ROOT}/x`、`${PLUGIN_DATA}/x`。
            let ok = c.starts_with("./")
                || c.starts_with("${PLUGIN_ROOT}")
                || c.starts_with("${PLUGIN_DATA}")
                || c.starts_with("${CLAUDE_PLUGIN_ROOT}")
                || c.starts_with("${CLAUDE_PLUGIN_DATA}");
            if strict && !ok {
                return Err(format!(
                    "`cwd` must be plugin-relative or rooted at a placeholder: `{c}`"
                ));
            }
            paths::contain_or_data(vars, c).map_err(|e| e.to_string())?
        }
        Some(_) => return Err("`cwd` must be a string".into()),
    };

    Ok(McpTransport::Stdio {
        command,
        args,
        env,
        cwd: Some(cwd),
    })
}

/// `command`：包内路径就解析并做包含检查；裸名字留给 PATH。
///
/// 判据是"长得像路径"：带分隔符、或以 `.` 开头、或是绝对路径。`npx` /
/// `uvx` / `node` 这种裸名走平台的可执行文件搜索。
fn resolve_command(command: &str, vars: &Vars) -> Result<String, String> {
    let looks_like_path = command.contains('/')
        || command.contains('\\')
        || command.starts_with('.')
        || Path::new(command).is_absolute();
    if !looks_like_path {
        if command.chars().any(char::is_whitespace) {
            return Err(format!(
                "`command` must be a single executable token, got `{command}`"
            ));
        }
        return Ok(command.to_owned());
    }
    paths::contain(&vars.root, command)
        .map(|p| p.display().to_string())
        .map_err(|e| e.to_string())
}

fn parse_http(
    obj: &serde_json::Map<String, Value>,
    strict: bool,
    legacy_sse: bool,
) -> Result<McpTransport, String> {
    if strict {
        for key in obj.keys() {
            if !matches!(key.as_str(), "type" | "url" | "headers") {
                return Err(format!("unexpected field `{key}` in an HTTP server"));
            }
        }
    }
    let url = obj
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|u| !u.is_empty())
        .ok_or("`url` is required")?;
    validate_url(url)?;

    let mut headers: Vec<(String, String)> = Vec::new();
    if let Some(h) = obj.get("headers") {
        let h = h.as_object().ok_or("`headers` must be an object")?;
        for (k, v) in h {
            let v = v
                .as_str()
                .ok_or_else(|| format!("header `{k}` must be a string"))?;
            if headers
                .iter()
                .any(|(existing, _)| existing.eq_ignore_ascii_case(k))
            {
                return Err(format!(
                    "header `{k}` appears more than once (case-insensitive)"
                ));
            }
            if k.is_empty() || !k.chars().all(|c| c.is_ascii_graphic() && c != ':') {
                return Err(format!("`{k}` is not a valid header name"));
            }
            headers.push((k.clone(), v.to_owned()));
        }
    }
    Ok(McpTransport::Http {
        url: url.to_owned(),
        headers,
        legacy_sse,
    })
}

/// §7.2.1：绝对 http(s)，无 userinfo、无 fragment；非回环必须 https。
fn validate_url(raw: &str) -> Result<(), String> {
    let parsed = url::Url::parse(raw).map_err(|e| format!("`url` is not a valid URL: {e}"))?;
    match parsed.scheme() {
        "https" => {}
        "http" => {
            let host = parsed.host_str().unwrap_or("");
            let loopback = host == "localhost"
                || parsed.host().is_some_and(|h| match h {
                    url::Host::Ipv4(ip) => ip.is_loopback(),
                    url::Host::Ipv6(ip) => ip.is_loopback(),
                    url::Host::Domain(_) => false,
                });
            if !loopback {
                return Err("plain http is only allowed for loopback hosts".into());
            }
        }
        other => return Err(format!("`url` scheme must be http or https, got `{other}`")),
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("`url` must not contain user information".into());
    }
    if parsed.fragment().is_some() {
        return Err("`url` must not contain a fragment".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, Vars) {
        let t = tempfile::tempdir().expect("临时目录");
        let root = t.path().join("plug");
        std::fs::create_dir_all(root.join("bin")).expect("建目录");
        std::fs::write(root.join("bin/server"), "").expect("写");
        let vars = Vars {
            root: super::paths::canonical(&root).expect("canon"),
            data: t.path().join("data"),
        };
        (t, vars)
    }

    fn run(v: serde_json::Value, vars: &Vars) -> (Vec<McpServer>, Vec<(PathBuf, UiError)>) {
        let mut problems = Vec::new();
        let out = parse(
            &v,
            vars,
            Path::new("mcp.json"),
            Some("1.0.0"),
            &mut problems,
        );
        (out, problems)
    }

    #[test]
    fn 标准格式_stdio_展开与默认_cwd() {
        let (_t, vars) = setup();
        let (out, problems) = run(
            serde_json::json!({
                "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
                "mcpServers": {
                    "db": {
                        "type": "stdio",
                        "command": "./bin/server",
                        "args": ["--data", "${PLUGIN_DATA}/db"],
                        "env": { "X": "${PLUGIN_ROOT}/cfg" }
                    }
                }
            }),
            &vars,
        );
        assert!(problems.is_empty(), "{problems:?}");
        assert_eq!(out.len(), 1);
        let McpTransport::Stdio {
            command,
            args,
            env,
            cwd,
        } = &out[0].transport
        else {
            panic!("该是 stdio");
        };
        assert_eq!(Path::new(command), vars.root.join("bin/server"));
        assert_eq!(args[1], format!("{}/db", vars.data.display()));
        assert!(env.iter().any(|(k, v)| k == "X" && v.ends_with("/cfg")));
        assert!(
            env.iter().any(|(k, _)| k == "PLUGIN_ROOT")
                && env.iter().any(|(k, _)| k == "PLUGIN_DATA"),
            "保留变量由我们提供"
        );
        assert_eq!(
            cwd.as_deref(),
            Some(vars.root.as_path()),
            "缺省 cwd = 插件根"
        );
    }

    #[test]
    fn 标准格式_严格_缺_type_多字段_保留变量_都拒() {
        let (_t, vars) = setup();
        let (out, problems) = run(
            serde_json::json!({
                "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
                "mcpServers": {
                    "a": { "command": "npx" },
                    "b": { "type": "stdio", "command": "npx", "extra": 1 },
                    "c": { "type": "stdio", "command": "npx", "env": { "PLUGIN_ROOT": "/x" } },
                    "d": { "type": "stdio", "command": "${PLUGIN_ROOT}/bin/server" },
                    "ok": { "type": "stdio", "command": "npx" }
                }
            }),
            &vars,
        );
        assert_eq!(
            out.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            vec!["ok"]
        );
        assert_eq!(problems.len(), 4, "坏的逐条报，不拖累好的：{problems:?}");
    }

    #[test]
    fn 标准格式_版本与_plugin_json_不一致整份作废() {
        let (_t, vars) = setup();
        let mut problems = Vec::new();
        let out = parse(
            &serde_json::json!({
                "$schema": "https://agent-plugins.org/schemas/1.1.0/mcp.schema.json",
                "mcpServers": { "a": { "type": "stdio", "command": "npx" } }
            }),
            &vars,
            Path::new("mcp.json"),
            Some("1.0.0"),
            &mut problems,
        );
        assert!(out.is_empty());
        assert_eq!(problems.len(), 1);
    }

    #[test]
    fn cc_格式_宽松_command_可展开_默认_stdio() {
        let (_t, vars) = setup();
        let (out, problems) = run(
            serde_json::json!({
                "mcpServers": {
                    "srv": {
                        "command": "${CLAUDE_PLUGIN_ROOT}/bin/server",
                        "args": ["--plugin-mode"],
                        "env": { "TOKEN": "x" }
                    },
                    "remote": { "type": "http", "url": "https://mcp.example.com/x", "headers": { "A": "b" } }
                }
            }),
            &vars,
        );
        assert!(problems.is_empty(), "{problems:?}");
        assert_eq!(out.len(), 2);
        let McpTransport::Stdio { command, .. } = &out[1].transport else {
            panic!("srv 该是 stdio");
        };
        assert_eq!(Path::new(command), vars.root.join("bin/server"));
        assert!(matches!(
            &out[0].transport,
            McpTransport::Http {
                legacy_sse: false,
                ..
            }
        ));
    }

    #[test]
    fn 内联的服务器表_没有外层也认() {
        let (_t, vars) = setup();
        let (out, problems) = run(
            serde_json::json!({ "only": { "command": "uvx", "args": ["thing"] } }),
            &vars,
        );
        assert!(problems.is_empty(), "{problems:?}");
        assert_eq!(out[0].name, "only");
    }

    #[test]
    fn command_逃出根被拒_裸名放行() {
        let (_t, vars) = setup();
        let (out, problems) = run(
            serde_json::json!({ "mcpServers": {
                "bad": { "command": "../../bin/sh" },
                "bare": { "command": "npx" },
                "spaces": { "command": "node server.js" }
            }}),
            &vars,
        );
        assert_eq!(
            out.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            vec!["bare"]
        );
        assert_eq!(problems.len(), 2);
    }

    #[test]
    fn url_规则() {
        assert!(validate_url("https://a.example/mcp").is_ok());
        assert!(validate_url("http://localhost:3000/mcp").is_ok());
        assert!(validate_url("http://127.0.0.1/mcp").is_ok());
        assert!(
            validate_url("http://a.example/mcp").is_err(),
            "非回环要 https"
        );
        assert!(
            validate_url("https://u:p@a.example/mcp").is_err(),
            "不许 userinfo"
        );
        assert!(
            validate_url("https://a.example/mcp#frag").is_err(),
            "不许 fragment"
        );
        assert!(validate_url("ftp://a.example").is_err());
    }

    #[test]
    fn 标准格式_http_严格字段() {
        let (_t, vars) = setup();
        let (out, problems) = run(
            serde_json::json!({
                "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
                "mcpServers": {
                    "ok": { "type": "streamable-http", "url": "https://a.example/mcp" },
                    "old": { "type": "sse", "url": "https://a.example/sse" },
                    "dup": { "type": "streamable-http", "url": "https://a.example/mcp", "headers": { "X-A": "1", "x-a": "2" } }
                }
            }),
            &vars,
        );
        // 按名字排序：ok、old（dup 被拒）。
        assert_eq!(
            out.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            vec!["ok", "old"]
        );
        assert!(matches!(
            &out[0].transport,
            McpTransport::Http {
                legacy_sse: false,
                ..
            }
        ));
        assert!(
            matches!(
                &out[1].transport,
                McpTransport::Http {
                    legacy_sse: true,
                    ..
                }
            ),
            "old 是 sse"
        );
        assert_eq!(problems.len(), 1, "大小写重复的头要拒");
    }
}
