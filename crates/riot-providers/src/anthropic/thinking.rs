//! 思考参数：按模型代际选 `budget_tokens` 还是 `adaptive` + `effort`。
//!
//! Anthropic 的思考接口换过一代：
//! - Claude 4.5 及更早：`thinking: {type: "enabled", budget_tokens}`；
//! - Opus 4.6 / Sonnet 4.6 起：`thinking: {type: "adaptive"}` 加
//!   `output_config.effort`，模型按请求自己决定想多深。Opus 4.7 起
//!   `budget_tokens` 直接 400，温度这类采样参数也一并移除（发了同样 400）。
//!
//! `[取舍]` 认不出的模型名照旧走 `budget_tokens`：走 Anthropic 协议的兼容
//! 端点上跑的往往不是 Claude（GLM 等），旧命名的 Claude 也在这条路上
//! —— 那是这里改动之前的行为，不让它们跟着冒险。DeepSeek 单列一档：它的
//! 兼容端点忽略 `budget_tokens`，只认 `output_config.effort`。

use riot_protocol::provider::{ThinkingConfig, ThinkingEffort};

use super::request::{WireOutputConfig, WireThinking};

/// 模型的思考接口代际。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Generation {
    /// `budget_tokens`。不发 = 不思考；不开思考时采样参数可用。
    Budget,
    /// adaptive，不发 = 不思考：Opus 4.6 / Sonnet 4.6。采样还在；思考摘要
    /// 默认就给，不用（也不发）`display`。
    OptIn46,
    /// adaptive，不发 = 不思考：Opus 4.7 / 4.8、Sonnet 5。采样已移除；思考
    /// 默认不回正文，要摘要得显式要。
    OptIn,
    /// 不发 thinking 也照样 adaptive 地想，"关"只能把 effort 压到 low：
    /// Opus 5 / 5.5、Fable、Mythos 5 起、Haiku 5.5。
    ///
    /// Opus 5.5、Fable 收到 `{type: "disabled"}` 直接 400；Opus 5、Haiku 5.5
    /// 在 high 档以下认它，但 Opus 5 关思考有已知的失败形态（把工具调用写进
    /// 正文、漏出思考标签），官方建议压低 effort —— 这一档统一走 low。
    AlwaysOn,
    /// 同 [`Self::AlwaysOn`]，但有正式的关闭方式 `{type: "between_tools"}`：
    /// Sonnet 5.5。
    BetweenTools,
    /// DeepSeek：不发 thinking 也照样想（默认 high），力度只认
    /// `output_config.effort`（`budget_tokens` 被忽略），关思考要显式发
    /// `{type: "disabled"}`。采样参数认（思考时不生效）。
    DeepSeek,
}

/// 从模型 id 认代际。认得 Bedrock（`anthropic.claude-…-v1:0`）、Vertex
/// （`claude-…@日期`）和带日期快照的写法。
pub(crate) fn generation(model: &str) -> Generation {
    if crate::is_deepseek_model(model) {
        return Generation::DeepSeek;
    }
    let m = model.to_ascii_lowercase();
    let Some(at) = m.find("claude-") else {
        return Generation::Budget;
    };
    let mut parts = m[at + "claude-".len()..].split(['-', '@', '.', ':']);
    let family = parts.next().unwrap_or_default();
    let Some(major) = parts.next().and_then(|p| p.parse::<u32>().ok()) else {
        return Generation::Budget;
    };
    // 次版本号是一两位数字；八位的是日期快照（`claude-sonnet-4-20250514`）。
    let minor = parts
        .next()
        .filter(|p| p.len() <= 2)
        .and_then(|p| p.parse::<u32>().ok())
        .unwrap_or(0);
    let v = (major, minor);
    match family {
        "fable" => Generation::AlwaysOn,
        "mythos" if major >= 5 => Generation::AlwaysOn,
        "opus" if v >= (5, 0) => Generation::AlwaysOn,
        "opus" if v >= (4, 7) => Generation::OptIn,
        "opus" if v == (4, 6) => Generation::OptIn46,
        "sonnet" if v >= (5, 5) => Generation::BetweenTools,
        "sonnet" if v >= (5, 0) => Generation::OptIn,
        "sonnet" if v == (4, 6) => Generation::OptIn46,
        "haiku" if v >= (5, 5) => Generation::AlwaysOn,
        _ => Generation::Budget,
    }
}

