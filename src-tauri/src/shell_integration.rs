//! 终端面板里交互式 shell 的「shell 集成」：在每条命令开始和结束时打
//! 一个 OSC 133 标记（和 VS Code、iTerm2、WezTerm 用的是同一套）。
//!
//! - `ESC ] 133 ; A BEL`：提示符要出来了（shell 空闲，可以写命令）。
//! - `ESC ] 133 ; C BEL`：命令开始执行，之后是它自己的输出。
//! - `ESC ] 133 ; D ; <退出码> BEL`：命令结束。
//!
//! 前端（TerminalPanel）靠它让回答里的「运行」知道命令什么时候跑完、
//! 退出码是几、哪几行是这条命令的输出。标记是不可见的控制序列，xterm
//! 吃掉不显示，用户在终端里什么都看不出来。
//!
//! # 怎么装进去，又不碰用户的配置
//!
//! 不改用户的任何文件。在私有目录里放几份很薄的启动文件，让 shell 先读
//! 它们，它们**原样**加载用户自己的配置，最后挂上两个钩子：
//!
//! - zsh：把 `ZDOTDIR` 指到这个目录。zsh 的 `.zshenv` / `.zprofile` /
//!   `.zshrc` / `.zlogin` 都从 `ZDOTDIR` 找，这边每份都是"切回用户的
//!   ZDOTDIR → source 用户那份 → 切回来"。最后一份 `.zlogin` 收尾时把
//!   `ZDOTDIR` 还给用户，之后在终端里起的子 zsh 完全不受影响。
//! - bash：`--init-file` 换掉启动文件，按登录 shell 的顺序加载
//!   `/etc/profile` 和 `~/.bash_profile`（或 `.bash_login`、`.profile`）。
//!   bash 没有 preexec，用 DEBUG trap 模拟；用户自己已经有 DEBUG trap 的
//!   （bash-preexec 一类）不动它，只打 A / D —— 拿不到 C 时前端退回按
//!   前台进程判断，只是没有退出码。
//!
//! 其余 shell（fish、sh、nu……）和 Windows 的 PowerShell 不装，照原样起。
//! 设 `RIOT_SHELL_INTEGRATION=0` 可以整个关掉。装失败（目录写不进）同样
//! 照原样起 —— 集成是锦上添花，不能因为它开不出终端。

#![allow(clippy::disallowed_methods)]

use portable_pty::CommandBuilder;

/// 用户的交互式 shell，能装集成就装上。
#[cfg(unix)]
pub fn interactive_shell() -> CommandBuilder {
    let shell = crate::gui_env::user_shell();
    if std::env::var("RIOT_SHELL_INTEGRATION").is_ok_and(|v| v == "0") {
        return plain(&shell);
    }
    let name = std::path::Path::new(&shell)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .trim_start_matches('-')
        .to_owned();
    let Some(dir) = integration_dir() else {
        return plain(&shell);
    };
    match name.as_str() {
        "zsh" => {
            if write_files(&dir, ZSH_FILES).is_err() {
                return plain(&shell);
            }
            let mut cmd = plain(&shell);
            let user_zdotdir = std::env::var("ZDOTDIR")
                .ok()
                .filter(|v| !v.is_empty());
            cmd.env("RIOT_ZDOTDIR_WAS_SET", if user_zdotdir.is_some() { "1" } else { "0" });
            if let Some(z) = user_zdotdir.or_else(|| std::env::var("HOME").ok()) {
                cmd.env("RIOT_USER_ZDOTDIR", z);
            }
            cmd.env("RIOT_SHELL_DIR", dir.as_os_str());
            cmd.env("ZDOTDIR", dir.as_os_str());
            cmd
        }
        "bash" => {
            if write_files(&dir, BASH_FILES).is_err() {
                return plain(&shell);
            }
            // 不能再带 -l：登录 shell 会忽略 --init-file。登录期该读的文件由
            // 集成脚本自己按顺序读，效果一样。
            let mut cmd = CommandBuilder::new(&shell);
            cmd.arg("--init-file");
            cmd.arg(dir.join("bashrc").as_os_str());
            cmd.arg("-i");
            cmd
        }
        _ => plain(&shell),
    }
}

#[cfg(windows)]
pub fn interactive_shell() -> CommandBuilder {
    CommandBuilder::new("powershell.exe")
}

/// 不装集成的登录 shell（和 term.rs 的 default_shell 一样）。
#[cfg(unix)]
fn plain(shell: &str) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(shell);
    cmd.arg("-l");
    cmd
}

