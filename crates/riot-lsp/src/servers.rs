//! 语言、项目根、服务器程序的识别。
//!
//! # 只用用户自己装的服务器
//!
//! `[约束]` 不从项目目录里找服务器（`node_modules/.bin`、`.venv/bin`）。
//! 那是仓库里的代码：克隆一个陌生仓库、问一句"这个函数在哪定义"，
//! 不该变成执行仓库作者放进去的程序。只认 PATH、rustup 和几个常见的
//! 全局安装位置。找不到就明说怎么装，让模型经 Bash（走权限确认）去装
//! 或者退回 Grep —— 用户同意这一步由现有的权限系统负责，不另开通道。
//!
//! # 关掉会执行项目代码的功能
//!
//! rust-analyzer 默认会跑 build.rs 和过程宏 —— 两者都是仓库里的任意代码。
//! 这里关掉（见 [`rust_settings`]），代价是宏展开出来的东西看不见、
//! 相关诊断不全；完整的编译检查仍然交给 `Diagnostics`（走权限确认）。
//! TypeScript 指定全局的 tsserver，不加载项目 `node_modules` 里的那份。

#![allow(clippy::disallowed_methods)]
// 豁免理由：识别阶段要看真实文件系统（项目标记文件、PATH 上的程序）
// 并试跑一次 `--version`。这些只决定"用哪个程序"，不参与黄金回放。

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Language {
    Rust,
    TypeScript,
    Python,
}

impl Language {
    pub fn for_path(path: &Path) -> Option<Self> {
        let ext = path.extension()?.to_str()?.to_ascii_lowercase();
        match ext.as_str() {
            "rs" => Some(Language::Rust),
            "ts" | "tsx" | "mts" | "cts" | "js" | "jsx" | "mjs" | "cjs" => {
                Some(Language::TypeScript)
            }
            "py" | "pyi" => Some(Language::Python),
            _ => None,
        }
    }

    /// `textDocument/didOpen` 里的 languageId。
    pub fn language_id(path: &Path) -> &'static str {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase)
            .unwrap_or_default();
        match ext.as_str() {
            "rs" => "rust",
            "tsx" => "typescriptreact",
            "jsx" => "javascriptreact",
            "js" | "mjs" | "cjs" => "javascript",
            "py" | "pyi" => "python",
            _ => "typescript",
        }
    }

    pub fn server_name(self) -> &'static str {
        match self {
            Language::Rust => "rust-analyzer",
            Language::TypeScript => "typescript-language-server",
            Language::Python => "pyright",
        }
    }

    /// 找不到服务器时给模型的安装说明。
    pub fn install_hint(self) -> &'static str {
        match self {
            Language::Rust => {
                "Install it with `rustup component add rust-analyzer` (run it inside the project \
                 so it matches the project's rust-toolchain)."
            }
            Language::TypeScript => {
                "Install it with `npm install -g typescript-language-server typescript` \
                 (needs Node.js)."
            }
            Language::Python => {
                "Install it with `npm install -g pyright` (needs Node.js) or `pip install pyright`."
            }
        }
    }

    fn root_markers(self) -> &'static [&'static str] {
        match self {
            Language::Rust => &["Cargo.toml"],
            Language::TypeScript => &["tsconfig.json", "jsconfig.json", "package.json"],
            Language::Python => &[
                "pyrightconfig.json",
                "pyproject.toml",
                "setup.py",
                "setup.cfg",
            ],
        }
    }
}

