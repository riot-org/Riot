//! `riot-server exec`：不开界面跑一个任务，跑完退出。
//!
//! 给脚本、CI、GitHub Action 用 —— 和 `codex exec`、`claude -p` 同一类入口：
//!
//! ```text
//! riot-server exec "修复 issue #42 并跑测试"
//! git diff | riot-server exec --mode plan "审查这个改动" -
//! riot-server exec --json "..." | jq 'select(.kind == "message")'
//! ```
//!
//! # 和桌面版是同一套
//!
//! 同一个 `AppState`、同一个内核、同一份模型配置和密钥 —— 能在界面里跑的
//! 任务，这里就能跑。区别只在没人可问：
//!
//! - **权限**：默认 `auto` 模式（分类器放行明显安全的操作）。剩下要问人的
//!   一律拒绝，拒绝理由告诉模型"这是无人值守运行"，让它换条路；退出前
//!   在 stderr 列出被拒的操作。要放开就显式给 `--mode bypass`。
//! - **提问**：模型的 AskUserQuestion 同样被拒绝并说明"自己拿主意"。
//!   回合若仍然停下来等人，退出码 3。
//!
//! # 会话放在单独的目录
//!
//! `[约束]` 会话写进 `<配置目录>/exec-sessions/`，不进桌面版的会话目录：
//! 会话索引是整份重写的，两个宿主共用一个目录会互相抹掉对方新建的会话。
//! 也不挂浏览器、不跑定时任务（理由见 [`crate::start_exec_background`]）。
//!
//! # 输出
//!
//! - 默认：stdout 只有模型最后的回答（可以直接重定向成文件）；过程
//!   （调了什么工具、被拒了什么）写 stderr。
//! - `--json`：stdout 是一行一个事件的 JSONL（[`AgentEvent`] 原样），
//!   适合程序消费。
//!
//! 退出码：0 完成；1 出错或到达轮数上限；2 参数错误；3 停下来等人；
//! 124 超时；130 被中断。

// 宿主层：真实进程、真实 stdin/stdout。
#![allow(clippy::disallowed_methods)]

use std::io::{IsTerminal as _, Read as _, Write as _};
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use riot_protocol::event::{AgentEvent, TerminalReason};
use riot_protocol::message::{AssistantContent, Message};
use riot_protocol::permission::{PermissionMode, PermissionResponse};
use tokio::sync::mpsc;

use crate::ipc::{Channel, InvokeResponseBody};
use crate::state::AppState;

pub const HELP: &str = "\
riot-server exec — run one task without a UI and exit

USAGE:
    riot-server exec [OPTIONS] <PROMPT>
    riot-server exec [OPTIONS] -          (read the prompt from stdin)

When both stdin is piped and PROMPT is given, stdin is appended to the prompt
as context (e.g. `git diff | riot-server exec \"review this\"`).

