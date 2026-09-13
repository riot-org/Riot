//! HTTP 传输：MCP 的 Streamable HTTP（2025-03-26 起），以及旧的 HTTP+SSE
//! （2024-11-05）。
//!
//! # 形状
//!
//! [`Client`](crate::Client) 只认"一边读行、一边写行"的字节流。这里不改它，
//! 而是把 HTTP 适配成一对管道：客户端往管道里写的每一行变成一次 POST，
//! 服务器经 HTTP 回来的每条消息变成管道里的一行。握手、超时、取消、
//! 服务器主动的通知全部沿用 stdio 那套代码 —— 传输层的差异被压在这个
//! 文件里，别处一行不动。
//!
//! # Streamable HTTP
//!
//! - 每条出站消息 `POST <url>`，`Accept: application/json, text/event-stream`。
//!   服务器回 202 = 收到（通知/应答），回 JSON = 单条应答，回 SSE = 一串
//!   消息直到它关流。
//! - `initialize` 的应答头里若有 `Mcp-Session-Id`，之后每个请求都带上；
//!   握手成功后还开一条 `GET` 事件流收服务器主动发的消息（`tools/list_changed`
//!   走这里）。服务器不支持（405）就算了。
//! - 出站的每条消息各起一个任务发：工具调用可能跑几分钟，串行发的话一次
//!   长调用会把心跳的应答也堵住。
//!
//! # 旧 HTTP+SSE
//!
//! 先 `GET` 开事件流，第一个 `endpoint` 事件给出 POST 地址；之后出站走
//! POST 到那个地址，入站全部从事件流来。
//!
//! # 信任边界
//!
//! 远端服务器和 stdio 那些一样过权限闸（`McpTool` 不看传输）。多出来的
//! 一条：`headers` 里的东西是**明文配置**，不是密钥机制；宿主也不会把
//! 任何环境变量塞进去。
//!
//! 豁免理由：传输层，操作的就是真实网络；超时用真实时钟。
#![allow(clippy::disallowed_methods)]

use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt as _;
use serde_json::Value;
use tokio::io::{
    AsyncBufReadExt as _, AsyncWriteExt as _, BufReader, DuplexStream, ReadHalf, WriteHalf,
};
use tokio::sync::{Mutex, mpsc};
use tokio_util::sync::CancellationToken;

/// 单条消息的 HTTP 往返上限。工具调用可能真跑十分钟（对齐
/// `Timeouts::call`），再往上就是服务器挂了。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(600);
/// 建连上限。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// 旧 SSE 等 `endpoint` 事件的上限。
const ENDPOINT_TIMEOUT: Duration = Duration::from_secs(20);
/// 管道缓冲。一条大工具结果几 MB 是有的。
const PIPE_BUF: usize = 4 * 1024 * 1024;
/// 我们说的协议版本（`MCP-Protocol-Version` 头）。
const PROTOCOL_VERSION: &str = "2025-06-18";

/// 连上去，返回给 [`Client::connect`](crate::Client::connect) 用的读写两端。
///
/// Streamable HTTP 是惰性的：这里不发任何请求，第一条 `initialize` 才会
/// 真正碰网络，失败以 JSON-RPC 错误应答的形式回到客户端（握手因此失败，
/// 原因带 HTTP 状态或网络错误原文）。旧 SSE 要先开流拿 endpoint，这里就会
/// 失败。
///
/// `cancel` 取消时所有 HTTP 任务停下、管道关闭。
pub(crate) async fn connect(
    url: String,
    headers: Vec<(String, String)>,
    legacy_sse: bool,
    cancel: CancellationToken,
) -> std::io::Result<(ReadHalf<DuplexStream>, WriteHalf<DuplexStream>)> {
    let http = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        // 不设整体超时：SSE 流是长连接。单次 POST 的上限自己掐。
        .build()
        .map_err(|e| std::io::Error::other(format!("http client: {e}")))?;

    // 两端：客户端那一侧交出去；我们这一侧读它写的行、往它写服务器的消息。
    let (client_side, server_side) = tokio::io::duplex(PIPE_BUF);
    let (client_read, client_write) = tokio::io::split(client_side);
    let (from_client, to_client) = tokio::io::split(server_side);

    let (inbound_tx, inbound_rx) = mpsc::unbounded_channel::<String>();
    // 写任务：所有入站消息串成行。一个写者，顺序无所谓（JSON-RPC 按 id 配对）。
    spawn_writer(to_client, inbound_rx, cancel.clone());

    let shared = Arc::new(Shared {
        http,
        url,
        headers,
        session_id: Mutex::new(None),
        protocol_version: Mutex::new(None),
        inbound: inbound_tx,
        cancel,
    });

    let mode = if legacy_sse {
        // 先开流：endpoint 事件不来就什么都发不了。
        let endpoint = open_legacy_stream(Arc::clone(&shared)).await?;
        Outbound::Legacy { endpoint }
    } else {
        Outbound::Streamable
    };
    tokio::spawn(pump_outbound(from_client, shared, mode));

    Ok((client_read, client_write))
}

