//! 插件从哪来、怎么落到盘上：git clone、本地目录链接、压缩包下载。
//!
//! 安装分两步（`prepare` → `commit`），中间是给用户看的确认页：插件带的
//! hooks 会在每次工具调用时以他的身份跑命令、MCP 服务器会起进程 —— 这些
//! 得在用户点"安装"之前摆到他眼前，而不是装完才在设置页里发现。
//!
//! `prepare` 尽量拿到**真实内容**再预览：git 和本地目录是先取下来再读；
//! 压缩包几百 MB，预览只能用市场条目的元数据，内容以下载解压后的校验为准。
//!
//! 豁免理由：宿主层，操作真实的 git、网络与磁盘。

#![allow(clippy::disallowed_methods)]

use std::path::{Path, PathBuf};

use riot_kernel::config::PluginSource;
use serde::{Deserialize, Serialize};

use super::install::{self, InstallError};
use super::market::{ArchiveAsset, ResolvedSource};
use super::{PluginProgress, PluginStatus};

/// 前端发来的"装这个"。
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SourceRequest {
    /// 链接本地目录（开发模式）：不拷贝，改完即生效。
    Local { path: String },
    /// 任意 git 仓库。
    Git {
        url: String,
        #[serde(default)]
        git_ref: Option<String>,
        #[serde(default)]
        subdir: Option<String>,
    },
    /// 市场里的一条。
    Market { marketplace: String, name: String },
}

/// 一次准备好、等用户确认的安装。
#[derive(Debug)]
pub struct Pending {
    pub id: String,
    pub source: PluginSource,
    pub marketplace: Option<String>,
    pub staged: Staged,
    /// 清单里的版本（压缩包来源是市场条目里的）。
    pub version: String,
}

#[derive(Debug)]
pub enum Staged {
    /// 已 clone 到临时目录，确认后搬进 `plugins/<id>`。
    Dir(PathBuf),
    /// 链接的本地目录。
    Linked(PathBuf),
    /// 确认后再下载。
    Archive { asset: ArchiveAsset },
}

/// 给确认页的预览。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPreview {
    pub token: String,
    /// 插件的样子：id、元数据、组件清单、问题、不支持项。压缩包来源时
    /// 只有元数据（`contents_verified == false`）。
    pub plugin: PluginStatus,
    /// 内容已经真的读过了（git / 本地），还是只有市场说的（压缩包）。
    pub contents_verified: bool,
    pub download_size: u64,
    pub installed_size: u64,
    /// 同 id 已装的版本；有值 = 这次是覆盖/升级。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replaces_version: Option<String>,
}

/// 浅 clone 到 `dest`（先清空）。`git_ref` 是分支或标签。
///
/// 用 `git` 命令行而不是 libgit2：Riot 已经依赖 git（Windows 上 bash 就是
/// 从 Git for Windows 反推出来的），再编一份 libgit2 只为 clone 不划算。
pub async fn git_clone(url: &str, git_ref: Option<&str>, dest: &Path) -> Result<(), InstallError> {
    let _ = std::fs::remove_dir_all(dest);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| InstallError::Io("create clone dir".into(), e))?;
    }
    let mut cmd = tokio::process::Command::new("git");
    cmd.arg("clone")
        .arg("--depth")
        .arg("1")
        .arg("--quiet")
        .arg("--recurse-submodules")
        .arg("--shallow-submodules");
    if let Some(r) = git_ref.filter(|r| !r.trim().is_empty()) {
        cmd.arg("--branch").arg(r.trim());
    }
    cmd.arg("--").arg(url).arg(dest);
    // 绝不能在这里弹出凭证/编辑器等待：没人在看那个提示。
    cmd.env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true")
        .stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = tokio::time::timeout(std::time::Duration::from_secs(300), cmd.output())
        .await
        .map_err(|_| InstallError::Git(format!("clone {url} timed out")))?
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                InstallError::Git("git is not installed or not on PATH".into())
            } else {
                InstallError::Git(format!("cannot run git: {e}"))
            }
        })?;
    if !out.status.success() {
        let _ = std::fs::remove_dir_all(dest);
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_owned();
        return Err(InstallError::Git(format!(
            "clone {url} failed: {}",
            if stderr.is_empty() {
                format!("exit {:?}", out.status.code())
            } else {
                stderr
            }
        )));
    }
    Ok(())
}

