//! 「安装命令行工具」：让终端里能直接敲 `riot exec …`。
//!
//! 安装包里的启动器叫 `riot-cli`（见 crates/riot-cli）—— 不能叫 `riot`：macOS
//! 和 Windows 的文件系统默认不分大小写，它会和旁边的 `Riot` 主程序撞名。这里
//! 在用户自己的目录里放一个叫 `riot` 的入口：
//!
//! - macOS / Linux：`~/.local/bin/riot` → 安装包里的 `riot-cli` 的软链接。
//!   启动器解析软链接找到真实位置，主程序就在它旁边。
//! - Windows：把 `riot-cli.exe` 复制成 `%LOCALAPPDATA%\Riot\bin\riot.exe`，旁边
//!   写 `riot.target`（主程序的完整路径），再把这个目录加进**用户级** PATH。
//!
//! `[约束]` Windows 改 PATH 不用 `setx`：它把超过 1024 个字符的值截断，会把
//! 用户的 PATH 弄坏。走 PowerShell 的 .NET 接口，而且只追加、不重写别的项。
//!
//! 豁免理由：宿主层，操作的是用户目录下的真实文件和用户环境变量。
#![allow(clippy::disallowed_methods)]

use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    /// 安装包里有没有启动器（开发构建没跑 stage 脚本时可能没有）。
    pub available: bool,
    /// `riot` 入口已经指向这一份应用。
    pub installed: bool,
    /// 入口所在目录在 PATH 上（新开的终端才认得到 —— Windows 改完要重开）。
    pub on_path: bool,
    /// 入口的路径（给人看）。
    pub path: String,
    /// 不在 PATH 上时建议的做法（一行命令）。
    pub hint: Option<String>,
}

fn launcher() -> Option<PathBuf> {
    let me = std::env::current_exe().ok()?;
    let me = std::fs::canonicalize(&me).unwrap_or(me);
    let name = if cfg!(windows) {
        "riot-cli.exe"
    } else {
        "riot-cli"
    };
    let p = me.parent()?.join(name);
    p.is_file().then_some(p)
}

fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

fn bin_dir() -> Option<PathBuf> {
    if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA")
            .filter(|v| !v.is_empty())
            .map(|d| PathBuf::from(d).join("Riot").join("bin"))
    } else {
        home().map(|h| h.join(".local").join("bin"))
    }
}

fn entry_path(dir: &Path) -> PathBuf {
    dir.join(if cfg!(windows) { "riot.exe" } else { "riot" })
}

fn on_path(dir: &Path) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    let want = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    std::env::split_paths(&path).any(|p| {
        let p = std::fs::canonicalize(&p).unwrap_or(p);
        p == want
    })
}

pub fn status() -> CliStatus {
    let launcher = launcher();
    let Some(dir) = bin_dir() else {
        return CliStatus {
            available: false,
            installed: false,
            on_path: false,
            path: String::new(),
            hint: None,
        };
    };
    let entry = entry_path(&dir);
    let installed = match &launcher {
        Some(l) => is_ours(&entry, l),
        None => false,
    };
    let on = on_path(&dir);
    CliStatus {
        available: launcher.is_some(),
        installed,
        on_path: on,
        path: entry.display().to_string(),
        hint: (!on).then(|| path_hint(&dir)),
    }
}

fn path_hint(dir: &Path) -> String {
    if cfg!(windows) {
        "Open a new terminal window".to_owned()
    } else {
        format!("export PATH=\"{}:$PATH\"", dir.display())
    }
}

#[cfg(unix)]
fn is_ours(entry: &Path, launcher: &Path) -> bool {
    std::fs::read_link(entry).is_ok_and(|t| {
        std::fs::canonicalize(&t).unwrap_or(t)
            == std::fs::canonicalize(launcher).unwrap_or_else(|_| launcher.to_path_buf())
    })
}

#[cfg(windows)]
fn is_ours(entry: &Path, _launcher: &Path) -> bool {
    let Ok(me) = std::env::current_exe() else {
        return false;
    };
    entry.is_file()
        && std::fs::read_to_string(entry.with_file_name("riot.target"))
            .is_ok_and(|t| Path::new(t.trim()) == me)
}

/// 装上（或修好）`riot` 入口。返回装好之后的状态。
pub fn install() -> Result<CliStatus, String> {
    let launcher = launcher().ok_or(
        "this build has no riot-cli next to the app (development builds need `node scripts/stage-kernel.mjs`)",
    )?;
    let dir = bin_dir().ok_or("cannot find the user's home directory")?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let entry = entry_path(&dir);
    install_entry(&entry, &launcher)?;
    #[cfg(windows)]
    add_to_user_path(&dir)?;
    Ok(status())
}

#[cfg(unix)]
fn install_entry(entry: &Path, launcher: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(entry) {
        Ok(m) if m.file_type().is_symlink() => {
            std::fs::remove_file(entry)
                .map_err(|e| format!("cannot replace {}: {e}", entry.display()))?;
        }
        Ok(_) => {
            // 不是我们放的：不碰别人的文件。
            return Err(format!(
                "{} already exists and is not a link Riot created; remove it first",
                entry.display()
            ));
        }
        Err(_) => {}
    }
    std::os::unix::fs::symlink(launcher, entry)
        .map_err(|e| format!("cannot link {}: {e}", entry.display()))
}

#[cfg(windows)]
fn install_entry(entry: &Path, launcher: &Path) -> Result<(), String> {
    std::fs::copy(launcher, entry)
        .map_err(|e| format!("cannot copy to {}: {e}", entry.display()))?;
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    std::fs::write(
        entry.with_file_name("riot.target"),
        me.display().to_string(),
    )
    .map_err(|e| format!("cannot write riot.target: {e}"))
}

/// 把目录追加到用户级 PATH（已在就不动）。目录经环境变量传给 PowerShell，
/// 不拼进脚本文本 —— 路径里的引号、空格、`$` 都不用转义。
#[cfg(windows)]
fn add_to_user_path(dir: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt as _;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let script = "$d = $env:RIOT_BIN_DIR; \
        $p = [Environment]::GetEnvironmentVariable('Path', 'User'); \
        if ($null -eq $p) { $p = '' }; \
        if (($p -split ';') -notcontains $d) { \
          $n = if ($p.Trim() -eq '') { $d } else { $p.TrimEnd(';') + ';' + $d }; \
          [Environment]::SetEnvironmentVariable('Path', $n, 'User') \
        }";
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("RIOT_BIN_DIR", dir)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("cannot run PowerShell: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "could not add {} to PATH: {}",
            dir.display(),
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn 软链接可以替换_别人的文件不碰() {
        let t = tempfile::tempdir().unwrap();
        let launcher = t.path().join("riot-cli");
        std::fs::write(&launcher, "").unwrap();
        let entry = t.path().join("bin").join("riot");
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();

        install_entry(&entry, &launcher).unwrap();
        assert!(is_ours(&entry, &launcher));
        // 再装一次（升级后换了位置）：旧链接被替换
        let launcher2 = t.path().join("riot-cli-2");
        std::fs::write(&launcher2, "").unwrap();
        install_entry(&entry, &launcher2).unwrap();
        assert!(is_ours(&entry, &launcher2));

        // 用户自己的同名文件：拒绝覆盖
        std::fs::remove_file(&entry).unwrap();
        std::fs::write(&entry, "mine").unwrap();
        assert!(install_entry(&entry, &launcher).is_err());
        assert_eq!(std::fs::read_to_string(&entry).unwrap(), "mine");
    }
}