struct Shared {
    http: reqwest::Client,
    url: String,
    headers: Vec<(String, String)>,
    session_id: Mutex<Option<String>>,
    protocol_version: Mutex<Option<String>>,
    inbound: mpsc::UnboundedSender<String>,
    cancel: CancellationToken,
}

impl Shared {
    /// 配置里的头 + 会话头。
    async fn decorate(
        &self,
        mut req: reqwest::RequestBuilder,
        with_version: bool,
    ) -> reqwest::RequestBuilder {
        for (k, v) in &self.headers {
            req = req.header(k, v);
        }
        if let Some(sid) = self.session_id.lock().await.as_deref() {
            req = req.header("Mcp-Session-Id", sid);
        }
        if with_version {
            let v = self.protocol_version.lock().await.clone();
            req = req.header(
                "MCP-Protocol-Version",
                v.as_deref().unwrap_or(PROTOCOL_VERSION),
            );
        }
        req
    }
}

enum Outbound {
    Streamable,
    Legacy { endpoint: String },
}

fn spawn_writer(
    mut to_client: WriteHalf<DuplexStream>,
    mut inbound: mpsc::UnboundedReceiver<String>,
    cancel: CancellationToken,
) {
    tokio::spawn(async move {
        loop {
            let line = tokio::select! {
                l = inbound.recv() => match l { Some(l) => l, None => break },
                _ = cancel.cancelled() => break,
            };
            if to_client.write_all(line.as_bytes()).await.is_err()
                || to_client.write_all(b"\n").await.is_err()
                || to_client.flush().await.is_err()
            {
                break;
            }
        }
        let _ = to_client.shutdown().await;
    });
}

/// 读客户端写出的每一行，各起一个任务发出去。行读完（客户端被 drop）=
/// 会话结束：Streamable 下顺手 DELETE 一下会话。
async fn pump_outbound(from_client: ReadHalf<DuplexStream>, shared: Arc<Shared>, mode: Outbound) {
    let mut reader = BufReader::new(from_client);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let n = tokio::select! {
            r = reader.read_until(b'\n', &mut buf) => r.unwrap_or(0),
            _ = shared.cancel.cancelled() => 0,
        };
        if n == 0 {
            break;
        }
        let line = String::from_utf8_lossy(&buf).trim().to_owned();
        if line.is_empty() {
            continue;
        }
        let shared = Arc::clone(&shared);
        match &mode {
            Outbound::Streamable => {
                tokio::spawn(async move { post_streamable(shared, line).await });
            }
            Outbound::Legacy { endpoint } => {
                let endpoint = endpoint.clone();
                tokio::spawn(async move { post_legacy(shared, &endpoint, line).await });
            }
        }
    }
    if matches!(mode, Outbound::Streamable) {
        let sid = shared.session_id.lock().await.clone();
        if let Some(sid) = sid {
            let _ = shared
                .http
                .delete(&shared.url)
                .header("Mcp-Session-Id", sid)
                .timeout(Duration::from_secs(5))
                .send()
                .await;
        }
    }
}

