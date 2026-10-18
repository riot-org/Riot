//! 规则后置（[`super::RulesPlacement::FirstUserMessage`]）的机制：系统提示词
//! 换成一句 persona，原来的系统提示词包成 system-reminder 接在首条用户消息
//! 末尾。哪家用、为什么，写在各家的适配模块里。

use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use riot_protocol::message::{Attachment, Message, UserContent};
use riot_protocol::provider::{Provider, ProviderRequest, ProviderStream};
use riot_providers::anthropic::split_request_system;

/// 每次请求都现搬：系统提示词 → 首条用户消息末尾的 system-reminder，
/// 系统提示词本身换成 `persona`。工具清单不动。
///
/// `[取舍]` 在 provider 这一层搬，不在历史里存：历史里的首条用户消息永远是
/// 用户的原话，规则是每次请求时贴上去的。好处是压缩后首条消息变成总结时，
/// 规则自动跟着贴到新的首条消息上，不会丢；系统提示词逐会话变化（工作目录、
/// 用户补充指令）也照常生效。代价是界面和转录里看不到这段 reminder —— 本来
/// 也看不到系统提示词。
///
/// `[约束]` 贴的位置固定在**首条**用户消息、内容固定是**本轮**的系统提示词，
/// 所以一轮内、跨轮之间请求前缀逐字节不变（系统提示词本来就要求跨轮稳定）。
/// 贴到最后一条用户消息上会让每轮的前缀都失效。
///
/// 分节外壳（[`crate::prompt::Flavor`]）照旧跟着协议走，缓存边界标记
/// （`SYSTEM_SECTION_BOUNDARY`）在这里去掉：它是给 system 字段切块打断点用的，
/// 进了消息正文就成了一行乱码。
pub(super) struct RulesInUser {
    pub inner: Arc<dyn Provider>,
    pub persona: &'static str,
}

impl Provider for RulesInUser {
    fn stream(&self, req: ProviderRequest, cancel: CancellationToken) -> ProviderStream {
        self.inner.stream(move_rules(req, self.persona), cancel)
    }

    fn count_tokens(&self, messages: &[Message]) -> u32 {
        self.inner.count_tokens(messages)
    }

    fn estimate_tokens_of(&self, messages: &[Message]) -> u32 {
        self.inner.estimate_tokens_of(messages)
    }
}

fn move_rules(mut req: ProviderRequest, persona: &str) -> ProviderRequest {
    if req.system.trim().is_empty() {
        return req;
    }
    let Some(content) = req.messages.iter_mut().find_map(|m| match m {
        Message::User { content, .. } => Some(content),
        _ => None,
    }) else {
        // 没有用户消息可贴（正常请求碰不到）：宁可不搬，也不能把规则丢了。
        return req;
    };
    let (stable, project) = split_request_system(&req.system);
    let rules = if project.is_empty() {
        stable.to_owned()
    } else {
        format!("{stable}\n\n{project}")
    };
    content.push(UserContent::Attachment(Attachment::SystemReminder {
        text: rules,
    }));
    req.system = persona.to_owned();
    req
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::StreamExt;
    use riot_core::testing::{ScriptedProvider, assistant_tool_use, user_text};
    use riot_protocol::provider::{ProviderEvent, ThinkingConfig, ToolSpec};
    use riot_providers::anthropic::SYSTEM_SECTION_BOUNDARY;

    const PERSONA: &str = "一句话的 persona";

    fn request(messages: Vec<Message>, system: &str) -> ProviderRequest {
        ProviderRequest {
            model: "deepseek-v4-flash".into(),
            messages,
            system: system.into(),
            tools: vec![ToolSpec {
                name: "Read".into(),
                description: "读文件".into(),
                input_schema: serde_json::json!({"type": "object"}),
            }],
            max_output_tokens: None,
            thinking: ThinkingConfig::Disabled,
            cache_ttl: Default::default(),
        }
    }

    async fn sent(req: ProviderRequest) -> ProviderRequest {
        let inner = Arc::new(ScriptedProvider::new(vec![vec![ProviderEvent::Message(
            assistant_tool_use("a1", "u1", "Read", serde_json::json!({})),
        )]]));
        let p = RulesInUser {
            inner: Arc::clone(&inner) as Arc<dyn Provider>,
            persona: PERSONA,
        };
        let _: Vec<_> = p.stream(req, CancellationToken::new()).collect().await;
        inner.requests().remove(0)
    }

    fn reminders(m: &Message) -> Vec<String> {
        let Message::User { content, .. } = m else {
            return Vec::new();
        };
        content
            .iter()
            .filter_map(|c| match c {
                UserContent::Attachment(Attachment::SystemReminder { text }) => Some(text.clone()),
                _ => None,
            })
            .collect()
    }

    #[tokio::test]
    async fn 系统提示词换成_persona_规则贴在首条用户消息末尾() {
        let req = request(vec![user_text("u0", "画个时钟")], "完整的 Riot 规则");
        let out = sent(req.clone()).await;
        assert_eq!(out.system, PERSONA);
        assert_eq!(out.tools, req.tools);
        let Message::User { content, .. } = &out.messages[0] else {
            panic!("首条该是用户消息");
        };
        assert_eq!(content.len(), 2, "原话 + 一段规则");
        assert!(matches!(&content[0], UserContent::Text { text } if text == "画个时钟"));
        assert_eq!(reminders(&out.messages[0]), vec!["完整的 Riot 规则"]);
    }

    /// 后面的轮次也贴在**首条**上，其余消息原样 —— 前缀缓存靠这个。
    #[tokio::test]
    async fn 多轮时只贴首条_两轮之间前缀不变() {
        let first = vec![user_text("u0", "画个时钟")];
        let mut second = first.clone();
        second.push(assistant_tool_use(
            "a1",
            "u1",
            "Read",
            serde_json::json!({}),
        ));
        second.push(user_text("u1", "继续"));
        let (a, b) = (
            sent(request(first, "规则")).await,
            sent(request(second, "规则")).await,
        );
        assert_eq!(
            a.messages[..],
            b.messages[..1],
            "第一轮的消息要原样出现在第二轮开头"
        );
        assert!(reminders(&b.messages[2]).is_empty(), "新消息上不贴");
    }

    #[tokio::test]
    async fn 缓存边界标记不进正文_两段都在() {
        let system = format!("跨会话的准则\n\n{SYSTEM_SECTION_BOUNDARY}\n\n工作目录：/tmp/proj");
        let out = sent(request(vec![user_text("u0", "hi")], &system)).await;
        let text = reminders(&out.messages[0]).remove(0);
        assert!(!text.contains(SYSTEM_SECTION_BOUNDARY), "{text}");
        assert!(
            text.contains("跨会话的准则") && text.contains("工作目录：/tmp/proj"),
            "{text}"
        );
    }

    #[tokio::test]
    async fn 系统提示词为空就不动() {
        let req = request(vec![user_text("u0", "hi")], "");
        let out = sent(req.clone()).await;
        assert_eq!(out.system, "");
        assert_eq!(out.messages, req.messages);
    }
}
