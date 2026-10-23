//! 挂起与续跑的主循环语义（见 riot_protocol::suspend）。
//!
//! - 批次带挂起记录：交出 `Suspended`，以 `AwaitingUser` 收场，**不写**
//!   tool_result —— 同一条 assistant 消息的结果要在续跑时一次给全；
//! - 续跑：不发请求，先只跑挂起和推迟的调用，结果和已完成的按原顺序
//!   拼成一条，再照常请求模型；
//! - 续跑的批次又挂起：槽位合并，已完成的不丢。

use std::sync::{Arc, Mutex};

use futures::StreamExt;
use riot_protocol::event::{AgentEvent, TerminalReason, Transition};
use riot_protocol::id::{MessageId, RequestId, SessionId, ToolUseId};
use riot_protocol::message::{
    AssistantContent, Message, MessageMeta, ToolResultContent, UserContent,
};
use riot_protocol::permission::{AskPreview, DecisionReason, PermissionAsk};
use riot_protocol::provider::{ProviderEvent, ToolSpec};
use riot_protocol::runner::{
    BatchContext, BatchEvent, BatchOutcome, BatchStream, ToolCall, ToolRunner,
};
use riot_protocol::suspend::{SuspendSlot, SuspendedAsk, Suspension};
use riot_protocol::text::UiText;
use tokio_util::sync::CancellationToken;

use riot_core::state::AgentState;
use riot_core::testing::{
    FakeCompactor, ScriptedProvider, assistant_text, mock_deps_with, user_text,
};

fn result(id: &str, text: &str) -> UserContent {
    UserContent::ToolResult {
        tool_use_id: ToolUseId::from_raw(id),
        content: ToolResultContent::text(text),
        is_error: false,
    }
}

fn asked(id: &str) -> SuspendSlot {
    SuspendSlot::Asked {
        tool_use_id: ToolUseId::from_raw(id),
        name: "Bash".into(),
        ask: Box::new(SuspendedAsk {
            request_id: RequestId::from_raw(format!("r-{id}")),
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
            input: serde_json::json!({ "command": "ls" }),
        }),
    }
}

/// 按脚本一批一批地给结果，并记下每批收到了哪些调用。
struct Runner {
    outcomes: Mutex<Vec<BatchOutcome>>,
    seen: Arc<Mutex<Vec<Vec<String>>>>,
}

impl ToolRunner for Runner {
    fn specs(&self) -> Vec<ToolSpec> {
        Vec::new()
    }

    fn run_batch(&self, calls: Vec<ToolCall>, _ctx: BatchContext) -> BatchStream {
        self.seen
            .lock()
            .unwrap()
            .push(calls.iter().map(|c| c.id.as_str().to_owned()).collect());
        let o = self.outcomes.lock().unwrap().remove(0);
        Box::pin(futures::stream::iter(vec![BatchEvent::Done(o)]))
    }
}

fn outcome(results: Vec<UserContent>, suspended: Option<Suspension>) -> BatchOutcome {
    BatchOutcome {
        results: Message::User {
            id: MessageId::from_raw("res"),
            content: results,
            meta: MessageMeta::default(),
        },
        side_messages: vec![],
        cancelled: 0,
        suspended: suspended.map(Box::new),
    }
}

fn two_tool_uses() -> Message {
    Message::Assistant {
        id: MessageId::from_raw("m_tools"),
        content: vec![
            AssistantContent::ToolUse {
                id: ToolUseId::from_raw("a"),
                name: "Read".into(),
                input: serde_json::json!({}),
            },
            AssistantContent::ToolUse {
                id: ToolUseId::from_raw("b"),
                name: "Bash".into(),
                input: serde_json::json!({ "command": "ls" }),
            },
        ],
        usage: None,
        meta: MessageMeta::default(),
    }
}

async fn collect(state: AgentState, deps: riot_core::state::AgentDeps) -> Vec<AgentEvent> {
    let s = riot_core::run_agent(state, deps, CancellationToken::new());
    futures::pin_mut!(s);
    let mut out = Vec::new();
    while let Some(ev) = s.next().await {
        out.push(ev);
    }
    out
}

