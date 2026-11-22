//! 一条到语言服务器的连接。
//!
//! # 结构
//!
//! - 写任务：独占 stdin，按顺序发帧。请求、通知、对服务器请求的应答
//!   都经同一个 mpsc 进来 —— 帧不会交错。
//! - 读任务：读帧、分派。应答交给等着的请求；服务器发来的请求当场代答
//!   （`workspace/configuration` 回设置，其余回 null）；通知更新状态
//!   （诊断、进度、rust-analyzer 的空闲信号），然后拨一下 `tick`。
//! - 等待方（等就绪、等诊断）订阅 `tick`，条件不满足就等下一次拨动。
//!
//! # 和传输无关
//!
//! [`Client::connect`] 吃一对 AsyncRead / AsyncWrite。测试用内存管道接
//! 一个假服务器，不起进程。
//!
//! 豁免理由：这里等的是外部进程的应答，用真实时钟做超时；文件内容从
//! 真实磁盘读（服务器看的就是磁盘）。不参与黄金回放。
#![allow(clippy::disallowed_methods)]

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use process_wrap::tokio::{ChildWrapper, CommandWrap};
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, oneshot, watch};

use crate::framing::{Frame, read_frame, write_frame};
use crate::position::Encoding;
use crate::servers::{Language, ServerCommand};

/// `initialize` 的等待上限。握手只交换能力，不等索引；一分钟还没回
/// 说明服务器卡死或者根本不说 LSP。
const INIT_TIMEOUT: Duration = Duration::from_secs(60);

/// 关闭时给 `shutdown` 请求的时间。
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);

/// 诊断"静下来"的判定：最后一次推送之后这么久没有新的，就认为这一批齐了。
/// 服务器推诊断没有"本轮结束"信号，只能这么等。
const DIAG_SETTLE: Duration = Duration::from_millis(400);

#[derive(Debug, Clone, PartialEq)]
pub enum RpcError {
    /// 服务器回了 error。
    Server {
        code: i64,
        message: String,
    },
    Timeout,
    /// 连接断了（服务器退出）。
    Dead,
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RpcError::Server { code, message } => write!(f, "server error {code}: {message}"),
            RpcError::Timeout => f.write_str("the language server did not answer in time"),
            RpcError::Dead => f.write_str("the language server exited"),
        }
    }
}

/// LSP 的 ContentModified：服务器在算的时候文件又变了，重试即可。
pub const CONTENT_MODIFIED: i64 = -32801;

/// 一条诊断。行、列是服务器原样给的（0 起，列按协商的编码单元）。
#[derive(Debug, Clone, PartialEq)]
pub struct Diagnostic {
    pub line: u32,
    pub col: u32,
    /// 1 error / 2 warning / 3 info / 4 hint。没给按 error。
    pub severity: u8,
    pub message: String,
    pub code: Option<String>,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct DiagSet {
    generation: u64,
    items: Vec<Diagnostic>,
}

#[derive(Debug)]
struct Doc {
    version: i32,
    text: String,
}

#[derive(Default)]
struct State {
    docs: HashMap<PathBuf, Doc>,
    diags: HashMap<PathBuf, DiagSet>,
    /// 进行中的 `$/progress` token。
    progress: HashSet<String>,
    /// rust-analyzer 的 `experimental/serverStatus.quiescent`。
    quiescent: Option<bool>,
}

struct Shared {
    pending: StdMutex<HashMap<i64, oneshot::Sender<Result<Value, RpcError>>>>,
    next_id: AtomicI64,
    state: StdMutex<State>,
    tick: watch::Sender<u64>,
    generation: AtomicU64,
    alive: AtomicBool,
    settings: Value,
    root_uri: String,
    root_name: String,
}

impl Shared {
    fn bump(&self) {
        self.tick.send_modify(|v| *v = v.wrapping_add(1));
    }

    fn fail_all(&self) {
        self.alive.store(false, Ordering::SeqCst);
        let pending: Vec<_> = self
            .pending
            .lock()
            .map(|mut p| p.drain().map(|(_, tx)| tx).collect())
            .unwrap_or_default();
        for tx in pending {
            let _ = tx.send(Err(RpcError::Dead));
        }
        self.bump();
    }
}

pub struct Client {
    pub lang: Language,
    pub root: PathBuf,
    shared: Arc<Shared>,
    out: mpsc::UnboundedSender<Vec<u8>>,
    /// 握手时协商出来，之后不变。
    encoding: std::sync::OnceLock<Encoding>,
    child: tokio::sync::Mutex<Option<Box<dyn ChildWrapper>>>,
    last_used: StdMutex<Instant>,
    started: Instant,
    reader: tokio::task::JoinHandle<()>,
    writer: tokio::task::JoinHandle<()>,
}

impl Drop for Client {
    fn drop(&mut self) {
        self.reader.abort();
        self.writer.abort();
    }
}

impl std::fmt::Debug for Client {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Client")
            .field("lang", &self.lang)
            .field("root", &self.root)
            .finish_non_exhaustive()
    }
}

