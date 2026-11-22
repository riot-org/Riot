//! `Lsp`：模型查符号用的工具。
//!
//! # 输入形状
//!
//! 模型不擅长数列号，擅长说"第 42 行的 `parse_config`"。所以位置用
//! `line`（1 起）+ `symbol`（那一行里的名字）给，列号只作为兜底。
//!
//! # 权限：只读
//!
//! 它不改任何文件，按只读工具处理 —— 所有模式下放行，包括规划模式
//! （查定义、查引用恰恰是规划时最需要的）。这个判断成立的前提是
//! [`crate::servers`] 里的几条约束：
//!
//! - 只用用户自己装的服务器（PATH / rustup / 全局 npm），不跑项目目录
//!   里的程序；
//! - rust-analyzer 关掉 build.rs 和过程宏；TypeScript 用全局 tsserver。
//!
//! 剩下的风险是 rust-analyzer 会跑 `cargo metadata`，它读项目的
//! `.cargo/config.toml` 和 `rust-toolchain.toml` —— 和在仓库里跑
//! `git status`（会读仓库的 git 配置）是同一个量级。改上面任何一条约束
//! 之前，先重新评估这里的只读判定。
//!
//! 路径在会话根之外时由通用的围栏检查照常询问（[`Tool::target_path`]）。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use riot_protocol::permission::{PermissionContext, PermissionResult};
use riot_protocol::text::UiText;
use riot_protocol::tool::{PromptContext, ResultBudget, Tool, ToolContext, ToolOutcome};
use riot_protocol::ui_text;
use riot_tools::tools::path;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::client::{Client, path_to_uri};
use crate::position::{find_symbol, to_server_col};
use crate::render::{self, Lines};
use crate::servers::{Language, find_root};
use crate::{LspHub, strip_verbatim};

pub const LSP: &str = "Lsp";

/// 第一次查询时等服务器建完索引的上限。超过就带着"可能不全"的提示
/// 先答，而不是让模型对着一个转圈的工具干等几分钟。
const READY_WAIT: Duration = Duration::from_secs(45);

/// 单个请求的上限。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// 诊断的等待上限。
const DIAG_WAIT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, Copy, Deserialize, schemars::JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Operation {
    /// Where the symbol is defined.
    Definition,
    /// Where the symbol's type is defined.
    TypeDefinition,
    /// Implementations of a trait / interface / abstract method.
    Implementation,
    /// Every place the symbol is used (includes the declaration).
    References,
    /// The symbol's type signature and docs.
    Hover,
    /// Outline of one file: its types, functions, methods, with line numbers.
    DocumentSymbols,
    /// Find symbols by name across the whole project (`query`).
    WorkspaceSymbols,
    /// Errors and warnings the language server reports for one file.
    Diagnostics,
}

impl Operation {
    fn needs_position(self) -> bool {
        matches!(
            self,
            Operation::Definition
                | Operation::TypeDefinition
                | Operation::Implementation
                | Operation::References
                | Operation::Hover
        )
    }

    fn key(self) -> &'static str {
        match self {
            Operation::Definition => "definition",
            Operation::TypeDefinition => "type_definition",
            Operation::Implementation => "implementation",
            Operation::References => "references",
            Operation::Hover => "hover",
            Operation::DocumentSymbols => "document_symbols",
            Operation::WorkspaceSymbols => "workspace_symbols",
            Operation::Diagnostics => "diagnostics",
        }
    }
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Input {
    /// What to ask the language server.
    operation: Operation,
    /// The file to ask about. For `workspace_symbols`, any file of that language in the
    /// project (it picks the language server and project root).
    path: String,
    /// 1-based line number (same numbering as Read). Required for definition,
    /// type_definition, implementation, references and hover.
    #[serde(default)]
    line: Option<u32>,
    /// The identifier on that line to ask about, e.g. `parse_config`. Preferred over `column`.
    #[serde(default)]
    symbol: Option<String>,
    /// Which occurrence of `symbol` on the line (1-based) when it appears more than once.
    #[serde(default)]
    occurrence: Option<usize>,
    /// 1-based character column; only when `symbol` cannot identify the spot.
    #[serde(default)]
    column: Option<u32>,
    /// Name (or fragment) to search for with `workspace_symbols`.
    #[serde(default)]
    query: Option<String>,
}

pub struct LspTool {
    hub: Arc<LspHub>,
}

impl LspTool {
    pub fn new(hub: Arc<LspHub>) -> Self {
        Self { hub }
    }
}

#[async_trait]
impl Tool for LspTool {
    fn name(&self) -> &str {
        LSP
    }

    fn input_schema(&self) -> schemars::Schema {
        schemars::schema_for!(Input)
    }

