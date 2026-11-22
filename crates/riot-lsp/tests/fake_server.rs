//! 客户端对一个假服务器的往返：握手、编码协商、配置代答、文件同步、
//! 诊断等待、进度与就绪、服务器退出。
//!
//! 豁免理由：等的是内存管道上另一个任务的应答，用真实时钟做超时。
#![allow(clippy::disallowed_methods)]

use std::path::PathBuf;
use std::time::Duration;

use riot_lsp::client::{Client, path_to_uri};
use riot_lsp::framing::{Frame, read_frame, write_frame};
use riot_lsp::position::Encoding;
use riot_lsp::servers::Language;
use serde_json::{Value, json};
use tokio::io::{BufReader, DuplexStream, ReadHalf, WriteHalf};
use tokio::sync::mpsc;

struct Server {
    r: BufReader<ReadHalf<DuplexStream>>,
    w: WriteHalf<DuplexStream>,
}

impl Server {
    async fn recv(&mut self) -> Value {
        match read_frame(&mut self.r).await {
            Frame::Body(b) => serde_json::from_slice(&b).unwrap(),
            other => panic!("unexpected {other:?}"),
        }
    }
    async fn send(&mut self, v: Value) {
        write_frame(&mut self.w, &serde_json::to_vec(&v).unwrap())
            .await
            .unwrap();
    }
}

async fn pair(
    encoding: &str,
    lang: Language,
    root: &std::path::Path,
) -> (std::sync::Arc<Client>, Server) {
    let (client_side, server_side) = tokio::io::duplex(1 << 20);
    let (cr, cw) = tokio::io::split(client_side);
    let (sr, sw) = tokio::io::split(server_side);
    let mut server = Server {
        r: BufReader::new(sr),
        w: sw,
    };
    let root = root.to_path_buf();
    let settings = json!({ "rust-analyzer": { "procMacro": { "enable": false } } });
    let connect = tokio::spawn(async move {
        Client::connect(cr, cw, None, lang, &root, json!({}), settings).await
    });
    let init = server.recv().await;
    assert_eq!(init["method"], "initialize");
    assert_eq!(
        init["params"]["capabilities"]["general"]["positionEncodings"],
        json!(["utf-8", "utf-16"])
    );
    server
        .send(json!({ "jsonrpc": "2.0", "id": init["id"],
            "result": { "capabilities": { "positionEncoding": encoding } } }))
        .await;
    let initialized = server.recv().await;
    assert_eq!(initialized["method"], "initialized");
    (connect.await.unwrap().unwrap(), server)
}

#[tokio::test]
async fn 握手协商编码_并代答配置请求() {
    let dir = tempfile::tempdir().unwrap();
    let (client, mut server) = pair("utf-8", Language::Rust, dir.path()).await;
    assert_eq!(client.encoding(), Encoding::Utf8);

    server
        .send(
            json!({ "jsonrpc": "2.0", "id": 99, "method": "workspace/configuration",
            "params": { "items": [{ "section": "rust-analyzer" }, { "section": "nope" }] } }),
        )
        .await;
    let reply = server.recv().await;
    assert_eq!(reply["id"], 99);
    assert_eq!(
        reply["result"],
        json!([{ "procMacro": { "enable": false } }, null])
    );
}

#[tokio::test]
async fn 同步文件_没变不重发_变了发全文() {
    let dir = tempfile::tempdir().unwrap();
    let f: PathBuf = dir.path().join("a.rs");
    std::fs::write(&f, "fn a() {}").unwrap();
    let (client, mut server) = pair("utf-16", Language::Rust, dir.path()).await;

    assert!(client.sync_file(&f).await.unwrap());
    let open = server.recv().await;
    assert_eq!(open["method"], "textDocument/didOpen");
    assert_eq!(open["params"]["textDocument"]["languageId"], "rust");
    assert_eq!(open["params"]["textDocument"]["version"], 1);

    assert!(!client.sync_file(&f).await.unwrap(), "内容没变不该再发");

    std::fs::write(&f, "fn b() {}").unwrap();
    assert!(client.sync_file(&f).await.unwrap());
    let change = server.recv().await;
    assert_eq!(change["method"], "textDocument/didChange");
    assert_eq!(change["params"]["textDocument"]["version"], 2);
    assert_eq!(change["params"]["contentChanges"][0]["text"], "fn b() {}");
}

