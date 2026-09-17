//! 解包、原子切换、装完自检。
//!
//! 豁免理由：宿主层。自检更是非用真进程不可 —— 它要回答的就是"这台机器上
//! 这个二进制到底跑不跑得起来"，注入 mock 会让这个检查完全失去意义。

#![allow(clippy::disallowed_methods)]

use std::path::{Path, PathBuf};

use riot_kernel::plugins::Loaded;
use riot_protocol::{UiError, ui_error};

/// 安装链路的错误。`Display` 是给日志的英文；给前端看的形态见 [`Self::to_ui`]。
///
/// 各变体里的字符串都是技术细节（HTTP 状态、io 错误原文、哪个二进制起不来），
/// 不翻译，前端放在译文后面的次要位置。
#[derive(Debug, thiserror::Error)]
pub enum InstallError {
    #[error("marketplace: {0}")]
    Marketplace(String),
    #[error("plugin `{0}` is not in the marketplace")]
    NotFound(String),
    #[error("no build for platform {0}")]
    Unsupported(String),
    #[error("network: {0}")]
    Network(String),
    #[error("checksum mismatch (expected {expected}, got {actual})")]
    Checksum { expected: String, actual: String },
    /// 第一项是"当时在做什么"（英文短语），进细节里。
    #[error("{0}: {1}")]
    Io(String, #[source] std::io::Error),
    /// 插件目录挪不开 / 删不掉。和 `Io` 分开：这一类几乎总是"有进程还在
    /// 用它"（Windows 上一个还在跑的 exe 就够），文案要把这条出路说出来，
    /// 而不是笼统地说"写盘失败"—— 用户在做的明明是删除。
    #[error("plugin dir busy: {0}")]
    DirBusy(#[source] std::io::Error),
    #[error("bad plugin layout: {0}")]
    Layout(String),
    /// 清单读不了、名字非法之类：插件目录本身不合规。
    #[error("invalid plugin: {0}")]
    Invalid(UiError),
    #[error("self-check failed: {0}")]
    SelfCheck(String),
    #[error("git: {0}")]
    Git(String),
    /// 已经装了同 id 的插件，而这次不是升级。
    #[error("plugin `{0}` is already installed")]
    AlreadyInstalled(String),
    /// 解压 / 自检那个 blocking 任务本身没能跑完（panic 或 runtime 正在关）。
    /// 和"包坏了"分开，不然用户会去重下一个没问题的包。
    #[error("task: {0}")]
    Task(String),
}

impl InstallError {
    /// 前端要的形态：按"发生了什么"给键，原始原因留作细节。
    pub fn to_ui(&self) -> UiError {
        match self {
            InstallError::Marketplace(d) => ui_error!("host.plugin.marketplaceFailed"; d),
            InstallError::NotFound(id) => ui_error!("host.plugin.notInMarketplace", id = id),
            InstallError::Unsupported(p) => {
                ui_error!("host.plugin.unsupportedPlatform", platform = p)
            }
            InstallError::Network(d) => ui_error!("host.plugin.downloadFailed"; d),
            InstallError::Checksum { expected, actual } => {
                ui_error!("host.plugin.checksumMismatch"; format!("expected {expected}, got {actual}"))
            }
            InstallError::Io(what, e) => ui_error!("host.plugin.ioFailed"; format!("{what}: {e}")),
            InstallError::DirBusy(e) => ui_error!("host.plugin.dirBusy"; e),
            InstallError::Layout(d) => ui_error!("host.plugin.badLayout"; d),
            InstallError::Invalid(e) => e.clone(),
            InstallError::SelfCheck(d) => ui_error!("host.plugin.selfCheckFailed"; d),
            InstallError::Git(d) => ui_error!("host.plugin.gitFailed"; d),
            InstallError::AlreadyInstalled(id) => {
                ui_error!("host.plugin.alreadyInstalled", id = id)
            }
            InstallError::Task(d) => ui_error!("host.plugin.taskFailed"; d),
        }
    }
}

/// 目录里有没有一份我们认的清单。解压完、clone 完都拿它判"这到底是不是
/// 一个插件"—— 报错时把实际看到的东西列出来，"下错了文件"和"多裹了一层
/// 目录"的排查方向相反。
pub fn has_manifest(dir: &Path) -> bool {
    riot_kernel::plugins::Format::ALL
        .iter()
        .any(|f| dir.join(f.manifest_path()).is_file())
}

/// 解压 tar.zst 到 `dest` 旁边的临时目录，返回那个目录。搬进 `dest` 是
/// [`swap_in`] 的事，两步之间宿主要先停掉还在用旧目录的进程。
///
/// 先解到同一个文件系统上的临时目录再 rename:直接往 `dest` 里解压的话,
/// 解到一半断电或用户退出,留下的是一个"看起来装好了、实际缺文件"的插件 ——
/// 那比没装更糟,因为状态显示已安装,用起来却在各种地方随机报错。
pub fn extract(archive: &Path, dest: &Path) -> Result<PathBuf, InstallError> {
    let staging = staging_dir_for(dest)?;
    // 出任何岔子都要把临时目录收掉,否则失败几次就在用户盘上堆了几个 GB。
    if let Err(e) = extract_into(archive, &staging) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }
    Ok(staging)
}

/// 在 `dest` 旁边开一个空的临时目录（同一文件系统，rename 才是原子的）。
pub fn staging_dir_for(dest: &Path) -> Result<PathBuf, InstallError> {
    let parent = dest
        .parent()
        .ok_or_else(|| InstallError::Layout(format!("{} has no parent dir", dest.display())))?;
    std::fs::create_dir_all(parent)
        .map_err(|e| InstallError::Io("create plugins dir".into(), e))?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let staging = parent.join(format!(
        ".staging-{}-{nonce}",
        dest.file_name().unwrap_or_default().to_string_lossy()
    ));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)
        .map_err(|e| InstallError::Io("create staging dir".into(), e))?;
    Ok(staging)
}

