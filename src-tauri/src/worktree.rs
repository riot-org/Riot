//! 分叉到独立的 git worktree（见 docs/FORK_DESIGN.md「worktree 模式」）。
//!
//! git 命令和目录都在宿主这边；内核只管把文件落到分叉点、改写路径。
//! 这里的函数全是阻塞的（跑 git、拷文件），调用方放进 `spawn_blocking`。

// 宿主层：真实进程、真实文件系统。见 clippy.toml。
#![allow(clippy::disallowed_methods)]

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use riot_protocol::{ForkWorktree, UiError, ui_error};
use serde::Serialize;
use sha2::Digest as _;

/// 分叉出来的 worktree 都放在这下面：`<根>/<项目名>-<短哈希>/<会话 id>`。
///
/// 不放在用户仓库里面或旁边：仓库里的嵌套 worktree 会在 `git status` 里显示成
/// 未跟踪目录，放旁边会往用户的文件夹里塞东西。
pub fn root(config_path: &Path) -> PathBuf {
    config_path
        .parent()
        .unwrap_or(Path::new("."))
        .join("worktrees")
}

/// 未跟踪文件单个超过这么大就不带过去（和切片同一条线）。
const MAX_UNTRACKED_BYTES: u64 = riot_kernel::checkpoint::MAX_SNAPSHOT_BYTES as u64;
/// 未跟踪文件最多带这么多个。没被忽略的构建产物可能有成千上万个。
const MAX_UNTRACKED_FILES: usize = 2000;
/// [`Carried::skipped`] 最多列几个。
const SKIP_LIST: usize = 20;

/// 会话根所在的仓库。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Repo {
    /// 仓库（或 worktree）的顶层。从会话根往上数出来，写法和会话根一致 ——
    /// 不用 `--show-toplevel`：它给的是 realpath，和会话根的写法对不上的话，
    /// 切片和基线里的路径前缀就改写不到。
    pub root: PathBuf,
    /// 此刻的 HEAD 提交。
    pub head: String,
}

/// 把原工作区未提交的状态带进 worktree 的结果。
#[derive(Debug, Default, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Carried {
    /// 拷过去的文件：改过的、新加的、未跟踪的。
    pub copied: usize,
    /// 原工作区里删掉了、worktree 里跟着删掉的。
    pub removed: usize,
    /// 没带过去的未跟踪文件（太大、太多、嵌套仓库），只列前几个。
    pub skipped: Vec<String>,
    pub skipped_count: usize,
}

/// 删 worktree 会话之前要知道的。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub path: PathBuf,
    pub branch: String,
    /// worktree 目录还在。
    pub exists: bool,
    /// 没提交的改动（含未跟踪文件）有几处。查不出来按有算。
    pub dirty: usize,
    /// 分叉之后分支上的提交，没被别的分支包含的有几个。
    pub unmerged: usize,
}

impl Status {
    /// 删掉不会丢东西。
    pub fn clean(&self) -> bool {
        self.dirty == 0 && self.unmerged == 0
    }
}

/// 没有对应会话的 worktree 目录。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Orphan {
    pub path: PathBuf,
    pub branch: Option<String>,
}

fn git(dir: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(dir)
        // 绝不能在这里弹凭证或编辑器：没人在看。
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true")
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// 跑完拿 stdout。失败时带上 git 自己的话（进 `UiError` 的 detail）。
fn run(cmd: &mut Command) -> Result<Vec<u8>, String> {
    let out = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("cannot run git: {e}"))?;
    if out.status.success() {
        return Ok(out.stdout);
    }
    let err = String::from_utf8_lossy(&out.stderr).trim().to_owned();
    Err(if err.is_empty() {
        format!("git exited with {:?}", out.status.code())
    } else {
        err
    })
}

fn run_str(cmd: &mut Command) -> Option<String> {
    let out = run(cmd).ok()?;
    let s = String::from_utf8_lossy(&out).trim().to_owned();
    (!s.is_empty()).then_some(s)
}

