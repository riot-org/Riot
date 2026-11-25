//! 回答里 ```diff 补丁块的「应用到文件」（前端 components/PatchApply.tsx）。
//!
//! 补丁是模型写的，用户点一下就落到项目文件上 —— 所以先过两道关：
//!
//! - **路径不出项目**：补丁里每个目标路径都必须是相对路径、不含 `..`、
//!   拼到项目根上之后还在项目根下面（符号链接按真实位置算）。模型被网页
//!   内容带偏写出 `../../.ssh/authorized_keys`，这里就拦下。
//! - **整体能应用才应用**：先 `--check`，有一块对不上就一个文件都不动。
//!
//! 应用交给 `git apply`：它不在仓库里也能用（就当 `patch`），能容忍行号
//! 偏移（模型写的 `@@` 行号常常不准），`--recount` 再把块头的行数纠正过来。
//! 撤销就是反向应用同一份补丁。

#![allow(clippy::disallowed_methods)]

use std::io::Write as _;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum PatchOutcome {
    /// 应用（或撤销）成功，改了这些文件（相对项目根）。
    Applied { files: Vec<String> },
    /// 正向应用不上，但反向能 —— 这份补丁已经在文件里了。
    AlreadyApplied { files: Vec<String> },
    /// 应用不上。`reason` 是 git 的原话（截短），给用户看哪一块对不上。
    Failed { reason: String },
}

/// 补丁里的目标文件（新旧路径都算，`/dev/null` 除外），以及要剥掉几层前缀。
///
/// `diff --git a/x b/x`、`--- a/x` / `+++ b/x` 是 git 的写法，剥一层；模型
/// 也常写 `--- src/x.ts` 不带前缀，那就不剥 —— 不然 `src/` 被当成前缀吃掉。
pub fn targets(patch: &str) -> Result<(Vec<String>, u8), String> {
    let mut raw: Vec<String> = Vec::new();
    for line in patch.lines() {
        let path = if let Some(rest) = line.strip_prefix("+++ ") {
            rest
        } else if let Some(rest) = line.strip_prefix("--- ") {
            rest
        } else {
            continue;
        };
        // `--- a/x\t2024-…` 这种带时间戳的写法：路径到制表符为止。
        let path = path.split('\t').next().unwrap_or("").trim();
        if path.is_empty() || path == "/dev/null" {
            continue;
        }
        raw.push(path.to_owned());
    }
    if raw.is_empty() {
        return Err("no file headers".into());
    }
    let prefixed = raw.iter().all(|p| p.starts_with("a/") || p.starts_with("b/"));
    let strip = if prefixed { 1 } else { 0 };
    let mut files: Vec<String> = raw
        .into_iter()
        .map(|p| if prefixed { p[2..].to_owned() } else { p })
        .collect();
    files.sort();
    files.dedup();
    Ok((files, strip))
}

/// 目标路径必须落在项目根下面。
fn check_paths(root: &Path, files: &[String]) -> Result<(), String> {
    let root_real = root.canonicalize().map_err(|e| format!("project root: {e}"))?;
    for f in files {
        let p = Path::new(f);
        if p.is_absolute()
            || p.components().any(|c| matches!(c, Component::ParentDir | Component::Prefix(_) | Component::RootDir))
        {
            return Err(format!("path outside the project: {f}"));
        }
        // 文件可能还不存在（新建）：找到最近一个存在的祖先，看它的真实位置。
        let mut probe: PathBuf = root.join(p);
        while !probe.exists() {
            match probe.parent() {
                Some(parent) => probe = parent.to_path_buf(),
                None => break,
            }
        }
        let real = probe.canonicalize().map_err(|e| format!("{f}: {e}"))?;
        if !real.starts_with(&root_real) {
            return Err(format!("path outside the project: {f}"));
        }
    }
    Ok(())
}

fn git_apply(root: &Path, patch: &str, strip: u8, directory: Option<&str>, extra: &[&str]) -> Result<(), String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(root)
        .arg("apply")
        .arg(format!("-p{strip}"))
        .args(["--recount", "--whitespace=nowarn", "--ignore-whitespace"])
        .args(extra);
    if let Some(dir) = directory {
        cmd.arg(format!("--directory={dir}"));
    }
    cmd.arg("-")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| format!("cannot run git: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        // 补丁末尾没换行时 git 会报 "corrupt patch"。
        let mut body = patch.to_owned();
        if !body.ends_with('\n') {
            body.push('\n');
        }
        stdin.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        let msg = String::from_utf8_lossy(&out.stderr);
        let short: String = msg.lines().take(4).collect::<Vec<_>>().join("\n");
        Err(if short.is_empty() { "git apply failed".into() } else { short })
    }
}

/// 项目根在仓库里的哪个子目录（`git rev-parse --show-prefix`）。
///
/// 在仓库里，`git apply` 的路径是相对**仓库顶层**的；而模型写的路径相对
/// 项目根。项目根是仓库的子目录时，要用 `--directory` 把这段前缀补上。
/// 不在仓库里返回 None（那时 `git apply` 就按当前目录解释路径）。
fn repo_prefix(root: &Path) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "--show-prefix"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let p = String::from_utf8_lossy(&out.stdout).trim().trim_end_matches('/').to_owned();
    (!p.is_empty()).then_some(p)
}

