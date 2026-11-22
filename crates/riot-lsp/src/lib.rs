//! LSP 客户端：给模型「跳转定义、查引用、看类型、列符号、看诊断」。
//!
//! # 为什么要有
//!
//! Grep 找得到字符串，找不准符号：同名方法十几个、trait 实现散在各处、
//! 重导出换了名字 —— 这些 grep 都要人肉排除，而语言服务器一次答对。
//! 编辑后的诊断也一样：不用等一次完整编译，改错了当场就知道。
//!
//! # 结构
//!
//! - [`framing`] —— `Content-Length` 分帧。
//! - [`client`] —— 一条连接：握手、文件同步、诊断与就绪状态。
//! - [`servers`] —— 语言、项目根、服务器程序的识别（只用用户装好的）。
//! - [`position`] —— 「行 + 符号名」和 LSP 位置之间的换算。
//! - [`render`] —— 结果排版成给模型看的文本。
//! - [`tool`] —— [`LspTool`]：模型调用的那个工具。
//! - [`edit_hook`] —— [`WithDiagnostics`]：包在 Edit / Write 外面，
//!   改完把新的错误附在结果后面。
//! - [`LspHub`] —— 内核级的连接池：按（语言, 项目根）一个服务器，
//!   会话之间共享，空闲久了自己关。

pub mod client;
pub mod edit_hook;
pub mod framing;
pub mod position;
pub mod render;
pub mod servers;
pub mod tool;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};
use std::time::Duration;

pub use client::Client;
pub use edit_hook::WithDiagnostics;
pub use servers::Language;
pub use tool::LspTool;

/// 空闲多久关掉。rust-analyzer 在大仓库上常驻 1–2 GB，不能一直留着。
const IDLE_SHUTDOWN: Duration = Duration::from_secs(20 * 60);

/// 同时最多几个服务器。超出时关掉最久没用的那个。
const MAX_SERVERS: usize = 6;

type Key = (Language, PathBuf);
type Cell = Arc<tokio::sync::OnceCell<Result<Arc<Client>, String>>>;

/// 内核级的语言服务器池。
pub struct LspHub {
    cells: tokio::sync::Mutex<HashMap<Key, Cell>>,
    reaper: std::sync::Once,
}

impl Default for LspHub {
    fn default() -> Self {
        Self {
            cells: tokio::sync::Mutex::new(HashMap::new()),
            reaper: std::sync::Once::new(),
        }
    }
}

impl std::fmt::Debug for LspHub {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("LspHub")
    }
}

impl LspHub {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// 拿一个连接，没有就拉起来。同一个（语言, 根）并发来的请求只拉一次。
    ///
    /// 失败不缓存：模型照提示装好服务器之后，下一次调用应该能直接成功。
    pub async fn client(
        self: &Arc<Self>,
        lang: Language,
        root: &Path,
    ) -> Result<Arc<Client>, String> {
        self.start_reaper();
        let key = (lang, root.to_path_buf());
        let cell = {
            let mut cells = self.cells.lock().await;
            // 死掉的连接（服务器崩了）清掉重来。
            if let Some(c) = cells.get(&key)
                && matches!(c.get(), Some(Ok(client)) if !client.is_alive())
            {
                cells.remove(&key);
            }
            Arc::clone(cells.entry(key.clone()).or_default())
        };
        let result = cell
            .get_or_init(|| async {
                let cmd = servers::discover(lang, root).await?;
                tracing::info!(server = %cmd.program.display(), root = %root.display(), "拉起语言服务器");
                Client::start(lang, root, &cmd).await
            })
            .await
            .clone();
        match &result {
            Ok(_) => self.evict_over_limit(&key).await,
            Err(_) => {
                let mut cells = self.cells.lock().await;
                if cells.get(&key).is_some_and(|c| Arc::ptr_eq(c, &cell)) {
                    cells.remove(&key);
                }
            }
        }
        result
    }

    /// 已经在跑的连接；不拉新的。
    pub async fn running(&self, lang: Language, root: &Path) -> Option<Arc<Client>> {
        let cells = self.cells.lock().await;
        match cells.get(&(lang, root.to_path_buf()))?.get()? {
            Ok(c) if c.is_alive() => Some(Arc::clone(c)),
            _ => None,
        }
    }

    async fn evict_over_limit(&self, keep: &Key) {
        let victim = {
            let cells = self.cells.lock().await;
            if cells.len() <= MAX_SERVERS {
                return;
            }
            cells
                .iter()
                .filter(|(k, _)| *k != keep)
                .filter_map(|(k, c)| match c.get() {
                    Some(Ok(client)) => Some((k.clone(), client.idle_for())),
                    _ => None,
                })
                .max_by_key(|(_, idle)| *idle)
                .map(|(k, _)| k)
        };
        if let Some(k) = victim {
            self.stop(&k).await;
        }
    }

    async fn stop(&self, key: &Key) {
        let cell = self.cells.lock().await.remove(key);
        if let Some(cell) = cell
            && let Some(Ok(client)) = cell.get()
        {
            tracing::info!(server = key.0.server_name(), root = %key.1.display(), "关闭语言服务器");
            client.shutdown().await;
        }
    }

    fn start_reaper(self: &Arc<Self>) {
        let weak: Weak<Self> = Arc::downgrade(self);
        self.reaper.call_once(|| {
            tokio::spawn(async move {
                loop {
                    #[allow(clippy::disallowed_methods)]
                    // 豁免理由：后台清扫按真实时间走，和会话的确定性无关。
                    tokio::time::sleep(Duration::from_secs(60)).await;
                    let Some(hub) = weak.upgrade() else { return };
                    let idle: Vec<Key> = {
                        let cells = hub.cells.lock().await;
                        cells
                            .iter()
                            .filter_map(|(k, c)| match c.get() {
                                Some(Ok(client))
                                    if !client.is_alive() || client.idle_for() > IDLE_SHUTDOWN =>
                                {
                                    Some(k.clone())
                                }
                                _ => None,
                            })
                            .collect()
                    };
                    for k in idle {
                        hub.stop(&k).await;
                    }
                }
            });
        });
    }

    /// 关闭全部。内核 shutdown 时调。
    pub async fn shutdown(&self) {
        let keys: Vec<Key> = self.cells.lock().await.keys().cloned().collect();
        for k in keys {
            self.stop(&k).await;
        }
    }
}

/// Windows 的 canonicalize 会带 `\\?\` 前缀；比较路径前去掉。
pub(crate) fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\")
        && !rest.starts_with("UNC\\")
    {
        return PathBuf::from(rest.to_owned());
    }
    p
}