/// 会话根在不在 git 仓库里、仓库顶层在哪、HEAD 是什么。不是仓库、还没有
/// 提交（没法从 HEAD 开分支）、没装 git 都是 None。
pub fn probe(session_root: &Path) -> Option<Repo> {
    let prefix = run(git(session_root).args(["rev-parse", "--show-prefix"])).ok()?;
    let prefix = String::from_utf8_lossy(&prefix);
    let mut top = session_root.to_path_buf();
    for _ in Path::new(prefix.trim_end_matches(['\n', '\r'])).components() {
        if !top.pop() {
            return None;
        }
    }
    let head =
        run_str(git(session_root).args(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]))?;
    Some(Repo { root: top, head })
}

/// 新分支名：`riot/fork-<标题>`。标题里 git 不收的字符换成 `-`，撞名加 `-2`、`-3`……
/// 没有标题（或换完不合法）就用 `fallback`。
pub fn branch_for(repo: &Path, title: Option<&str>, fallback: &str) -> String {
    let slug = slug(title.unwrap_or_default());
    let plain = format!("riot/fork-{fallback}");
    let base = if slug.is_empty() {
        plain.clone()
    } else {
        format!("riot/fork-{slug}")
    };
    let base = if valid_branch(repo, &base) {
        base
    } else {
        plain.clone()
    };
    if !branch_exists(repo, &base) {
        return base;
    }
    (2..100)
        .map(|n| format!("{base}-{n}"))
        .find(|name| !branch_exists(repo, name))
        .unwrap_or(plain)
}

fn slug(title: &str) -> String {
    let mut out = String::new();
    let mut dash = true;
    for c in title.chars() {
        if out.chars().count() >= 24 {
            break;
        }
        if c.is_alphanumeric() {
            out.push(c);
            dash = false;
        } else if !dash {
            out.push('-');
            dash = true;
        }
    }
    out.trim_end_matches('-').to_owned()
}

fn valid_branch(repo: &Path, name: &str) -> bool {
    run(git(repo).args(["check-ref-format", "--branch", name])).is_ok()
}

fn branch_exists(repo: &Path, name: &str) -> bool {
    run(git(repo).args([
        "show-ref",
        "--verify",
        "--quiet",
        &format!("refs/heads/{name}"),
    ]))
    .is_ok()
}

/// 新 worktree 的目录。项目分组目录名留着可读的项目名，唯一性靠路径哈希。
pub fn dir_for(root: &Path, project_root: &Path, session_id: &str) -> PathBuf {
    let name: String = project_root
        .file_name()
        .map(|n| {
            n.to_string_lossy()
                .chars()
                .map(|c| {
                    if c.is_alphanumeric() || matches!(c, '-' | '_' | '.') {
                        c
                    } else {
                        '-'
                    }
                })
                .take(40)
                .collect()
        })
        .unwrap_or_default();
    let name = name.trim_start_matches('.');
    let hash = sha2::Sha256::digest(project_root.to_string_lossy().as_bytes());
    let short: String = hash.iter().take(4).map(|b| format!("{b:02x}")).collect();
    let group = if name.is_empty() {
        short
    } else {
        format!("{name}-{short}")
    };
    root.join(group).join(session_id)
}