/// 放启动文件的私有目录。
///
/// `[约束]` 不能放在多用户共享的 `/tmp` 下：别人先建好同名目录，就能往
/// 每个新开的终端里塞代码。macOS 的 `$TMPDIR` 是每个用户自己的；Linux
/// 用 `$XDG_RUNTIME_DIR`（每用户、0700），没有就放进家目录的缓存里。
/// 目录名带版本号：脚本改了换个目录，不和老版本的进程抢同一份文件。
#[cfg(unix)]
fn integration_dir() -> Option<std::path::PathBuf> {
    const NAME: &str = "riot-shell-integration-v1";
    let base = if cfg!(target_os = "macos") {
        std::env::temp_dir()
    } else if let Some(d) = std::env::var_os("XDG_RUNTIME_DIR").filter(|d| !d.is_empty()) {
        std::path::PathBuf::from(d)
    } else {
        std::path::PathBuf::from(std::env::var_os("HOME")?).join(".cache")
    };
    Some(base.join(NAME))
}

/// 写启动文件。内容没变就不写 —— 每开一个终端都来一遍，别白白改 mtime。
#[cfg(unix)]
fn write_files(dir: &std::path::Path, files: &[(&str, &str)]) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
    // 目录可能是别人预先建好的（见 integration_dir）：不是自己的、或者别人
    // 能写，就不用它。
    let meta = std::fs::symlink_metadata(dir)?;
    {
        use std::os::unix::fs::MetadataExt;
        let mine = meta.uid() == current_uid(dir)?;
        if !meta.is_dir() || !mine || meta.permissions().mode() & 0o022 != 0 {
            return Err(std::io::Error::other("integration dir not private"));
        }
    }
    for (name, body) in files {
        let path = dir.join(name);
        if std::fs::read_to_string(&path).is_ok_and(|cur| cur == *body) {
            continue;
        }
        // 先写临时文件再改名：另一个终端正好在读这份文件时不会读到半截。
        let tmp = dir.join(format!(".{name}.tmp{}", std::process::id()));
        std::fs::write(&tmp, body)?;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
        std::fs::rename(&tmp, &path)?;
    }
    Ok(())
}

/// 当前用户的 uid。不为一个 `getuid` 引进 libc：父目录（`$TMPDIR`、
/// `$XDG_RUNTIME_DIR`、`~/.cache`）都是用户自己的，拿它的属主做参照。
#[cfg(unix)]
fn current_uid(dir: &std::path::Path) -> std::io::Result<u32> {
    use std::os::unix::fs::MetadataExt;
    let parent = dir.parent().ok_or_else(|| std::io::Error::other("no parent"))?;
    Ok(std::fs::metadata(parent)?.uid())
}

/// zsh 的四份启动文件。每份都是：ZDOTDIR 切回用户的 → 读用户那份 →
/// 记下用户可能改过的 ZDOTDIR → 切回本目录（读下一份时还要从这里找）。
#[cfg(unix)]
const ZSH_FILES: &[(&str, &str)] = &[
    (
        ".zshenv",
        r#"# Riot 终端的 shell 集成：原样加载你自己的配置，再挂上命令开始 / 结束的标记。
ZDOTDIR=${RIOT_USER_ZDOTDIR:-$HOME}
[[ -f $ZDOTDIR/.zshenv ]] && builtin source $ZDOTDIR/.zshenv
RIOT_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$RIOT_SHELL_DIR
"#,
    ),
    (
        ".zprofile",
        r#"ZDOTDIR=$RIOT_USER_ZDOTDIR
[[ -f $ZDOTDIR/.zprofile ]] && builtin source $ZDOTDIR/.zprofile
RIOT_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$RIOT_SHELL_DIR
"#,
    ),
    (
        ".zshrc",
        r#"# /etc/zshrc 按 ZDOTDIR 定 HISTFILE，那时 ZDOTDIR 还指着这里 —— 改回你的。
[[ $HISTFILE == $RIOT_SHELL_DIR/.zsh_history ]] && HISTFILE=$RIOT_USER_ZDOTDIR/.zsh_history
ZDOTDIR=$RIOT_USER_ZDOTDIR
[[ -f $ZDOTDIR/.zshrc ]] && builtin source $ZDOTDIR/.zshrc
RIOT_USER_ZDOTDIR=$ZDOTDIR

typeset -gi __riot_ran=0
__riot_preexec() {
  __riot_ran=1
  builtin print -n '\e]133;C\a'
}
__riot_precmd() {
  local c=$?
  if (( __riot_ran )); then
    builtin print -n "\e]133;D;$c\a"
    __riot_ran=0
  fi
  builtin print -n '\e]133;A\a'
}
# precmd 排第一个：后面的钩子（主题、插件）会改掉 $?。
precmd_functions=(__riot_precmd $precmd_functions)
preexec_functions+=(__riot_preexec)

ZDOTDIR=$RIOT_SHELL_DIR
"#,
    ),
    (
        ".zlogin",
        r#"ZDOTDIR=$RIOT_USER_ZDOTDIR
[[ -f $ZDOTDIR/.zlogin ]] && builtin source $ZDOTDIR/.zlogin
# 收尾：ZDOTDIR 还给你。原来没设的就不留一个，终端里再起的 zsh 和平时一样。
[[ $RIOT_ZDOTDIR_WAS_SET == 0 && $ZDOTDIR == $HOME ]] && builtin unset ZDOTDIR
builtin unset RIOT_USER_ZDOTDIR RIOT_SHELL_DIR RIOT_ZDOTDIR_WAS_SET
"#,
    ),
];

