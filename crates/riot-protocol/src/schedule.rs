//! 定时任务：让 agent 的"要不要我下午再扫一次"能真正兑现。
//!
//! # 职责划分
//!
//! - **宿主是调度权威**：任务表、时间解析、下次运行的计算、tick 循环、
//!   到点执行，全在宿主进程（调度要在内核不在时也活着，和会话注册表
//!   同一条理由）。
//! - **内核只是发起方**：`Schedule` 工具通过反向 RPC（[`ScheduleAccess`]
//!   的远程实现）把创建/查询/删除转给宿主。
//! - **时间只有宿主碰**：模型给的是本地时间的说法（[`WhenSpec`]），
//!   宿主解析并算出 Unix 毫秒。内核进程不做时区运算 —— 两边各算一遍，
//!   哪天必然对不上。
//!
//! # 视图与存储分离
//!
//! [`ScheduledTask`] 是给前端和模型看的**视图**（带宿主现算的本地时间
//! 文字）。宿主自己的存储结构在 src-tauri，不在协议里 —— 协议只承诺
//! "你会看到什么"，不承诺"盘上长什么样"。

use async_trait::async_trait;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::text::UiError;

/// 重复规则。
///
/// `Once` 不带时刻 —— 一次性任务的时刻就是 [`ScheduledTask::next_run_ms`]，
/// 再存一份就有"哪个说了算"的问题。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Repeat {
    /// 只跑一次，跑完自动停用。
    Once,
    /// 每隔 `minutes` 分钟跑一次（从上一次到点算）。
    ///
    /// "每五分钟提醒我喝水"是**一个**任务反复跑，不是每跑完再建一个
    /// 五分钟后的一次性任务 —— 后者会在列表里堆出一串。
    Every { minutes: u32 },
    /// 每天 `time`（本地时间 "HH:MM"）。
    Daily { time: String },
    /// 周一到周五的 `time`。
    Weekdays { time: String },
    /// 每周 `weekday`（1=周一 … 7=周日）的 `time`。
    Weekly { weekday: u8, time: String },
}

/// 跳过时段：周期任务到点时落在这里就不跑（不开对话、不补跑）。
///
/// 典型用途是盯盘任务避开午休、收盘后和周末 —— 不设的话，到点照样把
/// 长提示词发给模型，模型只回一句"午休，跳过"，白烧 token。
///
/// 语义（本地墙钟，宿主判定，见宿主 `schedule::in_skip_window`）：
/// - 区间左闭右开：`start` 那一刻算在内，`end` 那一刻不算（11:30–13:00
///   里 11:30 跳过、13:00 照跑）。
/// - `start > end` 是跨午夜：15:00–09:30 = 当天 15:00 之后 + 当天 09:30 之前。
/// - `start == end` 是全天（00:00–00:00 配周六日 = 周末全天）。
/// - `weekdays` 按**此刻所在的那一天**判，不按时段起点那天：15:00–09:30
///   配周一到周五，周五 15:00 后跳过，周六凌晨不归它管。空 = 每天。
/// - 只管周期任务；一次性任务跳过就等于丢了，宿主不对它生效。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkipWindow {
    /// 开始，本地时间 "HH:MM"（含）。
    pub start: String,
    /// 结束，本地时间 "HH:MM"（不含）。比 start 早 = 跨午夜；相等 = 全天。
    pub end: String,
    /// 只在这些星期生效（1=周一 … 7=周日）。空 = 每天。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub weekdays: Vec<u8>,
}

/// 创建任务时对时间的说法。解析与计算在宿主。
///
/// `After` 存在的理由：模型对"现在几点"没有可靠感知，"90 分钟后"这种
/// 相对说法它不会算错；绝对时间给错了，宿主会报错并附上当前时刻让它自纠。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WhenSpec {
    /// 一次性，绝对本地时间 "YYYY-MM-DD HH:MM"。
    Once { at: String },
    /// 一次性，从现在起 `minutes` 分钟后。
    After { minutes: u32 },
    /// 周期性，每隔 `minutes` 分钟。首次在 `minutes` 分钟后。
    Every { minutes: u32 },
    /// 每天 "HH:MM"。
    Daily { time: String },
    /// 工作日 "HH:MM"。
    Weekdays { time: String },
    /// 每周 `weekday`（1=周一 … 7=周日）的 "HH:MM"。
    Weekly { weekday: u8, time: String },
}

/// 创建一个定时任务的完整说法。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleSpec {
    /// 任务名。列表和系统通知都用它，起短一点。
    pub name: String,
    /// 到点注入的提示词。像写给未来的自己：要自带全部背景，
    /// 那时不一定有现在的上下文。
    pub prompt: String,
    /// 什么时候跑。
    pub when: WhenSpec,
    /// true = 到点在**发起创建的会话**里续跑（上下文都在，适合"下午
    /// 再扫一次"）；false = 每次运行新开一个会话（适合周期简报）。
    pub in_this_session: bool,
    /// 跳过时段（见 [`SkipWindow`]）。空 = 不跳过。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skip_windows: Vec<SkipWindow>,
}

