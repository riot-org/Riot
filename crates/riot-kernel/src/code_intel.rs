//! 代码智能（LSP）在内核里的挂点。
//!
//! 语言服务器池是**进程级**的一份：rust-analyzer 一个项目一份就够，
//! 同一个项目开几个会话不该各起一个吃 2 GB 的进程。所以用静态单例，
//! 而不是挂在某个会话上。内核关闭时由 [`crate::manager::SessionManager::shutdown`]
//! 统一收掉。

use std::sync::{Arc, OnceLock};

use riot_lsp::{LspHub, LspTool, WithDiagnostics};
use riot_protocol::Tool;

static HUB: OnceLock<Arc<LspHub>> = OnceLock::new();

pub fn hub() -> Arc<LspHub> {
    Arc::clone(HUB.get_or_init(LspHub::new))
}

/// 模型用的 `Lsp` 工具。
pub fn tool() -> Arc<dyn Tool> {
    Arc::new(LspTool::new(hub()))
}

/// 给 Edit / Write 套上"改完附带诊断"。名字、描述、schema 原样，
/// prompt cache 的前缀不变；没有服务器在跑时行为逐字节不变。
pub fn decorate_edits(tools: &mut [Arc<dyn Tool>]) {
    let hub = hub();
    for t in tools.iter_mut() {
        if matches!(t.name(), "Edit" | "Write") {
            *t = WithDiagnostics::wrap(Arc::clone(t), Arc::clone(&hub));
        }
    }
}

/// 内核关闭时调。没起过服务器就什么都不做。
pub async fn shutdown() {
    if let Some(h) = HUB.get() {
        h.shutdown().await;
    }
}