/// 从 `repo` 的 HEAD 开分支 `branch`，检出到 `dest`，再把原工作区此刻的未提交
/// 状态带过去。返回 worktree 的实际路径（规范写法）。
///
/// 失败时什么都不留下：目录、分支、git 里的登记。
pub fn create(repo: &Repo, dest: &Path, branch: &str) -> Result<(PathBuf, Carried), UiError> {
    let (Some(parent), Some(name)) = (dest.parent(), dest.file_name()) else {
        return Err(ui_error!("host.fork.worktreeFailed"; dest.display()));
    };
    std::fs::create_dir_all(parent).map_err(|e| ui_error!("host.fork.worktreeFailed"; e))?;
    // `[约束]` 规范写法：工具记基线用的是 canonicalize 过的路径，新会话的根、
    // 改写后的切片和基线都得和它们一个写法，不然对不上。
    let parent =
        std::fs::canonicalize(parent).map_err(|e| ui_error!("host.fork.worktreeFailed"; e))?;
    let dest = parent.join(name);
    if let Err(e) = run(git(&repo.root)
        .args(["worktree", "add", "--quiet", "-b", branch])
        .arg(&dest)
        .arg(&repo.head))
    {
        discard_at(&dest, Some(branch), Some(&repo.root));
        return Err(ui_error!("host.fork.worktreeFailed"; e));
    }
    match carry(&repo.root, &dest) {
        Ok(carried) => Ok((dest, carried)),
        Err(e) => {
            discard_at(&dest, Some(branch), Some(&repo.root));
            Err(ui_error!("host.fork.carryFailed"; e))
        }
    }
}

/// 把 `src` 工作区里没提交的东西照原样拷进 `dst`：改过的、新加的、未跟踪的
/// 拷过去，删掉的跟着删。
///
/// 拷文件而不是 `git diff | git apply`：二进制、换行符过滤、补丁打不上这些
/// 情况都不用操心，结果和原工作区逐字节相同。
fn carry(src: &Path, dst: &Path) -> Result<Carried, String> {
    let raw = run(git(src).args([
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=all",
    ]))?;
    let mut out = Carried::default();
    let mut untracked = 0usize;
    let mut fields = raw.split(|&b| b == 0).filter(|f| f.len() > 3);
    while let Some(entry) = fields.next() {
        let (xy, path) = (&entry[..2], &entry[3..]);
        let mut paths = vec![path];
        // 改名 / 复制：后面紧跟原路径。原路径在工作区里多半已经不在，照下面
        // 的规则删掉。
        if matches!(xy[0], b'R' | b'C')
            && let Some(from) = fields.next()
        {
            paths.push(from);
        }
        let new_file = xy == b"??";
        for rel in paths.into_iter().map(path_from_bytes) {
            let from = src.join(&rel);
            let to = dst.join(&rel);
            let meta = match std::fs::symlink_metadata(&from) {
                Ok(m) => m,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    if remove_file_like(&to)? {
                        out.removed += 1;
                    }
                    continue;
                }
                Err(e) => return Err(format!("{}: {e}", from.display())),
            };
            if new_file {
                untracked += 1;
            }
            // 嵌套仓库在 status 里是一个目录。
            let too_much =
                new_file && (untracked > MAX_UNTRACKED_FILES || meta.len() > MAX_UNTRACKED_BYTES);
            if meta.is_dir() || too_much {
                out.skipped_count += 1;
                if out.skipped.len() < SKIP_LIST {
                    out.skipped.push(rel.display().to_string());
                }
                continue;
            }
            copy_entry(&from, &to, &meta)?;
            out.copied += 1;
        }
    }
    Ok(out)
}

#[cfg(unix)]
fn path_from_bytes(b: &[u8]) -> PathBuf {
    use std::os::unix::ffi::OsStrExt as _;
    PathBuf::from(std::ffi::OsStr::from_bytes(b))
}

#[cfg(not(unix))]
fn path_from_bytes(b: &[u8]) -> PathBuf {
    PathBuf::from(String::from_utf8_lossy(b).into_owned())
}

/// 删掉一个文件或符号链接。目录不动。回有没有删。
fn remove_file_like(path: &Path) -> Result<bool, String> {
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => Ok(false),
        Ok(_) => std::fs::remove_file(path)
            .map(|()| true)
            .map_err(|e| format!("{}: {e}", path.display())),
        Err(_) => Ok(false),
    }
}