impl Client {
    /// 拉起服务器进程并完成握手。
    pub async fn start(
        lang: Language,
        root: &Path,
        cmd: &ServerCommand,
    ) -> Result<Arc<Client>, String> {
        let (child, stdout, stdin) =
            spawn(cmd, root).map_err(|e| format!("cannot start {}: {e}", cmd.program.display()))?;
        Client::connect(
            stdout,
            stdin,
            Some(child),
            lang,
            root,
            cmd.init_options.clone(),
            cmd.settings.clone(),
        )
        .await
    }

    /// 在一对管道上握手。
    pub async fn connect<R, W>(
        reader: R,
        writer: W,
        child: Option<Box<dyn ChildWrapper>>,
        lang: Language,
        root: &Path,
        init_options: Value,
        settings: Value,
    ) -> Result<Arc<Client>, String>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let root_uri = path_to_uri(root).ok_or_else(|| format!("bad root {}", root.display()))?;
        let root_name = root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "root".to_owned());
        let (tick, _) = watch::channel(0u64);
        let shared = Arc::new(Shared {
            pending: StdMutex::new(HashMap::new()),
            next_id: AtomicI64::new(1),
            state: StdMutex::new(State::default()),
            tick,
            generation: AtomicU64::new(0),
            alive: AtomicBool::new(true),
            settings,
            root_uri: root_uri.clone(),
            root_name: root_name.clone(),
        });
        let (out, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();

        let writer_shared = Arc::clone(&shared);
        let writer = tokio::spawn(async move {
            let mut writer = writer;
            while let Some(body) = rx.recv().await {
                if write_frame(&mut writer, &body).await.is_err() {
                    break;
                }
            }
            writer_shared.fail_all();
        });

        let reader_shared = Arc::clone(&shared);
        let reader_out = out.clone();
        let reader = tokio::spawn(async move {
            let mut r = tokio::io::BufReader::new(reader);
            loop {
                match read_frame(&mut r).await {
                    Frame::Eof => break,
                    Frame::TooLarge(n) => {
                        tracing::debug!(bytes = n, "LSP 帧超过上限，已丢弃");
                    }
                    Frame::Body(body) => match serde_json::from_slice::<Value>(&body) {
                        Ok(msg) => dispatch(&reader_shared, &reader_out, msg),
                        Err(e) => tracing::debug!(error = %e, "LSP 帧不是 JSON"),
                    },
                }
            }
            reader_shared.fail_all();
        });

        let client = Arc::new(Client {
            lang,
            root: root.to_path_buf(),
            shared,
            out,
            encoding: std::sync::OnceLock::new(),
            child: tokio::sync::Mutex::new(child),
            last_used: StdMutex::new(Instant::now()),
            started: Instant::now(),
            reader,
            writer,
        });

        let params = json!({
            "processId": std::process::id(),
            "clientInfo": { "name": "riot", "version": env!("CARGO_PKG_VERSION") },
            "rootUri": root_uri,
            "rootPath": root.display().to_string(),
            "workspaceFolders": [{ "uri": root_uri, "name": root_name }],
            "initializationOptions": init_options,
            "capabilities": {
                "general": { "positionEncodings": ["utf-8", "utf-16"] },
                "workspace": {
                    "configuration": true,
                    "workspaceFolders": true,
                    "symbol": { "dynamicRegistration": false }
                },
                "textDocument": {
                    "synchronization": { "dynamicRegistration": false, "didSave": false },
                    "definition": { "linkSupport": true },
                    "typeDefinition": { "linkSupport": true },
                    "implementation": { "linkSupport": true },
                    "references": {},
                    "hover": { "contentFormat": ["markdown", "plaintext"] },
                    "documentSymbol": { "hierarchicalDocumentSymbolSupport": true },
                    "publishDiagnostics": { "relatedInformation": false, "versionSupport": true }
                },
                "window": { "workDoneProgress": true },
                "experimental": { "serverStatusNotification": true }
            }
        });
        let init = match client.request("initialize", params, INIT_TIMEOUT).await {
            Ok(v) => v,
            Err(e) => {
                client.kill().await;
                return Err(format!("{} failed to initialize: {e}", lang.server_name()));
            }
        };
        let encoding = Encoding::from_server(
            init.pointer("/capabilities/positionEncoding")
                .and_then(Value::as_str),
        );
        let _ = client.encoding.set(encoding);
        client.notify("initialized", json!({}));
        tracing::info!(server = lang.server_name(), root = %root.display(), ?encoding, "LSP 握手完成");
        Ok(client)
    }

    pub fn encoding(&self) -> Encoding {
        self.encoding.get().copied().unwrap_or(Encoding::Utf16)
    }

    pub fn is_alive(&self) -> bool {
        self.shared.alive.load(Ordering::SeqCst)
    }

    pub fn touch(&self) {
        if let Ok(mut t) = self.last_used.lock() {
            *t = Instant::now();
        }
    }

    pub fn idle_for(&self) -> Duration {
        self.last_used
            .lock()
            .map(|t| t.elapsed())
            .unwrap_or_default()
    }

    fn send(&self, msg: &Value) {
        if let Ok(body) = serde_json::to_vec(msg) {
            let _ = self.out.send(body);
        }
    }

    pub fn notify(&self, method: &str, params: Value) {
        self.send(&json!({ "jsonrpc": "2.0", "method": method, "params": params }));
    }

    pub async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, RpcError> {
        if !self.is_alive() {
            return Err(RpcError::Dead);
        }
        let id = self.shared.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        if let Ok(mut p) = self.shared.pending.lock() {
            p.insert(id, tx);
        }
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err(RpcError::Dead),
            Err(_) => {
                if let Ok(mut p) = self.shared.pending.lock() {
                    p.remove(&id);
                }
                self.notify("$/cancelRequest", json!({ "id": id }));
                Err(RpcError::Timeout)
            }
        }
    }

    /// 带一次 ContentModified 重试的请求 —— rust-analyzer 在文件刚变过时
    /// 常回这个，意思是"再问一次"。
    pub async fn request_retry(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, RpcError> {
        match self.request(method, params.clone(), timeout).await {
            Err(RpcError::Server { code, .. }) if code == CONTENT_MODIFIED => {
                tokio::time::sleep(Duration::from_millis(300)).await;
                self.request(method, params, timeout).await
            }
            r => r,
        }
    }

    /// 服务器是否已经分析完、可以给出完整答案。
    pub fn is_ready(&self) -> bool {
        let Ok(s) = self.shared.state.lock() else {
            return false;
        };
        match (self.lang, s.quiescent) {
            (_, Some(q)) => q && s.progress.is_empty(),
            // rust-analyzer 声明了 serverStatus：没收到之前不算好。但旧版本
            // 可能不发 —— 握手后 10 秒还没有就退回只看进度。
            (Language::Rust, None) => {
                self.started.elapsed() > Duration::from_secs(10) && s.progress.is_empty()
            }
            (_, None) => s.progress.is_empty(),
        }
    }

    /// 等到就绪或超时。返回是否就绪。
    pub async fn wait_ready(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut rx = self.shared.tick.subscribe();
        loop {
            if self.is_ready() {
                return true;
            }
            if !self.is_alive() {
                return false;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            // 每秒醒一次：Rust 的"10 秒后退回"是按时间判的，不会有通知。
            let wait = left.min(Duration::from_secs(1));
            let _ = tokio::time::timeout(wait, rx.changed()).await;
        }
    }

    /// 把磁盘上的内容同步给服务器。返回是否真的发了 didOpen / didChange。
    pub async fn sync_file(&self, path: &Path) -> Result<bool, String> {
        let text = tokio::fs::read_to_string(path)
            .await
            .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
        Ok(self.sync_text(path, text))
    }

    /// 已打开的文件全部按磁盘重同步一遍（模型可能用 Edit 改过）。
    pub async fn resync_open(&self) {
        let paths: Vec<PathBuf> = self
            .shared
            .state
            .lock()
            .map(|s| s.docs.keys().cloned().collect())
            .unwrap_or_default();
        for p in paths {
            match tokio::fs::read_to_string(&p).await {
                Ok(text) => {
                    self.sync_text(&p, text);
                }
                Err(_) => self.close(&p),
            }
        }
    }

    fn sync_text(&self, path: &Path, text: String) -> bool {
        let Some(uri) = path_to_uri(path) else {
            return false;
        };
        let msg = {
            let Ok(mut s) = self.shared.state.lock() else {
                return false;
            };
            match s.docs.get_mut(path) {
                Some(doc) if doc.text == text => return false,
                Some(doc) => {
                    doc.version += 1;
                    doc.text.clone_from(&text);
                    json!({
                        "jsonrpc": "2.0",
                        "method": "textDocument/didChange",
                        "params": {
                            "textDocument": { "uri": uri, "version": doc.version },
                            "contentChanges": [{ "text": text }]
                        }
                    })
                }
                None => {
                    let msg = json!({
                        "jsonrpc": "2.0",
                        "method": "textDocument/didOpen",
                        "params": { "textDocument": {
                            "uri": uri,
                            "languageId": Language::language_id(path),
                            "version": 1,
                            "text": text
                        }}
                    });
                    s.docs.insert(path.to_path_buf(), Doc { version: 1, text });
                    msg
                }
            }
        };
        self.send(&msg);
        true
    }

    fn close(&self, path: &Path) {
        let removed = self
            .shared
            .state
            .lock()
            .map(|mut s| s.docs.remove(path).is_some())
            .unwrap_or(false);
        if removed && let Some(uri) = path_to_uri(path) {
            self.notify(
                "textDocument/didClose",
                json!({ "textDocument": { "uri": uri } }),
            );
        }
    }

    /// 这个文件目前的诊断代数。0 = 还没收到过。
    pub fn diag_generation(&self, path: &Path) -> u64 {
        self.shared
            .state
            .lock()
            .ok()
            .and_then(|s| s.diags.get(path).map(|d| d.generation))
            .unwrap_or(0)
    }

    pub fn diagnostics(&self, path: &Path) -> Option<Vec<Diagnostic>> {
        self.shared
            .state
            .lock()
            .ok()
            .and_then(|s| s.diags.get(path).map(|d| d.items.clone()))
    }

    /// 等这个文件的诊断比 `after` 新，再等它静下来。超时返回当前已有的。
    pub async fn wait_diagnostics(
        &self,
        path: &Path,
        after: u64,
        timeout: Duration,
    ) -> Option<Vec<Diagnostic>> {
        let deadline = Instant::now() + timeout;
        let mut rx = self.shared.tick.subscribe();
        // 第一段：等到有新的一批。
        loop {
            if self.diag_generation(path) > after || !self.is_alive() {
                break;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return self.diagnostics(path);
            }
            let _ = tokio::time::timeout(left, rx.changed()).await;
        }
        // 第二段：静下来。服务器常常先推一批语法错误、再推一批语义错误。
        loop {
            let seen = self.diag_generation(path);
            let left = deadline.saturating_duration_since(Instant::now());
            let wait = left.min(DIAG_SETTLE);
            if wait.is_zero() {
                break;
            }
            let quiet = tokio::time::timeout(wait, async {
                loop {
                    if rx.changed().await.is_err() {
                        return;
                    }
                    if self.diag_generation(path) != seen {
                        return;
                    }
                }
            })
            .await
            .is_err();
            if quiet {
                break;
            }
        }
        self.diagnostics(path)
    }

    /// 礼貌关闭：shutdown → exit → 杀进程组。
    pub async fn shutdown(&self) {
        if self.is_alive() {
            let _ = self
                .request("shutdown", Value::Null, SHUTDOWN_TIMEOUT)
                .await;
            self.notify("exit", Value::Null);
        }
        self.kill().await;
    }

    async fn kill(&self) {
        let child = self.child.lock().await.take();
        if let Some(mut child) = child {
            // 给 exit 一点时间自己退；退不掉就整组杀。
            let _ = tokio::time::timeout(Duration::from_millis(500), child.wait()).await;
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_millis(500), child.wait()).await;
        }
        self.shared.alive.store(false, Ordering::SeqCst);
    }
}

