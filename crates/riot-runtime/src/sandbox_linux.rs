//! Linux bubblewrap 后端。
//!
//! `bwrap` 在一个新的挂载命名空间里把根目录**只读**挂回来，再把可写目录
//! 逐个 bind 成可写 —— 和 seatbelt 的「`allow default`、`deny file-write*`、
//! 再按目录放回」是同一个形状，所以跨平台的 [`SandboxPolicy`] 原样适用。
//! 跨平台的策略与激活在 [`crate::sandbox`]，这里只有 argv 拼装、seccomp
//! 过滤器和冒烟。
//!
//! # 为什么是 bubblewrap
//!
//! 不要 root、不要守护进程，Ubuntu / Debian / Fedora 都有现成的包，
//! Flatpak 和 Claude Code 的 Linux 沙箱都建在它上面。Landlock 不用装东西，
//! 但它只能**放行**、不能在放行的子树里再挖洞 —— `~/.cargo` 可写而
//! `~/.cargo/bin` 不可写（见 [`crate::sandbox::escape_surfaces`]）这种
//! 形状它表达不了。
//!
//! # 和 macOS 对齐的那几条
//!
//! - 读全开（`--ro-bind / /`），写限于 `writable`。
//! - 逃逸面在可写 bind **之后**再只读 bind 一次，后挂的盖住先挂的 ——
//!   和 SBPL「后写覆盖先写」同一个顺序约束。
//! - unix socket：seccomp 拦 `socket(AF_UNIX, …)`，挡的是把活外包给沙箱外
//!   daemon 的那条通道（docker、tmux server、本地数据库）。理由见
//!   `sandbox_macos::unix_socket_section`。
//! - 断网档：`--unshare-net`，只剩一个 loopback。
//!
//! 这个模块在所有平台编译：参数拼装、BPF 编码这些纯逻辑在开发机上就能测，
//! 和 `sandbox_win` 同一个理由。只有调用方是 Linux 门控的。

#![allow(clippy::disallowed_methods)]
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::path::{Path, PathBuf};

use riot_protocol::tool::ProcessSpec;

use crate::sandbox::SandboxPolicy;

/// 找 `bwrap`。
///
/// `[约束]` 只认固定的系统路径，不走 PATH。查找发生在沙箱**外**，而 PATH
/// 上常有用户可写的目录（`~/.local/bin`）—— 沙箱里的命令往那儿放一个假
/// `bwrap`，下一条命令就在沙箱外裸跑，而界面上照样显示「隔离生效中」。
/// `RIOT_BWRAP` 留给自己编 bubblewrap 的管理员：环境变量由启动方给，
/// 沙箱里改不到内核进程的环境。
pub(crate) fn locate() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("RIOT_BWRAP").filter(|s| !s.is_empty()) {
        let p = PathBuf::from(p);
        return p.is_file().then_some(p);
    }
    ["/usr/bin/bwrap", "/usr/local/bin/bwrap"]
        .into_iter()
        .map(PathBuf::from)
        .find(|p| p.is_file())
}

/// 一份能在这台机器上起得来的 bwrap 调用方式。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Bwrap {
    pub exe: PathBuf,
    pub proc: ProcMount,
}

/// `/proc` 怎么给。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProcMount {
    /// 新挂一份 procfs：配合 PID 命名空间，沙箱里只看得见自己的进程。
    Fresh,
    /// 只读 bind 宿主的 `/proc`。
    ///
    /// `[约束]` 容器里只能这样。Docker 在容器的 `/proc` 上叠了一层遮罩挂载
    /// （`/proc/kcore` 那些），而内核只允许在「完整可见」的 procfs 之上再挂
    /// 一份 —— 新挂直接 EPERM（`Can't mount proc on /newroot/proc`）。代价是
    /// 沙箱里看得见宿主的进程列表；PID 命名空间照拆，kill 不到它们。
    Host,
}

