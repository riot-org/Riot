//! 把服务器的回答排成给模型看的文本。
//!
//! 原则：每条结果一行，带「路径:行:列」和那一行的原文 —— 模型据此
//! 直接决定下一步 Read 哪里，不用再去打开文件确认"是不是这个"。
//! 行列都是 1 起、按字符计，和 Read 的行号一致。
//!
//! 豁免理由：要读真实文件取那一行原文（服务器只给坐标）。
#![allow(clippy::disallowed_methods)]

use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::client::{Diagnostic, uri_to_path};
use crate::position::{Encoding, from_server_col};

/// 引用 / 定义最多列多少条。
pub const MAX_LOCATIONS: usize = 200;
const MAX_SYMBOLS: usize = 400;
const MAX_WORKSPACE_SYMBOLS: usize = 100;
const MAX_HOVER_CHARS: usize = 6000;
pub const MAX_DIAGNOSTICS: usize = 60;

/// 一个落点。行 0 起、列是服务器单位。
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Location {
    pub path: PathBuf,
    pub line: u32,
    pub col: u32,
}

/// Location / Location[] / LocationLink[] / null 都认。
pub fn parse_locations(v: &Value) -> Vec<Location> {
    let items: Vec<&Value> = match v {
        Value::Array(a) => a.iter().collect(),
        Value::Null => Vec::new(),
        other => vec![other],
    };
    items
        .into_iter()
        .filter_map(|it| {
            let (uri, start) = if let Some(uri) = it.get("targetUri") {
                (
                    uri,
                    it.pointer("/targetSelectionRange/start")
                        .or_else(|| it.pointer("/targetRange/start"))?,
                )
            } else {
                (it.get("uri")?, it.pointer("/range/start")?)
            };
            Some(Location {
                path: uri_to_path(uri.as_str()?)?,
                line: u32::try_from(start.get("line")?.as_u64()?).ok()?,
                col: u32::try_from(start.get("character")?.as_u64()?).ok()?,
            })
        })
        .collect()
}

/// 按需读文件、按行缓存。
#[derive(Default)]
pub struct Lines {
    files: HashMap<PathBuf, Option<Vec<String>>>,
}

impl Lines {
    pub fn line(&mut self, path: &Path, line: u32) -> Option<&str> {
        let lines = self
            .files
            .entry(path.to_path_buf())
            .or_insert_with(|| {
                std::fs::read_to_string(path)
                    .ok()
                    .map(|t| t.lines().map(str::to_owned).collect())
            })
            .as_ref()?;
        lines.get(line as usize).map(String::as_str)
    }
}

pub fn display_path(path: &Path, cwd: &Path) -> String {
    match path.strip_prefix(cwd) {
        Ok(rel) if !rel.as_os_str().is_empty() => rel.display().to_string(),
        _ => path.display().to_string(),
    }
}

fn clip(s: &str, max: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= max {
        return t.to_owned();
    }
    let mut out: String = t.chars().take(max).collect();
    out.push('…');
    out
}

/// `path:行:列: 原文`，去重排序，带上限。
pub fn locations(
    locs: &[Location],
    cwd: &Path,
    enc: Encoding,
    lines: &mut Lines,
    what: &str,
) -> String {
    let mut locs = locs.to_vec();
    locs.sort();
    locs.dedup();
    if locs.is_empty() {
        return format!("No {what} found.");
    }
    let total = locs.len();
    let files = {
        let mut f: Vec<&PathBuf> = locs.iter().map(|l| &l.path).collect();
        f.dedup();
        f.len()
    };
    let mut out = if total == 1 {
        format!("1 {what}:\n")
    } else {
        format!("{total} {what}s in {files} file(s):\n")
    };
    for l in locs.iter().take(MAX_LOCATIONS) {
        let text = lines.line(&l.path, l.line).map(str::to_owned);
        let col = text
            .as_deref()
            .map(|t| from_server_col(t, l.col, enc) + 1)
            .unwrap_or(l.col as usize + 1);
        let _ = write!(out, "{}:{}:{}", display_path(&l.path, cwd), l.line + 1, col);
        if let Some(t) = text {
            let _ = write!(out, ": {}", clip(&t, 200));
        }
        out.push('\n');
    }
    if total > MAX_LOCATIONS {
        let _ = writeln!(out, "… {} more not shown.", total - MAX_LOCATIONS);
    }
    out
}