fn dispatch(shared: &Shared, out: &mpsc::UnboundedSender<Vec<u8>>, msg: Value) {
    let method = msg.get("method").and_then(Value::as_str);
    match (method, msg.get("id")) {
        // 服务器发来的请求：必须应答，否则有的服务器会一直等。
        (Some(method), Some(id)) => {
            let params = msg.get("params").cloned().unwrap_or(Value::Null);
            let result = match method {
                "workspace/configuration" => {
                    let items = params
                        .get("items")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    Value::Array(
                        items
                            .iter()
                            .map(|it| {
                                it.get("section")
                                    .and_then(Value::as_str)
                                    .map(|s| lookup_section(&shared.settings, s))
                                    .unwrap_or(Value::Null)
                            })
                            .collect(),
                    )
                }
                "workspace/workspaceFolders" => {
                    json!([{ "uri": shared.root_uri, "name": shared.root_name }])
                }
                _ => Value::Null,
            };
            let reply = json!({ "jsonrpc": "2.0", "id": id, "result": result });
            if let Ok(body) = serde_json::to_vec(&reply) {
                let _ = out.send(body);
            }
        }
        (Some(method), None) => {
            let params = msg.get("params").cloned().unwrap_or(Value::Null);
            on_notification(shared, method, &params);
            shared.bump();
        }
        (None, Some(id)) => {
            let Some(id) = id.as_i64() else { return };
            let tx = shared.pending.lock().ok().and_then(|mut p| p.remove(&id));
            if let Some(tx) = tx {
                let r = match msg.get("error") {
                    Some(err) => Err(RpcError::Server {
                        code: err.get("code").and_then(Value::as_i64).unwrap_or(0),
                        message: err
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                    }),
                    None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
                };
                let _ = tx.send(r);
            }
        }
        (None, None) => {}
    }
}