fn copy_entry(from: &Path, to: &Path, meta: &std::fs::Metadata) -> Result<(), String> {
    let fail = |e: std::io::Error| format!("{}: {e}", to.display());
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(fail)?;
    }
    // worktree 里原有的可能是符号链接：`fs::copy` 会顺着它写到别处去。
    remove_file_like(to)?;
    #[cfg(unix)]
    if meta.file_type().is_symlink() {
        let target = std::fs::read_link(from).map_err(fail)?;
        return std::os::unix::fs::symlink(target, to).map_err(fail);
    }
    #[cfg(not(unix))]
    let _ = meta;
    std::fs::copy(from, to).map(|_| ()).map_err(fail)
}

/// 仓库的公共 git 目录（所有 worktree 共用的那个）。`dir` 不在了就 None。
fn common_dir(dir: &Path) -> Option<PathBuf> {
    if !dir.join(".git").exists() {
        return None;
    }
    let s = run_str(git(dir).args(["rev-parse", "--git-common-dir"]))?;
    let p = PathBuf::from(s);
    Some(if p.is_absolute() { p } else { dir.join(p) })
}

/// worktree 会话删之前查一下：有没有没提交的、没合并的。
pub fn status(w: &ForkWorktree) -> Status {
    let exists = w.path.is_dir();
    let dirty = if exists {
        run(git(&w.path).args(["status", "--porcelain=v1", "--untracked-files=normal"]))
            .map(|o| o.split(|&b| b == b'\n').filter(|l| !l.is_empty()).count())
            .unwrap_or(1)
    } else {
        0
    };
    let unmerged = common_dir(&w.path)
        .or_else(|| common_dir(&w.repo_root))
        .map_or(0, |c| unmerged(&c, &w.branch, &w.base));
    Status {
        path: w.path.clone(),
        branch: w.branch.clone(),
        exists,
        dirty,
        unmerged,
    }
}

/// 删没有会话的 worktree 时，分支能不能一起删：上面没有别处没有的提交。
/// 查不出来按不能算。
pub fn branch_is_merged(worktree: &Path, branch: &str) -> bool {
    common_dir(worktree).is_some_and(|c| unmerged(&c, branch, "HEAD") == 0)
}

fn unmerged(git_dir: &Path, branch: &str, base: &str) -> usize {
    let head = format!("refs/heads/{branch}");
    let ahead: usize =
        run_str(git(git_dir).args(["rev-list", "--count", &format!("{base}..{head}")]))
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
    if ahead == 0 {
        return 0;
    }
    let holders =
        run_str(git(git_dir).args(["branch", "--format=%(refname:short)", "--contains", &head]))
            .unwrap_or_default();
    if holders.lines().any(|b| b.trim() != branch) {
        0
    } else {
        ahead
    }
}

/// 删掉 `root` 下的一个 worktree（连同 git 里的登记）；`branch` 给了就把分支
/// 也删了。尽力而为，失败只告警。
///
/// `[约束]` 只删 `root` 下面的目录：路径来自索引，索引坏了也不能让它删到
/// 用户的项目。
pub fn discard(root: &Path, path: &Path, branch: Option<&str>, repo_hint: Option<&Path>) {
    let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    if !path.starts_with(&root) || path == root {
        tracing::warn!(path = %path.display(), "worktree 不在应用的 worktrees 目录里，没删");
        return;
    }
    discard_at(path, branch, repo_hint);
}

