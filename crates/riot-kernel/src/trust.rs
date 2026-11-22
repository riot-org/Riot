//! 项目信任：没被用户信任过的项目，不加载它自带的 Riot 配置。
//!
//! # 为什么要有
//!
//! 项目里的 `.riot/hooks.json` 会被直接 `sh -c` 执行 —— 不经过沙箱、不问人，
//! SessionStart 更是在第一条消息时就跑。克隆一个陌生仓库、用 Riot 打开、
//! 说一句"帮我看看"，仓库作者写的脚本就以用户的身份跑起来了。Claude Code
//! 和 VS Code 都用"信任此文件夹吗？"挡这一下，这里是同一件事。
//!
//! # 挡什么、不挡什么
//!
//! 挡：**会被当成 Riot 自身配置生效**的项目文件 ——
//! - `.riot/hooks.json`：自动执行的代码；
//! - `.riot/skills/`、`.riot/commands/`：以"技能 / 命令"的身份交给模型，
//!   权威比普通文件高，而且技能可以带脚本。
//!
//! 不挡：`AGENTS.md` / `CLAUDE.md`。它和 README 一样只是给模型读的文字，
//! 模型反正会读仓库里的文件 —— 挡住它换不来多少安全，却让每个正常项目
//! 在点"信任"之前都少了团队约定。
//!
//! # 记在哪
//!
//! `<配置目录>/riot/trusted_projects.json`。宿主写（用户点了"信任"），内核
//! 每次加载配置时读 —— 文件很小，读一次比在两个进程之间同步状态简单。
//! 信任一个目录即信任它下面的所有目录；git worktree 跟着主仓库走。
//!
//! 另有两条不落盘的来源：
//! - 环境变量 `RIOT_TRUSTED_PROJECTS`（路径列表）：`riot-server exec --trust`
//!   在拉起内核前设上，只对这一次运行有效；
//! - [`trust_for_process`]：进程内追加（测试用）。
//!
//! 豁免理由：宿主层数据，读写 Riot 自己的配置目录。
#![allow(clippy::disallowed_methods)]

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

pub const ENV_VAR: &str = "RIOT_TRUSTED_PROJECTS";
const FILE: &str = "trusted_projects.json";

static EXTRA: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

#[derive(Debug, Default, Serialize, Deserialize)]
struct TrustFile {
    #[serde(default)]
    projects: Vec<String>,
}

fn trust_path() -> PathBuf {
    crate::config::config_path()
        .parent()
        .unwrap_or(Path::new("."))
        .join(FILE)
}

fn canonical(p: &Path) -> PathBuf {
    let c = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    // Windows 的 canonicalize 带 `\\?\`，和配置里存的普通路径比不上。
    let s = c.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest.to_owned()),
        _ => c,
    }
}

fn read_file(path: &Path) -> TrustFile {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// 这个项目根是否被信任。
pub fn is_trusted(root: &Path) -> bool {
    let env = std::env::var_os(ENV_VAR);
    let extra = EXTRA.lock().map(|g| g.clone()).unwrap_or_default();
    is_trusted_in(&trust_path(), env.as_deref(), &extra, root)
}

fn is_trusted_in(
    file: &Path,
    env: Option<&std::ffi::OsStr>,
    extra: &[PathBuf],
    root: &Path,
) -> bool {
    let root = canonical(root);
    let main = canonical(&crate::auto_memory::main_checkout(&root));
    let mut trusted: Vec<PathBuf> = read_file(file).projects.iter().map(PathBuf::from).collect();
    if let Some(env) = env {
        trusted.extend(std::env::split_paths(env));
    }
    trusted.extend(extra.iter().cloned());
    trusted.iter().any(|t| {
        let t = canonical(t);
        root.starts_with(&t) || main.starts_with(&t)
    })
}

/// 信任 / 取消信任一个项目（宿主在用户点按钮时调）。
pub fn set_trusted(root: &Path, trusted: bool) -> std::io::Result<()> {
    set_trusted_in(&trust_path(), root, trusted)
}

fn set_trusted_in(file: &Path, root: &Path, trusted: bool) -> std::io::Result<()> {
    let root = canonical(root).display().to_string();
    let mut f = read_file(file);
    f.projects.retain(|p| p != &root);
    if trusted {
        f.projects.push(root);
        f.projects.sort();
    }
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&f).unwrap_or_default())?;
    std::fs::rename(&tmp, file)
}