/// clone 出来的提交号。拿不到就 None（不影响安装）。
pub async fn git_head(dir: &Path) -> Option<String> {
    let out = tokio::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["rev-parse", "HEAD"])
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
        .filter(|s| !s.is_empty())
}

/// 把一个 git 来源取到 `staging`：clone → 取子目录 → 摘掉 `.git`。
/// 返回插件根（staging 本身或其子目录搬上来之后仍是 staging）和提交号。
pub async fn fetch_git(
    url: &str,
    git_ref: Option<&str>,
    subdir: Option<&str>,
    staging: &Path,
) -> Result<Option<String>, InstallError> {
    let clone_dir = staging.join(".clone");
    git_clone(url, git_ref, &clone_dir).await?;
    let commit = git_head(&clone_dir).await;

    let root = match subdir.map(str::trim).filter(|s| !s.is_empty()) {
        Some(sub) => {
            // 子目录不许往上爬：`../` 会指到 clone 目录外面。
            let rel = Path::new(sub);
            if rel.is_absolute()
                || rel
                    .components()
                    .any(|c| matches!(c, std::path::Component::ParentDir))
            {
                return Err(InstallError::Layout(format!("bad subdir `{sub}`")));
            }
            let p = clone_dir.join(rel);
            if !p.is_dir() {
                return Err(InstallError::Layout(format!(
                    "`{sub}` is not a directory in {url}"
                )));
            }
            p
        }
        None => clone_dir.clone(),
    };
    if !install::has_manifest(&root) {
        return Err(InstallError::Layout(format!(
            "no plugin manifest in {url}{}",
            subdir.map(|s| format!(" ({s})")).unwrap_or_default()
        )));
    }
    // 把插件根的内容搬到 staging 顶层，.git 不要（几十 MB 的历史没用，
    // 而且会被当成目录扫）。
    let _ = std::fs::remove_dir_all(root.join(".git"));
    for entry in std::fs::read_dir(&root).map_err(|e| InstallError::Io("read clone".into(), e))? {
        let entry = entry.map_err(|e| InstallError::Io("read clone".into(), e))?;
        let name = entry.file_name();
        if name == ".git" {
            continue;
        }
        std::fs::rename(entry.path(), staging.join(&name))
            .map_err(|e| InstallError::Io("arrange clone".into(), e))?;
    }
    let _ = std::fs::remove_dir_all(&clone_dir);
    Ok(commit)
}

/// 下载 + 解压 + 自检一个压缩包来源，落到 `dest`。
pub async fn install_archive(
    id: &str,
    version: &str,
    asset: &ArchiveAsset,
    cache_dir: &Path,
    dest: &Path,
    data_root: &Path,
    progress: &(impl Fn(PluginProgress) + Send + Sync),
) -> Result<riot_kernel::plugins::Loaded, InstallError> {
    std::fs::create_dir_all(cache_dir)
        .map_err(|e| InstallError::Io("create cache dir".into(), e))?;
    let archive = cache_dir.join(format!("{id}-{version}.tar.zst"));

    super::download::fetch(&asset.url, &archive, asset.size, &asset.sha256, progress).await?;

    // `[约束]` 解压和自检都走 spawn_blocking。两者都是彻头彻尾的同步活:
    // 几百 MB 的 zstd 解码 + tar 逐条落盘、以及真的把包里的二进制跑起来。
    // 直接在 async 上下文里调，这几十秒内同一个 runtime 上的所有命令 ——
    // 发消息、内核 RPC、面板刷新 —— 一起卡住，而用户以为只是在装个插件。
    progress(PluginProgress::Extracting);
    let (src, dst) = (archive.clone(), dest.to_path_buf());
    let root = tokio::task::spawn_blocking(move || install::unpack(&src, &dst))
        .await
        .map_err(|e| InstallError::Task(format!("unpack task did not finish: {e}")))??;

    progress(PluginProgress::SelfCheck);
    let data_root = data_root.to_path_buf();
    let loaded = tokio::task::spawn_blocking(move || install::finalize(&root, &data_root))
        .await
        .map_err(|e| InstallError::Task(format!("self-check task did not finish: {e}")))?;
    // 自检不过的话把刚解出来的目录收掉：留着的话状态显示已安装，用起来
    // 却处处报错。
    let loaded = match loaded {
        Ok(l) => l,
        Err(e) => {
            let _ = std::fs::remove_dir_all(dest);
            return Err(e);
        }
    };

    // 装完就把压缩包删掉。它和解压出来的内容加起来是两份几百 MB,
    // 留着只在"同一版本重装"这一个场景有用,不值这个盘。
    let _ = std::fs::remove_file(&archive);
    Ok(loaded)
}