pub fn hover(v: &Value) -> String {
    fn piece(v: &Value) -> Option<String> {
        match v {
            Value::String(s) => Some(s.clone()),
            Value::Object(o) => {
                let value = o.get("value")?.as_str()?;
                match o.get("language").and_then(Value::as_str) {
                    Some(lang) => Some(format!("```{lang}\n{value}\n```")),
                    None => Some(value.to_owned()),
                }
            }
            Value::Array(a) => {
                let parts: Vec<String> = a.iter().filter_map(piece).collect();
                (!parts.is_empty()).then(|| parts.join("\n\n"))
            }
            _ => None,
        }
    }
    let text = v.get("contents").and_then(piece).unwrap_or_default();
    if text.trim().is_empty() {
        return "No hover information at that position.".to_owned();
    }
    clip(&text, MAX_HOVER_CHARS)
}

pub fn symbol_kind(kind: u64) -> &'static str {
    match kind {
        1 => "file",
        2 => "module",
        3 => "namespace",
        4 => "package",
        5 => "class",
        6 => "method",
        7 => "property",
        8 => "field",
        9 => "constructor",
        10 => "enum",
        11 => "interface",
        12 => "function",
        13 => "variable",
        14 => "constant",
        15 => "string",
        16 => "number",
        17 => "boolean",
        18 => "array",
        19 => "object",
        20 => "key",
        21 => "null",
        22 => "enum-member",
        23 => "struct",
        24 => "event",
        25 => "operator",
        26 => "type-param",
        _ => "symbol",
    }
}

/// 文档符号：DocumentSymbol（树）或 SymbolInformation（平）。
pub fn document_symbols(v: &Value) -> String {
    let Some(items) = v.as_array() else {
        return "No symbols in this file.".to_owned();
    };
    if items.is_empty() {
        return "No symbols in this file.".to_owned();
    }
    let mut out = String::new();
    let mut count = 0usize;
    fn walk(items: &[Value], depth: usize, out: &mut String, count: &mut usize) {
        for it in items {
            if *count >= MAX_SYMBOLS {
                return;
            }
            *count += 1;
            let name = it.get("name").and_then(Value::as_str).unwrap_or("?");
            let kind = symbol_kind(it.get("kind").and_then(Value::as_u64).unwrap_or(0));
            let line = it
                .pointer("/selectionRange/start/line")
                .or_else(|| it.pointer("/range/start/line"))
                .or_else(|| it.pointer("/location/range/start/line"))
                .and_then(Value::as_u64)
                .map(|l| l + 1);
            let _ = write!(out, "{}{kind} {name}", "  ".repeat(depth));
            if let Some(d) = it.get("detail").and_then(Value::as_str)
                && !d.trim().is_empty()
            {
                let _ = write!(out, " — {}", clip(d, 120));
            }
            if let Some(l) = line {
                let _ = write!(out, " (line {l})");
            }
            out.push('\n');
            if let Some(children) = it.get("children").and_then(Value::as_array) {
                walk(children, depth + 1, out, count);
            }
        }
    }
    walk(items, 0, &mut out, &mut count);
    if count >= MAX_SYMBOLS {
        let _ = writeln!(out, "… truncated at {MAX_SYMBOLS} symbols.");
    }
    out
}

pub fn workspace_symbols(v: &Value, cwd: &Path) -> String {
    let Some(items) = v.as_array().filter(|a| !a.is_empty()) else {
        return "No matching symbols.".to_owned();
    };
    let mut out = format!("{} symbol(s):\n", items.len());
    for it in items.iter().take(MAX_WORKSPACE_SYMBOLS) {
        let name = it.get("name").and_then(Value::as_str).unwrap_or("?");
        let kind = symbol_kind(it.get("kind").and_then(Value::as_u64).unwrap_or(0));
        let _ = write!(out, "{kind} {name}");
        if let Some(c) = it.get("containerName").and_then(Value::as_str)
            && !c.is_empty()
        {
            let _ = write!(out, " (in {c})");
        }
        if let Some(path) = it
            .pointer("/location/uri")
            .and_then(Value::as_str)
            .and_then(uri_to_path)
        {
            let _ = write!(out, " — {}", display_path(&path, cwd));
            if let Some(l) = it
                .pointer("/location/range/start/line")
                .and_then(Value::as_u64)
            {
                let _ = write!(out, ":{}", l + 1);
            }
        }
        out.push('\n');
    }
    if items.len() > MAX_WORKSPACE_SYMBOLS {
        let _ = writeln!(
            out,
            "… {} more; narrow the query.",
            items.len() - MAX_WORKSPACE_SYMBOLS
        );
    }
    out
}

pub fn severity(s: u8) -> &'static str {
    match s {
        1 => "error",
        2 => "warning",
        3 => "info",
        _ => "hint",
    }
}