/// 一次 Streamable HTTP 的 POST。
async fn post_streamable(shared: Arc<Shared>, line: String) {
    let msg: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
    let id = msg.get("id").cloned();
    let is_initialize = msg.get("method").and_then(Value::as_str) == Some("initialize");

    let req = shared
        .http
        .post(&shared.url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .timeout(REQUEST_TIMEOUT)
        .body(line);
    let req = shared.decorate(req, !is_initialize).await;

    let res = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            fail(&shared, id, format!("HTTP request failed: {e}"));
            return;
        }
    };
    let status = res.status();
    if status.as_u16() == 202 {
        return; // 通知 / 应答被收下了，没有正文。
    }
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        let detail = body.trim().chars().take(300).collect::<String>();
        fail(
            &shared,
            id,
            if detail.is_empty() {
                format!("HTTP {status}")
            } else {
                format!("HTTP {status}: {detail}")
            },
        );
        return;
    }
    if is_initialize
        && let Some(sid) = res
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
    {
        *shared.session_id.lock().await = Some(sid.to_owned());
    }

    let content_type = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();

    let mut negotiated = false;
    if content_type.starts_with("text/event-stream") {
        let mut stream = res.bytes_stream();
        let mut parser = SseParser::default();
        loop {
            let chunk = tokio::select! {
                c = stream.next() => c,
                _ = shared.cancel.cancelled() => None,
            };
            let Some(Ok(chunk)) = chunk else { break };
            for event in parser.push(&chunk) {
                if let Some(data) = event.data {
                    negotiated |= deliver(&shared, &data, is_initialize).await;
                }
            }
        }
    } else {
        let body = match res.text().await {
            Ok(b) => b,
            Err(e) => {
                fail(&shared, id, format!("reading response body: {e}"));
                return;
            }
        };
        if !body.trim().is_empty() {
            negotiated = deliver(&shared, &body, is_initialize).await;
        }
    }
    // 握手成功之后才开通知流：它要带会话 id 和协议版本。
    if negotiated {
        tokio::spawn(open_notification_stream(Arc::clone(&shared)));
    }
}

/// 一次旧 SSE 协议的 POST：应答从事件流来，这里只管发出去。
async fn post_legacy(shared: Arc<Shared>, endpoint: &str, line: String) {
    let msg: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
    let id = msg.get("id").cloned();
    let req = shared
        .http
        .post(endpoint)
        .header("Content-Type", "application/json")
        .timeout(REQUEST_TIMEOUT)
        .body(line);
    let req = shared.decorate(req, false).await;
    match req.send().await {
        Ok(res) if res.status().is_success() => {
            // 一些实现直接在 POST 应答里回 JSON（而不是走流）。有正文就当消息。
            if let Ok(body) = res.text().await
                && body.trim_start().starts_with('{')
            {
                deliver(&shared, &body, false).await;
            }
        }
        Ok(res) => fail(&shared, id, format!("HTTP {}", res.status())),
        Err(e) => fail(&shared, id, format!("HTTP request failed: {e}")),
    }
}

/// 开旧协议的 GET 事件流，等到 `endpoint` 事件后返回 POST 地址；之后的
/// `message` 事件由后台任务持续送进管道。
async fn open_legacy_stream(shared: Arc<Shared>) -> std::io::Result<String> {
    let req = shared
        .http
        .get(&shared.url)
        .header("Accept", "text/event-stream");
    let req = shared.decorate(req, false).await;
    let res = req
        .send()
        .await
        .map_err(|e| std::io::Error::other(format!("GET {}: {e}", shared.url)))?;
    if !res.status().is_success() {
        return Err(std::io::Error::other(format!(
            "GET {} returned HTTP {}",
            shared.url,
            res.status()
        )));
    }

    let (endpoint_tx, endpoint_rx) = tokio::sync::oneshot::channel::<String>();
    let base = shared.url.clone();
    let shared2 = Arc::clone(&shared);
    tokio::spawn(async move {
        let mut stream = res.bytes_stream();
        let mut parser = SseParser::default();
        let mut endpoint_tx = Some(endpoint_tx);
        loop {
            let chunk = tokio::select! {
                c = stream.next() => c,
                _ = shared2.cancel.cancelled() => None,
            };
            let Some(Ok(chunk)) = chunk else { break };
            for event in parser.push(&chunk) {
                if event.name.as_deref() == Some("endpoint") {
                    if let (Some(tx), Some(data)) = (endpoint_tx.take(), event.data) {
                        let _ = tx.send(resolve_endpoint(&base, &data));
                    }
                } else if let Some(data) = event.data {
                    deliver(&shared2, &data, false).await;
                }
            }
        }
    });

    match tokio::time::timeout(ENDPOINT_TIMEOUT, endpoint_rx).await {
        Ok(Ok(ep)) => Ok(ep),
        Ok(Err(_)) => Err(std::io::Error::other(
            "SSE stream closed before the endpoint event",
        )),
        Err(_) => Err(std::io::Error::other(
            "no endpoint event from the SSE stream",
        )),
    }
}