/// 市场条目 → 记进注册表的来源。
pub fn source_of(resolved: &ResolvedSource, platform: &str) -> Result<PluginSource, InstallError> {
    Ok(match resolved {
        ResolvedSource::Git {
            url,
            git_ref,
            subdir,
        } => PluginSource::Git {
            url: url.clone(),
            git_ref: git_ref.clone(),
            subdir: subdir.clone(),
            commit: None,
        },
        ResolvedSource::Archive { platforms } => {
            let a = platforms
                .get(platform)
                .ok_or_else(|| InstallError::Unsupported(platform.to_owned()))?;
            PluginSource::Archive {
                url: a.url.clone(),
                sha256: a.sha256.clone(),
                size: a.size,
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 本机建一个 git 仓库当远端，走一遍 clone → 子目录 → 摘 .git。
    /// 没装 git 的机器上跳过（Riot 本来就依赖 git，CI 都有）。
    #[tokio::test]
    async fn 从_git_取插件_子目录_与摘掉_git() {
        if tokio::process::Command::new("git")
            .arg("--version")
            .output()
            .await
            .is_err()
        {
            eprintln!("没有 git，跳过");
            return;
        }
        let tmp = tempfile::tempdir().expect("临时目录");
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(repo.join("plugins/demo/skills/s")).expect("建目录");
        std::fs::write(
            repo.join("plugins/demo/plugin.json"),
            r#"{ "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", "name": "demo", "version": "1.0.0" }"#,
        )
        .expect("写清单");
        std::fs::write(
            repo.join("plugins/demo/skills/s/SKILL.md"),
            "---\ndescription: d\n---\nx\n",
        )
        .expect("写技能");
        for args in [
            vec!["init", "-q", "-b", "main"],
            vec!["-c", "user.name=t", "-c", "user.email=t@t", "add", "."],
            vec![
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "commit",
                "-q",
                "-m",
                "init",
            ],
        ] {
            let ok = tokio::process::Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(&args)
                .output()
                .await
                .expect("git")
                .status
                .success();
            assert!(ok, "git {args:?} 失败");
        }

        let staging = tmp.path().join("staging");
        std::fs::create_dir_all(&staging).expect("建目录");
        let commit = fetch_git(
            &repo.display().to_string(),
            None,
            Some("plugins/demo"),
            &staging,
        )
        .await
        .expect("取下来");
        assert!(commit.is_some(), "要记下提交号");
        assert!(
            staging.join("plugin.json").is_file(),
            "子目录的内容搬到了 staging 顶层"
        );
        assert!(staging.join("skills/s/SKILL.md").is_file());
        assert!(!staging.join(".git").exists(), ".git 不要");
        assert!(!staging.join(".clone").exists(), "中间目录要收掉");

        // 子目录不许往上爬。
        let staging2 = tmp.path().join("staging2");
        std::fs::create_dir_all(&staging2).expect("建目录");
        let err = fetch_git(&repo.display().to_string(), None, Some("../x"), &staging2)
            .await
            .expect_err("该拒");
        assert!(matches!(err, InstallError::Layout(_)));
    }
}
