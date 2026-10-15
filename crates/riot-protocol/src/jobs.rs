//! 后台命令（Bash 的 `run_in_background`）：会自己结束、但要跑很久的命令。
//!
//! # 为什么不用终端面板
//!
//! 终端面板（[`crate::terminal`]）是给**不会结束**的服务的：dev server
//! 要一直活着、用户要看它的日志、要能 Ctrl-C。盯 CI、跑一遍很长的测试
//! 不是这种东西 —— 它们会自己结束，模型要的只是"结束时告诉我结果"。
//! 塞进终端面板的结果是：用户面前多出一个没有输出的终端；模型为了知道
//! 它什么时候结束，只能拿 TerminalOutput 的 `wait_for` 一轮轮地等，
//! 回合一直占着，"后台"名不副实。
//!
//! 这里的做法和后台子 agent 一样：调用立刻返回，模型结束回合；命令在
//! 会话上跑，进后台任务面板（用户看得见、能停）；结束时以一条通知消息
//! 把退出码和输出交给模型，空闲的会话被这条通知唤起新的一轮。
//!
//! 执行本身（怎么起进程、怎么把输出写成模型读得懂的话）在工具那边，
//! 这一层只管"登记、在后台跑、结束时通知"。

use std::future::Future;
use std::pin::Pin;

use tokio_util::sync::CancellationToken;

use crate::id::ToolUseId;
use crate::task::BackgroundTaskStatus;

/// 要放到后台的一条命令。
#[derive(Debug, Clone)]
pub struct JobSpec {
    /// 给人看的名字（Bash 的 `description`，没给就截命令）。
    pub title: String,
    /// 原样的命令。通知里要带上 —— 模型可能同时开了几条，得认得出是哪条。
    pub command: String,
    /// 开它的那次 Bash 调用。
    pub tool_use_id: ToolUseId,
}

/// 命令跑完之后交回来的东西。
#[derive(Debug, Clone)]
pub struct JobReport {
    /// 退出码 0 → Completed；非零 / 超时 / 起不来 → Failed；被停 → Cancelled。
    pub status: BackgroundTaskStatus,
    /// 给模型的正文：退出码和输出，已经裁剪成读得下的大小。
    pub report: String,
}

/// 真正去跑的那段。拿到的令牌在用户按面板上的停止键、或会话关闭时取消。
pub type JobRun =
    Box<dyn FnOnce(CancellationToken) -> Pin<Box<dyn Future<Output = JobReport> + Send>> + Send>;

pub trait BackgroundJobs: Send + Sync {
    /// 登记并在后台开跑，立刻返回任务 id（**不等它结束**）。
    ///
    /// `Err` 是写给模型的话（这个环境放不了后台）。
    fn spawn(&self, spec: JobSpec, run: JobRun) -> Result<String, String>;
}

/// 没有后台的占位实现。
///
/// 和 [`crate::terminal::NoTerminal`] 同一个规矩：没装配就明说用不了，
/// 而不是悄悄在前台跑完 —— 那会让模型以为自己可以结束回合了。
pub struct NoJobs;

impl BackgroundJobs for NoJobs {
    fn spawn(&self, _spec: JobSpec, _run: JobRun) -> Result<String, String> {
        Err(
            "这个环境不支持后台命令。去掉 `run_in_background` 在前台跑（可以调大 \
             `timeout_ms`）。"
                .to_owned(),
        )
    }
}