/// 找到 bwrap，并冒烟出这台机器能用的 `/proc` 挂法。
///
/// 冒烟就是在沙箱里跑一次 `/bin/true`，和 seatbelt 的 `profile_accepted`
/// 同一个理由，而 Linux 上失败的方式更多：没开非特权用户命名空间、AppArmor
/// 限制了它（Ubuntu 24.04 的 `apparmor_restrict_unprivileged_userns`，不是
/// apt 装的 bwrap 就没有放行的 profile）、跑在默认 seccomp 的 Docker 容器里
/// （`unshare` 被拦）。每一种都会让**每条**命令失败，所以激活时验一次，
/// 失败原因原样带回给 [`crate::sandbox::status`]。
pub(crate) fn probe(policy: &SandboxPolicy) -> Result<Bwrap, String> {
    let exe = locate()
        .ok_or_else(|| "找不到 bwrap。装上 bubblewrap（apt install bubblewrap）".to_owned())?;
    let mut first_err = None;
    for proc in [ProcMount::Fresh, ProcMount::Host] {
        let b = Bwrap {
            exe: exe.clone(),
            proc,
        };
        match smoke(&b, policy) {
            Ok(()) => return Ok(b),
            Err(e) => {
                first_err.get_or_insert(e);
            }
        }
    }
    Err(first_err.unwrap_or_default())
}

fn smoke(bwrap: &Bwrap, policy: &SandboxPolicy) -> Result<(), String> {
    let spec = wrap(
        bwrap,
        policy,
        ProcessSpec {
            program: "/bin/true".to_owned(),
            args: Vec::new(),
            cwd: PathBuf::from("/"),
            env: Vec::new(),
            timeout_ms: None,
            sandbox_exempt: false,
        },
    );
    let out = std::process::Command::new(&spec.program)
        .args(&spec.args)
        .current_dir("/")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|e| format!("起不来 {}：{e}", bwrap.exe.display()))?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr).trim().to_owned();
    Err(if err.is_empty() {
        format!("bwrap 冒烟失败（{}）", out.status)
    } else {
        err
    })
}

/// 把逃逸面里还不存在、允许预建的那些建出来。
///
/// bwrap 只能把只读挂载压在**存在的**路径上，而「不存在」本身就是缺口：
/// `~/.cargo` 可写，沙箱就能**新建**一个 `config.toml`，内容照样被沙箱外的
/// cargo 读走。所以和 Windows 一样先建空占位再盖只读；不许预建的（cargo
/// 老配置名，见 `escape_surfaces`）宁可留着那个洞。
pub(crate) fn plant_protected() {
    for p in crate::sandbox::escape_surfaces() {
        if !p.plant || p.path.exists() {
            continue;
        }
        let made = if p.is_dir {
            std::fs::create_dir_all(&p.path)
        } else {
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&p.path)
                .map(drop)
        };
        if let Err(e) = made {
            tracing::warn!(path = %p.path.display(), error = %e, "逃逸面占位没建出来，这一处不受保护");
        }
    }
}

/// 把一条命令改写成「在沙箱里跑这条命令」。
///
/// 外面套一层 `/bin/sh`，只为把 seccomp 过滤器从管道喂给 `bwrap --seccomp`：
///
/// ```text
/// /bin/sh -c 'printf "<BPF>" | exec "$@" 9<&0 0</dev/null' riot-sandbox bwrap … -- 程序 参数…
/// ```
///
/// `[约束]` 过滤器不能落盘。可写区里有 `/tmp`，放在那里的话沙箱里的命令
/// 改一下文件，下一条命令就没有 unix socket 的限制了；放到可写区之外又
/// 没有一个所有部署都有、而且一定写得进的位置。管道里的东西沙箱碰不到。
///
/// stdin 本来就是 `/dev/null`（见 `proc.rs`），这里把管道挪到 9 号 fd 之后
/// 再把 0 号接回 `/dev/null`，命令看到的 stdin 不变。
pub(crate) fn wrap(bwrap: &Bwrap, policy: &SandboxPolicy, spec: ProcessSpec) -> ProcessSpec {
    let script = format!(
        "printf '{}' | exec \"$@\" {SECCOMP_FD}<&0 0</dev/null",
        printf_escape(&seccomp_program())
    );
    let mut args = vec![
        "-c".to_owned(),
        script,
        "riot-sandbox".to_owned(),
        bwrap.exe.to_string_lossy().into_owned(),
    ];
    args.extend(bwrap_args(policy, bwrap.proc, &spec.cwd));
    args.push("--".to_owned());
    args.push(spec.program);
    args.extend(spec.args);
    ProcessSpec {
        program: "/bin/sh".to_owned(),
        args,
        ..spec
    }
}

fn running_as_root() -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        std::fs::metadata("/proc/self").is_ok_and(|m| m.uid() == 0)
    }
    #[cfg(not(unix))]
    false
}

/// bwrap 读过滤器的 fd。
const SECCOMP_FD: u32 = 9;

