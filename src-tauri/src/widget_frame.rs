//! 回答里 HTML/SVG 组件的沙箱页（`assets/widget-frame.html`）。
//!
//! 组件是模型写的 HTML 和脚本，必须和 Riot 的界面隔开：
//!
//! - **不同 origin**：桌面版走自定义协议 `riot-widget://`（Windows 上是
//!   `http://riot-widget.localhost`），网页版走远程服务的 `/__riot_widget`。
//!   iframe 再加 `sandbox="allow-scripts"`、不给 `allow-same-origin`，
//!   落到不透明 origin —— 碰不到界面的 DOM、存储和 IPC。
//! - **自己的 CSP**：不能用 `srcdoc`。srcdoc 继承父页面的 CSP，而界面的 CSP
//!   不许内联脚本，组件一行脚本都跑不了；要放开就得放开整个界面。这一页
//!   由响应头给它单独的一条：脚本只认内联和几个公共 CDN（模型画图常引
//!   Chart.js / D3），不许发请求、不许提交表单、不许再嵌框。
//!
//! 页面内容在前端仓库里只有一份，三处端出它：Tauri 协议（这里的
//! [`response`]）、远程服务的路由（remote/server.rs）、vite 开发服务器
//! （vite.config.ts 的插件，按同一条 CSP 端出）。

/// 沙箱页本体。
pub const HTML: &str = include_str!("../assets/widget-frame.html");

/// 沙箱页的 CSP。改这里要同步 vite.config.ts 里那份（开发服务器用）。
pub const CSP: &str = "default-src 'none'; \
    script-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com; \
    style-src 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; \
    font-src data: https://fonts.gstatic.com https://cdn.jsdelivr.net; \
    img-src data: blob:; media-src data: blob:; \
    connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

/// 桌面版自定义协议的响应。不管请求哪个路径都回这一页 —— 它没有别的资源。
#[cfg(feature = "desktop")]
pub fn response() -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(200)
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Content-Security-Policy", CSP)
        .header("Cache-Control", "no-cache")
        .header("X-Content-Type-Options", "nosniff")
        .body(HTML.as_bytes().to_vec())
        .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}
