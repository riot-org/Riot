//! 上下文明细：当前占用按类别拆开（输入框右下角那个浮层）。
//!
//! `[取舍]` 只有总数是准的。服务方随回复报的 usage 是那一刻整个上下文的
//! 真实尺寸，但它不告诉你里面多少是系统提示词、多少是工具定义 —— 那些只能
//! 按字节折算（[`crate::provider::estimate_tokens`]）。所以「消息」一项不单独
//! 估，而是用真实总数减去各固定部分：各项加起来和总数对得上，估算误差全
//! 落在「消息」这一行，而不是让加总凭空多出或少掉一截。
//!
//! 窗口大小和自动压缩缓冲区不在这里：内核不知道窗口（那是宿主的模型配置），
//! 界面本来就拿着窗口和压缩阈值画进度条，由它算剩下两行，两处才不会对不上。

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// 可展开类别里的一项（一个 MCP 工具、一份记忆文件）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ContextItem {
    /// MCP 工具是完整工具名（`mcp__<服务器>__<工具>`），记忆文件是路径。
    pub name: String,
    pub tokens: u32,
}

/// 一个会话此刻的上下文明细。除注明外都是估算的 token 数。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ContextBreakdown {
    /// 服务方最近一次报的真实占用。`None` = 还没有 usage（新会话、刚压缩完），
    /// 下面全是估算。
    pub reported: Option<u32>,
    /// 内置的系统提示词（不含自定义指令）。
    pub system_prompt: u32,
    /// 用户为这个会话补充的指令（系统提示词里单独一节）。
    pub custom_instructions: u32,
    /// 内置工具的定义（描述 + schema），不含 Skill 和 MCP。
    pub system_tools: u32,
    /// 进了请求的 MCP 工具，逐个列出。
    pub mcp_tools: Vec<ContextItem>,
    /// Skill 工具（技能清单就写在它的描述里）。
    pub skills: u32,
    /// 记忆文件（AGENTS.md 等），随首条消息注入。
    pub memory_files: Vec<ContextItem>,
    /// 对话消息：真实占用减去其它各项；没有 usage 时按内容估。
    pub messages: u32,
    /// 最近一次 usage 之后新增的消息（还没被服务方数过）。
    pub since_last_update: u32,
    /// ToolSearch 延迟着、还没加载的内置工具。**不计入占用**。
    pub deferred_system_tools: u32,
    /// ToolSearch 延迟着、还没加载的 MCP 工具。**不计入占用**。
    pub deferred_mcp_tools: Vec<ContextItem>,
    /// 计入占用的各项之和 —— 有 usage 时就是真实占用加上新增那段。
    pub total: u32,
}
