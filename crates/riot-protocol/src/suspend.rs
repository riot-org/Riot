//! 挂起：要人做决定时，回合停下而不是干等。
//!
//! 权限闸判定"要问人"时不再挂着 oneshot 计时等待，而是返回
//! [`crate::permission::GateOutcome::Suspend`]。调度器把同批能跑的跑完、
//! 后面的批次原样推迟，打包成一条 [`Suspension`]；主循环以
//! [`crate::event::TerminalReason::AwaitingUser`] 收场，宿主把记录落盘。
//! 用户答完，宿主开一轮续跑：答案写成**那条 tool_use 自己的** tool_result，
//! 模型看到的只是"这个工具执行得久了一点"。
//!
//! `[约束]` 挂起期间不写任何 tool_result。同一条 assistant 消息的全部
//! tool_result 必须作为紧接着的下一条消息一次给全（两家协议都这么要求），
//! 先给一半、过后再补，序列就是非法的。已完成的结果存在槽位里，续跑时
//! 和新结果按调用顺序拼成一条。

use std::collections::HashMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::id::{MessageId, RequestId, ToolUseId};
use crate::message::{Message, MessageMeta, ToolResultContent, UserContent};
use crate::permission::{PermissionAsk, PermissionResponse};
use crate::runner::ToolCall;

/// 一条挂起中的询问：卡片详情，加上续跑时要执行的最终输入。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SuspendedAsk {
    pub request_id: RequestId,
    pub detail: PermissionAsk,
    /// hook 改写之后的输入。续跑按它执行 —— 退回原输入等于按 A 授权、
    /// 去执行 B。
    pub input: serde_json::Value,
}

/// 一批调用里的一个位置。顺序和模型发出的调用顺序一致。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SuspendSlot {
    /// 已经跑完。`result` 是一条 [`UserContent::ToolResult`]。
    Done { result: UserContent },
    /// 等用户回答。
    Asked {
        tool_use_id: ToolUseId,
        name: String,
        ask: Box<SuspendedAsk>,
    },
    /// 排在挂起的调用后面、还没跑的。批次之间有先后依赖（先读再写），
    /// 中间那个没定下来就跑后面的，会打乱模型预期的执行顺序。
    Deferred {
        tool_use_id: ToolUseId,
        name: String,
        input: serde_json::Value,
    },
}

impl SuspendSlot {
    pub fn tool_use_id(&self) -> &ToolUseId {
        match self {
            Self::Done { result } => match result {
                UserContent::ToolResult { tool_use_id, .. } => tool_use_id,
                // 构造方只放 ToolResult 进来（见调度器）；走到这里是代码错误。
                _ => unreachable!("SuspendSlot::Done 只装 tool_result"),
            },
            Self::Asked { tool_use_id, .. } | Self::Deferred { tool_use_id, .. } => tool_use_id,
        }
    }
}

/// 一次挂起的全部内容。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Suspension {
    pub slots: Vec<SuspendSlot>,
    /// 已完成的调用产生的旁路消息（hook 反馈、图片 metadata），续跑时
    /// 跟在 tool_result 后面一起发。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub side_messages: Vec<Message>,
}

impl Suspension {
    /// 还在等用户的询问，按调用顺序。
    pub fn asks(&self) -> impl Iterator<Item = &SuspendedAsk> {
        self.slots.iter().filter_map(|s| match s {
            SuspendSlot::Asked { ask, .. } => Some(&**ask),
            _ => None,
        })
    }

    /// 涉及的全部 tool_use id（含已完成的）。历史自愈要跳过它们。
    pub fn tool_use_ids(&self) -> Vec<ToolUseId> {
        self.slots.iter().map(|s| s.tool_use_id().clone()).collect()
    }

    /// 续跑要执行的调用：挂起的和推迟的，按原顺序。
    pub fn calls_to_run(&self) -> Vec<ToolCall> {
        self.slots
            .iter()
            .filter_map(|s| match s {
                SuspendSlot::Done { .. } => None,
                SuspendSlot::Asked {
                    tool_use_id,
                    name,
                    ask,
                } => Some(ToolCall {
                    id: tool_use_id.clone(),
                    name: name.clone(),
                    input: ask.input.clone(),
                }),
                SuspendSlot::Deferred {
                    tool_use_id,
                    name,
                    input,
                } => Some(ToolCall {
                    id: tool_use_id.clone(),
                    name: name.clone(),
                    input: input.clone(),
                }),
            })
            .collect()
    }

