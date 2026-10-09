//! 量每段思考花了多久，盖到助手消息的思考块上（界面显示「思考了 12 秒」）。
//!
//! 一段思考 = 从第一个思考增量开始，到模型转去写正文 / 调工具为止；没转
//! 就到这条消息收尾。一条消息里可能有好几段（交错思考），按出现顺序一一
//! 对上消息里的思考块。
//!
//! 放在主循环而不是 provider 里：三家解码器各写一份计时，迟早有一家漏掉；
//! 而主循环本来就逐个转发增量、手里有注入的时钟。量出来是 0（时钟没走 ——
//! 黄金回放的 MockClock、非流式的一次性响应）就不盖，回放快照不受影响。

use riot_protocol::event::StreamDelta;
use riot_protocol::message::{AssistantContent, Message};

/// 一次模型调用的思考计时。每次请求新建一个。
#[derive(Debug, Default)]
pub(crate) struct ThinkTimer {
    /// 正在进行的那段思考从什么时候开始。
    started: Option<u64>,
    /// 已经结束的各段时长，按先后顺序。
    spans: Vec<u64>,
}

impl ThinkTimer {
    pub(crate) fn on_delta(&mut self, delta: &StreamDelta, now_ms: u64) {
        match delta {
            StreamDelta::Thinking { .. } => {
                self.started.get_or_insert(now_ms);
            }
            // 开始写正文 / 调工具 = 这段思考结束。
            StreamDelta::Text { .. }
            | StreamDelta::ToolStart { .. }
            | StreamDelta::ToolInput { .. } => {
                self.close(now_ms);
            }
        }
    }

    /// 消息收尾：把量到的时长按顺序盖到它的思考块上，然后清空，留给
    /// 同一次调用里可能的下一条消息。
    pub(crate) fn stamp(&mut self, msg: &mut Message, now_ms: u64) {
        self.close(now_ms);
        let mut spans = std::mem::take(&mut self.spans).into_iter();
        let Message::Assistant { content, .. } = msg else {
            return;
        };
        for block in content.iter_mut() {
            if let AssistantContent::Thinking { duration_ms, .. } = block {
                match spans.next() {
                    Some(ms) if ms > 0 => *duration_ms = Some(ms),
                    Some(_) => {}
                    // 块比量到的段多（非流式响应一次性给全）：剩下的没得量。
                    None => break,
                }
            }
        }
    }

    fn close(&mut self, now_ms: u64) {
        if let Some(start) = self.started.take() {
            self.spans.push(now_ms.saturating_sub(start));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use riot_protocol::id::{MessageId, ToolUseId};
    use riot_protocol::message::MessageMeta;

    fn think(text: &str) -> StreamDelta {
        StreamDelta::Thinking {
            message_id: MessageId::from_raw("m"),
            text: text.into(),
        }
    }

    fn text(t: &str) -> StreamDelta {
        StreamDelta::Text {
            message_id: MessageId::from_raw("m"),
            text: t.into(),
        }
    }

    fn thinking_block(t: &str) -> AssistantContent {
        AssistantContent::Thinking {
            text: t.into(),
            signature: None,
            duration_ms: None,
        }
    }

    fn assistant(content: Vec<AssistantContent>) -> Message {
        Message::Assistant {
            id: MessageId::from_raw("m"),
            content,
            usage: None,
            meta: MessageMeta::default(),
        }
    }

    fn durations(m: &Message) -> Vec<Option<u64>> {
        let Message::Assistant { content, .. } = m else {
            return vec![];
        };
        content
            .iter()
            .filter_map(|c| match c {
                AssistantContent::Thinking { duration_ms, .. } => Some(*duration_ms),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn 思考到开始写正文为止() {
        let mut t = ThinkTimer::default();
        t.on_delta(&think("嗯"), 1_000);
        t.on_delta(&think("再想想"), 5_000);
        t.on_delta(&text("好的"), 13_000);
        t.on_delta(&text("……"), 20_000);
        let mut m = assistant(vec![
            thinking_block("嗯再想想"),
            AssistantContent::Text {
                text: "好的……".into(),
            },
        ]);
        t.stamp(&mut m, 21_000);
        assert_eq!(durations(&m), vec![Some(12_000)]);
    }

    #[test]
    fn 没转去写正文就量到消息收尾() {
        let mut t = ThinkTimer::default();
        t.on_delta(&think("嗯"), 1_000);
        let mut m = assistant(vec![thinking_block("嗯")]);
        t.stamp(&mut m, 4_000);
        assert_eq!(durations(&m), vec![Some(3_000)]);
    }

    #[test]
    fn 交错思考按顺序对上() {
        let mut t = ThinkTimer::default();
        t.on_delta(&think("a"), 0);
        t.on_delta(
            &StreamDelta::ToolStart {
                tool_use_id: ToolUseId::from_raw("t"),
                name: "Read".into(),
            },
            2_000,
        );
        t.on_delta(&think("b"), 3_000);
        t.on_delta(&text("x"), 8_000);
        let mut m = assistant(vec![thinking_block("a"), thinking_block("b")]);
        t.stamp(&mut m, 9_000);
        assert_eq!(durations(&m), vec![Some(2_000), Some(5_000)]);
    }

    /// 时钟没走（MockClock、非流式）就不盖 —— 黄金回放的快照不能因为
    /// 多出一个 0 而变。
    #[test]
    fn 量出来是零就不盖() {
        let mut t = ThinkTimer::default();
        t.on_delta(&think("a"), 7);
        t.on_delta(&text("x"), 7);
        let mut m = assistant(vec![thinking_block("a"), thinking_block("没增量的块")]);
        t.stamp(&mut m, 7);
        assert_eq!(durations(&m), vec![None, None]);
    }

    #[test]
    fn 盖完清空_不串到下一条消息() {
        let mut t = ThinkTimer::default();
        t.on_delta(&think("a"), 0);
        let mut first = assistant(vec![thinking_block("a")]);
        t.stamp(&mut first, 1_000);
        let mut second = assistant(vec![thinking_block("b")]);
        t.stamp(&mut second, 9_000);
        assert_eq!(durations(&second), vec![None]);
    }
}