fn discard_at(path: &Path, branch: Option<&str>, repo_hint: Option<&Path>) {
    let common = common_dir(path).or_else(|| repo_hint.and_then(common_dir));
    if let Some(c) = &common
        && let Err(e) = run(git(c).args(["worktree", "remove", "--force"]).arg(path))
    {
        tracing::debug!(error = %e, "git worktree remove 没成，直接删目录");
    }
    if path.exists()
        && let Err(e) = std::fs::remove_dir_all(path)
    {
        tracing::warn!(error = %e, path = %path.display(), "worktree 目录没删掉");
    }
    if let Some(c) = &common {
        let _ = run(git(c).args(["worktree", "prune"]));
        if let Some(b) = branch
            && let Err(e) = run(git(c).args(["branch", "-D", b]))
        {
            tracing::warn!(error = %e, branch = b, "worktree 的分支没删掉");
        }
    }
    // 项目分组目录空了就收掉；不空 remove_dir 自己会失败。
    if let Some(parent) = path.parent() {
        let _ = std::fs::remove_dir(parent);
    }
}

/// 目录已经不在的 worktree 在仓库里的登记清掉（用户手动删了目录时会剩下）。
pub fn prune(repo_roots: impl IntoIterator<Item = PathBuf>) {
    let mut seen = HashSet::new();
    for r in repo_roots {
        if let Some(c) = common_dir(&r)
            && seen.insert(c.clone())
        {
            let _ = run(git(&c).args(["worktree", "prune"]));
        }
    }
}