/// `bwrap` 自己的参数（不含 `--` 和命令）。
///
/// `[约束]` 顺序就是挂载顺序，后挂的盖住先挂的：根只读 → 可写目录 →
/// 逃逸面只读 → `/dev`、`/proc`。逃逸面排在可写目录前面的话会被
/// `~/.cargo` 的可写 bind 整个盖掉，静默重新可写。
fn bwrap_args(policy: &SandboxPolicy, proc: ProcMount, cwd: &Path) -> Vec<String> {
    let SandboxPolicy::WorkspaceWrite {
        writable,
        // 读本来就全开，手填的 allowRead 是 Windows 专属的概念。
        readable: _,
        allow_network,
    } = policy
    else {
        // Off 拿不到 ActiveSandbox，见 SandboxPolicy::activate。
        return vec!["--bind".into(), "/".into(), "/".into()];
    };

    let path = |p: &Path| p.to_string_lossy().into_owned();
    let mut a: Vec<String> = vec!["--ro-bind".into(), "/".into(), "/".into()];
    for dir in writable {
        a.extend(["--bind".into(), path(dir), path(dir)]);
    }
    for p in crate::sandbox::escape_surfaces() {
        // 不存在的是不许预建的那几个（见 plant_protected）：bwrap 对不存在
        // 的源路径直接报错，整条命令跑不起来。
        if p.path.exists() {
            a.extend(["--ro-bind".into(), path(&p.path), path(&p.path)]);
        }
    }
    // 全新的 /dev：null、zero、urandom、tty、pts、shm 都在，宿主的磁盘设备
    // 不在。新挂的 /proc 要配 --unshare-pid，顺带让沙箱看不见、也 kill 不到
    // 宿主的进程。
    a.extend(["--dev".into(), "/dev".into()]);
    match proc {
        ProcMount::Fresh => a.extend(["--proc".into(), "/proc".into()]),
        ProcMount::Host => a.extend(["--ro-bind".into(), "/proc".into(), "/proc".into()]),
    }
    // `[约束]` 两种情况要显式拆用户命名空间（bwrap 只在非 root、非 setuid
    // 时自动拆）：
    // - root：不拆的话它直接去建挂载命名空间，而容器里的 root 没有
    //   CAP_SYS_ADMIN，报 "Creating new namespace failed: Operation not permitted"。
    // - 宿主 /proc：同一用户命名空间里，`/proc/<宿主 pid>/root`、`cwd` 能跳进
    //   宿主进程的挂载视图，那边是可写的。隔着用户命名空间时内核拒绝访问。
    if running_as_root() || proc == ProcMount::Host {
        a.push("--unshare-user".into());
    }
    a.push("--unshare-pid".into());
    if !allow_network {
        a.push("--unshare-net".into());
    }
    // `--die-with-parent`：超时 / 取消时 proc.rs 杀的是进程组，而沙箱里的
    // 进程在新会话里、不在那个组里 —— 不带这条的话它们会比 bwrap 活得久。
    // `--new-session`：脱离控制终端，挡住 TIOCSTI 往宿主终端里塞按键。
    a.extend(["--die-with-parent".into(), "--new-session".into()]);
    a.extend(["--seccomp".into(), SECCOMP_FD.to_string()]);
    a.extend(["--chdir".into(), path(cwd)]);
    a
}