/// `dest` 挪开时用的位置：同目录下的 `<id>.old`。升级挪旧版本、卸载挪
/// 待删目录都用它，谁先来谁先把上次没删干净的那份清掉。
///
/// 不用 `Path::with_extension`：插件名允许带点（规范 §5.5），`com.acme.tool`
/// 会被它改成 `com.acme.old`，和插件 `com.acme` 挪开的位置撞车。
pub fn aside_dir(dest: &Path) -> PathBuf {
    let mut name = dest.file_name().unwrap_or_default().to_owned();
    name.push(".old");
    dest.with_file_name(name)
}

/// 整棵删掉一个插件目录：先原子地挪开，再删挪开的那份。
///
/// `remove_dir_all` 不是原子的。删到一半撞上一个删不掉的文件（Windows 上
/// 一个还在跑的 exe 就够了），留下的是半个插件：注册表说装着、清单却没了，
/// 比装着或没装都糟。rename 要么成要么不成：挪开成功，插件就已经不在原位；
/// 挪开的那份删不掉也只是多占一会儿盘 —— 下次装或卸同 id 时再清一次。
///
/// 调用方要保证没有进程还在用这个目录（宿主在这之前先停掉它带的 MCP
/// 服务器，见 `AppState::plugins_uninstall`）：Windows 上一个把它当工作目录
/// 的进程会让 rename 直接失败，而这里没法替它收尾。
///
/// 目录本来就不在 = 没事可做，返回 Ok —— 卸载是幂等的。
pub fn remove_tree(dir: &Path) -> Result<(), InstallError> {
    let aside = aside_dir(dir);
    let _ = std::fs::remove_dir_all(&aside);
    match retry_busy(|| std::fs::rename(dir, &aside)) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(InstallError::DirBusy(e)),
    }
    if let Err(e) = retry_busy(|| std::fs::remove_dir_all(&aside)) {
        tracing::warn!(
            path = %aside.display(),
            error = %e,
            "挪开的插件目录没删干净，下次装或卸同一个插件时再清"
        );
    }
    Ok(())
}

