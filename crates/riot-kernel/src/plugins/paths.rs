//! 插件包内路径的两条规矩：**不许逃出插件根**，和 `${PLUGIN_ROOT}` 一类
//! 占位符的展开。
//!
//! # 包含检查（Agent Plugins 规范 §4.1）
//!
//! 插件里任何被读、被执行的路径，按文件系统解析之后必须仍在插件根下面。
//! symlink 可以指向根内的东西，指到根外一律拒绝。这不是纠结：一个插件是
//! 从网上装来的目录，让它的 `mcp.json` 写一句 `"command": "../../../bin/sh"`
//! 就等于给了它整台机器 —— 而 `../` 在字符串上完全看不出问题，只有解析后
//! 比对根才拦得住。
//!
//! # 占位符（规范 §9.2）
//!
//! `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` 单次、非递归地替换成绝对路径。替换
//! 进来的文本不再扫描。Claude Code 的 `${CLAUDE_PLUGIN_ROOT}` /
//! `${CLAUDE_PLUGIN_DATA}` 是同一个东西的另一个拼法，一起认 —— 目标是让
//! 现成的 CC 插件零改造装上。别的 `${…}` 原样留着：它们多半是给 shell 看的。
//!
//! 豁免理由：宿主层，读的是用户装到本机的插件目录。

#![allow(clippy::disallowed_methods)]

use std::path::{Path, PathBuf};

use riot_protocol::text::UiError;
use riot_protocol::ui_error;

/// 占位符要填的值。
#[derive(Debug, Clone)]
pub struct Vars {
    /// 解析后的插件根（绝对路径）。
    pub root: PathBuf,
    /// 插件的持久数据目录（跨升级保留）。
    pub data: PathBuf,
}

impl Vars {
    /// 单次、非递归替换。`${PLUGIN_ROOT}` 和 CC 拼法指同一处。
    pub fn expand(&self, s: &str) -> String {
        let root = self.root.display().to_string();
        let data = self.data.display().to_string();
        // 一趟扫描，逐个 `${` 判断，替换进来的文本不再看 —— 规范要求
        // 非递归；而且 root 里要是真有 `${PLUGIN_DATA}` 这种字面量（用户
        // 完全可能把目录起成任何名字），递归替换会把它也吃掉。
        let mut out = String::with_capacity(s.len() + 32);
        let mut rest = s;
        while let Some(at) = rest.find("${") {
            out.push_str(&rest[..at]);
            let tail = &rest[at..];
            let Some(end) = tail.find('}') else {
                out.push_str(tail);
                rest = "";
                break;
            };
            let name = &tail[2..end];
            match name {
                "PLUGIN_ROOT" | "CLAUDE_PLUGIN_ROOT" | "CURSOR_PLUGIN_ROOT" => out.push_str(&root),
                "PLUGIN_DATA" | "CLAUDE_PLUGIN_DATA" | "CURSOR_PLUGIN_DATA" => out.push_str(&data),
                _ => out.push_str(&tail[..=end]),
            }
            rest = &tail[end + 1..];
        }
        out.push_str(rest);
        out
    }

    /// 子进程环境里要带上的两个保留变量。
    pub fn env(&self) -> Vec<(String, String)> {
        let root = self.root.display().to_string();
        let data = self.data.display().to_string();
        vec![
            ("PLUGIN_ROOT".to_owned(), root.clone()),
            ("PLUGIN_DATA".to_owned(), data.clone()),
            // CC 插件的脚本里写的是这两个名字。
            ("CLAUDE_PLUGIN_ROOT".to_owned(), root),
            ("CLAUDE_PLUGIN_DATA".to_owned(), data),
        ]
    }
}

/// 一个环境变量名是不是保留的（规范 §9.2：插件自己的 env 里不许设）。
pub fn is_reserved_env(name: &str) -> bool {
    matches!(
        name,
        "PLUGIN_ROOT" | "PLUGIN_DATA" | "CLAUDE_PLUGIN_ROOT" | "CLAUDE_PLUGIN_DATA"
    )
}

/// `canonicalize` 再剥掉 Windows 的 `\\?\` 前缀。
///
/// 这里的结果会进环境变量（`RUNTIME_BIN_DIR`）、进 bash shim、进 MCP 的
/// `command`。verbatim 形式的路径 Python / Node / bash 各有各的不认法，而
/// `Path::starts_with` 按组件比较时 `VerbatimDisk(D)` ≠ `Disk(D)`，两边
/// 不一致的话包含检查会把根内的路径判成根外。和工具侧 `resolve`、宿主侧
/// 围栏共用同一份实现（`riot_permissions::fence::strip_verbatim`）。
pub fn canonical(p: &Path) -> std::io::Result<PathBuf> {
    std::fs::canonicalize(p).map(riot_permissions::fence::strip_verbatim)
}

