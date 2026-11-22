//! 本地崩溃记录：`<配置目录>/riot/crash.log`。
//!
//! 打包后的应用从 Dock / 开始菜单启动时没有人看得到 stderr，panic 的现场
//! 只进 tracing，而 tracing 在桌面版里也是打到 stdout —— 用户能告诉我们的
//! 只有"它突然没反应了"。这里把宿主和内核的 panic 各留一条在本地文件里，
//! 「关于 → 反馈问题」读它，让用户**自己决定**要不要贴进 issue。
//!
//! `[约束]` 只写本地，不上传。崩溃信息里可能有路径（用户名、项目名），
//! 是否发出去由用户在 GitHub 的编辑框里看过之后决定。
//!
//! 豁免理由：宿主层，写的是 Riot 自己配置目录下的文件。
#![allow(clippy::disallowed_methods)]

use std::io::Write as _;
use std::path::PathBuf;

/// 文件上限。超过就只留后一半：要的是最近几次，不是全部历史。
const MAX_BYTES: u64 = 256 * 1024;

pub fn path() -> PathBuf {
    crate::config::config_path()
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .join("crash.log")
}

/// 追加一条。`source` 是 `host` / `kernel`。失败静默 —— 这是在 panic 里调的。
pub fn record(source: &str, message: &str, detail: Option<&str>) {
    let p = path();
    if let Ok(meta) = std::fs::metadata(&p)
        && meta.len() > MAX_BYTES
        && let Ok(text) = std::fs::read_to_string(&p)
    {
        let keep = &text[text.len() / 2..];
        let start = keep.find("\n=== ").map_or(0, |i| i + 1);
        let _ = std::fs::write(&p, &keep[start..]);
    }
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut entry = format!(
        "=== {ts} {source} v{} {} {}\n{message}\n",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
    );
    if let Some(d) = detail {
        // 回溯只留前 40 行：再往下基本是运行时和标准库的帧。
        for line in d.lines().take(40) {
            entry.push_str(line);
            entry.push('\n');
        }
    }
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&p)
    {
        let _ = f.write_all(entry.as_bytes());
    }
}

/// 最近一条记录（给「反馈问题」用）。没有就 None。
pub fn latest() -> Option<String> {
    let text = std::fs::read_to_string(path()).ok()?;
    let i = text.rfind("=== ")?;
    Some(text[i..].trim_end().to_owned())
}
