//! 运行环境检查：Riot 的几项能力依赖用户机器上的外部程序，缺了不会报错，
//! 只是悄悄不可用（没有 gh 开不了 PR，没有 rust-analyzer 查不了定义）。
//! 设置页把它们一次列清楚：有没有、能不能用、缺了怎么装。
//!
//! 豁免理由：宿主层，探测的就是真实机器上的程序。
#![allow(clippy::disallowed_methods)]

use std::path::Path;
use std::time::Duration;

use riot_lsp::servers::{self, Language};
use serde::Serialize;

/// 一项检查的结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCheck {
    /// `git` / `gh` / `node` / `rust-analyzer` / `typescript-language-server` / `pyright`。
    pub id: String,
    pub ok: bool,
    /// 版本号，或者不能用的原因（英文原话，给人看）。
    pub detail: String,
    /// 缺了 / 不能用时建议跑的命令。
    pub fix: Option<String>,
}

const PROBE_TIMEOUT: Duration = Duration::from_secs(8);

async fn run(program: &str, args: &[&str], cwd: &Path) -> Option<(bool, String)> {
    let path = servers::which(program)?;
    let out = tokio::process::Command::new(path)
        .args(args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    let out = tokio::time::timeout(PROBE_TIMEOUT, out).await.ok()?.ok()?;
    let text = String::from_utf8_lossy(if out.stdout.is_empty() {
        &out.stderr
    } else {
        &out.stdout
    })
    .lines()
    .next()
    .unwrap_or("")
    .trim()
    .to_owned();
    Some((out.status.success(), text))
}

fn install_cmd(mac: &str, win: &str, linux: &str) -> String {
    if cfg!(target_os = "macos") {
        mac.to_owned()
    } else if cfg!(windows) {
        win.to_owned()
    } else {
        linux.to_owned()
    }
}

async fn check_simple(id: &str, args: &[&str], cwd: &Path, fix: String) -> ToolCheck {
    match run(id, args, cwd).await {
        Some((true, v)) => ToolCheck {
            id: id.into(),
            ok: true,
            detail: v,
            fix: None,
        },
        Some((false, v)) => ToolCheck {
            id: id.into(),
            ok: false,
            detail: v,
            fix: Some(fix),
        },
        None => ToolCheck {
            id: id.into(),
            ok: false,
            detail: "not installed".into(),
            fix: Some(fix),
        },
    }
}

async fn check_gh(cwd: &Path) -> ToolCheck {
    let install = install_cmd(
        "brew install gh",
        "winget install GitHub.cli",
        "see https://cli.github.com",
    );
    let Some((true, version)) = run("gh", &["--version"], cwd).await else {
        return ToolCheck {
            id: "gh".into(),
            ok: false,
            detail: "not installed".into(),
            fix: Some(install),
        };
    };
    match run("gh", &["auth", "status"], cwd).await {
        Some((true, _)) => ToolCheck {
            id: "gh".into(),
            ok: true,
            detail: version,
            fix: None,
        },
        _ => ToolCheck {
            id: "gh".into(),
            ok: false,
            detail: format!("{version} — not logged in"),
            fix: Some("gh auth login".into()),
        },
    }
}

async fn check_lsp(lang: Language, cwd: &Path) -> ToolCheck {
    let id = lang.server_name();
    match servers::discover(lang, cwd).await {
        Ok(cmd) => ToolCheck {
            id: id.into(),
            ok: true,
            detail: cmd.program.display().to_string(),
            fix: None,
        },
        Err(why) => {
            // 安装命令在说明的反引号里：取第一段放进 fix。detail 只留
            // "为什么不能用"那一句 —— 界面上安装命令已经单独显示了。
            let fix = why.split('`').nth(1).map(str::to_owned);
            let detail = why
                .split(" Install it with")
                .next()
                .unwrap_or(&why)
                .trim()
                .to_owned();
            ToolCheck {
                id: id.into(),
                ok: false,
                detail,
                fix,
            }
        }
    }
}

/// 跑全部检查（并行）。`root` 给 rust-analyzer 用 —— 它要按项目的工具链判断。
pub async fn check(root: Option<&Path>) -> Vec<ToolCheck> {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let cwd = root.map(Path::to_path_buf).unwrap_or(home);
    let (git, gh, node, ra, ts, py) = tokio::join!(
        check_simple(
            "git",
            &["--version"],
            &cwd,
            install_cmd(
                "xcode-select --install",
                "winget install Git.Git",
                "sudo apt install git"
            ),
        ),
        check_gh(&cwd),
        check_simple(
            "node",
            &["--version"],
            &cwd,
            install_cmd(
                "brew install node",
                "winget install OpenJS.NodeJS",
                "see https://nodejs.org"
            ),
        ),
        check_lsp(Language::Rust, &cwd),
        check_lsp(Language::TypeScript, &cwd),
        check_lsp(Language::Python, &cwd),
    );
    vec![git, gh, node, ra, ts, py]
}