/// 这个模型还认不认 `temperature` / `top_p` / `top_k`。
///
/// Opus 4.7 起移除了（发了 400）；Sonnet 5.5、Haiku 5.5 只认默认值 —— 不发
/// 就是默认值，统一不发。
pub(crate) fn accepts_sampling(model: &str) -> bool {
    matches!(
        generation(model),
        Generation::Budget | Generation::OptIn46 | Generation::DeepSeek
    )
}

/// 本次请求的 `thinking` 和 `output_config`。
///
/// `[约束]` 自适应策略（[`ThinkingConfig::Adaptive`]）在这边**整个会话同一
/// 档**，不照 `hint` 逐请求切。思考参数一变，消息缓存就整段作废：首请求中档、
/// 续轮低档的话，每轮要在两处把整段历史重写一遍。新模型的 adaptive 本来就会
/// 按请求自己调深浅，用不着我们替它切。
pub(crate) fn wire_thinking(
    cfg: ThinkingConfig,
    model: &str,
    max_tokens: u32,
) -> (Option<WireThinking>, Option<WireOutputConfig>) {
    /// 用户要的是什么，和协议无关。
    enum Want {
        /// 一个参数都不发，端点默认。
        Default,
        Off,
        Level(ThinkingEffort),
        Tokens(u32),
    }
    let want = match cfg {
        ThinkingConfig::Off => Want::Default,
        ThinkingConfig::Disabled => Want::Off,
        ThinkingConfig::Effort { level } => Want::Level(level),
        ThinkingConfig::Budget { tokens } => Want::Tokens(tokens),
        ThinkingConfig::Adaptive { .. } => Want::Level(ThinkingEffort::Medium),
    };

    let generation = generation(model);
    let adaptive = WireThinking::Adaptive {
        // 4.7 起思考默认不回正文，界面上就是一段没有内容的长停顿。
        display: (generation != Generation::OptIn46).then_some("summarized"),
    };
    let effort = |level| {
        Some(WireOutputConfig {
            effort: effort_str(level),
        })
    };
    match (generation, want) {
        (_, Want::Default) => (None, None),

        (Generation::Budget, Want::Off) => (None, None),
        (Generation::Budget, Want::Level(level)) => {
            (budget(effort_budget(level), max_tokens), None)
        }
        (Generation::Budget, Want::Tokens(tokens)) => (budget(tokens, max_tokens), None),

        (Generation::OptIn46 | Generation::OptIn, Want::Off) => (None, None),
        (Generation::BetweenTools, Want::Off) => (Some(WireThinking::BetweenTools), None),
        (Generation::AlwaysOn, Want::Off) => (None, effort(ThinkingEffort::Low)),

        // 预算照发：DeepSeek 自己忽略它，但中转（OpenRouter）可能按它分配
        // 思考额度 —— 那是改动前的行为。力度要另走 output_config 才生效。
        (Generation::DeepSeek, Want::Off) => (Some(WireThinking::Disabled), None),
        (Generation::DeepSeek, Want::Level(level)) => {
            (budget(effort_budget(level), max_tokens), effort(level))
        }
        (Generation::DeepSeek, Want::Tokens(tokens)) => (
            budget(tokens, max_tokens),
            effort(ThinkingEffort::from_budget(tokens)),
        ),

        (_, Want::Level(level)) => (Some(adaptive), effort(level)),
        (_, Want::Tokens(tokens)) => (Some(adaptive), effort(ThinkingEffort::from_budget(tokens))),
    }
}

/// `output_config.effort` 的字面值。
fn effort_str(level: ThinkingEffort) -> &'static str {
    match level {
        ThinkingEffort::Low => "low",
        ThinkingEffort::Medium => "medium",
        ThinkingEffort::High => "high",
        ThinkingEffort::Max => "max",
    }
}

