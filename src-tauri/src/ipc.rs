//! 宿主往观看者推东西用的那几样类型：`Channel`、`State`、`spawn`。
//!
//! 桌面构建（`desktop` 特性）直接用 Tauri 的 —— 前端经 IPC 传进来的就是
//! `tauri::ipc::Channel`，这里不能换成别的类型。无界面构建（`riot-server`）
//! 里没有 Tauri：Linux 上的 `tauri` crate 无条件链接 GTK，服务器上装不起、
//! 也起不来。于是这里给出同名同形状的实现，宿主其余代码只认 `crate::ipc`，
//! 不知道自己编进了哪一种。
//!
//! `[约束]` 两套实现的公开形状必须一致：`Channel::new(闭包)`、`send`、
//! `Clone`；`InvokeResponseBody::{Json, Raw}`；`Response::new` + `IpcResponse::body`。
//! 只在一边存在的方法会让另一种构建编不过 —— CI 两种都编。

use std::future::Future;

#[cfg(feature = "desktop")]
pub use tauri::ipc::{Channel, InvokeResponseBody, IpcResponse, Response};

#[cfg(not(feature = "desktop"))]
pub use headless::{Channel, InvokeResponseBody, IpcResponse, Response};

/// 通道闭包报错时用的错误类型。远程连接断了就回一个 `BrokenPipe`。
#[cfg(feature = "desktop")]
pub fn closed_error(msg: &'static str) -> tauri::Error {
    tauri::Error::Io(std::io::Error::new(std::io::ErrorKind::BrokenPipe, msg))
}

#[cfg(not(feature = "desktop"))]
pub fn closed_error(msg: &'static str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::BrokenPipe, msg)
}

/// 命令拿到的共享状态。
///
/// 不直接用 `tauri::State`：远程分发（`remote/dispatch.rs`）要拿自己手里的
/// 引用造一个出来调同一个命令函数，而 `tauri::State` 没有公开的构造。桌面
/// 那边经 [`tauri::ipc::CommandArg`] 从 Tauri 的托管状态里取，结果一样。
pub struct State<'r, T: Send + Sync + 'static>(&'r T);

impl<'r, T: Send + Sync + 'static> State<'r, T> {
    pub fn from_ref(inner: &'r T) -> Self {
        Self(inner)
    }

    pub fn inner(&self) -> &'r T {
        self.0
    }
}

impl<T: Send + Sync + 'static> Clone for State<'_, T> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<T: Send + Sync + 'static> Copy for State<'_, T> {}

impl<T: Send + Sync + 'static> std::ops::Deref for State<'_, T> {
    type Target = T;
    fn deref(&self) -> &T {
        self.0
    }
}

#[cfg(feature = "desktop")]
impl<'r, 'de: 'r, T: Send + Sync + 'static, R: tauri::Runtime> tauri::ipc::CommandArg<'de, R>
    for State<'r, T>
{
    fn from_command(
        command: tauri::ipc::CommandItem<'de, R>,
    ) -> Result<Self, tauri::ipc::InvokeError> {
        let s: tauri::State<'r, T> = tauri::ipc::CommandArg::from_command(command)?;
        Ok(Self(s.inner()))
    }
}

/// 起一个后台任务。
///
/// `[约束]` 桌面上不能用裸 `tokio::spawn`：Tauri 的 setup 回调跑在 macOS 的
/// AppKit 主线程上，不在任何 tokio runtime 的上下文里，裸 spawn 会当场
/// panic（no reactor running）。有当前 runtime 就用它，没有才落到 Tauri
/// 自己那个全局 runtime。无界面构建一切都跑在 `main` 的 runtime 里。
pub fn spawn<F>(fut: F)
where
    F: Future<Output = ()> + Send + 'static,
{
    #[cfg(feature = "desktop")]
    {
        if let Ok(h) = tokio::runtime::Handle::try_current() {
            h.spawn(fut);
        } else {
            tauri::async_runtime::spawn(fut);
        }
    }
    #[cfg(not(feature = "desktop"))]
    {
        tokio::spawn(fut);
    }
}

#[cfg(not(feature = "desktop"))]
mod headless {
    use std::marker::PhantomData;
    use std::sync::Arc;

    use serde::Serialize;

    pub type Result<T> = std::result::Result<T, std::io::Error>;

    /// 一条消息的载荷：序列化好的 JSON，或原始字节（浏览器画面帧、文件内容）。
    #[derive(Debug, Clone)]
    pub enum InvokeResponseBody {
        Json(String),
        Raw(Vec<u8>),
    }

    /// 能作为消息发出去的东西。任何 `Serialize` 走 JSON；
    /// [`InvokeResponseBody`] 和 [`Response`] 原样透传。
    pub trait IpcResponse {
        fn body(self) -> Result<InvokeResponseBody>;
    }

    impl<T: Serialize> IpcResponse for T {
        fn body(self) -> Result<InvokeResponseBody> {
            serde_json::to_string(&self)
                .map(InvokeResponseBody::Json)
                .map_err(std::io::Error::other)
        }
    }

    impl IpcResponse for InvokeResponseBody {
        fn body(self) -> Result<InvokeResponseBody> {
            Ok(self)
        }
    }

    /// 命令的原始字节返回值（对应 Tauri 的 `ipc::Response`）。
    pub struct Response {
        body: InvokeResponseBody,
    }

    impl Response {
        pub fn new(bytes: Vec<u8>) -> Self {
            Self {
                body: InvokeResponseBody::Raw(bytes),
            }
        }
    }

    impl IpcResponse for Response {
        fn body(self) -> Result<InvokeResponseBody> {
            Ok(self.body)
        }
    }

    type OnMessage = dyn Fn(InvokeResponseBody) -> Result<()> + Send + Sync;

    /// 往一个观看者推消息的出口。浅拷贝，和 Tauri 的一样。
    pub struct Channel<T = InvokeResponseBody> {
        on_message: Arc<OnMessage>,
        phantom: PhantomData<fn(T)>,
    }

    impl<T> Clone for Channel<T> {
        fn clone(&self) -> Self {
            Self {
                on_message: Arc::clone(&self.on_message),
                phantom: PhantomData,
            }
        }
    }

    impl<T> std::fmt::Debug for Channel<T> {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("Channel")
        }
    }

    impl<T> Channel<T> {
        pub fn new<F>(on_message: F) -> Self
        where
            F: Fn(InvokeResponseBody) -> Result<()> + Send + Sync + 'static,
        {
            Self {
                on_message: Arc::new(on_message),
                phantom: PhantomData,
            }
        }

        pub fn send(&self, data: T) -> Result<()>
        where
            T: IpcResponse,
        {
            (self.on_message)(data.body()?)
        }
    }
}