/// 应用（`reverse` 时撤销）一份补丁到 `root` 下。
pub fn apply(root: &Path, patch: &str, reverse: bool) -> PatchOutcome {
    let (files, strip) = match targets(patch) {
        Ok(t) => t,
        Err(e) => return PatchOutcome::Failed { reason: e },
    };
    if let Err(e) = check_paths(root, &files) {
        return PatchOutcome::Failed { reason: e };
    }
    let dir = repo_prefix(root);
    let dir = dir.as_deref();
    let fwd: &[&str] = if reverse { &["-R"] } else { &[] };
    let back: &[&str] = if reverse { &[] } else { &["-R"] };
    let check = |extra: &[&str]| {
        let mut args = extra.to_vec();
        args.push("--check");
        git_apply(root, patch, strip, dir, &args)
    };
    match check(fwd) {
        Ok(()) => match git_apply(root, patch, strip, dir, fwd) {
            Ok(()) => PatchOutcome::Applied { files },
            Err(reason) => PatchOutcome::Failed { reason },
        },
        Err(reason) => {
            // 反方向能应用 = 已经是目标状态了（应用过 / 撤销过）。
            if !reverse && check(back).is_ok() {
                PatchOutcome::AlreadyApplied { files }
            } else {
                PatchOutcome::Failed { reason }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PATCH: &str = "--- a/hello.txt\n+++ b/hello.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n";

    fn project() -> tempfile::TempDir {
        let d = tempfile::tempdir().expect("tmp");
        std::fs::write(d.path().join("hello.txt"), "one\ntwo\nthree\n").expect("写");
        d
    }

    #[test]
    fn 解析目标路径和前缀层数() {
        assert_eq!(targets(PATCH).expect("ok"), (vec!["hello.txt".to_owned()], 1));
        let bare = "--- src/x.ts\n+++ src/x.ts\n@@ -1 +1 @@\n-a\n+b\n";
        assert_eq!(targets(bare).expect("ok"), (vec!["src/x.ts".to_owned()], 0));
        let new_file = "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hi\n";
        assert_eq!(targets(new_file).expect("ok").0, vec!["new.txt".to_owned()]);
        assert!(targets("-a\n+b\n").is_err(), "没有文件头的补丁不知道改哪个文件");
    }

    #[test]
    fn 应用撤销和重复应用() {
        let d = project();
        assert_eq!(apply(d.path(), PATCH, false), PatchOutcome::Applied { files: vec!["hello.txt".into()] });
        assert_eq!(std::fs::read_to_string(d.path().join("hello.txt")).expect("读"), "one\nTWO\nthree\n");
        assert!(matches!(apply(d.path(), PATCH, false), PatchOutcome::AlreadyApplied { .. }));
        assert!(matches!(apply(d.path(), PATCH, true), PatchOutcome::Applied { .. }));
        assert_eq!(std::fs::read_to_string(d.path().join("hello.txt")).expect("读"), "one\ntwo\nthree\n");
    }

    #[test]
    fn 行号不准也能应用() {
        let d = project();
        let off = PATCH.replace("@@ -1,3 +1,3 @@", "@@ -7,9 +7,9 @@");
        assert!(matches!(apply(d.path(), &off, false), PatchOutcome::Applied { .. }));
    }

    #[test]
    fn 对不上就一个文件都不动() {
        let d = project();
        std::fs::write(d.path().join("b.txt"), "x\n").expect("写");
        let two = format!("{PATCH}--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-nope\n+y\n");
        assert!(matches!(apply(d.path(), &two, false), PatchOutcome::Failed { .. }));
        assert_eq!(std::fs::read_to_string(d.path().join("hello.txt")).expect("读"), "one\ntwo\nthree\n");
    }

    #[test]
    fn 路径出了项目就拒绝() {
        let d = project();
        let evil = "--- a/../evil.txt\n+++ b/../evil.txt\n@@ -0,0 +1 @@\n+x\n";
        assert!(matches!(apply(d.path(), evil, false), PatchOutcome::Failed { .. }));
        let abs = "--- /etc/hosts\n+++ /etc/hosts\n@@ -1 +1 @@\n-a\n+b\n";
        assert!(matches!(apply(d.path(), abs, false), PatchOutcome::Failed { .. }));
        assert!(!d.path().parent().expect("p").join("evil.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn 符号链接指出项目也拒绝() {
        let d = project();
        let outside = tempfile::tempdir().expect("tmp");
        std::os::unix::fs::symlink(outside.path(), d.path().join("link")).expect("链接");
        let p = "--- /dev/null\n+++ b/link/x.txt\n@@ -0,0 +1 @@\n+x\n";
        assert!(matches!(apply(d.path(), p, false), PatchOutcome::Failed { .. }));
        assert!(!outside.path().join("x.txt").exists());
    }

    #[test]
    fn 新建文件() {
        let d = project();
        let p = "--- /dev/null\n+++ b/sub/new.txt\n@@ -0,0 +1,2 @@\n+hi\n+there\n";
        assert!(matches!(apply(d.path(), p, false), PatchOutcome::Applied { .. }));
        assert_eq!(std::fs::read_to_string(d.path().join("sub/new.txt")).expect("读"), "hi\nthere\n");
    }
}