/// 一个文件所属的项目根。
///
/// - Rust：最近的 `Cargo.toml`；再往上若有声明 `[workspace]` 的
///   `Cargo.toml`，取最上面那个 —— rust-analyzer 以 workspace 为单位分析，
///   从成员 crate 起会把同一个 workspace 加载两遍。
/// - TypeScript：最近的 tsconfig / jsconfig，没有才用 package.json。
/// - Python：最近的 pyrightconfig / pyproject / setup.*。
///
/// 都找不到时用 `fallback`（会话目录）。
pub fn find_root(lang: Language, file: &Path, fallback: &Path) -> PathBuf {
    let start = if file.is_dir() {
        file
    } else {
        file.parent().unwrap_or(file)
    };
    let found = match lang {
        Language::Rust => {
            let nearest = nearest_with(start, &["Cargo.toml"]);
            nearest.map(|n| {
                let mut top = n.clone();
                for dir in n.ancestors().skip(1) {
                    let manifest = dir.join("Cargo.toml");
                    if std::fs::read_to_string(&manifest)
                        .is_ok_and(|s| s.lines().any(|l| l.trim() == "[workspace]"))
                    {
                        top = dir.to_path_buf();
                    }
                }
                top
            })
        }
        Language::TypeScript => nearest_with(start, &["tsconfig.json", "jsconfig.json"])
            .or_else(|| nearest_with(start, &["package.json"])),
        Language::Python => nearest_with(start, lang.root_markers()),
    };
    found.unwrap_or_else(|| fallback.to_path_buf())
}

fn nearest_with(start: &Path, markers: &[&str]) -> Option<PathBuf> {
    start
        .ancestors()
        .find(|d| markers.iter().any(|m| d.join(m).is_file()))
        .map(Path::to_path_buf)
}

/// 拉起服务器要的全部东西。
#[derive(Debug, Clone)]
pub struct ServerCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// `initialize` 的 `initializationOptions`。
    pub init_options: Value,
    /// `workspace/configuration` 回给服务器的设置（按 section）。
    pub settings: Value,
}

/// 找一个能用的服务器。找不到返回给模型看的说明。
pub async fn discover(lang: Language, root: &Path) -> Result<ServerCommand, String> {
    match lang {
        Language::Rust => discover_rust(root).await,
        Language::TypeScript => discover_ts(),
        Language::Python => discover_python(),
    }
}

/// rust-analyzer 的设置：关掉一切会执行项目代码的东西。
pub fn rust_settings() -> Value {
    json!({
        "cargo": { "buildScripts": { "enable": false } },
        "procMacro": { "enable": false },
        // 保存时跑 cargo check = 跑 build.rs。完整检查交给 Diagnostics 工具。
        "checkOnSave": false,
        "check": { "command": "check" },
        // 自己盯文件变化：模型用 Edit 改了没打开过的文件，服务器也得知道。
        "files": { "watcher": "server" },
        // 关了过程宏以后这几类报错全是噪音，会让模型去"修"根本不存在的问题。
        "diagnostics": {
            "disabled": [
                "unresolved-proc-macro",
                "unresolved-macro-call",
                "macro-error",
                "proc-macro-disabled",
                "unresolved-env-var",
                "inactive-code"
            ]
        }
    })
}

async fn discover_rust(root: &Path) -> Result<ServerCommand, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    candidates.extend(which("rust-analyzer"));
    if let Some(home) = home_dir() {
        candidates.push(home.join(".cargo").join("bin").join(exe("rust-analyzer")));
    }
    // `rustup which` 给的是工具链里的真身。PATH 上的 rust-analyzer 往往只是
    // rustup 的代理，组件没装时一跑就报 "Unknown binary"。
    if let Some(p) = rustup_which(root).await {
        candidates.push(p);
    }
    candidates.dedup();
    let mut tried = Vec::new();
    for c in candidates {
        if !c.is_file() {
            continue;
        }
        if runs_ok(&c, root).await {
            let settings = rust_settings();
            return Ok(ServerCommand {
                program: c,
                args: Vec::new(),
                init_options: settings.clone(),
                settings: json!({ "rust-analyzer": settings }),
            });
        }
        tried.push(c.display().to_string());
    }
    let why = if tried.is_empty() {
        "rust-analyzer is not installed.".to_owned()
    } else {
        format!(
            "rust-analyzer was found ({}) but does not run for this project — usually the \
             rustup component is missing for the project's toolchain.",
            tried.join(", ")
        )
    };
    Err(format!("{why} {}", Language::Rust.install_hint()))
}