/// 把一个包内路径解析成绝对路径，并确认它没逃出插件根。
///
/// `root` 必须已经是 [`canonical`] 过的。`rel` 可以是 `./x`、`x`、或绝对
/// 路径（占位符展开之后的形态）—— 三种都要落在根内。目标不存在也算失败：
/// 不存在的东西没法 canonicalize，也就没法证明它在根内；而一个指着不存在
/// 文件的 MCP 服务器本来也起不来，早报比晚报好。
pub fn contain(root: &Path, rel: &str) -> Result<PathBuf, UiError> {
    let candidate = Path::new(rel);
    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        root.join(candidate)
    };
    let resolved = match canonical(&joined) {
        Ok(p) => p,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(ui_error!("kernel.plugin.pathMissing", path = rel));
        }
        Err(e) => return Err(ui_error!("kernel.plugin.pathUnreadable", path = rel; e)),
    };
    if !resolved.starts_with(root) {
        return Err(ui_error!("kernel.plugin.pathEscapes", path = rel));
    }
    Ok(resolved)
}

/// 同 [`contain`]，但允许目标落在数据目录里（`cwd` 可以是 `${PLUGIN_DATA}/x`）。
/// 数据目录不存在时先建 —— 规范要求客户端在起子进程前把它建好。
pub fn contain_or_data(vars: &Vars, rel: &str) -> Result<PathBuf, UiError> {
    let expanded = vars.expand(rel);
    let candidate = Path::new(&expanded);
    if candidate.is_absolute() && candidate.starts_with(&vars.data) {
        std::fs::create_dir_all(candidate)
            .map_err(|e| ui_error!("kernel.plugin.pathUnreadable", path = rel; e))?;
        return canonical(candidate)
            .map_err(|e| ui_error!("kernel.plugin.pathUnreadable", path = rel; e));
    }
    contain(&vars.root, &expanded)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(t: &tempfile::TempDir) -> Vars {
        let root = t.path().join("plug");
        let data = t.path().join("data");
        std::fs::create_dir_all(&root).expect("建根");
        Vars {
            root: super::canonical(&root).expect("canon"),
            data,
        }
    }

    #[test]
    fn 占位符单次替换_不递归() {
        let t = tempfile::tempdir().expect("临时目录");
        let v = vars(&t);
        let root = v.root.display().to_string();
        let data = v.data.display().to_string();

        assert_eq!(
            v.expand("${PLUGIN_ROOT}/bin/x --data ${PLUGIN_DATA}"),
            format!("{root}/bin/x --data {data}")
        );
        assert_eq!(
            v.expand("${CLAUDE_PLUGIN_ROOT}/s.sh"),
            format!("{root}/s.sh"),
            "CC 拼法是同一个东西"
        );
        // 不认识的原样留着 —— 那多半是给 shell 的。
        assert_eq!(v.expand("echo ${HOME} $PATH ${"), "echo ${HOME} $PATH ${");
    }

    #[test]
    fn 逃出根的路径被拒() {
        let t = tempfile::tempdir().expect("临时目录");
        let v = vars(&t);
        std::fs::create_dir_all(v.root.join("bin")).expect("建 bin");
        std::fs::write(v.root.join("bin/tool"), "").expect("写");
        std::fs::write(t.path().join("outside"), "").expect("写");

        assert!(contain(&v.root, "./bin/tool").is_ok());
        assert!(contain(&v.root, "bin/tool").is_ok(), "不带 ./ 也认");

        let err = contain(&v.root, "../outside").expect_err("该拒");
        assert_eq!(err.key(), "kernel.plugin.pathEscapes");

        let err = contain(&v.root, "./bin/nope").expect_err("该拒");
        assert_eq!(err.key(), "kernel.plugin.pathMissing");
    }

    #[cfg(unix)]
    #[test]
    fn 指向根外的_symlink_被拒() {
        let t = tempfile::tempdir().expect("临时目录");
        let v = vars(&t);
        std::fs::write(t.path().join("secret"), "").expect("写");
        std::os::unix::fs::symlink(t.path().join("secret"), v.root.join("link")).expect("建链接");

        let err = contain(&v.root, "./link").expect_err("symlink 解析后在根外，该拒");
        assert_eq!(err.key(), "kernel.plugin.pathEscapes");
    }

    #[test]
    fn 数据目录可以作为_cwd_且会被建出来() {
        let t = tempfile::tempdir().expect("临时目录");
        let v = vars(&t);
        assert!(!v.data.exists());
        let p = contain_or_data(&v, "${PLUGIN_DATA}/work").expect("数据目录该放行");
        assert!(p.is_dir(), "规范要求起进程前把数据目录建好");
    }
}