    /// 续跑的批次又挂起了：用新槽位替换同 id 的旧槽位，已完成的保留。
    pub fn merge(mut self, newer: Suspension) -> Suspension {
        let mut by_id: HashMap<ToolUseId, SuspendSlot> = newer
            .slots
            .into_iter()
            .map(|s| (s.tool_use_id().clone(), s))
            .collect();
        for slot in &mut self.slots {
            if let Some(n) = by_id.remove(slot.tool_use_id()) {
                *slot = n;
            }
        }
        self.side_messages.extend(newer.side_messages);
        self
    }

    /// 续跑的批次跑完了：已完成的结果和新结果按原顺序拼成一条消息。
    ///
    /// `fresh` 是续跑批次的 tool_result（任意顺序）。缺了哪一个就补一条
    /// 错误结果 —— 每个 tool_use 都必须有结果，缺一个下次请求就是 400。
    pub fn into_results(self, id: MessageId, fresh: Vec<UserContent>) -> (Message, Vec<Message>) {
        let mut by_id: HashMap<ToolUseId, UserContent> = fresh
            .into_iter()
            .filter_map(|c| match &c {
                UserContent::ToolResult { tool_use_id, .. } => Some((tool_use_id.clone(), c)),
                _ => None,
            })
            .collect();
        let content = self
            .slots
            .into_iter()
            .map(|s| match s {
                SuspendSlot::Done { result } => result,
                other => {
                    let id = other.tool_use_id().clone();
                    by_id
                        .remove(&id)
                        .unwrap_or_else(|| UserContent::ToolResult {
                            tool_use_id: id,
                            content: ToolResultContent::text(
                                "Result lost: this call was not run after the pause.",
                            ),
                            is_error: true,
                        })
                }
            })
            .collect();
        (
            Message::User {
                id,
                content,
                meta: MessageMeta::default(),
            },
            self.side_messages,
        )
    }

    /// 不等用户答完就收掉挂起（用户直接发了新消息、按了停止）：未回答的
    /// 和推迟的都换成 `text` 说明的错误结果，已完成的原样保留。
    pub fn close_with(self, id: MessageId, asked: &str, deferred: &str) -> (Message, Vec<Message>) {
        let fresh = self
            .slots
            .iter()
            .filter_map(|s| match s {
                SuspendSlot::Done { .. } => None,
                SuspendSlot::Asked { tool_use_id, .. } => Some(UserContent::ToolResult {
                    tool_use_id: tool_use_id.clone(),
                    content: ToolResultContent::text(asked),
                    is_error: true,
                }),
                SuspendSlot::Deferred { tool_use_id, .. } => Some(UserContent::ToolResult {
                    tool_use_id: tool_use_id.clone(),
                    content: ToolResultContent::text(deferred),
                    is_error: true,
                }),
            })
            .collect();
        self.into_results(id, fresh)
    }
}

/// 挂起记录加上已收到的答案。宿主持有、落盘、重启后重建。
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SuspendState {
    pub suspension: Option<Suspension>,
    /// request_id → 答案。
    pub answers: HashMap<String, PermissionResponse>,
}

impl SuspendState {
    pub fn new(suspension: Suspension) -> Self {
        Self {
            suspension: Some(suspension),
            answers: HashMap::new(),
        }
    }

    /// 是不是每条询问都答了。
    pub fn complete(&self) -> bool {
        self.suspension.as_ref().is_some_and(|s| {
            s.asks()
                .all(|a| self.answers.contains_key(a.request_id.as_str()))
        })
    }

    /// 这个 request_id 是不是本次挂起里一条还没回答的询问。
    pub fn awaits(&self, request_id: &str) -> bool {
        self.suspension.as_ref().is_some_and(|s| {
            s.asks().any(|a| a.request_id.as_str() == request_id)
                && !self.answers.contains_key(request_id)
        })
    }

