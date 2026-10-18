//! 内部消息格式 → OpenAI chat completions 请求。
//!
//! 内部用的是 Anthropic 风格的 content block（一条消息里可以同时有文本和
//! 若干 tool_use）。OpenAI 是另一套形状：工具结果是**独立的 role=tool 消息**，
//! 工具调用挂在 assistant 消息的 `tool_calls` 上。
//!
//! 这个文件就是那层翻译。它有几条不能违反的规矩，违反了服务端只会回一句
//! 语焉不详的 `invalid request`：
//!
//! 1. `role=tool` 的消息必须紧跟在带 `tool_calls` 的 assistant 消息之后，
//!    并且每个 `tool_call_id` 都要有恰好一条对应的 tool 消息；
//! 2. 消息的 `content` 不能是空字符串；
//! 3. `tool_calls[].function.arguments` 是 JSON **字符串**，不是对象；
//! 4. `reasoning_content` 只回传给 DeepSeek（别家不认这个字段）。

use riot_protocol::message::{
    AssistantContent, Attachment, Message, ToolResultContent, UserContent,
};
use riot_protocol::provider::{ProviderRequest, ThinkingConfig, ThinkingEffort};

use super::text::{assemble_system, data_url, render_attachment, render_result};
use super::wire::{
    StreamOptions, WireFunctionCall, WireImageUrl, WireMessage, WirePart, WireRequest,
    WireThinkingToggle, WireTool, WireToolCall, WireToolFunction,
};
use crate::anthropic::request::SystemSection;

/// 重试时对请求的调整。
#[derive(Debug, Clone, Default)]
pub struct RetryContext {
    /// 降级到别的模型。
    pub model_override: Option<String>,
    /// 上下文溢出恢复时调低。
    pub max_tokens_override: Option<u32>,
    /// 换模型时剥掉思考签名。Chat Completions 不回传思考，这只对 Responses 有意义。
    pub strip_thinking_signatures: bool,
}

impl RetryContext {
    pub fn initial() -> Self {
        Self::default()
    }

    pub fn fallback_to(model: impl Into<String>) -> Self {
        Self {
            model_override: Some(model.into()),
            strip_thinking_signatures: true,
            ..Self::default()
        }
    }
}

/// `replay_reasoning`：历史里的思考要不要作为 `reasoning_content` 回传
/// （见 [`super::OpenAiConfig::replay_reasoning`]）。
pub fn build_request(
    req: &ProviderRequest,
    system: &[SystemSection],
    ctx: &RetryContext,
    replay_reasoning: bool,
) -> WireRequest {
    let model = ctx
        .model_override
        .clone()
        .unwrap_or_else(|| req.model.clone());
    let mut messages = Vec::new();

    let full_system = assemble_system(system, &req.system);
    if !full_system.is_empty() {
        messages.push(WireMessage::System {
            content: full_system,
        });
    }

    // DeepSeek 只在带工具的请求里把历史思维链拼进上下文，不带工具时传了
    // 也被忽略 —— 总结、分类这类无工具请求就别白传那几十 KB。
    messages.extend(convert_messages(
        &req.messages,
        replay_reasoning && !req.tools.is_empty(),
    ));

    // 工具按名字排序。顺序不稳的话，服务端的前缀缓存每轮都会失效。
    let mut tools: Vec<WireTool> = req
        .tools
        .iter()
        .map(|t| WireTool {
            kind: "function",
            function: WireToolFunction {
                name: t.name.clone(),
                description: t.description.clone(),
                parameters: t.input_schema.clone(),
            },
        })
        .collect();
    tools.sort_by(|a, b| a.function.name.cmp(&b.function.name));

    // Effort 只发标准的 reasoning_effort：思考默认就是开的（DeepSeek / GLM），
    // 再捎上非标准的 thinking 对象只会把 OpenAI 官方端点也搭进去 400。
    let (reasoning_effort, thinking) = match req.thinking {
        ThinkingConfig::Off => (None, None),
        ThinkingConfig::Disabled => (None, Some(WireThinkingToggle::disabled())),
        ThinkingConfig::Effort { level } => (Some(effort_literal(level, &model)), None),
        // OpenAI 兼容协议没有预算参数，折算成最近的档位。
        ThinkingConfig::Budget { tokens } => (
            Some(effort_literal(ThinkingEffort::from_budget(tokens), &model)),
            None,
        ),
    };

    WireRequest {
        model,
        messages,
        stream: true,
        max_tokens: ctx.max_tokens_override.or(req.max_output_tokens),
        temperature: None,
        top_p: None,
        tools,
        stream_options: Some(StreamOptions {
            include_usage: true,
        }),
        reasoning_effort,
        thinking,
    }
}

/// 力度档 → `reasoning_effort` 的字面值。Chat Completions 和 Responses 共用。
///
/// `[约束]` DeepSeek 的最高档要写 `max`：它把 OpenAI 的 `xhigh` 当成 high，
/// 发 `xhigh` 等于没开最高档，而且不报错。
pub(crate) fn effort_literal(level: ThinkingEffort, model: &str) -> &'static str {
    if level == ThinkingEffort::Max && crate::is_deepseek_model(model) {
        "max"
    } else {
        level.as_openai_str()
    }
}

/// 这些消息发出去有多少字节。
///
/// `[约束]` 走 [`convert_messages`] 而不是直接量 `Message` —— 那是
/// [`riot_protocol::provider::Provider::count_tokens`] 那条约束的落地方式。
/// 复用转换（而不是另写一遍"哪些字段会发"）是刻意的:两套规则各自演化，
/// 迟早有一天线协议改了而估算没跟上，而那种偏差没有任何报错，只会表现成
/// 压缩时机变得莫名其妙。
pub fn wire_bytes(messages: &[Message], replay_reasoning: bool) -> usize {
    convert_messages(messages, replay_reasoning)
        .iter()
        .map(|m| serde_json::to_string(m).map(|s| s.len()).unwrap_or(0))
        .sum()
}