fn on_notification(shared: &Shared, method: &str, params: &Value) {
    let Ok(mut s) = shared.state.lock() else {
        return;
    };
    match method {
        "textDocument/publishDiagnostics" => {
            let Some(path) = params
                .get("uri")
                .and_then(Value::as_str)
                .and_then(uri_to_path)
            else {
                return;
            };
            let items = params
                .get("diagnostics")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(parse_diagnostic).collect())
                .unwrap_or_default();
            let generation = shared.generation.fetch_add(1, Ordering::SeqCst) + 1;
            s.diags.insert(path, DiagSet { generation, items });
        }
        "$/progress" => {
            let token = match params.get("token") {
                Some(Value::String(t)) => t.clone(),
                Some(other) => other.to_string(),
                None => return,
            };
            match params.pointer("/value/kind").and_then(Value::as_str) {
                Some("begin") => {
                    s.progress.insert(token);
                }
                Some("end") => {
                    s.progress.remove(&token);
                }
                _ => {}
            }
        }
        "experimental/serverStatus" => {
            s.quiescent = params.get("quiescent").and_then(Value::as_bool);
        }
        _ => {}
    }
}

fn parse_diagnostic(v: &Value) -> Option<Diagnostic> {
    let start = v.pointer("/range/start")?;
    Some(Diagnostic {
        line: u32::try_from(start.get("line")?.as_u64()?).ok()?,
        col: u32::try_from(start.get("character")?.as_u64()?).ok()?,
        severity: v
            .get("severity")
            .and_then(Value::as_u64)
            .and_then(|s| u8::try_from(s).ok())
            .unwrap_or(1),
        message: v.get("message")?.as_str()?.to_owned(),
        code: match v.get("code") {
            Some(Value::String(s)) => Some(s.clone()),
            Some(Value::Number(n)) => Some(n.to_string()),
            _ => None,
        },
        source: v.get("source").and_then(Value::as_str).map(str::to_owned),
    })
}