/// 升级迁移：信任文件还不存在时，把用户已经在用的项目全部记为信任。
///
/// 不迁的话，老用户升级后项目里的 hooks / 技能 / 命令会**悄悄失效** ——
/// 他们早就在用这些项目，信任是事实上已经给过的。只在文件不存在时做一次。
pub fn migrate_existing(projects: &[String]) {
    let path = trust_path();
    if path.exists() {
        return;
    }
    let f = TrustFile {
        projects: projects
            .iter()
            .map(|p| canonical(Path::new(p)).display().to_string())
            .collect(),
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Err(e) = std::fs::write(&path, serde_json::to_string_pretty(&f).unwrap_or_default()) {
        tracing::warn!(error = %e, "写不下项目信任清单，下次启动再迁");
    } else {
        tracing::info!(count = f.projects.len(), "已把现有项目记为信任（升级迁移）");
    }
}

/// 进程内追加一个信任目录。只给测试用 —— 测试不能写用户真实的信任清单，
/// 也不能改进程环境变量（并行测试里那是数据竞争）。
pub fn trust_for_process(root: &Path) {
    if let Ok(mut g) = EXTRA.lock() {
        g.push(canonical(root));
    }
}

/// 项目里一项会被信任机制管住的配置。给界面列"这个项目带了什么"。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConfigItem {
    /// `hooks` / `skills` / `commands`。
    pub kind: String,
    pub path: String,
    /// hooks：配了几条；skills / commands：几个。
    pub count: usize,
}

/// 这个项目带了哪些需要信任才加载的配置。空 = 什么都没带，不用问。
pub fn project_config(root: &Path) -> Vec<ProjectConfigItem> {
    let mut out = Vec::new();
    let hooks = crate::hooks::project_path(root);
    if hooks.is_file() {
        let n = crate::hooks::count_in_file(&hooks);
        out.push(ProjectConfigItem {
            kind: "hooks".into(),
            path: hooks.display().to_string(),
            count: n,
        });
    }
    for (kind, dir) in [
        ("skills", crate::skills::project_dir(root)),
        ("commands", crate::slash::project_dir(root)),
    ] {
        let n = std::fs::read_dir(&dir)
            .map(|rd| rd.filter_map(Result::ok).count())
            .unwrap_or(0);
        if n > 0 {
            out.push(ProjectConfigItem {
                kind: kind.into(),
                path: dir.display().to_string(),
                count: n,
            });
        }
    }
    out
}

/// 加载点用：项目可信就返回 true；不可信且确实带了配置时记一条日志。
pub(crate) fn allow_project_config(root: &Path, what: &str) -> bool {
    if is_trusted(root) {
        return true;
    }
    tracing::info!(root = %root.display(), what, "项目未被信任，跳过它自带的配置");
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 信任目录及其子目录_环境变量和进程内追加都算() {
        let t = tempfile::tempdir().unwrap();
        let file = t.path().join("trusted_projects.json");
        let proj = t.path().join("proj");
        let sub = proj.join("crates/a");
        std::fs::create_dir_all(&sub).unwrap();
        let other = t.path().join("other");
        std::fs::create_dir_all(&other).unwrap();

        assert!(!is_trusted_in(&file, None, &[], &proj), "默认不信任");
        set_trusted_in(&file, &proj, true).unwrap();
        assert!(is_trusted_in(&file, None, &[], &proj));
        assert!(is_trusted_in(&file, None, &[], &sub), "子目录跟着信任");
        assert!(!is_trusted_in(&file, None, &[], &other));

        let env = std::env::join_paths([&other]).unwrap();
        assert!(is_trusted_in(&file, Some(&env), &[], &other), "环境变量");
        assert!(
            is_trusted_in(&file, None, &[canonical(&other)], &other),
            "进程内"
        );

        set_trusted_in(&file, &proj, false).unwrap();
        assert!(!is_trusted_in(&file, None, &[], &proj), "取消信任");
    }

    #[test]
    fn worktree_跟着主仓库() {
        let t = tempfile::tempdir().unwrap();
        let file = t.path().join("trusted_projects.json");
        let main = t.path().join("repo");
        std::fs::create_dir_all(main.join(".git/worktrees/feat")).unwrap();
        let wt = t.path().join("wt");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(
            wt.join(".git"),
            format!("gitdir: {}\n", main.join(".git/worktrees/feat").display()),
        )
        .unwrap();
        set_trusted_in(&file, &main, true).unwrap();
        assert!(is_trusted_in(&file, None, &[], &wt));
    }

    #[test]
    fn 列出项目带的配置() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path();
        assert!(project_config(root).is_empty());
        std::fs::create_dir_all(root.join(".riot/skills/deploy")).unwrap();
        std::fs::write(
            root.join(".riot/hooks.json"),
            r#"{"SessionStart":[{"hooks":[{"type":"command","command":"a"},{"type":"command","command":"b"}]}]}"#,
        )
        .unwrap();
        let items = project_config(root);
        let kinds: Vec<(&str, usize)> = items.iter().map(|i| (i.kind.as_str(), i.count)).collect();
        assert_eq!(kinds, vec![("hooks", 2), ("skills", 1)]);
    }
}