    fn prompt(&self, ctx: &PromptContext) -> String {
        let grep = if ctx.sibling_tools.is_empty() || ctx.sibling_tools.iter().any(|t| t == "Grep")
        {
            "Grep"
        } else {
            "a text search"
        };
        format!(
            "Asks the project's language server (rust-analyzer, typescript-language-server, \
             pyright) about code: where a symbol is defined, every place it is used, its type, \
             a file's outline, or the errors in a file. Supports .rs, .ts/.tsx/.js/.jsx and .py.\n\
             \n\
             Point at a symbol with `line` (1-based, as Read shows it) plus `symbol` (the \
             identifier on that line). Results come back as `path:line:col: source line`.\n\
             \n\
             ### When to Use\n\
             \n\
             1. Following a call to its definition when the name is common (`new`, `parse`, \
             `handle`) or the call goes through a trait / interface — {grep} would return \
             dozens of unrelated hits.\n\
             2. Before renaming or changing a signature: `references` lists every caller, \
             including ones that import it under another name.\n\
             3. `hover` to learn an inferred type or a dependency's signature without opening \
             its source.\n\
             4. `document_symbols` for the shape of a long file before reading parts of it.\n\
             5. `diagnostics` after an edit, to see type errors without a full build.\n\
             \n\
             ### When NOT to Use\n\
             \n\
             1. Searching for text, comments, config keys or string literals — use {grep}.\n\
             2. Files in other languages; the call fails for unsupported extensions.\n\
             3. As the final word on whether the code compiles: Rust macro-generated code is \
             not expanded here, so run the real build or tests before declaring success.\n\
             \n\
             Notes:\n\
             - The first call in a project starts the server; a large project may still be \
             indexing, in which case results can be incomplete and the output says so.\n\
             - If the server is not installed the call fails with the install command. Ask \
             the user before installing; meanwhile continue with {grep}/Read."
        )
    }

    fn describe(&self, input: &Value) -> UiText {
        let op = input.get("operation").and_then(Value::as_str).unwrap_or("");
        let file = input
            .get("path")
            .and_then(Value::as_str)
            .map(|p| {
                Path::new(p)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| p.to_owned())
            })
            .unwrap_or_default();
        let symbol = input
            .get("symbol")
            .or_else(|| input.get("query"))
            .and_then(Value::as_str)
            .unwrap_or("");
        match op {
            "definition" | "type_definition" | "implementation" => {
                ui_text!("tools.lsp.definition", symbol = symbol, file = file)
            }
            "references" => ui_text!("tools.lsp.references", symbol = symbol, file = file),
            "hover" => ui_text!("tools.lsp.hover", symbol = symbol, file = file),
            "document_symbols" => ui_text!("tools.lsp.symbols", file = file),
            "workspace_symbols" => ui_text!("tools.lsp.workspace", query = symbol),
            "diagnostics" => ui_text!("tools.lsp.diagnostics", file = file),
            _ => ui_text!("tools.lsp.generic", file = file),
        }
    }

    fn is_read_only(&self, _input: &Value) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    fn result_budget(&self) -> ResultBudget {
        // 各类结果自己限了条数。
        ResultBudget::Unlimited
    }

    fn target_path(&self, input: &Value) -> Option<PathBuf> {
        input.get("path").and_then(Value::as_str).map(PathBuf::from)
    }

    fn check_permissions(&self, _input: &Value, _ctx: &PermissionContext) -> PermissionResult {
        PermissionResult::Passthrough
    }

    async fn call(&self, input: Value, ctx: ToolContext) -> ToolOutcome {
        let parsed: Input = match serde_json::from_value(input) {
            Ok(p) => p,
            Err(e) => {
                return ToolOutcome::failed(format!(
                    "Invalid Lsp arguments: {e}. Required: `operation` and `path`; \
                     position-based operations also need `line` and `symbol`."
                ));
            }
        };
        let file = match path::resolve(&parsed.path, &ctx, true).await {
            Ok(p) => p,
            Err(e) => return ToolOutcome::failed(e.for_model()),
        };
        let Some(lang) = Language::for_path(&file) else {
            return ToolOutcome::failed(format!(
                "{} is not a supported file type. Lsp handles .rs, .ts/.tsx/.js/.jsx/.mjs and \
                 .py files; use Grep for anything else.",
                file.display()
            ));
        };
        let root = strip_verbatim(
            ctx.fs
                .canonicalize(&find_root(lang, &file, &ctx.cwd))
                .await
                .unwrap_or_else(|_| ctx.cwd.clone()),
        );

        let hub = Arc::clone(&self.hub);
        let work = async move {
            let client = hub
                .client(lang, &root)
                .await
                .map_err(|e| format!("{e} Until then, use Grep and Read."))?;
            client.touch();
            let ready = client.wait_ready(READY_WAIT).await;
            client.resync_open().await;
            run(&client, &parsed, &file, &ctx.cwd, ready).await
        };
        tokio::select! {
            r = work => match r {
                Ok(text) => ToolOutcome::ok_text(text),
                Err(e) => ToolOutcome::failed(e),
            },
            () = ctx.cancel.cancelled() => ToolOutcome::Cancelled,
        }
    }
}

