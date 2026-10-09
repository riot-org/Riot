//! `riot-server`：没有窗口的宿主，只有网页版。
//!
//! 和桌面 `Riot` 是同一份宿主：同一个 `AppState`、同一个内核进程、同一张
//! 命令表（`remote/dispatch.rs`）。区别只有三处：
//!
//! 1. 没有 Tauri。Linux 服务器上 `tauri` crate 要链接 GTK，装不起也起不来。
//! 2. 远程访问一直开着，监听地址来自启动参数而不是设置页 —— 在网页里把
//!    "远程访问"关掉等于把自己锁在门外（见 [`crate::remote::Remote::pin`]）。
//! 3. 前端产物从磁盘上的目录读，不嵌进二进制（见 [`web_dir`]）。
//!
//! 令牌照旧放 `auth.json`（0600）。`[约束]` 启动日志里不打令牌：systemd 下
//! stdout 就是 journal，谁能读日志谁就拿到了主人身份。要登录链接用
//! `riot-server token`，那条命令只在调用者自己的终端里打印。

// 宿主层：真实 socket、真实文件系统。见 clippy.toml。
#![allow(clippy::disallowed_methods)]

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use crate::config::REMOTE_TOKEN_KEY;
use crate::remote::{self, Asset, Assets};
use crate::state::AppState;

/// 默认只听本机。要对外开放得显式给 `--listen 0.0.0.0:7823`，或者前面
/// 挂一个反向代理 —— 网页版没有 TLS（理由见 docs/REMOTE_ACCESS.md §5）。
const DEFAULT_LISTEN: &str = "127.0.0.1:7823";

/// 关闭时最多等内核退多久。systemd 默认给 90 秒，这里远用不到。
const SHUTDOWN_DEADLINE: Duration = Duration::from_secs(10);

const HELP: &str = "\
riot-server — Riot without a window, served as a web UI

USAGE:
    riot-server [serve] [--listen ADDR] [--web-dir DIR]
    riot-server token [--rotate] [--listen ADDR]
    riot-server --version

COMMANDS:
    serve     Run the server (default)
    token     Print the login link (creates a token on first use).
              --rotate invalidates the old one.

OPTIONS:
    --listen ADDR    Address to listen on [env: RIOT_LISTEN] [default: 127.0.0.1:7823]
    --web-dir DIR    Built frontend (the `dist/` folder) [env: RIOT_WEB_DIR]

ENVIRONMENT:
    RIOT_LOG                      Log filter, e.g. `info` or `riot=debug`
    RIOT_REMOTE_ALLOWED_ORIGINS   Extra allowed origins behind a reverse proxy,
                                  e.g. https://riot.example.com
";

enum Command {
    Serve,
    Token { rotate: bool },
}

struct Options {
    command: Command,
    listen: SocketAddr,
    web_dir: Option<PathBuf>,
}

/// 入口。`main.rs` 那样的多调用分发（`--print-env`、`--askpass`）由
/// `src/bin/riot-server.rs` 先做完。
pub fn main() -> ExitCode {
    let opts = match parse_args(std::env::args().skip(1)) {
        Ok(Some(o)) => o,
        Ok(None) => return ExitCode::SUCCESS,
        Err(msg) => {
            eprintln!("riot-server: {msg}\n\n{HELP}");
            return ExitCode::from(2);
        }
    };
    match opts.command {
        Command::Token { rotate } => token(opts.listen, rotate),
        Command::Serve => serve(opts.listen, opts.web_dir),
    }
}

fn parse_args(args: impl Iterator<Item = String>) -> Result<Option<Options>, String> {
    let mut command = Command::Serve;
    let mut listen = std::env::var("RIOT_LISTEN")
        .ok()
        .filter(|s| !s.trim().is_empty());
    let mut web_dir = std::env::var_os("RIOT_WEB_DIR")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    let mut rotate = false;
    let mut args = args.peekable();
    while let Some(a) = args.next() {
        match a.as_str() {
            "-h" | "--help" | "help" => {
                print!("{HELP}");
                return Ok(None);
            }
            "-V" | "--version" => {
                println!("riot-server {}", env!("CARGO_PKG_VERSION"));
                return Ok(None);
            }
            "serve" => command = Command::Serve,
            "token" => command = Command::Token { rotate: false },
            "--rotate" => rotate = true,
            "--listen" => {
                listen = Some(args.next().ok_or("--listen needs an address")?);
            }
            "--web-dir" => {
                web_dir = Some(PathBuf::from(
                    args.next().ok_or("--web-dir needs a directory")?,
                ));
            }
            other => {
                if let Some(v) = other.strip_prefix("--listen=") {
                    listen = Some(v.to_owned());
                } else if let Some(v) = other.strip_prefix("--web-dir=") {
                    web_dir = Some(PathBuf::from(v));
                } else {
                    return Err(format!("unknown argument `{other}`"));
                }
            }
        }
    }
    if let Command::Token { rotate: r } = &mut command {
        *r = rotate;
    } else if rotate {
        return Err("--rotate only goes with `token`".to_owned());
    }
    let raw = listen.unwrap_or_else(|| DEFAULT_LISTEN.to_owned());
    let listen = parse_listen(&raw)?;
    Ok(Some(Options {
        command,
        listen,
        web_dir,
    }))
}

