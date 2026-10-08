//! 无界面宿主。见 `riot_host_lib::headless`。

use std::process::ExitCode;

fn main() -> ExitCode {
    let mut args = std::env::args();
    let _ = args.next();
    // 和 `Riot` 同一套多调用分发：登录 shell 回调 `--print-env`，git / ssh
    // 回调 `--askpass`，Windows 沙箱回调 `--srt-win`。它们拿的都是
    // `current_exe()`，也就是这个二进制。
    match args.next().as_deref() {
        Some("--print-env") => {
            riot_host_lib::print_process_env();
            ExitCode::SUCCESS
        }
        Some("--askpass") => {
            let prompt = args.collect::<Vec<_>>().join(" ");
            std::process::exit(riot_host_lib::run_askpass(&prompt));
        }
        #[cfg(windows)]
        Some(a) if a == srt_win::SRT_WIN_DISPATCH_ARG1 => {
            std::process::exit(srt_win::run_from_args(std::env::args_os()));
        }
        _ => riot_host_lib::headless::main(),
    }
}
