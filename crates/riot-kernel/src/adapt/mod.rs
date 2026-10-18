//! 模型适配：提示词这一侧随模型家族变化的部分。
//!
//! 分两档：
//! - **通用模式**（[`general`]）：所有模型的默认值。
//! - **专门适配**：某一家在通用模式上改掉的那几项。每家一个子模块（目前只有
//!   [`deepseek`]），在 [`ADAPTED`] 里登记。
//!
//! 专门适配写成「通用模式 + 覆盖」（`..general(model)`），不是一份独立的
//! 配置：通用模式以后的改进各家自动拿到，只有明确覆盖的那几项不跟。
//!
//! 能适配的东西全是 [`PromptProfile`] 的字段。要支持一种新的差异，就加一个
//! 字段、在 [`general`] 里给默认值 —— 不要在 session.rs 或 prompt.rs 里按模型名
//! 分支，那样厂商知识又散回各处了。`prompt.rs` 只认 [`Flavor`]，不认厂商。
//!
//! `[约束]` 专门适配要有实测依据（同一任务、同一参数下的对照），并且只对测过
//! 的那一家生效。拿不准的改进进通用模式或者不做：为某一家单独写的东西，别家
//! 拿不到，也没人会回头再测。
//!
//! 请求参数层的差异（思维链回传、思考力度怎么映射）不在这里，在
//! `riot_providers` 各协议的实现里。这里管的是给模型看的字。

mod deepseek;
mod rules_in_user;

use std::sync::Arc;

use riot_protocol::ModelEndpoint;
use riot_protocol::provider::Provider;
use riot_providers::anthropic::request::SystemSection;

use crate::prompt::Flavor;

/// 一个模型在提示词上的全部可适配项。
pub(crate) struct PromptProfile {
    /// 系统提示词分节的外壳（XML 标签 / Markdown 小标题）。正文不跟着变，见
    /// [`Flavor`] 的取舍。
    pub flavor: Flavor,
    /// Riot 的规则放在哪：系统提示词里，还是首条用户消息里。
    pub rules: RulesPlacement,
    /// provider 级的 system 分节：只对这一家成立的补充说明。
    ///
    /// 会话那份完整的 system prompt 不走这条路 —— 它逐会话不同（工作目录、
    /// venv、用户补充指令），而 provider 按端点建、跨会话复用，把会话内容塞进来
    /// 两者的生命周期对不上。会话提示词在 [`crate::prompt::system_prompt`] 里装配。
    ///
    /// 目前各家都是空的。已知的候选：
    /// - Anthropic：并行工具调用的服从度最高，可以给更激进的批量指引；
    /// - OpenAI 兼容（DeepSeek、智谱）：对 `<system-reminder>` 这类 XML 包装的
    ///   服从度偏弱，可能需要一句「被 `<system-reminder>` 包住的内容和用户本人
    ///   说的话等权」。
    pub provider_sections: Vec<SystemSection>,
}

/// Riot 规则（会话那份完整的系统提示词）的放法。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RulesPlacement {
    /// 就是系统提示词。
    System,
    /// 系统提示词只放一句 `persona`，规则包成 system-reminder 接在首条用户
    /// 消息末尾。见 [`rules_in_user::RulesInUser`]。
    FirstUserMessage { persona: &'static str },
}

impl RulesPlacement {
    /// 按规则的放法包主循环的 provider。
    ///
    /// 只包主循环：压缩总结、分叉、子 agent 的请求照旧用完整的系统提示词
    /// —— 实测只覆盖了主循环。
    pub(crate) fn wrap(self, inner: Arc<dyn Provider>) -> Arc<dyn Provider> {
        match self {
            Self::System => inner,
            Self::FirstUserMessage { persona } => {
                Arc::new(rules_in_user::RulesInUser { inner, persona })
            }
        }
    }
}

/// 做了专门适配的模型家族：（认不认得这个端点，它的配置）。按顺序匹配，第一个
/// 命中的生效；都不命中走通用模式。
type Adapter = (
    fn(&ModelEndpoint) -> bool,
    fn(&ModelEndpoint) -> PromptProfile,
);

const ADAPTED: &[Adapter] = &[(deepseek::matches, deepseek::profile)];

/// 端点 → 它在提示词上的配置。
pub(crate) fn profile_for(model: &ModelEndpoint) -> PromptProfile {
    ADAPTED
        .iter()
        .find(|(matches, _)| matches(model))
        .map_or_else(|| general(model), |(_, profile)| profile(model))
}

/// 通用模式。
fn general(model: &ModelEndpoint) -> PromptProfile {
    PromptProfile {
        flavor: if model.is_anthropic() {
            Flavor::Anthropic
        } else {
            Flavor::OpenAiCompatible
        },
        rules: RulesPlacement::System,
        provider_sections: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn endpoint(protocol: riot_protocol::ApiProtocol, model: &str) -> ModelEndpoint {
        ModelEndpoint {
            protocol,
            openai_api: riot_protocol::OpenaiApi::ChatCompletions,
            base_url: "https://gw.test".into(),
            api_path: String::new(),
            api_key: "k".into(),
            model: model.into(),
            fallback_model: None,
            sampling: riot_protocol::EndpointSampling::default(),
            extra_headers: Default::default(),
        }
    }

    #[test]
    fn 没做专门适配的模型走通用模式() {
        let claude = profile_for(&endpoint(
            riot_protocol::ApiProtocol::Anthropic,
            "claude-sonnet-5-5",
        ));
        assert_eq!(claude.flavor, Flavor::Anthropic);
        assert_eq!(claude.rules, RulesPlacement::System);

        let glm = profile_for(&endpoint(riot_protocol::ApiProtocol::Openai, "glm-5.3"));
        assert_eq!(glm.flavor, Flavor::OpenAiCompatible);
        assert_eq!(glm.rules, RulesPlacement::System);
    }

    /// 专门适配只覆盖它要改的那几项，分节外壳照旧跟着协议走：走 Anthropic
    /// 协议的 DeepSeek 拿到的还是 XML 标签。
    #[test]
    fn deepseek_走专门适配_其余项继承通用模式() {
        for protocol in [
            riot_protocol::ApiProtocol::Openai,
            riot_protocol::ApiProtocol::Anthropic,
        ] {
            let ep = endpoint(protocol, "deepseek-v4-flash");
            let adapted = profile_for(&ep);
            let base = general(&ep);
            assert!(matches!(
                adapted.rules,
                RulesPlacement::FirstUserMessage { .. }
            ));
            assert_eq!(adapted.flavor, base.flavor);
            assert_eq!(
                adapted.provider_sections.len(),
                base.provider_sections.len()
            );
        }
    }
}