/// `7823`、`:7823`、`0.0.0.0:7823`、`[::]:7823` 都认。
fn parse_listen(raw: &str) -> Result<SocketAddr, String> {
    let raw = raw.trim();
    let port_only = raw.strip_prefix(':').unwrap_or(raw);
    if let Ok(port) = port_only.parse::<u16>() {
        return Ok(SocketAddr::from(([127, 0, 0, 1], port)));
    }
    raw.parse()
        .map_err(|_| format!("`{raw}` is not a listen address (try 127.0.0.1:7823)"))
}

/// 打印登录链接。第一次用时生成令牌落进 auth.json —— 和桌面第一次打开
/// "远程访问"一样。
fn token(listen: SocketAddr, rotate: bool) -> ExitCode {
    let existing = if rotate {
        None
    } else {
        crate::config::load_secret(REMOTE_TOKEN_KEY)
    };
    let token = match existing {
        Some(t) => t,
        None => {
            let t = remote::auth::generate_token();
            if let Err(e) = crate::config::save_key(REMOTE_TOKEN_KEY, &t) {
                eprintln!("riot-server: cannot write the token to auth.json: {e}");
                return ExitCode::FAILURE;
            }
            t
        }
    };
    for url in remote::access_urls(listen) {
        println!("{url}#token={token}");
    }
    if rotate {
        eprintln!(
            "Token rotated. New logins need the new link right away; pages already logged in with the old one keep working until they reconnect."
        );
    }
    ExitCode::SUCCESS
}

fn serve(listen: SocketAddr, web_dir: Option<PathBuf>) -> ExitCode {
    // 先于任何线程：登录环境是 set_var 装进来的（见 init_process）。
    crate::init_process();

    let web_dir = web_dir.map(|d| d.canonicalize().unwrap_or(d));
    let Some(web_dir) = web_dir.or_else(default_web_dir) else {
        eprintln!(
            "riot-server: cannot find the web UI. Build it with `pnpm build` and pass --web-dir <repo>/dist (or set RIOT_WEB_DIR)."
        );
        return ExitCode::FAILURE;
    };
    if !web_dir.join("index.html").is_file() {
        eprintln!(
            "riot-server: {} has no index.html; is it the built frontend (`dist/`)?",
            web_dir.display()
        );
        return ExitCode::FAILURE;
    }

    // restore 在 runtime 之外做，和桌面一样（它是同步的，而且必须先于
    // 任何命令可达）。
    let state = AppState::restore();

    let rt = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("riot-server")
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("riot-server: cannot start the async runtime: {e}");
            return ExitCode::FAILURE;
        }
    };
    rt.block_on(run(state, listen, web_dir))
}

async fn run(state: AppState, listen: SocketAddr, web_dir: PathBuf) -> ExitCode {
    crate::start_background(&state);

    let remote = remote::Remote::default();
    remote.pin(listen);
    remote.attach(remote::HostCtx {
        state: state.clone(),
        terms: state.terminals(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
        assets: Arc::new(DirAssets::new(web_dir.clone())),
    });
    let cfg = state.config().await;
    remote.apply(&cfg.remote).await;
    let Some(addr) = remote.listen_addr().await else {
        let why = remote
            .last_error()
            .map(|e| e.to_string())
            .unwrap_or_else(|| "unknown error".to_owned());
        eprintln!("riot-server: could not listen on {listen}: {why}");
        state.shutdown().await;
        return ExitCode::FAILURE;
    };

    tracing::info!(%addr, web_dir = %web_dir.display(), "riot-server is up");
    eprintln!("Riot is listening on http://{addr}/");
    eprintln!("Run `riot-server token` in your own terminal to get the login link.");
    if !addr.ip().is_loopback() {
        eprintln!(
            "Warning: reachable from the network without TLS. Put it behind a reverse proxy or a tunnel (Tailscale / Cloudflare) before exposing it."
        );
    }

    wait_for_signal().await;
    tracing::info!("shutting down");
    if tokio::time::timeout(SHUTDOWN_DEADLINE, state.shutdown())
        .await
        .is_err()
    {
        tracing::warn!("kernel did not stop in time; exiting anyway");
    }
    ExitCode::SUCCESS
}

/// Ctrl-C，或者 systemd / docker 的 SIGTERM。
async fn wait_for_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        match signal(SignalKind::terminate()) {
            Ok(mut term) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = term.recv() => {}
                }
            }
            Err(e) => {
                tracing::warn!(error = %e, "cannot listen for SIGTERM; only Ctrl-C will stop the server");
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

/// 没给 `--web-dir` 时按发版布局找：二进制旁边的 `web/`，或者
/// `<prefix>/share/riot/web`（`/usr/local/bin/riot-server` 配
/// `/usr/local/share/riot/web`）。开发时退回仓库里的 `dist/`。
fn default_web_dir() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        candidates.push(dir.join("web"));
        candidates.push(dir.join("../share/riot/web"));
    }
    #[cfg(debug_assertions)]
    candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist"));
    candidates
        .into_iter()
        .find(|d| d.join("index.html").is_file())
        .map(|d| d.canonicalize().unwrap_or(d))
}