async fn rustup_which(root: &Path) -> Option<PathBuf> {
    let rustup = which("rustup").or_else(|| {
        home_dir()
            .map(|h| h.join(".cargo").join("bin").join(exe("rustup")))
            .filter(|p| p.is_file())
    })?;
    let out = command(&rustup)
        .args(["which", "rust-analyzer"])
        .current_dir(root)
        .output();
    let out = tokio::time::timeout(Duration::from_secs(10), out)
        .await
        .ok()?
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let p = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
    p.is_file().then_some(p)
}

/// 试跑 `--version`：区分"装了"和"只是个代理壳"。
async fn runs_ok(program: &Path, cwd: &Path) -> bool {
    let out = command(program).arg("--version").current_dir(cwd).output();
    matches!(
        tokio::time::timeout(Duration::from_secs(15), out).await,
        Ok(Ok(o)) if o.status.success()
    )
}

fn discover_ts() -> Result<ServerCommand, String> {
    let Some(program) = which("typescript-language-server") else {
        return Err(format!(
            "typescript-language-server is not installed. {}",
            Language::TypeScript.install_hint()
        ));
    };
    // 全局 tsserver：和语言服务器装在同一个全局 node_modules 下。
    let Some(tsserver) = global_tsserver(&program) else {
        return Err(format!(
            "typescript-language-server is installed but no global `typescript` package was \
             found next to it (Riot does not load the project's own copy). {}",
            Language::TypeScript.install_hint()
        ));
    };
    Ok(ServerCommand {
        program,
        args: vec!["--stdio".to_owned()],
        init_options: json!({
            "tsserver": { "path": tsserver },
            "disableAutomaticTypingAcquisition": true,
        }),
        settings: json!({}),
    })
}

/// 从语言服务器的位置推出全局 `typescript/lib/tsserver.js`。
///
/// - Unix：`bin/typescript-language-server` 是指向
///   `lib/node_modules/typescript-language-server/lib/cli.mjs` 的链接，
///   顺着真身往上找到 `node_modules`；
/// - Windows：`%APPDATA%\npm\typescript-language-server.cmd`，旁边就是
///   `node_modules`。
fn global_tsserver(program: &Path) -> Option<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(real) = std::fs::canonicalize(program)
        && let Some(nm) = real
            .ancestors()
            .find(|d| d.file_name().is_some_and(|n| n == "node_modules"))
    {
        roots.push(nm.to_path_buf());
    }
    if let Some(bin) = program.parent() {
        roots.push(bin.join("node_modules"));
        if let Some(prefix) = bin.parent() {
            roots.push(prefix.join("lib").join("node_modules"));
        }
    }
    roots
        .into_iter()
        .map(|nm| nm.join("typescript").join("lib").join("tsserver.js"))
        .find(|p| p.is_file())
}

fn discover_python() -> Result<ServerCommand, String> {
    for name in ["pyright-langserver", "basedpyright-langserver"] {
        if let Some(program) = which(name) {
            return Ok(ServerCommand {
                program,
                args: vec!["--stdio".to_owned()],
                init_options: json!({}),
                settings: json!({
                    "python": { "analysis": {
                        "autoSearchPaths": true,
                        "diagnosticMode": "openFilesOnly",
                        "useLibraryCodeForTypes": true
                    }}
                }),
            });
        }
    }
    Err(format!(
        "pyright is not installed. {}",
        Language::Python.install_hint()
    ))
}

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    }
}

