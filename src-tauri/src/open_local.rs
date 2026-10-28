//! 用系统默认应用打开本地文件（代码引用、文件链接、预览里的「用系统应用打开」）。
//!
//! # 为什么不用 opener 插件的 `open_path` 命令
//!
//! 插件按目录划范围（capabilities 里的 `$HOME/**` 这类），范围外一律
//! `ForbiddenPath`。Windows 上项目常在 `D:\` —— 不在 `C:\Users\<name>` 下，
//! 于是 D 盘项目里所有文件都打不开。而按目录划范围本来也挡不住真正的
//! 风险：下载目录里的 `.exe` 在范围内照样能"打开"。
//!
//! # 真正的风险在文件类型
//!
//! 「用默认应用打开」一个可执行文件就是运行它。链接来自模型输出 ——
//! 不可信内容 —— 点一下引用就跑了个程序是不能接受的。所以这里不看目录，
//! 看类型：可执行类的不打开，改成在文件夹里显示（[`risky_to_open`]）。

use std::path::Path;

/// 实际做了什么。前端可以据此提示"可执行文件只在文件夹里显示"。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Opened {
    /// 用默认应用打开了。
    Opened,
    /// 可执行类文件：没打开，在文件管理器里选中了它。
    Revealed,
}

/// 打开这个路径（不存在就报错；可执行类改成在文件夹里显示）。
#[cfg(feature = "desktop")]
pub fn open(app: &tauri::AppHandle, path: &str) -> Result<Opened, riot_protocol::UiError> {
    use riot_protocol::ui_error;
    use tauri_plugin_opener::OpenerExt as _;

    let p = Path::new(path);
    // opener 是分离式启动，目标不存在它也报成功 —— 先自己查，让"不存在"
    // 成为看得见的失败，而不是点了没反应。
    if !p.exists() {
        return Err(ui_error!("host.open.missing", path = path));
    }
    if risky_to_open(p) {
        tracing::info!(path, "可执行类文件，只在文件夹中显示");
        app.opener()
            .reveal_item_in_dir(p)
            .map_err(|e| ui_error!("host.open.failed", path = path; e))?;
        return Ok(Opened::Revealed);
    }
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| ui_error!("host.open.failed", path = path; e))?;
    Ok(Opened::Opened)
}

/// 用默认应用打开它会**运行**它吗。
///
/// 按扩展名判（不分大小写），外加 Unix 上带执行位的普通文件 —— macOS 上
/// `open` 一个可执行文件会在终端里跑它。目录（`.app` 除外）总是安全的：
/// 打开就是在文件管理器里进去。
///
/// `[约束]` Windows 的名单里有 `.py` / `.js`：装了 Python / 自带 WSH 时，
/// 它们的默认动作是执行，不是编辑。代价是这两类引用在 Windows 上只能
/// 在文件夹里显示 —— 宁可多点一下，也不能点引用就跑脚本。
pub fn risky_to_open(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if RISKY_EVERYWHERE.contains(&ext.as_str()) {
        return true;
    }
    if cfg!(windows) && RISKY_WINDOWS.contains(&ext.as_str()) {
        return true;
    }
    if cfg!(target_os = "macos") && RISKY_MACOS.contains(&ext.as_str()) {
        return true;
    }
    has_exec_bit(path)
}

/// 哪个平台上都是"打开即运行"的。
const RISKY_EVERYWHERE: &[&str] = &["jar", "appimage", "run"];

const RISKY_WINDOWS: &[&str] = &[
    "exe", "com", "scr", "pif", "cpl", "msi", "msp", "msc", "bat", "cmd", "ps1", "psm1", "vbs",
    "vbe", "js", "jse", "wsf", "wsh", "hta", "lnk", "url", "reg", "inf", "scf", "appref-ms",
    "application", "py", "pyw",
];

const RISKY_MACOS: &[&str] = &[
    "app", "command", "tool", "terminal", "pkg", "mpkg", "workflow", "scpt", "applescript",
];

/// 豁免理由：宿主层，判断的是用户磁盘上真实文件的权限位，没有注入的
/// FileSystem 可走（同 lib.rs 里 path_exists 的直接 `Path::exists`）。
#[cfg(unix)]
#[allow(clippy::disallowed_methods)]
fn has_exec_bit(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn has_exec_bit(_path: &Path) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 普通源码和文档可以直接打开() {
        for name in ["Mapper.xml", "README.md", "main.rs", "a.TXT", "报告.docx", "noext"] {
            // 这些文件都不存在：没有执行位可查，只按扩展名判。
            assert!(!risky_to_open(Path::new(name)), "{name}");
        }
    }

    #[test]
    fn 各平台都可执行的不打开() {
        assert!(risky_to_open(Path::new("tool.JAR")), "扩展名不分大小写");
        assert!(risky_to_open(Path::new("x.AppImage")));
    }

    #[cfg(windows)]
    #[test]
    fn windows_上脚本和程序不打开() {
        for name in [r"D:\w\setup.exe", "run.bat", "a.ps1", "x.lnk", "main.py", "app.js"] {
            assert!(risky_to_open(Path::new(name)), "{name}");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_上应用和脚本不打开() {
        for name in ["/Applications/Foo.app", "build.command", "a.pkg", "x.scpt"] {
            assert!(risky_to_open(Path::new(name)), "{name}");
        }
        assert!(!risky_to_open(Path::new("main.py")), "macOS 上 .py 默认是编辑器打开");
    }

    #[cfg(unix)]
    #[test]
    fn 带执行位的普通文件不打开() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = tempfile::tempdir().expect("临时目录");
        let f = dir.path().join("deploy");
        #[allow(clippy::disallowed_methods)]
        std::fs::write(&f, "#!/bin/sh\n").expect("写");
        assert!(!risky_to_open(&f));
        #[allow(clippy::disallowed_methods)]
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        assert!(risky_to_open(&f));
        assert!(!risky_to_open(dir.path()), "目录打开就是进文件夹");
    }
}