/// 从磁盘目录端前端产物。
struct DirAssets {
    root: PathBuf,
}

impl DirAssets {
    fn new(root: PathBuf) -> Self {
        Self { root }
    }

    /// URL 路径 → 目录里的文件。任何能走出根目录的写法一律不认。
    fn resolve(&self, path: &str) -> Option<PathBuf> {
        let rel = path.trim_start_matches('/');
        if rel.is_empty() {
            return None;
        }
        let ok = rel
            .split('/')
            .all(|seg| !seg.is_empty() && seg != "." && seg != ".." && !seg.contains('\\'));
        ok.then(|| self.root.join(rel))
    }
}

impl Assets for DirAssets {
    fn get(&self, path: &str) -> Option<Asset> {
        let file = self.resolve(path)?;
        let bytes = std::fs::read(&file).ok()?;
        Some(Asset {
            bytes,
            mime: mime_for(&file).to_owned(),
        })
    }
}

fn mime_for(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    match ext.as_deref() {
        Some("html" | "htm") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json" | "map") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("wasm") => "application/wasm",
        Some("txt") => "text/plain; charset=utf-8",
        Some("pdf") => "application/pdf",
        Some("webmanifest") => "application/manifest+json",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Option<Options>, String> {
        parse_args(args.iter().map(|s| (*s).to_owned()))
    }

    #[test]
    fn 监听地址的几种写法() {
        assert_eq!(
            parse_listen("7823"),
            Ok("127.0.0.1:7823".parse().expect("地址"))
        );
        assert_eq!(
            parse_listen(":8080"),
            Ok("127.0.0.1:8080".parse().expect("地址"))
        );
        assert_eq!(
            parse_listen("0.0.0.0:7823"),
            Ok("0.0.0.0:7823".parse().expect("地址"))
        );
        assert_eq!(
            parse_listen("[::]:7823"),
            Ok("[::]:7823".parse().expect("地址"))
        );
        assert!(parse_listen("localhost").is_err());
    }

    #[test]
    fn 参数解析() {
        let o = parse(&["--listen", "0.0.0.0:9000", "--web-dir=/srv/web"])
            .expect("能解析")
            .expect("不是 help");
        assert!(matches!(o.command, Command::Serve));
        assert_eq!(
            o.listen,
            "0.0.0.0:9000".parse::<SocketAddr>().expect("地址")
        );
        assert_eq!(o.web_dir, Some(PathBuf::from("/srv/web")));

        let o = parse(&["token", "--rotate"])
            .expect("能解析")
            .expect("不是 help");
        assert!(matches!(o.command, Command::Token { rotate: true }));

        assert!(parse(&["--rotate"]).is_err(), "--rotate 只跟 token");
        assert!(parse(&["--bogus"]).is_err());
    }

    #[test]
    fn 静态资源不许走出根目录() {
        let a = DirAssets::new(PathBuf::from("/srv/web"));
        assert_eq!(
            a.resolve("/assets/index-abc.js"),
            Some(PathBuf::from("/srv/web/assets/index-abc.js"))
        );
        for bad in [
            "/../etc/passwd",
            "/assets/../../x",
            "/a//b",
            "/./x",
            "/a\\..\\b",
            "/",
        ] {
            assert_eq!(a.resolve(bad), None, "{bad}");
        }
    }

    #[test]
    fn 入口页是_html() {
        assert!(mime_for(Path::new("index.html")).starts_with("text/html"));
        assert_eq!(mime_for(Path::new("x.WASM")), "application/wasm");
        assert_eq!(mime_for(Path::new("noext")), "application/octet-stream");
    }
}