fn tool_result_ids(events: &[AgentEvent]) -> Vec<Vec<String>> {
    events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::Message(Message::User { content, .. }) => {
                let ids: Vec<String> = content
                    .iter()
                    .filter_map(|c| match c {
                        UserContent::ToolResult { tool_use_id, .. } => {
                            Some(tool_use_id.as_str().to_owned())
                        }
                        _ => None,
                    })
                    .collect();
                (!ids.is_empty()).then_some(ids)
            }
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn 要问人时以_awaiting_user_收场且不写结果() {
    let provider = Arc::new(ScriptedProvider::new(vec![vec![ProviderEvent::Message(
        two_tool_uses(),
    )]]));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let runner = Arc::new(Runner {
        outcomes: Mutex::new(vec![outcome(
            vec![],
            Some(Suspension {
                slots: vec![
                    SuspendSlot::Done {
                        result: result("a", "读到了"),
                    },
                    asked("b"),
                ],
                side_messages: vec![],
            }),
        )]),
        seen: Arc::clone(&seen),
    });
    let state =
        AgentState::new(SessionId::from_raw("s"), "m").with_messages(vec![user_text("u", "干活")]);
    let events = collect(
        state,
        mock_deps_with(provider, runner, Arc::new(FakeCompactor::default())),
    )
    .await;

    assert!(
        tool_result_ids(&events).is_empty(),
        "挂起时一条结果都不能写"
    );
    let n = events.len();
    assert!(
        matches!(&events[n - 2], AgentEvent::Suspended { suspension } if suspension.asks().count() == 1),
        "Done 之前要把挂起记录交出去：{:?}",
        events[n - 2]
    );
    assert!(matches!(
        &events[n - 1],
        AgentEvent::Done {
            reason: TerminalReason::AwaitingUser { asks: 1 }
        }
    ));
}

#[tokio::test]
async fn 续跑只跑挂起的调用_结果按原顺序拼成一条() {
    let provider = Arc::new(ScriptedProvider::new(vec![vec![ProviderEvent::Message(
        assistant_text("m_end", "好了"),
    )]]));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let runner = Arc::new(Runner {
        outcomes: Mutex::new(vec![outcome(vec![result("b", "ls 的输出")], None)]),
        seen: Arc::clone(&seen),
    });
    let mut state = AgentState::new(SessionId::from_raw("s"), "m")
        .with_messages(vec![user_text("u", "干活"), two_tool_uses()]);
    state.resume = Some(Suspension {
        slots: vec![
            SuspendSlot::Done {
                result: result("a", "读到了"),
            },
            asked("b"),
        ],
        side_messages: vec![],
    });
    let events = collect(
        state,
        mock_deps_with(
            Arc::clone(&provider) as _,
            runner,
            Arc::new(FakeCompactor::default()),
        ),
    )
    .await;

    assert_eq!(
        *seen.lock().unwrap(),
        vec![vec!["b".to_owned()]],
        "已完成的不能重跑"
    );
    assert_eq!(
        tool_result_ids(&events),
        vec![vec!["a".to_owned(), "b".to_owned()]]
    );
    assert!(
        matches!(
            &events[0],
            AgentEvent::RequestStart {
                after: Some(Transition::ResumedAfterUser),
                ..
            }
        ),
        "续跑开头要报一声，界面和宿主靠它置忙"
    );
    assert!(matches!(
        events.last(),
        Some(AgentEvent::Done {
            reason: TerminalReason::Completed
        })
    ));
    assert_eq!(provider.call_count(), 1, "结果给齐之后才请求模型");
}

#[tokio::test]
async fn 续跑又挂起时合并槽位_已完成的不丢() {
    let provider = Arc::new(ScriptedProvider::new(vec![]));
    let runner = Arc::new(Runner {
        outcomes: Mutex::new(vec![outcome(
            vec![],
            Some(Suspension {
                slots: vec![
                    SuspendSlot::Done {
                        result: result("b", "ls 的输出"),
                    },
                    asked("c"),
                ],
                side_messages: vec![],
            }),
        )]),
        seen: Arc::new(Mutex::new(Vec::new())),
    });
    let mut state = AgentState::new(SessionId::from_raw("s"), "m")
        .with_messages(vec![user_text("u", "干活"), two_tool_uses()]);
    state.resume = Some(Suspension {
        slots: vec![
            SuspendSlot::Done {
                result: result("a", "读到了"),
            },
            asked("b"),
            SuspendSlot::Deferred {
                tool_use_id: ToolUseId::from_raw("c"),
                name: "Bash".into(),
                input: serde_json::json!({}),
            },
        ],
        side_messages: vec![],
    });
    let events = collect(
        state,
        mock_deps_with(provider, runner, Arc::new(FakeCompactor::default())),
    )
    .await;

    let sus = events
        .iter()
        .find_map(|e| match e {
            AgentEvent::Suspended { suspension } => Some(suspension),
            _ => None,
        })
        .expect("应该再次挂起");
    let done: Vec<&str> = sus
        .slots
        .iter()
        .filter(|s| matches!(s, SuspendSlot::Done { .. }))
        .map(|s| s.tool_use_id().as_str())
        .collect();
    assert_eq!(done, vec!["a", "b"]);
    assert_eq!(sus.asks().count(), 1);
}