async fn run(
    client: &Client,
    input: &Input,
    file: &Path,
    cwd: &Path,
    ready: bool,
) -> Result<String, String> {
    let uri = path_to_uri(file).ok_or_else(|| format!("bad path {}", file.display()))?;
    let enc = client.encoding();
    let mut lines = Lines::default();
    let before = client.diag_generation(file);
    let sent = client.sync_file(file).await?;
    let op = input.operation;

    let position = if op.needs_position() {
        let Some(line_no) = input.line.filter(|l| *l >= 1) else {
            return Err(format!(
                "`{}` needs `line` (1-based) and `symbol`.",
                op.key()
            ));
        };
        let text = lines
            .line(file, line_no - 1)
            .ok_or_else(|| {
                format!(
                    "{} has no line {line_no}. Read the file to get the right line number.",
                    file.display()
                )
            })?
            .to_owned();
        let char_idx = match (&input.symbol, input.column) {
            (Some(sym), _) => {
                find_symbol(&text, sym, input.occurrence.unwrap_or(1)).ok_or_else(|| {
                    format!(
                        "`{sym}` does not appear on line {line_no}, which reads: `{}`. Check the \
                         line number with Read.",
                        text.trim()
                    )
                })?
            }
            (None, Some(col)) if col >= 1 => (col - 1) as usize,
            _ => {
                return Err(format!(
                    "`{}` needs `symbol` (the identifier on line {line_no}).",
                    op.key()
                ));
            }
        };
        Some(json!({
            "line": line_no - 1,
            "character": to_server_col(&text, char_idx, enc),
        }))
    } else {
        None
    };

    let doc = json!({ "uri": uri });
    let body = match op {
        Operation::Definition | Operation::TypeDefinition | Operation::Implementation => {
            let method = match op {
                Operation::Definition => "textDocument/definition",
                Operation::TypeDefinition => "textDocument/typeDefinition",
                _ => "textDocument/implementation",
            };
            let v = client
                .request_retry(
                    method,
                    json!({ "textDocument": doc, "position": position }),
                    REQUEST_TIMEOUT,
                )
                .await
                .map_err(|e| e.to_string())?;
            let what = match op {
                Operation::Implementation => "implementation",
                Operation::TypeDefinition => "type definition",
                _ => "definition",
            };
            render::locations(&render::parse_locations(&v), cwd, enc, &mut lines, what)
        }
        Operation::References => {
            let v = client
                .request_retry(
                    "textDocument/references",
                    json!({
                        "textDocument": doc,
                        "position": position,
                        "context": { "includeDeclaration": true }
                    }),
                    REQUEST_TIMEOUT,
                )
                .await
                .map_err(|e| e.to_string())?;
            render::locations(
                &render::parse_locations(&v),
                cwd,
                enc,
                &mut lines,
                "reference",
            )
        }
        Operation::Hover => {
            let v = client
                .request_retry(
                    "textDocument/hover",
                    json!({ "textDocument": doc, "position": position }),
                    REQUEST_TIMEOUT,
                )
                .await
                .map_err(|e| e.to_string())?;
            render::hover(&v)
        }
        Operation::DocumentSymbols => {
            let v = client
                .request_retry(
                    "textDocument/documentSymbol",
                    json!({ "textDocument": doc }),
                    REQUEST_TIMEOUT,
                )
                .await
                .map_err(|e| e.to_string())?;
            render::document_symbols(&v)
        }
        Operation::WorkspaceSymbols => {
            let Some(q) = input.query.as_deref().filter(|q| !q.trim().is_empty()) else {
                return Err("`workspace_symbols` needs `query`.".to_owned());
            };
            let v = client
                .request_retry("workspace/symbol", json!({ "query": q }), REQUEST_TIMEOUT)
                .await
                .map_err(|e| e.to_string())?;
            render::workspace_symbols(&v, cwd)
        }
        Operation::Diagnostics => {
            let items = if sent || before == 0 {
                client.wait_diagnostics(file, before, DIAG_WAIT).await
            } else {
                client.diagnostics(file)
            };
            match items {
                Some(items) => render::diagnostics(file, &items, cwd, enc, &mut lines, 2),
                None => format!(
                    "{} has not reported diagnostics for this file yet. Try again in a moment, \
                     or run the project's build.",
                    client.lang.server_name()
                ),
            }
        }
    };

    if ready {
        Ok(body)
    } else {
        Ok(format!(
            "{body}\n(Note: {} is still indexing this project, so this answer may be \
             incomplete. Retry shortly, or confirm with Grep.)",
            client.lang.server_name()
        ))
    }
}