#[cfg(unix)]
const BASH_FILES: &[(&str, &str)] = &[(
    "bashrc",
    r#"# Riot 终端的 shell 集成：按登录 shell 的顺序原样加载你的配置，再挂上命令开始 / 结束的标记。
if [ -r /etc/profile ]; then . /etc/profile; fi
for __riot_f in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
  if [ -r "$__riot_f" ]; then . "$__riot_f"; break; fi
done
unset __riot_f

__riot_armed=0
__riot_ran=0
# 只在提示符出来之后的第一条命令上打 C：PROMPT_COMMAND 里那些命令
# 也会触发 DEBUG，不能算成用户的命令。
__riot_preexec() {
  [ "$__riot_armed" = 1 ] || return
  case "$BASH_COMMAND" in __riot_*) return ;; esac
  __riot_armed=0
  __riot_ran=1
  printf '\033]133;C\007'
}
__riot_precmd() {
  local c=$?
  __riot_armed=0
  if [ "$__riot_ran" = 1 ]; then
    printf '\033]133;D;%s\007' "$c"
    __riot_ran=0
  fi
}
__riot_ready() {
  __riot_armed=1
  printf '\033]133;A\007'
}
# 已经有 DEBUG trap（bash-preexec 之类）就不抢，只打 A / D。
if [ -z "$(trap -p DEBUG)" ]; then
  trap '__riot_preexec' DEBUG
fi
PROMPT_COMMAND="__riot_precmd${PROMPT_COMMAND:+; $PROMPT_COMMAND}; __riot_ready"
"#,
)];

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn 启动文件写进私有目录且内容不变时不重写() {
        let tmp = tempfile::tempdir().expect("tmp");
        let dir = tmp.path().join("si");
        write_files(&dir, ZSH_FILES).expect("写");
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&dir).expect("meta").permissions().mode();
        assert_eq!(mode & 0o077, 0, "目录只给自己");
        let rc = dir.join(".zshrc");
        let before = std::fs::metadata(&rc).expect("rc").modified().expect("mtime");
        std::thread::sleep(std::time::Duration::from_millis(20));
        write_files(&dir, ZSH_FILES).expect("再写");
        let after = std::fs::metadata(&rc).expect("rc").modified().expect("mtime");
        assert_eq!(before, after);
    }

    #[test]
    fn 别人能写的目录不用() {
        let tmp = tempfile::tempdir().expect("tmp");
        let dir = tmp.path().join("si");
        std::fs::create_dir(&dir).expect("建");
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o777)).expect("chmod");
        assert!(write_files(&dir, BASH_FILES).is_err());
    }

    /// 在真 PTY 里起 bash，跑一条失败的命令，看标记和退出码。（管道当
    /// stdin 的交互式 bash 行为和终端里不一样，测不出真东西。）
    #[test]
    fn bash_集成打出开始结束标记和退出码() {
        use portable_pty::{PtySize, native_pty_system};
        use std::io::{Read, Write};
        if !std::path::Path::new("/bin/bash").exists() {
            return;
        }
        let tmp = tempfile::tempdir().expect("tmp");
        let dir = tmp.path().join("si");
        write_files(&dir, BASH_FILES).expect("写");
        let home = tmp.path().join("home");
        std::fs::create_dir(&home).expect("home");

        let pty = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 100, pixel_width: 0, pixel_height: 0 })
            .expect("pty");
        let mut cmd = CommandBuilder::new("/bin/bash");
        cmd.arg("--init-file");
        cmd.arg(dir.join("bashrc").as_os_str());
        cmd.arg("-i");
        cmd.env("HOME", &home);
        let mut child = pty.slave.spawn_command(cmd).expect("spawn");
        drop(pty.slave);
        let mut reader = pty.master.try_clone_reader().expect("reader");
        let mut writer = pty.master.take_writer().expect("writer");
        let got = std::sync::Arc::new(std::sync::Mutex::new(Vec::<u8>::new()));
        let sink = got.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                sink.lock().expect("lock").extend_from_slice(&buf[..n]);
            }
        });
        let text = || String::from_utf8_lossy(&got.lock().expect("lock")).into_owned();
        let wait = |want: &str| {
            for _ in 0..100 {
                if text().contains(want) {
                    return true;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            false
        };
        assert!(wait("\x1b]133;A\x07"), "提示符标记: {:?}", text());
        writer.write_all(b"sh -c 'exit 3'\r").expect("写");
        assert!(wait("\x1b]133;D;3\x07"), "退出码 3: {:?}", text());
        assert!(text().contains("\x1b]133;C\x07"), "开始标记: {:?}", text());
        // 空回车不算一条命令，不该再打 D。
        let before = text().matches("133;D").count();
        writer.write_all(b"\r").expect("写");
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert_eq!(text().matches("133;D").count(), before, "空回车: {:?}", text());
        let _ = writer.write_all(b"exit\r");
        let _ = child.wait();
    }
}