OPTIONS:
    -C, --cwd DIR        Project directory [default: current directory]
    --mode MODE          default | accept-edits | plan | auto | bypass | unattended
                         [default: auto]. Anything that still needs a human is denied.
    --model MODEL        Model id to use [default: the app's active model]
    --provider ID        Provider id for --model [default: the active provider]
    --json               Print every event as one JSON object per line on stdout
    --timeout SECS       Give up after SECS seconds (exit 124)
    --trust              Trust the project for this run: load its .riot/hooks.json,
                         skills and commands. Without it, an untrusted project's own
                         Riot config is skipped.
    -h, --help           Show this help

EXIT CODES:
    0 done · 1 error or turn limit · 2 bad arguments · 3 stopped to ask the user
    124 timed out · 130 interrupted

Sessions are kept in <config dir>/riot/exec-sessions/, separate from the app.
";

struct Options {
    prompt: String,
    wants_stdin: bool,
    cwd: PathBuf,
    mode: PermissionMode,
    model: Option<String>,
    provider: Option<String>,
    json: bool,
    timeout: Option<Duration>,
    trust: bool,
}

fn parse_mode(s: &str) -> Result<PermissionMode, String> {
    Ok(match s {
        "default" => PermissionMode::Default,
        "accept-edits" | "acceptEdits" | "accept_edits" => PermissionMode::AcceptEdits,
        "plan" => PermissionMode::Plan,
        "auto" => PermissionMode::Auto,
        "bypass" | "bypass-permissions" => PermissionMode::BypassPermissions,
        "unattended" => PermissionMode::Unattended,
        other => return Err(format!("unknown mode `{other}`")),
    })
}

fn parse(args: Vec<String>) -> Result<Option<Options>, String> {
    let mut prompt_parts: Vec<String> = Vec::new();
    let mut cwd = None;
    let mut mode = PermissionMode::Auto;
    let mut model = None;
    let mut provider = None;
    let mut json = false;
    let mut timeout = None;
    let mut trust = false;
    let mut it = args.into_iter();
    let mut rest_is_prompt = false;
    while let Some(a) = it.next() {
        if rest_is_prompt {
            prompt_parts.push(a);
            continue;
        }
        let mut value = |name: &str| it.next().ok_or(format!("{name} needs a value"));
        match a.as_str() {
            "-h" | "--help" => {
                print!("{HELP}");
                return Ok(None);
            }
            "--" => rest_is_prompt = true,
            "-C" | "--cwd" => cwd = Some(PathBuf::from(value("--cwd")?)),
            "--mode" => mode = parse_mode(&value("--mode")?)?,
            "--model" => model = Some(value("--model")?),
            "--provider" => provider = Some(value("--provider")?),
            "--json" => json = true,
            "--trust" => trust = true,
            "--timeout" => {
                let v = value("--timeout")?;
                let secs: u64 = v
                    .parse()
                    .map_err(|_| format!("--timeout takes seconds, got `{v}`"))?;
                timeout = Some(Duration::from_secs(secs));
            }
            other if other.starts_with("--") && other.contains('=') => {
                let (k, v) = other.split_once('=').unwrap_or((other, ""));
                match k {
                    "--cwd" => cwd = Some(PathBuf::from(v)),
                    "--mode" => mode = parse_mode(v)?,
                    "--model" => model = Some(v.to_owned()),
                    "--provider" => provider = Some(v.to_owned()),
                    "--timeout" => {
                        timeout =
                            Some(Duration::from_secs(v.parse().map_err(|_| {
                                format!("--timeout takes seconds, got `{v}`")
                            })?));
                    }
                    _ => return Err(format!("unknown option `{k}`")),
                }
            }
            other if other.starts_with('-') && other != "-" => {
                return Err(format!("unknown option `{other}`"));
            }
            _ => prompt_parts.push(a),
        }
    }

    // `-` = 从 stdin 读；给了提示词而 stdin 是管道 = 把管道内容当附加上下文。
    // 真正的读取在 [`main`] 里做（测试里的 stdin 不该被碰）。
    let wants_stdin = prompt_parts.iter().any(|p| p == "-");
    prompt_parts.retain(|p| p != "-");
    let prompt = prompt_parts.join(" ");
    let cwd = match cwd {
        Some(c) => c,
        None => std::env::current_dir().map_err(|e| format!("cannot read current dir: {e}"))?,
    };
    let cwd = cwd
        .canonicalize()
        .map_err(|e| format!("{}: {e}", cwd.display()))?;
    Ok(Some(Options {
        prompt,
        wants_stdin,
        cwd: crate::fence::strip_verbatim(cwd),
        mode,
        model,
        provider,
        json,
        timeout,
        trust,
    }))
}

/// 入口。`args` 是 `exec` 之后的参数。
pub fn main(args: Vec<String>) -> ExitCode {
    let mut opts = match parse(args) {
        Ok(Some(o)) => o,
        Ok(None) => return ExitCode::SUCCESS,
        Err(msg) => {
            eprintln!("riot-server exec: {msg}\n\n{HELP}");
            return ExitCode::from(2);
        }
    };
    if opts.wants_stdin || !std::io::stdin().is_terminal() {
        let mut input = String::new();
        if std::io::stdin().read_to_string(&mut input).is_ok() && !input.trim().is_empty() {
            opts.prompt = if opts.prompt.trim().is_empty() {
                input
            } else {
                format!("{}\n\n<stdin>\n{}\n</stdin>", opts.prompt, input.trim_end())
            };
        }
    }
    if opts.prompt.trim().is_empty() {
        eprintln!("riot-server exec: no prompt given\n\n{HELP}");
        return ExitCode::from(2);
    }
    if opts.trust {
        // SAFETY: 这时还没有任何别的线程（runtime 在下面才建，init_process
        // 也还没跑）。内核子进程继承环境，读到它就把这个目录当作信任。
        unsafe {
            std::env::set_var(riot_kernel::trust::ENV_VAR, &opts.cwd);
        }
    }
    crate::init_process_stderr();

    let config_path = crate::config::config_path();
    let sessions_dir = config_path
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .join("exec-sessions");
    let state = AppState::restore_exec(config_path, sessions_dir.clone());

    let rt = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("riot-exec")
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("riot-server exec: cannot start the async runtime: {e}");
            return ExitCode::FAILURE;
        }
    };
    rt.block_on(run(state, opts, sessions_dir))
}

/// 被拒绝时喂回模型的话。
const DENY_MESSAGE: &str = "This is a non-interactive run (riot exec): nobody can approve this \
     action or answer questions. It was not run. Choose a different approach that does not need \
     approval, make reasonable decisions yourself, or finish and explain what a human needs to do.";