/// Windows 上目录操作的重试。
///
/// 刚被杀掉的进程松开句柄、Defender 扫一遍新落地的 exe，都会让紧接着的
/// rename / delete 吃一个 Access denied（5）或 sharing violation（32）；删目录
/// 还可能撞上"目录非空"（145）—— 里面的文件已标记删除、句柄还没关。这些
/// 几百毫秒后就好了，这里总共等一秒半左右。跑在阻塞线程池里，睡得起。
///
/// 别的平台不重试：unlink 一个正在用的文件本来就是允许的，会失败的都是
/// 真的权限问题，重试只是让用户多等。
fn retry_busy<T>(mut op: impl FnMut() -> std::io::Result<T>) -> std::io::Result<T> {
    let mut delay = std::time::Duration::from_millis(50);
    for _ in 0..5 {
        match op() {
            Err(e) if cfg!(windows) && is_busy(&e) => {
                std::thread::sleep(delay);
                delay *= 2;
            }
            r => return r,
        }
    }
    op()
}

fn is_busy(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::PermissionDenied
        || matches!(e.raw_os_error(), Some(5 | 32 | 145))
}

fn extract_into(archive: &Path, staging: &Path) -> Result<(), InstallError> {
    let file =
        std::fs::File::open(archive).map_err(|e| InstallError::Io("open archive".into(), e))?;
    let decoder = zstd::stream::read::Decoder::new(std::io::BufReader::new(file))
        .map_err(|e| InstallError::Io("init zstd decoder".into(), e))?;
    let mut tar = tar::Archive::new(decoder);
    // 可执行位必须保留 —— 丢了的话 bin 里的 shim 全都跑不了。
    tar.set_preserve_permissions(true);
    tar.set_overwrite(true);

    // 逐条解而不是 `unpack()`，为的是把 AppleDouble 条目挡在外面。
    //
    // macOS 的 tar 会为带扩展属性的文件额外写一条 `._<原名>`，解包时由它自己
    // 还原成 xattr、不落地成文件。别的实现不认这套，会老老实实把它们当普通
    // 文件写出来 —— 于是 LibreOffice 的 program/ 和 share/registry/ 里凭空
    // 多出一堆 `._*`，它扫目录时把这些二进制垃圾当成配置去解析，直接抛
    // UNO 异常挂掉。报错里完全看不出和解压有关系。
    //
    // 构建脚本那边已经用 COPYFILE_DISABLE 从源头掐掉了，这里再挡一道：
    // 用户手上可能有老脚本打的包，而这个故障的排查成本高得离谱。
    for entry in tar
        .entries()
        .map_err(|e| InstallError::Io("read archive entries".into(), e))?
    {
        let mut entry = entry.map_err(|e| InstallError::Io("read archive entry".into(), e))?;
        let path = entry.path().map(|p| p.into_owned()).ok();
        let is_apple_double = path.as_ref().is_some_and(|p| {
            p.file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with("._"))
        });
        if is_apple_double {
            continue;
        }
        let mode = entry.header().mode().unwrap_or(0);
        let is_file = entry.header().entry_type().is_file();
        let unpacked = entry
            .unpack_in(staging)
            .map_err(|e| InstallError::Io("extract archive".into(), e))?;

        #[cfg(unix)]
        if unpacked && is_file && mode & 0o6000 != 0 {
            // setuid / setgid 位一律掩掉。归档里的这两位会被原样保留（可执行
            // 位必须保留，见上面），于是"下载一个插件"就变成了"在用户机器上放
            // 一个 setuid 程序"—— 归档是远端来的，包体内容变了签名不会变。
            // 掉的只是这两位，rwx 照旧。
            if let Some(p) = path.as_ref() {
                use std::os::unix::fs::PermissionsExt as _;
                let target = staging.join(p);
                let safe = std::fs::Permissions::from_mode(mode & 0o777);
                if let Err(e) = std::fs::set_permissions(&target, safe) {
                    return Err(InstallError::Io("strip setuid bit".into(), e));
                }
                tracing::warn!(path = %target.display(), mode = format!("{mode:o}"),
                    "archive entry had setuid/setgid bits; masked");
            }
        }
        #[cfg(not(unix))]
        let _ = (unpacked, is_file, mode);
    }
    Ok(())
}