pub fn convert_messages(messages: &[Message], replay_reasoning: bool) -> Vec<WireMessage> {
    let mut out = Vec::new();

    for m in messages {
        match m {
            Message::User { content, .. } => {
                // 工具结果先出。一条内部 User 消息里可能既有工具结果又有
                // 用户新说的话（用户在工具跑的时候插了一句），而 OpenAI 要求
                // tool 消息紧跟 assistant，中间不能插 user。
                let mut texts: Vec<String> = Vec::new();
                // 用户附的图。和文字同一条消息、排在文字前面（见下）。
                let mut user_images: Vec<WirePart> = Vec::new();
                // 工具结果里的图片。`tool` 消息装不了，攒起来跟在后面单发。
                let mut tool_images: Vec<WirePart> = Vec::new();
                for c in content {
                    match c {
                        UserContent::ToolResult {
                            tool_use_id,
                            content,
                            is_error,
                        } => {
                            out.push(WireMessage::Tool {
                                tool_call_id: tool_use_id.as_str().to_owned(),
                                content: render_result(content, *is_error),
                            });
                            // `path` 是给界面的（落盘原图）；发模型的只有
                            // `data` 里的压缩图。
                            // Image 和 MarkedImage 都带一张给模型的图，走同一条
                            // "图放下一条 user 消息"的路（OpenAI 的 tool 消息本身
                            // 塞不了图）。
                            if let ToolResultContent::Image {
                                media_type, data, ..
                            }
                            | ToolResultContent::MarkedImage {
                                media_type, data, ..
                            } = content
                            {
                                tool_images.push(WirePart::Text {
                                    text: format!("上一个工具结果（{tool_use_id}）的图片："),
                                });
                                tool_images.push(image_part(media_type, data));
                            }
                        }
                        UserContent::Text { text } => texts.push(text.clone()),
                        UserContent::Attachment(a) => {
                            if let Attachment::Image { media_type, data } = a {
                                user_images.push(image_part(media_type, data));
                            } else if let Some(t) = render_attachment(a) {
                                texts.push(t);
                            }
                        }
                    }
                }
                let joined = texts.join("\n");
                if user_images.is_empty() {
                    if !joined.trim().is_empty() {
                        out.push(WireMessage::User { content: joined });
                    }
                } else {
                    // `[约束]` 用户附的图排在文字**前面**，和 user_content
                    // 摆进历史的顺序一致（两家的文档都建议这个顺序）。以前
                    // 图片被挪到文字后面单发一条，等于把上游特意排好的顺序
                    // 又翻了回去。
                    let mut parts = user_images;
                    if !joined.trim().is_empty() {
                        parts.push(WirePart::Text { text: joined });
                    }
                    out.push(WireMessage::UserParts { content: parts });
                }
                // `[约束]` 工具结果的图必须排在 tool 消息**之后**，不能塞进
                // tool 消息里。OpenAI 要求 tool 消息紧跟着对应的 assistant，
                // 而它的 content 只收字符串 —— 唯一能带图的位置就是后面
                // 这条 user 消息。
                if !tool_images.is_empty() {
                    out.push(WireMessage::UserParts {
                        content: tool_images,
                    });
                }
            }

            Message::Assistant { content, .. } => {
                let mut text = String::new();
                let mut reasoning = String::new();
                let mut calls = Vec::new();

                for c in content {
                    match c {
                        AssistantContent::Text { text: t } => text.push_str(t),
                        AssistantContent::ToolUse { id, name, input } => {
                            calls.push(WireToolCall {
                                id: id.as_str().to_owned(),
                                kind: "function",
                                function: WireFunctionCall {
                                    name: name.clone(),
                                    // 序列化失败时给 `{}` 而不是丢掉这次调用。
                                    // 丢掉的话 tool_calls 和后面的 tool 消息
                                    // 对不上，服务端直接拒整个请求。
                                    arguments: serde_json::to_string(input)
                                        .unwrap_or_else(|_| "{}".to_owned()),
                                },
                            });
                        }
                        // `[约束]` DeepSeek 思考模式带工具时，历史上每一轮的
                        // reasoning_content 都要回传：它被拼回上下文，模型靠它
                        // 在工具调用之间接着上一步的思路想。不回传不报错（实测
                        // 照样 200），模型每一步都从零想起，效果明显变差。别家
                        // 没有这个字段，一律不发。
                        AssistantContent::Thinking { text: t, .. } => {
                            if replay_reasoning {
                                reasoning.push_str(t);
                            }
                        }
                    }
                }

                // 空消息会被服务端拒。这在压缩清理过历史之后是真实会发生的。
                if text.trim().is_empty() && calls.is_empty() {
                    continue;
                }

                out.push(WireMessage::Assistant {
                    content: (!text.trim().is_empty()).then_some(text),
                    reasoning_content: (!reasoning.is_empty()).then_some(reasoning),
                    tool_calls: calls,
                });
            }

            // 系统提醒不入模型请求。由 INV-7 保证这里拿不到。
            Message::System { .. } => {}
        }
    }

    out
}

/// 一张图的内容块。
fn image_part(media_type: &str, data: &str) -> WirePart {
    WirePart::ImageUrl {
        image_url: WireImageUrl {
            url: data_url(media_type, data),
        },
    }
}