/// `"python.analysis"` 这样的点路径在设置里取值。
fn lookup_section(settings: &Value, section: &str) -> Value {
    let mut cur = settings;
    for part in section.split('.') {
        match cur.get(part) {
            Some(v) => cur = v,
            None => return Value::Null,
        }
    }
    cur.clone()
}

pub fn path_to_uri(path: &Path) -> Option<String> {
    url::Url::from_file_path(path).ok().map(String::from)
}

/// 服务器给的 URI → 路径。Windows 上有的服务器把盘符冒号编码成 `%3A`
/// （`file:///c%3A/x`），`to_file_path` 不认，先还原。
pub fn uri_to_path(uri: &str) -> Option<PathBuf> {
    let fixed = uri.replacen("%3A", ":", 1).replacen("%3a", ":", 1);
    url::Url::parse(&fixed).ok()?.to_file_path().ok()
}

// ────────────────────────────────────────────────────────────
// 进程
// ────────────────────────────────────────────────────────────

/// 传给语言服务器的宿主环境变量。
///
/// `[约束]` 白名单，同 MCP 的理由：宿主环境里可能有 API key。比 MCP 多
/// 的是工具链定位用的变量 —— 少了 `RUSTUP_HOME` / `CARGO_HOME`，
/// rust-analyzer 找不到 cargo；少了 `VIRTUAL_ENV`，pyright 找不到依赖。
#[cfg(unix)]
const INHERITED: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TMPDIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "CARGO_HOME",
    "RUSTUP_HOME",
    "RUSTUP_TOOLCHAIN",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "NODE_PATH",
    "NVM_DIR",
    "VIRTUAL_ENV",
    "CONDA_PREFIX",
    "PYTHONPATH",
];