#[tokio::test]
async fn 诊断等新的一批并等它静下来() {
    let dir = tempfile::tempdir().unwrap();
    let f = dir.path().join("a.rs");
    std::fs::write(&f, "x").unwrap();
    let (client, mut server) = pair("utf-16", Language::Rust, dir.path()).await;
    let uri = path_to_uri(&f).unwrap();

    let before = client.diag_generation(&f);
    assert_eq!(before, 0);
    let (tx, mut rx) = mpsc::unbounded_channel();
    let c = std::sync::Arc::clone(&client);
    let f2 = f.clone();
    tokio::spawn(async move {
        let r = c
            .wait_diagnostics(&f2, before, Duration::from_secs(5))
            .await;
        let _ = tx.send(r);
    });
    // 两批：先空、再带一条错误。等待方应该拿到第二批。
    server
        .send(
            json!({ "jsonrpc": "2.0", "method": "textDocument/publishDiagnostics",
            "params": { "uri": uri, "diagnostics": [] } }),
        )
        .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    server
        .send(json!({ "jsonrpc": "2.0", "method": "textDocument/publishDiagnostics",
            "params": { "uri": uri, "diagnostics": [{
                "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 1 } },
                "severity": 1, "message": "cannot find value `x`", "code": "E0425" }] } }))
        .await;
    let got = rx.recv().await.unwrap().unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].message, "cannot find value `x`");
    assert_eq!(got[0].code.as_deref(), Some("E0425"));
}

#[tokio::test]
async fn rust_要等空闲信号才算就绪() {
    let dir = tempfile::tempdir().unwrap();
    let (client, mut server) = pair("utf-8", Language::Rust, dir.path()).await;
    assert!(!client.is_ready(), "rust-analyzer 刚握手还在建索引");
    server
        .send(json!({ "jsonrpc": "2.0", "method": "$/progress",
            "params": { "token": "idx", "value": { "kind": "begin", "title": "Indexing" } } }))
        .await;
    server
        .send(
            json!({ "jsonrpc": "2.0", "method": "experimental/serverStatus",
            "params": { "health": "ok", "quiescent": true } }),
        )
        .await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!client.is_ready(), "进度没结束不算就绪");
    server
        .send(json!({ "jsonrpc": "2.0", "method": "$/progress",
            "params": { "token": "idx", "value": { "kind": "end" } } }))
        .await;
    assert!(client.wait_ready(Duration::from_secs(2)).await);
}

#[tokio::test]
async fn 其他语言握手完就绪_服务器退出后请求立即失败() {
    let dir = tempfile::tempdir().unwrap();
    let (client, server) = pair("utf-16", Language::TypeScript, dir.path()).await;
    assert!(client.is_ready());
    drop(server);
    tokio::time::sleep(Duration::from_millis(50)).await;
    let r = client
        .request("textDocument/hover", json!({}), Duration::from_secs(5))
        .await;
    assert!(r.is_err());
    assert!(!client.is_alive());
}

#[tokio::test]
async fn 请求带回服务器的错误() {
    let dir = tempfile::tempdir().unwrap();
    let (client, mut server) = pair("utf-16", Language::Python, dir.path()).await;
    let c = std::sync::Arc::clone(&client);
    let req = tokio::spawn(async move {
        c.request(
            "workspace/symbol",
            json!({ "query": "x" }),
            Duration::from_secs(5),
        )
        .await
    });
    let got = server.recv().await;
    server
        .send(json!({ "jsonrpc": "2.0", "id": got["id"],
            "error": { "code": -32801, "message": "content modified" } }))
        .await;
    match req.await.unwrap() {
        Err(riot_lsp::client::RpcError::Server { code, .. }) => assert_eq!(code, -32801),
        other => panic!("{other:?}"),
    }
}