enum Incoming {
    Event(Box<AgentEvent>),
}

async fn run(state: AppState, opts: Options, sessions_dir: PathBuf) -> ExitCode {
    crate::start_exec_background(&state);
    state.reconcile_mcp().await;

    let root = opts.cwd.display().to_string();
    let untrusted = riot_kernel::trust::project_config(&opts.cwd);
    if !opts.trust && !untrusted.is_empty() && !riot_kernel::trust::is_trusted(&opts.cwd) {
        let what: Vec<&str> = untrusted.iter().map(|i| i.kind.as_str()).collect();
        eprintln!(
            "riot-server exec: this project has its own Riot config ({}) that is not loaded \
             because the project is not trusted. Pass --trust to load it.",
            what.join(", ")
        );
    }
    let info = match state.create_session(&root).await {
        Ok(i) => i,
        Err(e) => {
            eprintln!("riot-server exec: cannot open {root}: {e}");
            return ExitCode::FAILURE;
        }
    };
    let sid = info.id.clone();
    if let Err(e) = state.set_mode(&sid, opts.mode).await {
        eprintln!("riot-server exec: cannot set mode: {e}");
        return ExitCode::FAILURE;
    }
    if opts.model.is_some() || opts.provider.is_some() {
        let cfg = state.config().await;
        let provider = opts.provider.clone().unwrap_or(cfg.active_provider.clone());
        let model = opts.model.clone().unwrap_or(cfg.active_model.clone());
        if let Err(e) = state.set_session_model(&sid, provider, model).await {
            eprintln!("riot-server exec: {e}");
            return ExitCode::from(2);
        }
    }

    let (tx, mut rx) = mpsc::unbounded_channel::<Incoming>();
    let channel: Channel<AgentEvent> = Channel::new(move |body: InvokeResponseBody| {
        let parsed = match &body {
            InvokeResponseBody::Json(s) => serde_json::from_str::<AgentEvent>(s).ok(),
            InvokeResponseBody::Raw(b) => serde_json::from_slice::<AgentEvent>(b).ok(),
        };
        if let Some(ev) = parsed {
            let _ = tx.send(Incoming::Event(Box::new(ev)));
        }
        Ok(())
    });
    state.attach_sink("exec", sid.clone(), 0, channel).await;

    if let Err(e) = state
        .send_turn(&sid, &opts.prompt, Vec::new(), Vec::new(), None)
        .await
    {
        eprintln!("riot-server exec: cannot start the turn: {e}");
        state.shutdown().await;
        return ExitCode::FAILURE;
    }

    let mut out = Output::new(opts.json);
    let mut denied: Vec<String> = Vec::new();
    let deadline = opts.timeout.map(|t| tokio::time::Instant::now() + t);
    let code = loop {
        let next = async {
            match deadline {
                Some(d) => tokio::time::timeout_at(d, rx.recv()).await.ok(),
                None => Some(rx.recv().await),
            }
        };
        let ev = tokio::select! {
            r = next => r,
            _ = tokio::signal::ctrl_c() => {
                let _ = state.interrupt(&sid).await;
                eprintln!("riot-server exec: interrupted");
                break 130u8;
            }
        };
        let Some(ev) = ev else {
            eprintln!("riot-server exec: timed out");
            let _ = state.interrupt(&sid).await;
            break 124;
        };
        let Some(Incoming::Event(ev)) = ev else {
            eprintln!("riot-server exec: the kernel stopped sending events");
            break 1;
        };
        out.event(&ev);
        match *ev {
            AgentEvent::PermissionRequest { request_id, detail } => {
                let what = describe_ask(&detail);
                out.note(&format!("denied (needs approval): {what}"));
                denied.push(what);
                if let Err(e) = state
                    .respond_permission(
                        &sid,
                        request_id.as_str(),
                        PermissionResponse::Deny {
                            message: Some(DENY_MESSAGE.to_owned()),
                        },
                    )
                    .await
                {
                    tracing::warn!(error = %e, "回应权限请求失败");
                }
            }
            AgentEvent::Done { reason } => {
                break match reason {
                    TerminalReason::Completed => 0,
                    TerminalReason::AwaitingUser { .. } => {
                        eprintln!(
                            "riot-server exec: the agent stopped to ask the user; nobody can \
                             answer in a non-interactive run"
                        );
                        3
                    }
                    TerminalReason::MaxTurns { limit } => {
                        eprintln!("riot-server exec: reached the turn limit ({limit})");
                        1
                    }
                    TerminalReason::Aborted { .. } | TerminalReason::AbortedTools { .. } => 130,
                    TerminalReason::StopHookPrevented { message } => {
                        eprintln!("riot-server exec: a stop hook ended the turn: {message}");
                        1
                    }
                    TerminalReason::Error { error } => {
                        eprintln!(
                            "riot-server exec: {}",
                            serde_json::to_string(&error).unwrap_or_default()
                        );
                        1
                    }
                };
            }
            _ => {}
        }
    };

    out.finish();
    if !denied.is_empty() {
        eprintln!(
            "riot-server exec: {} action(s) were denied because they needed approval \
             (rerun with --mode bypass to allow them):",
            denied.len()
        );
        for d in &denied {
            eprintln!("  - {d}");
        }
    }
    eprintln!(
        "riot-server exec: session {sid} saved in {}",
        sessions_dir.display()
    );
    if tokio::time::timeout(Duration::from_secs(10), state.shutdown())
        .await
        .is_err()
    {
        tracing::warn!("kernel did not stop in time; exiting anyway");
    }
    ExitCode::from(code)
}