/// 运行目标（编辑面板的"运行于"）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RunTargetSpec {
    /// 每次新开会话，绑定这个项目根。
    NewSession { root: String },
    /// 在指定会话里续跑。
    Session { id: String },
}

/// 新开会话跑任务时用哪个模型。
///
/// 只管"每次新开会话"的任务 —— 续跑型任务用的就是那个会话自己钉的
/// 模型，这里改它等于替用户换了对话的模型。到点时这一对在配置里找不到
/// （服务方删了、模型下架了）或者压根没选，宿主退回模型列表第一个。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleModel {
    pub provider: String,
    pub model: String,
}

/// 前端表单手动创建一个任务的完整说法。
///
/// 和模型用的 [`ScheduleSpec`] 差在目标：模型只能说"在这个会话 / 新会话"
/// （发起会话就是上下文），表单没有发起会话，目标得显式给出。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleDraft {
    pub name: String,
    pub prompt: String,
    pub when: WhenSpec,
    pub target: RunTargetSpec,
    /// 新开会话用的模型。None = 没选，到点用模型列表第一个。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ScheduleModel>,
    /// 跳过时段。空 = 不跳过。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skip_windows: Vec<SkipWindow>,
}

/// 编辑任务的补丁（前端详情面板保存时用）。None = 那一项不动。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SchedulePatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    /// 重设时间。宿主重算下次运行；已跑完的一次性任务借此复活。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<WhenSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<RunTargetSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ScheduleModel>,
    /// 整组替换跳过时段。Some(空) = 清空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skip_windows: Option<Vec<SkipWindow>>,
}

/// 一个定时任务的视图。宿主是唯一生产者。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTask {
    pub id: String,
    pub name: String,
    pub prompt: String,
    pub repeat: Repeat,
    /// Some = 到点在这个会话里续跑；None = 每次新开会话。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// 新开会话时绑定的项目根。
    pub root: String,
    /// 新开会话用的模型。None = 没选（老任务），到点用模型列表第一个。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ScheduleModel>,
    /// false = 暂停中（或一次性任务已跑完）。
    pub enabled: bool,
    /// 下次运行的 Unix 毫秒。None = 不会再跑。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_run_ms: Option<u64>,
    /// `next_run_ms` 的本地时间文字（宿主现算，如 "2026-08-31 15:30"）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_run_local: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_local: Option<String>,
    /// 上次运行产生（或续跑）的会话，前端点它跳过去看结果。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_session_id: Option<String>,
    pub created_at_ms: u64,
    /// 跳过时段。空 = 不跳过（老任务没有这个字段）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skip_windows: Vec<SkipWindow>,
    /// 运行历史，新的在前。宿主只留最近若干条（见宿主的上限）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub runs: Vec<ScheduleRunRecord>,
}

/// 运行历史里的一条：这个任务的某一次执行。
///
/// 周期任务是**一个**任务反复跑，"跑过哪几次、哪次失败了"得有地方看 ——
/// 没有它，用户只能靠侧栏里一串同名会话回忆。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRunRecord {
    pub started_at_ms: u64,
    /// `started_at_ms` 的本地时间文字（宿主现算）。
    pub started_at_local: String,
    /// 这次跑在哪个会话里。开跑就失败（建不了会话）时没有。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// 跑完的时刻。None = 还在跑（或 App 中途退出，没等到结束）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at_ms: Option<u64>,
    /// 失败原因。Some = 这次没跑成。
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::text::deserialize_lenient_ui_error"
    )]
    pub error: Option<crate::text::UiError>,
    /// true = 到点落在跳过时段里，没开对话（没有会话、不算失败）。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub skipped: bool,
}

/// 启动时发现的错过运行（上次 App 没开着，到点没跑成）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MissedRun {
    pub task_id: String,
    pub name: String,
    /// 错过了几次（关机三天的每日任务就是 3）。
    pub count: u32,
    /// 最近一次错过的时刻。
    pub last_ms: u64,
    pub last_local: String,
}

/// 宿主 → 前端的全局事件：某个定时任务开跑了 / 跑完了。
/// 前端靠它刷新会话列表（新会话要立即出现在侧栏）和任务面板。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRun {
    pub task_id: String,
    pub name: String,
    pub session_id: String,
    pub phase: ScheduleRunPhase,
    /// 开跑失败时的原因（会话没了、模型没配好）。phase=Done 且它为
    /// Some 时，前端把它当失败显示。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<crate::text::UiError>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ScheduleRunPhase {
    Started,
    /// 这次运行停在等用户决定（权限确认、提问、表单）。还没跑完，用户答完
    /// 续跑结束才会有 Done。
    Waiting,
    Done,
}