/// 把解压 / clone 结果搬到最终位置。`staging` 里可以直接是插件根，也可以
/// 裹一层顶层目录（压缩包常这样）。
pub fn swap_in(staging: &Path, dest: &Path) -> Result<(), InstallError> {
    // 压缩包里裹了一层带版本和平台的顶层目录,剥掉它 —— 定位器按固定路径
    // 找插件,路径里带版本号的话每次升级都要改代码。
    //
    // 判断"是不是只有一层"时要跳过点开头的东西。macOS 的 tar 会为带扩展属性
    // 的文件额外写一个 `._xxx` 的 AppleDouble 条目,而它自己列归档时又把这些
    // 藏起来 —— 归档看着只有一个顶层目录,别的 tar 实现解出来却是两个条目。
    // 不跳过的话这里会误判成"没有外层目录",然后在压缩包根下找清单。
    let root = if has_manifest(staging) {
        staging.to_path_buf()
    } else {
        let entries: Vec<_> = std::fs::read_dir(staging)
            .map_err(|e| InstallError::Io("read staging dir".into(), e))?
            .filter_map(Result::ok)
            .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
            .collect();
        match entries.as_slice() {
            [only] if only.path().is_dir() => only.path(),
            _ => staging.to_path_buf(),
        }
    };
    if !has_manifest(&root) {
        // 把实际看到的东西带出来。只说"找不到清单"的话，是"下错了文件"
        // 还是"压缩包多裹了一层目录"完全分不清，而这两者的排查方向相反。
        let found: Vec<_> = std::fs::read_dir(&root)
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        return Err(InstallError::Layout(format!(
            "no plugin manifest (plugin.json / .claude-plugin/plugin.json / .cursor-plugin/plugin.json); {} contains: {}",
            root.display(),
            if found.is_empty() {
                "(empty)".to_owned()
            } else {
                found.join(", ")
            }
        )));
    }

    // macOS 侧的隔离标记要在搬进去之前清,不然第一次执行会被 Gatekeeper 拦。
    // reqwest 下载本身不打这个标记,但用户手工放进来的包会带,便宜的保险。
    #[cfg(target_os = "macos")]
    clear_quarantine(&root);

    // rename 不能覆盖非空目录,所以先把旧的挪开。挪开这一步是原子的,
    // 中间态最多是"旧的还在 .old 里、新的还没就位",下次安装会清掉。
    //
    // 挪不开几乎只有一个原因：旧版本的进程还开着（Windows 上工作目录在
    // 里面就够）。宿主在升级前先停掉它带的 MCP 服务器；这里报 DirBusy，
    // 让文案指向"关掉还在用它的程序"而不是"写盘失败"。
    let backup = aside_dir(dest);
    let _ = std::fs::remove_dir_all(&backup);
    if dest.exists() {
        retry_busy(|| std::fs::rename(dest, &backup)).map_err(InstallError::DirBusy)?;
    }
    if let Err(e) = std::fs::rename(&root, dest) {
        // 新的没就位就把旧的放回去,不能让用户既失去旧版本又没装上新的。
        if backup.exists() {
            let _ = std::fs::rename(&backup, dest);
        }
        return Err(InstallError::Io("swap in new version".into(), e));
    }
    let _ = std::fs::remove_dir_all(&backup);
    let _ = std::fs::remove_dir_all(staging);
    Ok(())
}

#[cfg(target_os = "macos")]
fn clear_quarantine(dir: &Path) {
    // 失败不致命:大多数情况下压根没有这个标记,xattr 会报"没有该属性"。
    // 真有标记又清不掉的话,后面的自检会以一个更清楚的错误暴露出来。
    match std::process::Command::new("/usr/bin/xattr")
        .args(["-dr", "com.apple.quarantine"])
        .arg(dir)
        .output()
    {
        Ok(o) if !o.status.success() => {
            tracing::debug!(status = ?o.status, "clearing quarantine flag failed (usually: none set)");
        }
        Err(e) => tracing::debug!(error = %e, "cannot run xattr"),
        _ => {}
    }
}