#[cfg(windows)]
const INHERITED: &[&str] = &[
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "HOMEDRIVE",
    "HOMEPATH",
    "USERNAME",
    "COMPUTERNAME",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "OS",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "CARGO_HOME",
    "RUSTUP_HOME",
    "RUSTUP_TOOLCHAIN",
    "NODE_PATH",
    "NVM_HOME",
    "NVM_SYMLINK",
    "VIRTUAL_ENV",
    "CONDA_PREFIX",
    "PYTHONPATH",
];

/// 见 riot-mcp 的同名包装器：`CREATE_NO_WINDOW` 必须在 JobObject 之后补上。
#[cfg(windows)]
#[derive(Debug)]
struct NoWindow;

#[cfg(windows)]
impl process_wrap::tokio::CommandWrapper for NoWindow {
    fn pre_spawn(
        &mut self,
        command: &mut tokio::process::Command,
        _core: &CommandWrap,
    ) -> std::io::Result<()> {
        use windows::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};
        command.creation_flags((CREATE_NO_WINDOW | CREATE_SUSPENDED).0);
        Ok(())
    }
}

type Spawned = (
    Box<dyn ChildWrapper>,
    tokio::process::ChildStdout,
    tokio::process::ChildStdin,
);

fn spawn(cmd: &ServerCommand, root: &Path) -> std::io::Result<Spawned> {
    let mut c = tokio::process::Command::new(&cmd.program);
    c.args(&cmd.args)
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env_clear();
    for (k, v) in std::env::vars_os() {
        let Some(name) = k.to_str() else { continue };
        let keep = INHERITED.iter().any(|a| {
            if cfg!(windows) {
                a.eq_ignore_ascii_case(name)
            } else {
                *a == name
            }
        });
        if keep {
            c.env(&k, v);
        }
    }
    // `[约束]` 进程组 / Job Object：typescript-language-server 会再拉起
    // tsserver 子进程，只杀直接子进程会留下孤儿。
    let mut wrap = CommandWrap::from(c);
    #[cfg(unix)]
    wrap.wrap(process_wrap::tokio::ProcessGroup::leader());
    #[cfg(windows)]
    {
        wrap.wrap(process_wrap::tokio::JobObject);
        wrap.wrap(NoWindow);
    }
    let mut child = wrap.spawn()?;
    let stdout = child.stdout().take().expect("stdout 已设为 piped");
    let stdin = child.stdin().take().expect("stdin 已设为 piped");
    let stderr = child.stderr().take().expect("stderr 已设为 piped");
    // stderr 必须排空，否则写满管道后服务器整个卡住。内容只进 debug 日志。
    let name = cmd.program.display().to_string();
    tokio::spawn(async move {
        use tokio::io::AsyncBufReadExt as _;
        let mut lines = tokio::io::BufReader::new(stderr).split(b'\n');
        while let Ok(Some(line)) = lines.next_segment().await {
            let line = String::from_utf8_lossy(&line);
            let line: String = line.chars().take(2000).collect();
            tracing::debug!(server = %name, "{}", line.trim_end());
        }
    });
    Ok((child, stdout, stdin))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 点路径取设置() {
        let s = json!({ "python": { "analysis": { "x": 1 } }, "rust-analyzer": { "a": true } });
        assert_eq!(lookup_section(&s, "python.analysis"), json!({ "x": 1 }));
        assert_eq!(lookup_section(&s, "rust-analyzer"), json!({ "a": true }));
        assert_eq!(lookup_section(&s, "nope.x"), Value::Null);
    }

    #[cfg(unix)]
    #[test]
    fn uri_往返() {
        let p = PathBuf::from("/tmp/a b/中文.rs");
        let uri = path_to_uri(&p).unwrap();
        assert_eq!(uri_to_path(&uri), Some(p));
    }
}