/// 诊断清单，错误在前。`min_severity` 以下（数值更大）的不列。
pub fn diagnostics(
    path: &Path,
    items: &[Diagnostic],
    cwd: &Path,
    enc: Encoding,
    lines: &mut Lines,
    max_severity: u8,
) -> String {
    let mut items: Vec<&Diagnostic> = items
        .iter()
        .filter(|d| d.severity <= max_severity)
        .collect();
    items.sort_by_key(|d| (d.severity, d.line, d.col));
    let shown = display_path(path, cwd);
    if items.is_empty() {
        return format!("No problems reported in {shown}.");
    }
    let errors = items.iter().filter(|d| d.severity == 1).count();
    let warnings = items.iter().filter(|d| d.severity == 2).count();
    let mut out = format!("{shown}: {errors} error(s), {warnings} warning(s)\n");
    for d in items.iter().take(MAX_DIAGNOSTICS) {
        let col = lines
            .line(path, d.line)
            .map(|t| from_server_col(t, d.col, enc) + 1)
            .unwrap_or(d.col as usize + 1);
        let _ = write!(
            out,
            "{}:{}: {}: {}",
            d.line + 1,
            col,
            severity(d.severity),
            clip(&d.message.replace('\n', " "), 300)
        );
        match (&d.source, &d.code) {
            (Some(s), Some(c)) => {
                let _ = write!(out, " [{s} {c}]");
            }
            (None, Some(c)) => {
                let _ = write!(out, " [{c}]");
            }
            _ => {}
        }
        out.push('\n');
    }
    if items.len() > MAX_DIAGNOSTICS {
        let _ = writeln!(out, "… {} more.", items.len() - MAX_DIAGNOSTICS);
    }
    out
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[cfg(unix)]
    #[test]
    fn 认三种落点形状() {
        let loc = json!({ "uri": "file:///a/b.rs", "range": { "start": { "line": 3, "character": 4 }, "end": {} } });
        let link = json!([{ "targetUri": "file:///a/c.rs",
            "targetRange": { "start": { "line": 9, "character": 0 } },
            "targetSelectionRange": { "start": { "line": 10, "character": 7 } } }]);
        assert_eq!(
            parse_locations(&loc),
            vec![Location {
                path: "/a/b.rs".into(),
                line: 3,
                col: 4
            }]
        );
        assert_eq!(
            parse_locations(&link),
            vec![Location {
                path: "/a/c.rs".into(),
                line: 10,
                col: 7
            }]
        );
        assert!(parse_locations(&Value::Null).is_empty());
    }

    #[test]
    fn 落点带原文且按字符算列() {
        let t = tempfile::tempdir().unwrap();
        let f = t.path().join("x.rs");
        std::fs::write(&f, "fn a() {}\n// 中文 fn b() {}\n").unwrap();
        let mut lines = Lines::default();
        // utf-16 下 "// 中文 " 是 6 个码元，b 在第 9 个字符（0 起 9）
        let locs = vec![Location {
            path: f.clone(),
            line: 1,
            col: 9,
        }];
        let out = locations(&locs, t.path(), Encoding::Utf16, &mut lines, "definition");
        assert!(out.contains("x.rs:2:10: // 中文 fn b() {}"), "{out}");
    }

    #[test]
    fn hover_认几种_contents() {
        assert_eq!(
            hover(&json!({ "contents": { "kind": "markdown", "value": "fn f()" } })),
            "fn f()"
        );
        assert_eq!(
            hover(&json!({ "contents": [{ "language": "rust", "value": "u8" }, "doc"] })),
            "```rust\nu8\n```\n\ndoc"
        );
        assert!(hover(&Value::Null).starts_with("No hover"));
    }

    #[test]
    fn 文档符号按层缩进() {
        let v = json!([{ "name": "Foo", "kind": 23, "selectionRange": { "start": { "line": 0 } },
            "children": [{ "name": "bar", "kind": 6, "detail": "fn(&self)", "selectionRange": { "start": { "line": 2 } } }] }]);
        assert_eq!(
            document_symbols(&v),
            "struct Foo (line 1)\n  method bar — fn(&self) (line 3)\n"
        );
    }

    #[test]
    fn 诊断错误在前() {
        let t = tempfile::tempdir().unwrap();
        let f = t.path().join("x.rs");
        let items = vec![
            Diagnostic {
                line: 0,
                col: 0,
                severity: 2,
                message: "unused".into(),
                code: None,
                source: None,
            },
            Diagnostic {
                line: 5,
                col: 2,
                severity: 1,
                message: "mismatched types".into(),
                code: Some("E0308".into()),
                source: Some("rustc".into()),
            },
        ];
        let out = diagnostics(
            &f,
            &items,
            t.path(),
            Encoding::Utf8,
            &mut Lines::default(),
            2,
        );
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines[0], "x.rs: 1 error(s), 1 warning(s)");
        assert_eq!(lines[1], "6:3: error: mismatched types [rustc E0308]");
        assert_eq!(lines[2], "1:1: warning: unused");
    }
}