/// seccomp 过滤器（经典 BPF），按本机架构编好的字节。
///
/// 拦三样，其余放行：
/// - `socket(AF_UNIX, …)`：unix socket 外连，理由见模块头。`socketpair`
///   不拦 —— 它造的是进程内的一对，连不到沙箱外，而 Python 的
///   `multiprocessing`、libuv 的子进程 IPC 都靠它。
/// - `io_uring_setup`：`IORING_OP_SOCKET` 在内核里直接建 socket，不经过
///   `socket` 系统调用，上面那条拦不住它。
/// - 非本机 ABI（x86_64 上的 i386 / x32）：那边的 socket 走 `socketcall`
///   或另一套调用号，按本机调用号写的规则对它们无效。32 位程序在沙箱里
///   因此跑不了，服务器上几乎碰不到。
///
/// 被拦的一律回 `EPERM`，stderr 上是 "Operation not permitted" ——
/// 正好落进 `looks_denied`，模型会看到沙箱提示。
fn seccomp_program() -> Vec<u8> {
    #[cfg(target_arch = "aarch64")]
    const ARCH: (u32, u32) = (0xC000_00B7, 198); // AUDIT_ARCH_AARCH64, __NR_socket
    #[cfg(not(target_arch = "aarch64"))]
    const ARCH: (u32, u32) = (0xC000_003E, 41); // AUDIT_ARCH_X86_64, __NR_socket
    let (audit_arch, nr_socket) = ARCH;

    const LD_ABS: u16 = 0x20; // BPF_LD | BPF_W | BPF_ABS
    const JEQ: u16 = 0x15; // BPF_JMP | BPF_JEQ | BPF_K
    const JGE: u16 = 0x35; // BPF_JMP | BPF_JGE | BPF_K
    const RET: u16 = 0x06; // BPF_RET | BPF_K
    const ALLOW: u32 = 0x7fff_0000; // SECCOMP_RET_ALLOW
    const DENY: u32 = 0x0005_0000 | 1; // SECCOMP_RET_ERRNO | EPERM
    const X32_BIT: u32 = 0x4000_0000;
    const NR_IO_URING_SETUP: u32 = 425; // 两个架构共用的新调用号段
    const AF_UNIX: u32 = 1;

    // seccomp_data：nr @0、arch @4、args[0] @16（小端取低 32 位）。
    // 跳转偏移是「跳过几条」：第 8 条是 ALLOW，第 9 条是 DENY。
    let prog: [(u16, u8, u8, u32); 10] = [
        (LD_ABS, 0, 0, 4),
        (JEQ, 0, 7, audit_arch),
        (LD_ABS, 0, 0, 0),
        (JGE, 5, 0, X32_BIT),
        (JEQ, 4, 0, NR_IO_URING_SETUP),
        (JEQ, 0, 2, nr_socket),
        (LD_ABS, 0, 0, 16),
        (JEQ, 1, 0, AF_UNIX),
        (RET, 0, 0, ALLOW),
        (RET, 0, 0, DENY),
    ];
    let mut out = Vec::with_capacity(prog.len() * 8);
    for (code, jt, jf, k) in prog {
        out.extend_from_slice(&code.to_le_bytes());
        out.push(jt);
        out.push(jf);
        out.extend_from_slice(&k.to_le_bytes());
    }
    out
}