/// `root` 下没有对应会话（id 不在 `live` 里）的 worktree 目录。
pub fn orphans(root: &Path, live: &HashSet<String>) -> Vec<Orphan> {
    let Ok(groups) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for group in groups.flatten() {
        if !group.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(group.path()) else {
            continue;
        };
        for e in entries.flatten() {
            if !e.file_type().is_ok_and(|t| t.is_dir())
                || live.contains(e.file_name().to_string_lossy().as_ref())
            {
                continue;
            }
            let path = e.path();
            let branch = path
                .join(".git")
                .exists()
                .then(|| run_str(git(&path).args(["symbolic-ref", "--short", "-q", "HEAD"])))
                .flatten();
            out.push(Orphan { path, branch });
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(dir: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("git 能跑")
            .success();
        assert!(ok, "git {args:?}");
    }

    /// 一个有一次提交的仓库，会话根在子目录 `app` 里。
    fn repo() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let top = std::fs::canonicalize(dir.path()).unwrap().join("repo");
        std::fs::create_dir_all(top.join("app")).unwrap();
        sh(&top, &["init", "-q"]);
        sh(&top, &["config", "user.email", "t@t"]);
        sh(&top, &["config", "user.name", "t"]);
        std::fs::write(top.join("app/a.txt"), "a\n").unwrap();
        std::fs::write(top.join("app/gone.txt"), "g\n").unwrap();
        std::fs::write(top.join("old.txt"), "o\n").unwrap();
        sh(&top, &["add", "."]);
        sh(&top, &["commit", "-qm", "init"]);
        (dir, top)
    }

    #[test]
    fn 子目录会话_仓库顶层从会话根往上数() {
        let (_d, top) = repo();
        let r = probe(&top.join("app")).expect("是仓库");
        assert_eq!(r.root, top);
        assert_eq!(r.head.len(), 40);
        let plain = tempfile::tempdir().unwrap();
        assert_eq!(probe(plain.path()), None);
    }

    #[test]
    fn 分支名_标题能用就用_撞名加后缀_不合法退回_id() {
        let (_d, top) = repo();
        assert_eq!(
            branch_for(&top, Some("登录 重构: 第二版"), "abc"),
            "riot/fork-登录-重构-第二版"
        );
        sh(&top, &["branch", "riot/fork-x"]);
        assert_eq!(branch_for(&top, Some("x"), "abc"), "riot/fork-x-2");
        assert_eq!(branch_for(&top, Some("..."), "abc"), "riot/fork-abc");
        assert_eq!(branch_for(&top, None, "abc"), "riot/fork-abc");
    }

    #[test]
    fn 建_worktree_带上未提交的状态_删掉不留痕迹() {
        let (_d, top) = repo();
        // 未提交：改一个、删一个、改名一个（暂存）、新建两个（一个太大）
        std::fs::write(top.join("app/a.txt"), "改过\n").unwrap();
        std::fs::remove_file(top.join("app/gone.txt")).unwrap();
        sh(&top, &["mv", "old.txt", "new.txt"]);
        std::fs::create_dir_all(top.join("app/d")).unwrap();
        std::fs::write(top.join("app/d/u.txt"), "u\n").unwrap();
        std::fs::write(
            top.join("big.bin"),
            vec![0u8; MAX_UNTRACKED_BYTES as usize + 1],
        )
        .unwrap();

        let repo = probe(&top.join("app")).unwrap();
        let wts = tempfile::tempdir().unwrap();
        let dest = dir_for(wts.path(), &top.join("app"), "s1");
        let (path, carried) = create(&repo, &dest, "riot/fork-t").expect("建好");
        assert_eq!(
            std::fs::read_to_string(path.join("app/a.txt")).unwrap(),
            "改过\n"
        );
        assert!(!path.join("app/gone.txt").exists());
        assert!(!path.join("old.txt").exists());
        assert_eq!(
            std::fs::read_to_string(path.join("new.txt")).unwrap(),
            "o\n"
        );
        assert_eq!(
            std::fs::read_to_string(path.join("app/d/u.txt")).unwrap(),
            "u\n"
        );
        assert!(!path.join("big.bin").exists());
        assert_eq!(carried.skipped, ["big.bin"]);
        assert_eq!(carried.skipped_count, 1);
        assert_eq!(
            std::fs::read_to_string(top.join("app/a.txt")).unwrap(),
            "改过\n",
            "原工作区不动"
        );

        let w = ForkWorktree {
            path: path.clone(),
            repo_root: top.clone(),
            branch: "riot/fork-t".into(),
            base: repo.head.clone(),
            project_root: top.join("app"),
        };
        let st = status(&w);
        assert!(st.exists && st.dirty > 0 && !st.clean(), "{st:?}");

        let live = HashSet::from(["s1".to_owned()]);
        assert!(orphans(wts.path(), &live).is_empty());
        let found = orphans(wts.path(), &HashSet::new());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].branch.as_deref(), Some("riot/fork-t"));

        discard(wts.path(), &path, Some("riot/fork-t"), Some(&top));
        assert!(!path.exists());
        assert!(!branch_exists(&top, "riot/fork-t"));
        assert!(
            std::fs::read_dir(wts.path()).unwrap().next().is_none(),
            "空的项目分组目录也收掉"
        );
        let listed = run_str(git(&top).args(["worktree", "list", "--porcelain"])).unwrap();
        assert_eq!(listed.matches("worktree ").count(), 1, "{listed}");
    }

    #[test]
    fn 状态_提交过没合并的算不干净_合进别的分支就算干净() {
        let (_d, top) = repo();
        let repo = probe(&top).unwrap();
        let wts = tempfile::tempdir().unwrap();
        let (path, _) = create(&repo, &dir_for(wts.path(), &top, "s1"), "riot/fork-m").unwrap();
        let w = ForkWorktree {
            path: path.clone(),
            repo_root: top.clone(),
            branch: "riot/fork-m".into(),
            base: repo.head.clone(),
            project_root: top.clone(),
        };
        assert!(status(&w).clean());
        std::fs::write(path.join("x.txt"), "x\n").unwrap();
        sh(&path, &["add", "."]);
        sh(&path, &["commit", "-qm", "x"]);
        let st = status(&w);
        assert_eq!((st.dirty, st.unmerged), (0, 1));
        sh(&top, &["merge", "-q", "--ff-only", "riot/fork-m"]);
        assert!(status(&w).clean());
    }

    #[test]
    fn 不在_worktrees_目录下的不删() {
        let (_d, top) = repo();
        let wts = tempfile::tempdir().unwrap();
        discard(wts.path(), &top, None, None);
        assert!(top.join("app/a.txt").exists());
    }
}