/// stdout / stderr 的排版。
struct Output {
    json: bool,
    /// 最后一条助手消息的正文。默认模式只打印它。
    last_text: String,
}

impl Output {
    fn new(json: bool) -> Self {
        Self {
            json,
            last_text: String::new(),
        }
    }

    fn event(&mut self, ev: &AgentEvent) {
        if self.json {
            if !matches!(ev, AgentEvent::Delta(_))
                && let Ok(line) = serde_json::to_string(ev)
            {
                let mut so = std::io::stdout().lock();
                let _ = writeln!(so, "{line}");
                let _ = so.flush();
            }
            return;
        }
        if let AgentEvent::Message(Message::Assistant { content, .. }) = ev {
            let text: Vec<&str> = content
                .iter()
                .filter_map(|c| match c {
                    AssistantContent::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect();
            if !text.is_empty() {
                self.last_text = text.join("\n");
            }
            for c in content {
                if let AssistantContent::ToolUse { name, input, .. } = c {
                    eprintln!("▸ {name} {}", tool_brief(input));
                }
            }
        }
    }

    fn note(&self, msg: &str) {
        if !self.json {
            eprintln!("  {msg}");
        }
    }

    fn finish(&self) {
        if !self.json && !self.last_text.is_empty() {
            let mut so = std::io::stdout().lock();
            let _ = writeln!(so, "{}", self.last_text.trim_end());
            let _ = so.flush();
        }
    }
}

/// 被拒操作的一行说明：工具名 + 命令 / 路径 / 网址。
fn describe_ask(ask: &riot_protocol::permission::PermissionAsk) -> String {
    use riot_protocol::permission::AskPreview;
    let target = match &ask.preview {
        AskPreview::Command { command, .. } => Some(command.clone()),
        AskPreview::FileEdit { path, .. }
        | AskPreview::FileWrite { path, .. }
        | AskPreview::FileDelete { path, .. } => Some(path.display().to_string()),
        AskPreview::NetworkFetch { url, .. } => Some(url.clone()),
        _ => None,
    };
    match target {
        Some(t) => format!(
            "{}: {}",
            ask.tool_name,
            tool_brief(&serde_json::json!({ "command": t }))
        ),
        None => ask.tool_name.clone(),
    }
}

/// 工具调用的一行摘要：取最能说明它在干什么的那个参数。
fn tool_brief(input: &serde_json::Value) -> String {
    for key in [
        "command",
        "path",
        "pattern",
        "url",
        "query",
        "operation",
        "description",
    ] {
        if let Some(v) = input.get(key).and_then(|v| v.as_str()) {
            let one: String = v.split_whitespace().collect::<Vec<_>>().join(" ");
            let mut s: String = one.chars().take(120).collect();
            if one.chars().count() > 120 {
                s.push('…');
            }
            return s;
        }
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn 解析模式和选项() {
        let o = parse(args(&[
            "--mode",
            "plan",
            "--json",
            "--timeout=30",
            "fix",
            "it",
        ]))
        .unwrap()
        .unwrap();
        assert_eq!(o.mode, PermissionMode::Plan);
        assert!(o.json);
        assert_eq!(o.timeout, Some(Duration::from_secs(30)));
        assert!(o.prompt.starts_with("fix it"));
    }

    #[test]
    fn 默认_auto_未知选项报错() {
        let o = parse(args(&["hello"])).unwrap().unwrap();
        assert_eq!(o.mode, PermissionMode::Auto);
        assert!(parse(args(&["--frobnicate", "x"])).is_err());
        assert!(parse(args(&["--mode", "yolo", "x"])).is_err());
    }

    #[test]
    fn 工具摘要取关键参数() {
        assert_eq!(
            tool_brief(&serde_json::json!({ "command": "cargo   test\n-p x" })),
            "cargo test -p x"
        );
        assert_eq!(tool_brief(&serde_json::json!({ "x": 1 })), "");
    }
}