/// 读清单并实际跑一遍 `dev.riot.selfCheck` 里的命令。
///
/// 自检不是形式主义。文档插件里的二进制是从 Codex 运行时提取的,`soffice`
/// 和 `python3.12` 只有 ad-hoc 签名 —— 理论上能在 Apple Silicon 上跑,但一旦
/// 因为签名、隔离标记或架构不匹配跑不起来,失败会发生在几天后用户让模型
/// "做个 PPT"的时候,现场是一条模型都看不懂的 Bash 报错。在安装时就跑一次,
/// 把问题摁在用户还知道自己刚点了"安装"的时刻。
pub fn finalize(root: &Path, data_root: &Path) -> Result<Loaded, InstallError> {
    let loaded =
        riot_kernel::plugins::load(root, data_root).map_err(|f| InstallError::Invalid(f.reason))?;
    if !loaded.platform_ok {
        return Err(InstallError::Unsupported(
            riot_kernel::plugins::platform_key(),
        ));
    }
    // 数据目录先建好：自检里的命令可能就要往里写。
    let _ = std::fs::create_dir_all(&loaded.vars.data);

    for check in &loaded.self_checks {
        let program = Path::new(&check.command);
        if program.is_absolute() && !program.exists() {
            return Err(InstallError::SelfCheck(format!(
                "{} does not exist",
                program.display()
            )));
        }
        let out = std::process::Command::new(&check.command)
            .args(&check.args)
            // 只给插件自己声明的目录和系统基础目录。用宿主完整 PATH 的话,
            // 开发机上的全局 python / node 会把插件里缺失的东西兜住,自检就白做了。
            .env("PATH", minimal_path(&loaded))
            .envs(loaded.runtime.env.iter().cloned())
            .envs(loaded.vars.env())
            .env_remove("PYTHONHOME")
            .env_remove("PYTHONPATH")
            .env_remove("VIRTUAL_ENV")
            .current_dir(&loaded.root)
            .output();
        match out {
            Ok(o) if o.status.success() => {
                tracing::debug!(
                    program = %check.command,
                    out = %String::from_utf8_lossy(&o.stdout).trim(),
                    "plugin self-check passed"
                );
            }
            Ok(o) => {
                return Err(InstallError::SelfCheck(format!(
                    "{} exited with {:?}: {}",
                    check.command,
                    o.status.code(),
                    String::from_utf8_lossy(&o.stderr).trim(),
                )));
            }
            Err(e) => {
                return Err(InstallError::SelfCheck(format!(
                    "{} failed to start: {e}",
                    check.command
                )));
            }
        }
    }

    Ok(loaded)
}