fn budget(tokens: u32, max_tokens: u32) -> Option<WireThinking> {
    clamp_thinking_budget(tokens, max_tokens)
        .map(|budget_tokens| WireThinking::Enabled { budget_tokens })
}

/// 力度档 → 思考预算。老模型没有档位参数，只有 `budget_tokens`。
///
/// 数值参照 Claude Code 的 think/megathink 量级；high 刻意没顶到 CC 的
/// ultrathink（32k）—— 那是用户喊口令才给的量，当作常规档每轮都发太贵。
/// max 就是 ultrathink 那一档，只在用户显式选最高档时发。
fn effort_budget(level: ThinkingEffort) -> u32 {
    match level {
        ThinkingEffort::Low => 2_048,
        ThinkingEffort::Medium => 8_192,
        ThinkingEffort::High => 24_576,
        ThinkingEffort::Max => 32_000,
    }
}

/// 把预算夹进 API 的硬约束：`1024 ≤ budget < max_tokens`。
///
/// 挤不下（max_tokens 太小，思考和输出没法都留出最低空间）就返回 None
/// 不开思考 —— 发一个非法组合出去是整个请求 400，而不是思考被忽略。
fn clamp_thinking_budget(budget: u32, max_tokens: u32) -> Option<u32> {
    const MIN_BUDGET: u32 = 1_024;
    // 给最终输出至少留 MIN_BUDGET：预算贴着 max_tokens 的话，思考一满
    // 输出就被截断，表现为"想了半天一句话没说完"。
    let cap = max_tokens.saturating_sub(MIN_BUDGET);
    if cap < MIN_BUDGET {
        return None;
    }
    Some(budget.clamp(MIN_BUDGET, cap))
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn 代际按模型名认() {
        use Generation::*;
        for (model, want) in [
            ("claude-opus-5-5", AlwaysOn),
            ("claude-opus-5", AlwaysOn),
            ("claude-fable-5-1", AlwaysOn),
            ("claude-mythos-5-1", AlwaysOn),
            ("claude-haiku-5-5", AlwaysOn),
            ("claude-sonnet-5-5", BetweenTools),
            ("claude-sonnet-5", OptIn),
            ("claude-opus-4-8", OptIn),
            ("claude-opus-4-7", OptIn),
            ("claude-opus-4-6", OptIn46),
            ("claude-sonnet-4-6", OptIn46),
            ("anthropic.claude-opus-4-6-v1:0", OptIn46),
            ("us.anthropic.claude-sonnet-5-5", BetweenTools),
            ("CLAUDE-OPUS-5-5", AlwaysOn),
            // 老代际和认不出的：照旧走 budget_tokens。
            ("claude-opus-4-5@20251101", Budget),
            ("claude-sonnet-4-5-20250929", Budget),
            ("claude-sonnet-4-20250514", Budget),
            ("claude-haiku-4-5", Budget),
            ("claude-3-7-sonnet-20250219", Budget),
            ("claude-mythos-preview", Budget),
            ("glm-5", Budget),
            ("deepseek-v4-pro", DeepSeek),
            ("~deepseek/deepseek-v4-flash-latest", DeepSeek),
        ] {
            assert_eq!(generation(model), want, "{model}");
        }
    }

    /// 新模型发 adaptive + effort；老模型照旧发 budget_tokens。
    ///
    /// Opus 4.7 起 `budget_tokens` 是 400 —— 以前不分代际一律发预算，开着
    /// 思考的每个请求都失败。
    #[test]
    fn 新模型发_adaptive_加_effort() {
        let high = ThinkingConfig::Effort {
            level: ThinkingEffort::High,
        };
        assert_eq!(
            wire_thinking(high, "claude-opus-5-5", 8_192),
            (
                Some(WireThinking::Adaptive {
                    display: Some("summarized")
                }),
                Some(WireOutputConfig { effort: "high" })
            )
        );
        assert_eq!(
            wire_thinking(high, "claude-sonnet-4-6", 8_192).0,
            Some(WireThinking::Adaptive { display: None }),
            "4.6 默认就给摘要，不发 display"
        );
        assert_eq!(
            wire_thinking(high, "claude-haiku-4-5", 8_192),
            (
                Some(WireThinking::Enabled {
                    budget_tokens: 7_168
                }),
                None
            ),
            "老模型照旧发预算"
        );
        assert_eq!(
            wire_thinking(
                ThinkingConfig::Budget { tokens: 20_000 },
                "claude-opus-4-8",
                8_192
            )
            .1,
            Some(WireOutputConfig { effort: "high" }),
            "新模型没有预算参数，折算成档位"
        );
    }

    /// 自适应策略在 Anthropic 上整会话同一档：首请求和续轮发的思考参数逐字节
    /// 相同，消息缓存才不会每轮作废两次。
    #[test]
    fn 自适应策略不逐请求切档() {
        for model in ["claude-opus-5-5", "claude-sonnet-4-6", "claude-haiku-4-5"] {
            let first = wire_thinking(
                ThinkingConfig::Adaptive {
                    hint: ThinkingEffort::Medium,
                },
                model,
                8_192,
            );
            let follow_up = wire_thinking(
                ThinkingConfig::Adaptive {
                    hint: ThinkingEffort::Low,
                },
                model,
                8_192,
            );
            assert_eq!(first, follow_up, "{model}");
            assert!(first.0.is_some(), "{model}：自适应要真的开思考");
        }
    }

    /// "关思考"按代际落到各自能接受的写法，没有一种会 400。
    #[test]
    fn 关思考按代际落地() {
        let off = |model| wire_thinking(ThinkingConfig::Disabled, model, 8_192);
        assert_eq!(off("claude-haiku-4-5"), (None, None), "老模型不发就是不想");
        assert_eq!(off("claude-opus-4-8"), (None, None), "4.7/4.8 不发也是不想");
        assert_eq!(
            off("claude-sonnet-5-5"),
            (Some(WireThinking::BetweenTools), None),
            "Sonnet 5.5 收 disabled 会 400，正式的关法是 between_tools"
        );
        assert_eq!(
            off("claude-opus-5-5"),
            (None, Some(WireOutputConfig { effort: "low" })),
            "Opus 5.5 关不掉思考，只能压到 low"
        );
        assert_eq!(
            wire_thinking(ThinkingConfig::Off, "claude-opus-5-5", 8_192),
            (None, None),
            "Off 就是一个参数都不发"
        );
    }

    /// DeepSeek 的 Anthropic 端点忽略 `budget_tokens`：力度必须走
    /// `output_config.effort`，关思考必须显式发 disabled（不发就照默认想）。
    #[test]
    fn deepseek_力度走_effort_关思考显式发() {
        let model = "deepseek-v4-pro";
        let (thinking, output) = wire_thinking(
            ThinkingConfig::Effort {
                level: ThinkingEffort::Max,
            },
            model,
            65_536,
        );
        assert_eq!(output, Some(WireOutputConfig { effort: "max" }));
        assert!(
            matches!(thinking, Some(WireThinking::Enabled { .. })),
            "预算照发给中转看：{thinking:?}"
        );

        assert_eq!(
            wire_thinking(ThinkingConfig::Disabled, model, 65_536),
            (Some(WireThinking::Disabled), None)
        );
        assert_eq!(
            wire_thinking(ThinkingConfig::Off, model, 65_536),
            (None, None),
            "默认档一个参数都不发，由端点按 high 想"
        );
        assert_eq!(
            wire_thinking(
                ThinkingConfig::Effort {
                    level: ThinkingEffort::High
                },
                model,
                1_500
            )
            .1,
            Some(WireOutputConfig { effort: "high" }),
            "上限小到塞不下预算时，力度照样要发"
        );
    }

    #[test]
    fn 只有老代际还认采样参数() {
        assert!(accepts_sampling("claude-haiku-4-5"));
        assert!(accepts_sampling("claude-sonnet-4-6"));
        assert!(accepts_sampling("deepseek-v4-pro"));
        assert!(!accepts_sampling("claude-opus-4-7"));
        assert!(!accepts_sampling("claude-opus-5-5"));
        assert!(!accepts_sampling("claude-sonnet-5-5"));
    }
}