/// `endpoint` 事件里的地址可以是相对的，按流的地址解析。
fn resolve_endpoint(base: &str, data: &str) -> String {
    url::Url::parse(base)
        .and_then(|b| b.join(data.trim()))
        .map(|u| u.to_string())
        .unwrap_or_else(|_| data.trim().to_owned())
}

/// 握手成功后开一条 GET 流收服务器主动的消息。不支持就算了。
async fn open_notification_stream(shared: Arc<Shared>) {
    let req = shared
        .http
        .get(&shared.url)
        .header("Accept", "text/event-stream");
    let req = shared.decorate(req, true).await;
    let Ok(res) = req.send().await else { return };
    if !res.status().is_success() {
        return; // 405 = 服务器不开服务器→客户端流，正常。
    }
    let mut stream = res.bytes_stream();
    let mut parser = SseParser::default();
    loop {
        let chunk = tokio::select! {
            c = stream.next() => c,
            _ = shared.cancel.cancelled() => None,
        };
        let Some(Ok(chunk)) = chunk else { break };
        for event in parser.push(&chunk) {
            if let Some(data) = event.data {
                deliver(&shared, &data, false).await;
            }
        }
    }
}

/// 把服务器的一条（或一批）消息送进管道。`initialize` 的应答顺手记下
/// 协商到的协议版本；返回 true = 这就是那条应答（调用方据此开通知流）。
async fn deliver(shared: &Arc<Shared>, data: &str, is_initialize: bool) -> bool {
    let parsed: Value = match serde_json::from_str(data) {
        Ok(v) => v,
        Err(_) => {
            tracing::debug!("MCP HTTP: 忽略一条不是 JSON 的事件数据");
            return false;
        }
    };
    let items: Vec<Value> = match parsed {
        Value::Array(a) => a,
        v => vec![v],
    };
    let mut negotiated = false;
    for item in items {
        if is_initialize
            && let Some(v) = item
                .pointer("/result/protocolVersion")
                .and_then(Value::as_str)
        {
            *shared.protocol_version.lock().await = Some(v.to_owned());
            negotiated = true;
        }
        let _ = shared.inbound.send(item.to_string());
    }
    negotiated
}

/// 给客户端合成一条 JSON-RPC 错误应答，让等着的请求立刻失败而不是超时。
fn fail(shared: &Shared, id: Option<Value>, message: String) {
    tracing::warn!(url = %shared.url, %message, "MCP HTTP 请求失败");
    let Some(id) = id else { return };
    let err = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": -32000, "message": message }
    });
    let _ = shared.inbound.send(err.to_string());
}

/// 一条 SSE 事件。
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct SseEvent {
    pub name: Option<String>,
    pub data: Option<String>,
}

/// 增量的 SSE 解析器：喂字节，吐完整事件。按空行切事件；`data:` 多行用
/// `\n` 拼；`:` 开头是注释；`\r\n` 和 `\n` 都认。
#[derive(Default)]
pub(crate) struct SseParser {
    buf: Vec<u8>,
    name: Option<String>,
    data: Vec<String>,
}