    /// 还没回答的询问，给界面重建卡片用。
    pub fn unanswered(&self) -> Vec<SuspendedAsk> {
        self.suspension
            .as_ref()
            .map(|s| {
                s.asks()
                    .filter(|a| !self.answers.contains_key(a.request_id.as_str()))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permission::{AskPreview, DecisionReason};
    use crate::text::UiText;

    fn done(id: &str) -> SuspendSlot {
        SuspendSlot::Done {
            result: UserContent::ToolResult {
                tool_use_id: ToolUseId::from_raw(id),
                content: ToolResultContent::text(format!("ok {id}")),
                is_error: false,
            },
        }
    }

    fn asked(id: &str, req: &str) -> SuspendSlot {
        SuspendSlot::Asked {
            tool_use_id: ToolUseId::from_raw(id),
            name: "Bash".into(),
            ask: Box::new(SuspendedAsk {
                request_id: RequestId::from_raw(req),
                detail: PermissionAsk {
                    tool_use_id: ToolUseId::from_raw(id),
                    tool_name: "Bash".into(),
                    summary: UiText::new("x"),
                    agent_label: None,
                    preview: AskPreview::Plain {
                        text: UiText::new("x"),
                    },
                    suggestions: vec![],
                    reason: DecisionReason::UserChoice { remembered: false },
                },
                input: serde_json::json!({"command": "ls"}),
            }),
        }
    }

    fn deferred(id: &str) -> SuspendSlot {
        SuspendSlot::Deferred {
            tool_use_id: ToolUseId::from_raw(id),
            name: "Write".into(),
            input: serde_json::json!({}),
        }
    }

    fn ids(m: &Message) -> Vec<String> {
        match m {
            Message::User { content, .. } => content
                .iter()
                .filter_map(|c| match c {
                    UserContent::ToolResult { tool_use_id, .. } => {
                        Some(tool_use_id.as_str().to_owned())
                    }
                    _ => None,
                })
                .collect(),
            _ => vec![],
        }
    }

    #[test]
    fn 续跑的结果按原顺序拼成一条() {
        let s = Suspension {
            slots: vec![done("a"), asked("b", "r1"), deferred("c")],
            side_messages: vec![],
        };
        let calls: Vec<_> = s
            .calls_to_run()
            .into_iter()
            .map(|c| c.id.as_str().to_owned())
            .collect();
        assert_eq!(calls, ["b", "c"]);
        let fresh = vec![
            UserContent::ToolResult {
                tool_use_id: ToolUseId::from_raw("c"),
                content: ToolResultContent::text("c"),
                is_error: false,
            },
            UserContent::ToolResult {
                tool_use_id: ToolUseId::from_raw("b"),
                content: ToolResultContent::text("b"),
                is_error: false,
            },
        ];
        let (m, _) = s.into_results(MessageId::from_raw("m"), fresh);
        assert_eq!(ids(&m), ["a", "b", "c"]);
    }

    #[test]
    fn 缺结果的调用补成错误而不是漏掉() {
        let s = Suspension {
            slots: vec![asked("b", "r1"), deferred("c")],
            side_messages: vec![],
        };
        let (m, _) = s.into_results(MessageId::from_raw("m"), vec![]);
        assert_eq!(ids(&m), ["b", "c"]);
    }

    #[test]
    fn 再次挂起时合并保留已完成的() {
        let old = Suspension {
            slots: vec![done("a"), asked("b", "r1"), deferred("c")],
            side_messages: vec![],
        };
        let newer = Suspension {
            slots: vec![done("b"), asked("c", "r2")],
            side_messages: vec![],
        };
        let m = old.merge(newer);
        assert!(matches!(m.slots[0], SuspendSlot::Done { .. }));
        assert!(matches!(m.slots[1], SuspendSlot::Done { .. }));
        assert!(matches!(m.slots[2], SuspendSlot::Asked { .. }));
        assert_eq!(m.asks().count(), 1);
    }

    #[test]
    fn 答案收齐才算完成() {
        let mut st = SuspendState::new(Suspension {
            slots: vec![asked("a", "r1"), asked("b", "r2")],
            side_messages: vec![],
        });
        assert!(st.awaits("r1"));
        st.answers
            .insert("r1".into(), PermissionResponse::Deny { message: None });
        assert!(!st.awaits("r1"));
        assert!(!st.complete());
        assert_eq!(st.unanswered().len(), 1);
        st.answers
            .insert("r2".into(), PermissionResponse::Deny { message: None });
        assert!(st.complete());
    }

    #[test]
    fn 记录可以序列化往返() {
        let s = Suspension {
            slots: vec![done("a"), asked("b", "r1"), deferred("c")],
            side_messages: vec![],
        };
        let j = serde_json::to_string(&s).unwrap();
        assert_eq!(serde_json::from_str::<Suspension>(&j).unwrap(), s);
    }
}