/// 每个字节都写成 `printf` 格式串里的三位八进制转义。
///
/// 全部转义而不是只转不可见字符：这样格式串里不会出现 `%`、`'`、`\`
/// 的字面量，既不会被 printf 当成格式指令，也不会撑破外面那层单引号。
fn printf_escape(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("\\{b:03o}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(writable: Vec<PathBuf>, allow_network: bool) -> SandboxPolicy {
        SandboxPolicy::WorkspaceWrite {
            writable,
            readable: vec![],
            allow_network,
        }
    }

    fn position(args: &[String], seq: &[&str]) -> Option<usize> {
        args.windows(seq.len())
            .position(|w| w.iter().zip(seq).all(|(a, b)| a == b))
    }

    /// 挂载顺序就是覆盖顺序：根只读在最前，可写目录在它后面。反过来的话
    /// 根的只读 bind 会把可写目录整个盖掉，表现是「沙箱一开什么都写不了」。
    #[test]
    fn 根只读在前可写目录在后() {
        let a = bwrap_args(
            &policy(vec!["/w".into()], true),
            ProcMount::Fresh,
            Path::new("/w"),
        );
        let root = position(&a, &["--ro-bind", "/", "/"]).expect("根要只读挂回来");
        let work = position(&a, &["--bind", "/w", "/w"]).expect("可写目录要 bind 回来");
        assert!(root < work, "{a:?}");
        assert_eq!(&a[a.len() - 2..], ["--chdir", "/w"]);
    }

    /// 逃逸面要压在可写 bind 之后，否则 `~/.cargo` 的可写 bind 会把
    /// `~/.cargo/bin` 的只读盖掉 —— 沙箱能顶掉用户在沙箱外执行的 cargo。
    #[test]
    fn 逃逸面压在可写目录之后() {
        let surfaces = crate::sandbox::escape_surfaces();
        let Some(surface) = surfaces.iter().find(|p| p.path.exists()) else {
            eprintln!("这台机器没有 ~/.cargo / ~/.rustup，跳过");
            return;
        };
        let home = crate::sandbox::home_dir().expect("有逃逸面就有 home");
        let cargo = home.join(".cargo").canonicalize().unwrap_or(home);
        let a = bwrap_args(
            &policy(vec![cargo.clone()], true),
            ProcMount::Fresh,
            Path::new("/"),
        );
        let s = surface.path.to_string_lossy();
        let c = cargo.to_string_lossy();
        let deny = position(&a, &["--ro-bind", &s, &s]).expect("逃逸面要只读挂上");
        let allow = position(&a, &["--bind", &c, &c]).expect("缓存树要可写");
        assert!(deny > allow, "{a:?}");
    }

    /// 容器里退回 bind 宿主的 /proc，但必须是只读的 —— 可写的话沙箱能改
    /// `/proc/sys`、往宿主进程的 `/proc/<pid>/mem` 里写。
    #[test]
    fn 宿主_proc_只读挂() {
        let a = bwrap_args(&policy(vec![], true), ProcMount::Host, Path::new("/"));
        assert!(
            position(&a, &["--ro-bind", "/proc", "/proc"]).is_some(),
            "{a:?}"
        );
        assert!(!a.contains(&"--proc".to_owned()));
        assert!(a.contains(&"--unshare-user".to_owned()), "{a:?}");
    }

    #[test]
    fn 断网档才拆网络命名空间() {
        let on = bwrap_args(&policy(vec![], true), ProcMount::Fresh, Path::new("/"));
        let off = bwrap_args(&policy(vec![], false), ProcMount::Fresh, Path::new("/"));
        assert!(!on.contains(&"--unshare-net".to_owned()));
        assert!(off.contains(&"--unshare-net".to_owned()));
    }

    /// 命令接在 `--` 后面原样传，`-c`、`--release` 这类参数不能被 bwrap
    /// 当成自己的选项吃掉。
    #[test]
    fn wrap_把命令接在双横线之后() {
        let spec = ProcessSpec {
            program: "cargo".to_owned(),
            args: vec!["build".to_owned(), "--release".to_owned()],
            cwd: PathBuf::from("/w"),
            env: vec![("K".to_owned(), "V".to_owned())],
            timeout_ms: Some(5),
            sandbox_exempt: false,
        };
        let b = Bwrap {
            exe: PathBuf::from("/usr/bin/bwrap"),
            proc: ProcMount::Fresh,
        };
        let w = wrap(&b, &policy(vec![], true), spec);
        assert_eq!(w.program, "/bin/sh");
        assert_eq!(w.args[0], "-c");
        assert_eq!(w.args[2], "riot-sandbox", "$0 占位，$@ 才从 bwrap 开始");
        assert_eq!(w.args[3], "/usr/bin/bwrap");
        assert_eq!(
            &w.args[w.args.len() - 4..],
            ["--", "cargo", "build", "--release"]
        );
        assert_eq!(w.env, vec![("K".to_owned(), "V".to_owned())]);
        assert_eq!(w.cwd, PathBuf::from("/w"));
    }

    /// 格式串里只能有八进制转义：一个字面的 `%` 会被 printf 当成格式指令，
    /// 一个 `'` 会撑破外面那层单引号。
    #[test]
    fn 过滤器全部转义成八进制() {
        let esc = printf_escape(&seccomp_program());
        assert!(
            esc.chars().all(|c| c == '\\' || c.is_ascii_digit()),
            "{esc}"
        );
        assert_eq!(
            esc.len(),
            10 * 8 * 4,
            "十条指令，每条 8 字节，每字节 4 个字符"
        );
        assert_eq!(printf_escape(&[0, 7, 0o377]), "\\000\\007\\377");
    }

    /// 跳转偏移手算的，钉住两个出口的位置：数错一位，要么什么都放行，
    /// 要么连 `read` 都被拦。
    #[test]
    fn 过滤器的跳转都落在两个出口上() {
        let prog = seccomp_program();
        let insn: Vec<(u16, u8, u8, u32)> = prog
            .chunks(8)
            .map(|c| {
                (
                    u16::from_le_bytes([c[0], c[1]]),
                    c[2],
                    c[3],
                    u32::from_le_bytes([c[4], c[5], c[6], c[7]]),
                )
            })
            .collect();
        let (allow, deny) = (insn.len() - 2, insn.len() - 1);
        assert_eq!(insn[allow], (0x06, 0, 0, 0x7fff_0000));
        assert_eq!(insn[deny], (0x06, 0, 0, 0x0005_0001));
        for (i, &(code, jt, jf, k)) in insn.iter().enumerate() {
            if code & 0x07 != 0x05 {
                continue;
            }
            let t = i + 1 + jt as usize;
            let f = i + 1 + jf as usize;
            assert!(t <= deny && f <= deny, "第 {i} 条跳出了程序");
            match k {
                1 => assert_eq!((t, f), (deny, allow), "AF_UNIX 要拦、别的域放行"),
                425 | 0x4000_0000 => assert_eq!(t, deny, "第 {i} 条命中要拦"),
                _ => {}
            }
        }
    }
}
