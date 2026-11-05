//! 分叉（见 docs/FORK_DESIGN.md）的传输形状。

use crate::changes::RestoreSkip;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// worktree 分叉：新会话在一个独立检出里干活。
///
/// 宿主先建好 worktree 再发 `session.fork`；内核负责把文件落到分叉点、把
/// 切片和基线里的路径搬到新根下。整份记进新会话的分叉来源 —— 删会话时
/// 宿主据此收拾 worktree 和分支。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ForkWorktree {
    /// worktree 目录（检出的仓库根）。
    pub path: PathBuf,
    /// 原工作区的仓库根，写法跟着原会话的根走（不解析符号链接）。切片、
    /// 基线里这个前缀下的路径改写到 `path` 下；之外的不动、也不写回。
    pub repo_root: PathBuf,
    /// 检出的分支（`riot/fork-…`）。
    pub branch: String,
    /// 建 worktree 时的提交。删会话时据此判断分支上有没有新提交。
    pub base: String,
    /// 原项目根：侧栏按它分组。分叉的分叉沿用来源记下的那个。
    pub project_root: PathBuf,
}

impl ForkWorktree {
    /// 原工作区里的一个路径在 worktree 里的对应位置。不在仓库里的原样返回。
    pub fn relocate(&self, path: &Path) -> PathBuf {
        match path.strip_prefix(&self.repo_root) {
            Ok(rel) if rel.as_os_str().is_empty() => self.path.clone(),
            Ok(rel) => self.path.join(rel),
            Err(_) => path.to_path_buf(),
        }
    }

    /// 这个路径在原仓库里（会被搬进 worktree）。
    pub fn covers(&self, path: &Path) -> bool {
        path.starts_with(&self.repo_root)
    }
}

/// `session.fork_preview` 的应答：分叉确认框要的数字。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ForkPreview {
    /// 实际的分叉点：新会话历史的最后一条。
    pub message_id: String,
    /// 带过去几轮（用户提问数，含压缩归档里的）。
    pub turns: usize,
    /// 分叉点就是原会话的最新一轮，之后没有别的轮。
    pub latest: bool,
    /// 分叉点之后原会话改过、此刻和分叉点那一刻不一样的文件数。共用工作区
    /// 时新会话直接看到的就是这些改动，确认框要提一句。没有切片时是 0。
    pub changed_after: usize,
    /// 有分叉点那一刻的文件切片：worktree 能把会话动过的文件落回那一刻。
    /// 最新一轮不需要切片（此刻的磁盘就是那一刻），也记 true。
    pub has_slice: bool,
}

/// worktree 分叉时文件落到分叉点的结果。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ForkFiles {
    pub restored: usize,
    pub deleted: usize,
    pub skipped: Vec<RestoreSkip>,
    pub failed: Vec<RestoreSkip>,
    /// 没有分叉点那一刻的切片（老会话）：worktree 停在当前工作区的样子，
    /// 没往回落。
    pub stale: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wt() -> ForkWorktree {
        ForkWorktree {
            path: PathBuf::from("/data/worktrees/app-1a2b/f1"),
            repo_root: PathBuf::from("/code/app"),
            branch: "riot/fork-x".into(),
            base: "abc".into(),
            project_root: PathBuf::from("/code/app"),
        }
    }

    #[test]
    fn 仓库里的路径搬进_worktree_之外的不动() {
        let w = wt();
        assert_eq!(
            w.relocate(Path::new("/code/app/src/a.rs")),
            PathBuf::from("/data/worktrees/app-1a2b/f1/src/a.rs")
        );
        assert_eq!(
            w.relocate(Path::new("/code/app")),
            PathBuf::from("/data/worktrees/app-1a2b/f1")
        );
        // 前缀相同但不是同一个目录
        assert_eq!(
            w.relocate(Path::new("/code/application/a.rs")),
            PathBuf::from("/code/application/a.rs")
        );
        assert!(!w.covers(Path::new("/etc/hosts")));
        assert!(w.covers(Path::new("/code/app/x")));
    }
}