/// 调度操作失败。
///
/// 读者是模型：Schedule 工具把 `Display`（键 + `detail`）放进 tool_result。
/// 模型没有词典，所以 `detail` 必须是一句它能照着改参数的英文 —— 宿主
/// 拒绝时那句由宿主给（`kernel.schedule.hostRejected` 的细节就是宿主的
/// 原话），内核自己构造的错误也照此办。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct ScheduleError(pub UiError);

/// 让持有 `ScheduleError` 内层的调用方能直接把它塞进 `impl Into<String>`
/// 的参数（`ToolOutcome::failed(e.0)`）。得到的是 `Display` 文本 —— 给模型
/// 读的那一面。
impl From<UiError> for String {
    fn from(e: UiError) -> Self {
        e.to_string()
    }
}

/// 定时任务的操作入口。内核里的 `Schedule` 工具经它的远程实现调宿主。
#[async_trait]
pub trait ScheduleAccess: Send + Sync {
    async fn create(&self, spec: ScheduleSpec) -> Result<ScheduledTask, ScheduleError>;
    async fn list(&self) -> Result<Vec<ScheduledTask>, ScheduleError>;
    /// 暂停 / 恢复。恢复时宿主会重算下次运行。
    async fn set_enabled(&self, id: &str, enabled: bool) -> Result<ScheduledTask, ScheduleError>;
    async fn delete(&self, id: &str) -> Result<(), ScheduleError>;
}

/// 没接宿主时的替身：一律明说用不了，不悄悄换行为。
pub struct NoSchedule;

#[async_trait]
impl ScheduleAccess for NoSchedule {
    async fn create(&self, _spec: ScheduleSpec) -> Result<ScheduledTask, ScheduleError> {
        Err(no_schedule())
    }
    async fn list(&self) -> Result<Vec<ScheduledTask>, ScheduleError> {
        Err(no_schedule())
    }
    async fn set_enabled(&self, _id: &str, _enabled: bool) -> Result<ScheduledTask, ScheduleError> {
        Err(no_schedule())
    }
    async fn delete(&self, _id: &str) -> Result<(), ScheduleError> {
        Err(no_schedule())
    }
}

fn no_schedule() -> ScheduleError {
    ScheduleError(crate::ui_error!(
        "kernel.schedule.unavailable";
        "No schedule service is wired into this environment; scheduled tasks cannot be created here."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn when_spec_走_kind_标签() {
        let w = WhenSpec::Weekly {
            weekday: 5,
            time: "16:00".into(),
        };
        let v = serde_json::to_value(&w).expect("序列化");
        assert_eq!(v["kind"], "weekly");
        assert_eq!(v["weekday"], 5);
        let back: WhenSpec = serde_json::from_value(v).expect("往返");
        assert_eq!(back, w);
    }

    #[test]
    fn 任务视图缺省字段能读() {
        // 向后兼容：以后加字段，旧 JSON 不能整体解析失败。
        let raw = r#"{
            "id":"t1","name":"晨报","prompt":"给我晨报",
            "repeat":{"kind":"daily","time":"08:00"},
            "root":"/w","enabled":true,"createdAtMs":1
        }"#;
        let t: ScheduledTask = serde_json::from_str(raw).expect("解析");
        assert_eq!(
            t.repeat,
            Repeat::Daily {
                time: "08:00".into()
            }
        );
        assert!(t.session_id.is_none());
        assert!(t.next_run_ms.is_none());
        assert!(t.runs.is_empty(), "老 JSON 没有 runs 字段，得当空历史");
        assert!(
            t.skip_windows.is_empty(),
            "老 JSON 没有跳过时段，得当不跳过"
        );
    }

    #[test]
    fn 跳过时段_空星期不落盘_往返不变() {
        let w = SkipWindow {
            start: "11:30".into(),
            end: "13:00".into(),
            weekdays: Vec::new(),
        };
        let v = serde_json::to_value(&w).expect("序列化");
        assert!(v.get("weekdays").is_none(), "空星期 = 每天，不写出去：{v}");
        let back: SkipWindow = serde_json::from_value(v).expect("往返");
        assert_eq!(back, w);
    }

    #[test]
    fn 间隔重复走_every_标签() {
        let r = Repeat::Every { minutes: 5 };
        let v = serde_json::to_value(&r).expect("序列化");
        assert_eq!(v["kind"], "every");
        assert_eq!(v["minutes"], 5);
        let back: Repeat = serde_json::from_value(v).expect("往返");
        assert_eq!(back, r);
    }
}
