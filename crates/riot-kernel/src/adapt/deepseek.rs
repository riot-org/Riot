//! DeepSeek 的专门适配。
//!
//! 和通用模式只差规则的放法：系统提示词只放一句 persona（[`PERSONA`]），
//! Riot 的规则包成 system-reminder 接在首条用户消息末尾（见
//! [`super::rules_in_user::RulesInUser`]）。
//!
//! `[取舍]` 系统提示词基本决定了 V4 进哪种推理。一句 persona 加工具时几乎
//! 全是简写的规划笔记（"We need…"，R1-Zero 那一脉的原生 RL 风格）；系统提示词
//! 是 Riot 的完整规则时，多半是叙述式（"The user wants…"）或者干脆不思考就
//! 调工具。规则挪进用户消息后模式保住了，规则也照样遵守。实测 deepseek-v4-flash、
//! 最高档（方法和原始数据见 docs/research/deepseek-reasoning-modes.md 第 8 节）：
//! - 首个动作前的推理是简写的比例：完整提示词 6/48，规则后置 41/48；
//! - 设计题盲评（9 题）：规则后置 21 分，完整提示词 6 分（满分 27）；
//! - 三轮中文对话的规则遵守率：规则后置 100%，完整提示词 82%（主要差在用英文
//!   回答中文用户）；
//! - 修 bug / 写算法的通过率两边都是 100%，这批任务分不出高下。
//!
//! 上面的实验只带了 5 个精简工具。换成 Riot 真实装配出的请求（23 个工具，
//! 首条消息带时钟和规划提醒），首个动作前是简写的比例（各 8 次）：画 SVG
//! 8 对 7、写算法 8 对 0、修 bug 2 对 0（完整提示词那边修 bug 有一半直接不
//! 思考）。修 bug 掉得多，是因为工具描述本身也是大段规则写法：同一条消息配
//! 5 个精简工具时修 bug 有 7/8 是简写。
//!
//! 模型名留在规则里（身份句）：另测过规则后置时去掉模型名，agent 类任务的
//! 模式不变（24/24 都是简写），只有中文闲聊的简写比例从 5/8 掉到 1/8；而「被问
//! 是什么模型时答得上来」是硬要求。
//!
//! 只实测过思考开着的情况，关了思考也照搬：规则的放法每轮一致，切换思考档位
//! 时不至于连规则位置一起变、把前缀缓存整个打掉。

use riot_protocol::ModelEndpoint;

use super::{PromptProfile, RulesPlacement};

/// 实测用的就是这一句。
const PERSONA: &str = "You are a helpful software engineer assistant.";

/// 按模型名认，和 `replay_reasoning` 同一个判据：走中转、OpenRouter 的也认得出。
pub(super) fn matches(model: &ModelEndpoint) -> bool {
    riot_providers::is_deepseek_model(&model.model)
}

pub(super) fn profile(model: &ModelEndpoint) -> PromptProfile {
    PromptProfile {
        rules: RulesPlacement::FirstUserMessage { persona: PERSONA },
        ..super::general(model)
    }
}