fn minimal_path(plugin: &Loaded) -> std::ffi::OsString {
    let mut dirs = plugin.runtime.path_dirs.clone();
    if cfg!(windows) {
        dirs.push(PathBuf::from(r"C:\Windows\system32"));
        dirs.push(PathBuf::from(r"C:\Windows"));
    } else {
        dirs.extend([
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
            PathBuf::from("/usr/sbin"),
            PathBuf::from("/sbin"),
        ]);
    }
    std::env::join_paths(dirs).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_manifest(dir: &Path, version: &str) {
        std::fs::create_dir_all(dir).expect("建目录");
        std::fs::write(
            dir.join("plugin.json"),
            serde_json::json!({
                "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
                "name": "doc-runtime",
                "version": version,
            })
            .to_string(),
        )
        .expect("写 plugin.json");
    }

    #[test]
    fn 顶层目录会被剥掉() {
        let tmp = tempfile::tempdir().expect("临时目录");
        let staging = tmp.path().join("staging");
        write_manifest(&staging.join("doc-runtime-0.1.0-darwin-arm64"), "0.1.0");
        let dest = tmp.path().join("doc-runtime");

        swap_in(&staging, &dest).expect("切换");

        assert!(
            dest.join("plugin.json").exists(),
            "plugin.json 应该直接在插件根下"
        );
        assert!(!staging.exists(), "临时目录应被清掉");
    }

    #[test]
    fn 清单直接在_staging_根下也认() {
        let tmp = tempfile::tempdir().expect("临时目录");
        let staging = tmp.path().join("staging");
        write_manifest(&staging, "0.1.0");
        // 旁边还有别的目录（比如 git clone 出来的 .git 已删、只剩 skills）
        std::fs::create_dir_all(staging.join("skills")).expect("建目录");
        let dest = tmp.path().join("p");
        swap_in(&staging, &dest).expect("切换");
        assert!(dest.join("plugin.json").exists());
        assert!(dest.join("skills").is_dir());
    }

    #[test]
    fn 升级会替换掉旧版本且不留备份() {
        let tmp = tempfile::tempdir().expect("临时目录");
        let dest = tmp.path().join("doc-runtime");
        write_manifest(&dest, "0.1.0");
        std::fs::write(dest.join("stale.txt"), "旧版本残留").expect("写残留文件");

        let staging = tmp.path().join("staging");
        write_manifest(&staging.join("inner"), "0.2.0");
        swap_in(&staging, &dest).expect("切换");

        let raw = std::fs::read_to_string(dest.join("plugin.json")).expect("读 plugin.json");
        assert!(raw.contains("0.2.0"), "应该是新版本");
        assert!(
            !dest.join("stale.txt").exists(),
            "旧版本的文件必须消失，否则升级会留下互相矛盾的两代文件"
        );
        assert!(!aside_dir(&dest).exists(), "备份目录应被清掉");
    }

    #[test]
    fn 挪开位置不吃掉名字里的点() {
        // 插件名允许带点。`with_extension` 会把 `com.acme.tool` 变成
        // `com.acme.old`，和插件 `com.acme` 挪开的位置撞车。
        assert_eq!(
            aside_dir(Path::new("/p/com.acme.tool")),
            Path::new("/p/com.acme.tool.old")
        );
        assert_eq!(
            aside_dir(Path::new("/p/doc-runtime")),
            Path::new("/p/doc-runtime.old")
        );
    }

    #[test]
    fn 整棵删掉_原目录和挪开的那份都不留() {
        let tmp = tempfile::tempdir().expect("临时目录");
        let dir = tmp.path().join("doc-runtime");
        write_manifest(&dir, "1.0.0");
        std::fs::create_dir_all(dir.join("bin")).expect("建目录");
        std::fs::write(dir.join("bin/x"), "x").expect("写文件");
        // 上次没删干净的那份也要一起清掉，不能越积越多。
        std::fs::create_dir_all(aside_dir(&dir).join("stale")).expect("建残留");

        remove_tree(&dir).expect("删");

        assert!(!dir.exists(), "原目录应该没了");
        assert!(!aside_dir(&dir).exists(), "挪开的那份也该删掉");
    }

    #[test]
    fn 整棵删掉是幂等的() {
        let tmp = tempfile::tempdir().expect("临时目录");
        remove_tree(&tmp.path().join("nope")).expect("不存在的目录没事可做");
    }

    /// AppleDouble 条目不能落地成文件。
    ///
    /// 真的踩过，而且现场毫无线索：LibreOffice 会扫自己的 `program/` 和
    /// `share/registry/`，多出来的 `._*` 被当成配置去解析，抛 UNO 异常直接
    /// abort，报错里一个字都没提解压。
    #[test]
    fn apple_double_条目不落地并且可执行位不丢() {
        let tmp = tempfile::tempdir().expect("临时目录");
        let archive = tmp.path().join("a.tar.zst");

        {
            let f = std::fs::File::create(&archive).expect("建压缩文件");
            let enc = zstd::stream::write::Encoder::new(f, 1).expect("建编码器");
            let mut b = tar::Builder::new(enc);

            let mut shim = tar::Header::new_gnu();
            shim.set_size(3);
            shim.set_mode(0o755);
            shim.set_cksum();
            b.append_data(&mut shim.clone(), "pack/bin/soffice", &b"#!\n"[..])
                .expect("写 shim");

            let mut junk = tar::Header::new_gnu();
            junk.set_size(4);
            junk.set_mode(0o644);
            junk.set_cksum();
            b.append_data(&mut junk, "pack/bin/._soffice", &b"\x00\x05\x16\x07"[..])
                .expect("写 AppleDouble");

            b.into_inner()
                .expect("收尾 tar")
                .finish()
                .expect("收尾 zstd");
        }

        let staging = tmp.path().join("staging");
        std::fs::create_dir_all(&staging).expect("建目录");
        extract_into(&archive, &staging).expect("解压");

        assert!(
            staging.join("pack/bin/soffice").is_file(),
            "正常文件要解出来"
        );
        assert!(
            !staging.join("pack/bin/._soffice").exists(),
            "AppleDouble 不能落地"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(staging.join("pack/bin/soffice"))
                .expect("读元信息")
                .permissions()
                .mode();
            assert!(mode & 0o111 != 0, "逐条解压不能丢可执行位，mode={mode:o}");
        }
    }

    /// 归档里的 setuid 位不能落到用户盘上。
    #[cfg(unix)]
    #[test]
    fn setuid_位不会跟着解压落地() {
        use std::os::unix::fs::PermissionsExt as _;

        let tmp = tempfile::tempdir().expect("临时目录");
        let archive = tmp.path().join("a.tar.zst");
        {
            let f = std::fs::File::create(&archive).expect("建压缩文件");
            let enc = zstd::stream::write::Encoder::new(f, 1).expect("建编码器");
            let mut b = tar::Builder::new(enc);
            let mut h = tar::Header::new_gnu();
            h.set_size(3);
            h.set_mode(0o4755);
            h.set_cksum();
            b.append_data(&mut h, "pack/bin/evil", &b"#!\n"[..])
                .expect("写 setuid 条目");
            b.into_inner()
                .expect("收尾 tar")
                .finish()
                .expect("收尾 zstd");
        }

        let staging = tmp.path().join("staging");
        std::fs::create_dir_all(&staging).expect("建目录");
        extract_into(&archive, &staging).expect("解压");

        let mode = std::fs::metadata(staging.join("pack/bin/evil"))
            .expect("读元信息")
            .permissions()
            .mode();
        assert_eq!(mode & 0o6000, 0, "setuid/setgid 必须被掩掉，mode={mode:o}");
        assert!(mode & 0o111 != 0, "可执行位不能跟着一起掉，mode={mode:o}");
    }

    #[test]
    fn 缺清单直接拒绝() {
        let tmp = tempfile::tempdir().expect("临时目录");
        let staging = tmp.path().join("staging");
        std::fs::create_dir_all(staging.join("inner")).expect("建目录");
        let err = swap_in(&staging, &tmp.path().join("doc-runtime")).expect_err("应该失败");
        assert!(matches!(err, InstallError::Layout(_)), "实际是 {err:?}");
    }

    /// 自检里写的命令跑不起来要当成安装失败。
    #[cfg(unix)]
    #[test]
    fn 自检失败让安装失败() {
        let tmp = tempfile::tempdir().expect("临时目录");
        let root = tmp.path().join("p");
        std::fs::create_dir_all(root.join("bin")).expect("建目录");
        std::fs::write(root.join("bin/nope"), "#!/bin/sh\nexit 3\n").expect("写脚本");
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(
                root.join("bin/nope"),
                std::fs::Permissions::from_mode(0o755),
            )
            .expect("加可执行位");
        }
        std::fs::write(
            root.join("plugin.json"),
            serde_json::json!({
                "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
                "name": "p",
                "extensions": { "dev.riot": { "selfCheck": [{ "command": "./bin/nope" }] } }
            })
            .to_string(),
        )
        .expect("写清单");
        let err = finalize(&root, &tmp.path().join("data")).expect_err("该失败");
        assert!(matches!(err, InstallError::SelfCheck(_)), "实际 {err:?}");
    }
}