fn home_dir() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// 在 PATH 上找程序。Windows 按 PATHEXT 补扩展名（npm 装的是 `.cmd`）。
pub fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".EXE;.CMD;.BAT".to_owned())
            .split(';')
            .filter(|s| !s.is_empty())
            .map(str::to_ascii_lowercase)
            .collect()
    } else {
        vec![String::new()]
    };
    for dir in std::env::split_paths(&path) {
        for ext in &exts {
            let p = dir.join(format!("{name}{ext}"));
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// 不弹窗、不继承控制台的命令（只用于识别阶段的短命令）。
fn command(program: &Path) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        // 这里是裸的 tokio Command（没有 process-wrap 的 JobObject 改写
        // 标志位），直接设就生效。
        use windows::Win32::System::Threading::CREATE_NO_WINDOW;
        cmd.creation_flags(CREATE_NO_WINDOW.0);
    }
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(p: &Path, text: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    #[test]
    fn 按扩展名认语言() {
        assert_eq!(
            Language::for_path(Path::new("a/b.rs")),
            Some(Language::Rust)
        );
        assert_eq!(
            Language::for_path(Path::new("a.TSX")),
            Some(Language::TypeScript)
        );
        assert_eq!(
            Language::for_path(Path::new("a.py")),
            Some(Language::Python)
        );
        assert_eq!(Language::for_path(Path::new("Makefile")), None);
        assert_eq!(Language::language_id(Path::new("x.jsx")), "javascriptreact");
    }

    #[test]
    fn rust_取最上面的_workspace() {
        let t = tempfile::tempdir().unwrap();
        let ws = t.path();
        touch(
            &ws.join("Cargo.toml"),
            "[workspace]\nmembers = [\"crates/*\"]\n",
        );
        touch(&ws.join("crates/a/Cargo.toml"), "[package]\nname = \"a\"\n");
        let file = ws.join("crates/a/src/lib.rs");
        touch(&file, "");
        assert_eq!(find_root(Language::Rust, &file, Path::new("/x")), ws);
    }

    #[test]
    fn rust_没有_workspace_时取最近的_crate() {
        let t = tempfile::tempdir().unwrap();
        touch(
            &t.path().join("Cargo.toml"),
            "[package]\nname = \"outer\"\n",
        );
        let inner = t.path().join("inner");
        touch(&inner.join("Cargo.toml"), "[package]\nname = \"inner\"\n");
        let file = inner.join("src/main.rs");
        touch(&file, "");
        assert_eq!(find_root(Language::Rust, &file, Path::new("/x")), inner);
    }

    #[test]
    fn ts_优先_tsconfig_找不到退回会话目录() {
        let t = tempfile::tempdir().unwrap();
        touch(&t.path().join("package.json"), "{}");
        let app = t.path().join("app");
        touch(&app.join("tsconfig.json"), "{}");
        let file = app.join("src/x.ts");
        touch(&file, "");
        assert_eq!(find_root(Language::TypeScript, &file, Path::new("/x")), app);

        let lone = tempfile::tempdir().unwrap();
        let f = lone.path().join("a.py");
        touch(&f, "");
        // 临时目录往上可能碰巧有 pyproject（开发机上不太可能），只断言不 panic
        // 且结果是 f 的某个祖先或 fallback。
        let r = find_root(Language::Python, &f, Path::new("/fallback"));
        assert!(r == Path::new("/fallback") || f.starts_with(&r));
    }

    #[test]
    fn 全局_tsserver_从_windows_布局推出() {
        let t = tempfile::tempdir().unwrap();
        let bin = t.path().join("npm");
        let program = bin.join("typescript-language-server.cmd");
        touch(&program, "");
        let tsserver = bin.join("node_modules/typescript/lib/tsserver.js");
        touch(&tsserver, "");
        assert_eq!(global_tsserver(&program), Some(tsserver));
    }

    #[test]
    fn 全局_tsserver_从_unix_布局推出() {
        let t = tempfile::tempdir().unwrap();
        let prefix = t.path();
        let program = prefix.join("bin/typescript-language-server");
        touch(&program, "");
        let tsserver = prefix.join("lib/node_modules/typescript/lib/tsserver.js");
        touch(&tsserver, "");
        assert_eq!(global_tsserver(&program), Some(tsserver));
    }
}