impl SseParser {
    pub(crate) fn push(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(nl) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=nl).collect();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim_end_matches(['\n', '\r']);
            if line.is_empty() {
                if self.name.is_some() || !self.data.is_empty() {
                    out.push(SseEvent {
                        name: self.name.take(),
                        data: if self.data.is_empty() {
                            None
                        } else {
                            Some(std::mem::take(&mut self.data).join("\n"))
                        },
                    });
                }
                continue;
            }
            if line.starts_with(':') {
                continue;
            }
            let (field, value) = match line.split_once(':') {
                Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
                None => (line, ""),
            };
            match field {
                "event" => self.name = Some(value.to_owned()),
                "data" => self.data.push(value.to_owned()),
                _ => {} // id / retry：不需要
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_按空行切事件_多行_data_拼接_注释忽略() {
        let mut p = SseParser::default();
        let mut got = p.push(b": keep-alive\nevent: message\ndata: {\"a\":\ndata: 1}\n\n");
        got.extend(p.push(b"data: solo\r\n\r\n"));
        assert_eq!(
            got,
            vec![
                SseEvent {
                    name: Some("message".into()),
                    data: Some("{\"a\":\n1}".into()),
                },
                SseEvent {
                    name: None,
                    data: Some("solo".into()),
                },
            ]
        );
    }

    #[test]
    fn sse_跨_chunk_的半行要攒着() {
        let mut p = SseParser::default();
        assert!(p.push(b"data: hel").is_empty());
        assert!(p.push(b"lo\n").is_empty(), "事件要等空行");
        let got = p.push(b"\n");
        assert_eq!(got[0].data.as_deref(), Some("hello"));
    }

    #[test]
    fn 相对_endpoint_按流地址解析() {
        assert_eq!(
            resolve_endpoint("https://a.example/sse", "/messages?sid=1"),
            "https://a.example/messages?sid=1"
        );
        assert_eq!(
            resolve_endpoint("https://a.example/sse", "https://b.example/m"),
            "https://b.example/m"
        );
    }

    /// 起一个假的 Streamable HTTP 服务器，走完整握手 + tools/list。
    /// 覆盖三种应答形态：202、JSON、SSE，以及会话头的往返。
    #[tokio::test]
    async fn streamable_http_能握手并列出工具() {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("监听");
        let url = format!("http://{}/mcp", listener.local_addr().expect("地址"));
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 64 * 1024];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let body = req.split("\r\n\r\n").nth(1).unwrap_or("").to_owned();
                    let msg: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
                    let id = msg.get("id").cloned().unwrap_or(Value::Null);
                    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
                    let (status, headers, payload) = match method {
                        "initialize" => (
                            "200 OK",
                            "Content-Type: application/json\r\nMcp-Session-Id: sess-1\r\n",
                            serde_json::json!({
                                "jsonrpc": "2.0", "id": id,
                                "result": {
                                    "protocolVersion": "2025-06-18",
                                    "serverInfo": { "name": "fake-http", "version": "1" },
                                    "capabilities": {}
                                }
                            })
                            .to_string(),
                        ),
                        // 工具清单走 SSE 应答，验证流式那条路。要求带会话头
                        //（hyper 发出去的头名是小写的，按大小写无关比）。
                        "tools/list"
                            if req.to_ascii_lowercase().contains("mcp-session-id: sess-1") =>
                        {
                            (
                                "200 OK",
                                "Content-Type: text/event-stream\r\n",
                                format!(
                                    "event: message\ndata: {}\n\n",
                                    serde_json::json!({
                                        "jsonrpc": "2.0", "id": id,
                                        "result": { "tools": [{ "name": "ping", "inputSchema": {"type":"object"} }] }
                                    })
                                ),
                            )
                        }
                        "tools/list" => ("400 Bad Request", "", "missing session".to_owned()),
                        // 通知（initialized）→ 202，无正文。
                        _ if id.is_null() => ("202 Accepted", "", String::new()),
                        _ => ("404 Not Found", "", String::new()),
                    };
                    let head = format!(
                        "HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n",
                        payload.len()
                    );
                    let _ = sock.write_all(head.as_bytes()).await;
                    let _ = sock.write_all(payload.as_bytes()).await;
                    let _ = sock.shutdown().await;
                });
            }
        });

        let cancel = CancellationToken::new();
        let (r, w) = connect(url, vec![], false, cancel.clone())
            .await
            .expect("惰性连接不会失败");
        let timeouts = crate::Timeouts {
            connect: Duration::from_secs(5),
            request: Duration::from_secs(5),
            call: Duration::from_secs(5),
        };
        let (client, hello) = crate::Client::connect(r, w, timeouts).await.expect("握手");
        assert_eq!(hello.name, "fake-http");
        let tools = client.list_tools().await.expect("列工具");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "ping");
        cancel.cancel();
    }

    /// 连不上的地址：握手要以一条能读懂的错误失败，而不是傻等到超时。
    #[tokio::test]
    async fn 连不上时握手立刻失败() {
        // 先占一个端口再关掉，拿一个此刻必然拒绝连接的地址。
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("监听");
        let url = format!("http://{}/mcp", listener.local_addr().expect("地址"));
        drop(listener);

        let cancel = CancellationToken::new();
        let (r, w) = connect(url, vec![], false, cancel.clone())
            .await
            .expect("惰性");
        let timeouts = crate::Timeouts {
            connect: Duration::from_secs(10),
            request: Duration::from_secs(10),
            call: Duration::from_secs(10),
        };
        let started = std::time::Instant::now();
        let err = match crate::Client::connect(r, w, timeouts).await {
            Ok(_) => panic!("连不上的地址不该握手成功"),
            Err(e) => e,
        };
        assert!(
            matches!(err, crate::ClientError::Rpc { .. }),
            "要以合成的 JSON-RPC 错误失败（带原因），实际：{err:?}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(8),
            "不该等到超时才失败"
        );
        cancel.cancel();
    }
}
