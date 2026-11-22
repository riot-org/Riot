//! `riot`：命令行入口。
//!
//! # 为什么不直接用主程序
//!
//! Windows 正式版的 `Riot.exe` 是窗口程序（`windows_subsystem = "windows"`，
//! 不弹黑框）。cmd 和 PowerShell **不等窗口程序结束**：提示符立刻回来，输出
//! 随后乱入，退出码也拿不到 —— 而 `riot exec` 就是给脚本和 CI 用的，等待和
//! 退出码恰恰最不能错。
//!
//! 这里是一个控制台程序（和 Visual Studio 的 `devenv.com` 搭 `devenv.exe` 同一
//! 个套路）：找到主程序，把自己的 stdin / stdout / stderr 原样交给它跑
//! `exec`，等它结束，带着它的退出码退出。逻辑一行不重复，都在主程序里。
//!
//! # 平台
//!
//! - Unix：直接 `exec()` 把自己换成主程序 —— 没有中间进程，Ctrl-C、管道、
//!   退出码全是主程序自己的。
//! - Windows：子进程（窗口程序）不挂在控制台上，收不到 Ctrl-C。这里接住
//!   Ctrl-C，结束子进程并以 130 退出（主程序的内核在 Job Object 里，跟着
//!   一起走）。
//!
//! # 怎么找到主程序
//!
//! 1. 自己旁边有 `riot.target`（Windows 的「安装命令行工具」把启动器复制到
//!    用户目录时写的）：里面是主程序的完整路径；
//! 2. 否则在自己真实位置（解析软链接之后）的旁边找 `Riot` / `Riot.exe`：
//!    安装包里两者在同一个目录（macOS 是 `Riot.app/Contents/MacOS/`）。
//!
//! 豁免理由：它的全部职责就是读真实文件、起真实进程，不参与黄金回放。
#![allow(clippy::disallowed_methods)]

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

const HELP: &str = "\
riot — Riot from the command line

USAGE:
    riot exec [OPTIONS] <PROMPT>     Run one task without a UI and exit
    riot exec --help                 All options for exec

Runs inside the Riot app installed on this machine, with its model settings.
";

const MAIN_EXE: &str = if cfg!(windows) { "Riot.exe" } else { "Riot" };
const TARGET_FILE: &str = "riot.target";

/// 找主程序。见模块文档。
fn locate_app(me: &Path) -> Result<PathBuf, String> {
    let real = std::fs::canonicalize(me).unwrap_or_else(|_| me.to_path_buf());
    let dir = real.parent().ok_or("cannot tell where riot is installed")?;
    if let Ok(text) = std::fs::read_to_string(dir.join(TARGET_FILE)) {
        let p = PathBuf::from(text.trim());
        if p.is_file() {
            return Ok(p);
        }
        return Err(format!(
            "{} points to {}, which no longer exists. Reinstall the command line tool from \
             Riot's Settings → General.",
            dir.join(TARGET_FILE).display(),
            p.display()
        ));
    }
    let p = dir.join(MAIN_EXE);
    if p.is_file() {
        Ok(p)
    } else {
        Err(format!(
            "cannot find {} next to {}",
            MAIN_EXE,
            real.display()
        ))
    }
}

fn main() -> ExitCode {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    match args.first().and_then(|a| a.to_str()) {
        None | Some("-h" | "--help" | "help") => {
            print!("{HELP}");
            return ExitCode::SUCCESS;
        }
        Some("-V" | "--version") => {
            println!("riot {}", env!("CARGO_PKG_VERSION"));
            return ExitCode::SUCCESS;
        }
        Some("exec") => {}
        Some(other) => {
            eprintln!("riot: unknown command `{other}`\n\n{HELP}");
            return ExitCode::from(2);
        }
    }
    let me = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("riot: cannot locate itself: {e}");
            return ExitCode::FAILURE;
        }
    };
    let app = match locate_app(&me) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("riot: {e}");
            return ExitCode::FAILURE;
        }
    };
    let mut cmd = Command::new(&app);
    cmd.args(&args);
    run(cmd, &app)
}

#[cfg(unix)]
fn run(mut cmd: Command, app: &Path) -> ExitCode {
    use std::os::unix::process::CommandExt as _;
    // 成功就不会回来。
    let e = cmd.exec();
    eprintln!("riot: cannot start {}: {e}", app.display());
    ExitCode::FAILURE
}

#[cfg(windows)]
fn run(mut cmd: Command, app: &Path) -> ExitCode {
    use std::sync::atomic::{AtomicU32, Ordering};
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Console::SetConsoleCtrlHandler;
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_TERMINATE, TerminateProcess};
    use windows::core::BOOL;

    static CHILD: AtomicU32 = AtomicU32::new(0);

    /// Ctrl-C / Ctrl-Break / 关窗口：结束子进程。返回 TRUE = 自己不被默认
    /// 处理杀掉，回到 main 里等子进程退出、以 130 收尾。
    unsafe extern "system" fn on_ctrl(_kind: u32) -> BOOL {
        let pid = CHILD.load(Ordering::SeqCst);
        if pid != 0 {
            // SAFETY: 只用到 OpenProcess / TerminateProcess / CloseHandle，句柄
            // 用完即关；pid 来自我们自己拉起的子进程。
            unsafe {
                if let Ok(h) = OpenProcess(PROCESS_TERMINATE, false, pid) {
                    let _ = TerminateProcess(h, 130);
                    let _ = CloseHandle(h);
                }
            }
        }
        BOOL::from(true)
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("riot: cannot start {}: {e}", app.display());
            return ExitCode::FAILURE;
        }
    };
    CHILD.store(child.id(), Ordering::SeqCst);
    // SAFETY: 注册一个只读全局原子量的处理函数，进程退出前不注销也无妨。
    unsafe {
        let _ = SetConsoleCtrlHandler(Some(on_ctrl), true);
    }
    match child.wait() {
        Ok(status) => match status.code() {
            Some(c) => ExitCode::from(u8::try_from(c).unwrap_or(1)),
            None => ExitCode::from(130),
        },
        Err(e) => {
            eprintln!("riot: lost track of {}: {e}", app.display());
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 优先认_target_文件() {
        let t = std::env::temp_dir().join(format!("riot-cli-test-{}", std::process::id()));
        let bin = t.join("bin");
        let app_dir = t.join("app");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&app_dir).unwrap();
        let app = app_dir.join(MAIN_EXE);
        std::fs::write(&app, "").unwrap();
        // 不能叫 `riot`：macOS 默认文件系统不分大小写，它就是旁边的 `Riot`。
        let me = bin.join("riot-cli");
        std::fs::write(&me, "").unwrap();

        // 没有 target 文件、旁边也没有主程序：说清楚找不到
        assert!(locate_app(&me).unwrap_err().contains("cannot find"));

        std::fs::write(bin.join(TARGET_FILE), format!("{}\n", app.display())).unwrap();
        // target 文件里写的是原样路径，按原样用
        assert_eq!(locate_app(&me).unwrap(), app);

        // target 指向的主程序没了：提示重新安装
        std::fs::remove_file(&app).unwrap();
        assert!(locate_app(&me).unwrap_err().contains("Reinstall"));
        let _ = std::fs::remove_dir_all(&t);
    }

    #[test]
    fn 旁边的主程序() {
        let t = std::env::temp_dir().join(format!("riot-cli-side-{}", std::process::id()));
        std::fs::create_dir_all(&t).unwrap();
        let app = t.join(MAIN_EXE);
        std::fs::write(&app, "").unwrap();
        let me = t.join("riot-cli");
        std::fs::write(&me, "").unwrap();
        assert_eq!(
            locate_app(&me).unwrap(),
            std::fs::canonicalize(&t).unwrap().join(MAIN_EXE)
        );
        let _ = std::fs::remove_dir_all(&t);
    }
}
