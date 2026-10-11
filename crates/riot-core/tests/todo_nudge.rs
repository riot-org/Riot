//! 待办清单兜底提醒的主循环语义。
//!
//! - 模型开了清单却连续 NUDGE_AFTER_CALLS 次调用不碰 TodoWrite，工具结果
//!   后面跟一条 synthetic user + SystemReminder，把清单现状摆给它看；
//! - 提醒后计数归零：继续无视要再攒同样多次才会再提，不是每批都催；
//! - 清单全部完成、或压根没用清单，一次都不提。

use std::collections::HashMap;
use std::sync::Arc;

use futures::StreamExt;
use riot_protocol::event::{AgentEvent, TerminalReason};
use riot_protocol::id::SessionId;
use riot_protocol::message::{Attachment, Message, UserContent};
use riot_protocol::provider::ProviderEvent;
use tokio_util::sync::CancellationToken;

use riot_core::state::AgentState;
use riot_core::testing::{
    FakeCompactor, ScriptedProvider, ScriptedResult, ScriptedToolRunner, assistant_text,
    assistant_tool_use, mock_deps_with, user_text,
};
use riot_core::todo_nudge::{NUDGE_AFTER_CALLS, TODO_WRITE};

fn state() -> AgentState {
    AgentState::new(SessionId::from_raw("todo"), "test-model")
        .with_max_turns(64)
        .with_messages(vec![user_text("m_in", "干活")])
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

fn todo_call(i: usize, todos: serde_json::Value) -> Vec<ProviderEvent> {
    vec![ProviderEvent::Message(assistant_tool_use(
        &format!("m_todo{i}"),
        &format!("t_todo{i}"),
        TODO_WRITE,
        serde_json::json!({ "todos": todos }),
    ))]
}

fn read_call(i: usize) -> Vec<ProviderEvent> {
    vec![ProviderEvent::Message(assistant_tool_use(
        &format!("m_read{i}"),
        &format!("t_read{i}"),
        "Read",
        serde_json::json!({ "path": format!("/f{i}") }),
    ))]
}

fn finish() -> Vec<ProviderEvent> {
    vec![ProviderEvent::Message(assistant_text("m_end", "做完了"))]
}

fn tools() -> Arc<ScriptedToolRunner> {
    let mut results = HashMap::new();
    results.insert(
        TODO_WRITE.to_owned(),
        ScriptedResult::Ok {
            text: "清单已更新".into(),
        },
    );
    results.insert(
        "Read".to_owned(),
        ScriptedResult::Ok {
            text: "内容".into(),
        },
    );
    Arc::new(ScriptedToolRunner::new(results))
}

/// 事件流里跑轮中的提醒（synthetic user + 「多少次调用没更新」那条）。
fn nudges(events: &[AgentEvent]) -> Vec<&str> {
    reminders(events, "since you last updated")
}

/// 收尾前对账清单的提醒。
fn closing(events: &[AgentEvent]) -> Vec<&str> {
    reminders(events, "You are about to finish")
}

fn reminders<'a>(events: &'a [AgentEvent], marker: &str) -> Vec<&'a str> {
    events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::Message(Message::User { content, meta, .. }) if meta.synthetic => {
                content.iter().find_map(|c| match c {
                    UserContent::Attachment(Attachment::SystemReminder { text })
                        if text.contains(marker) =>
                    {
                        Some(text.as_str())
                    }
                    _ => None,
                })
            }
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn 连续不更新清单会收到一次提醒_且带清单现状() {
    let pending = serde_json::json!([
        { "content": "修 bug", "status": "in_progress", "activeForm": "正在修 bug" },
        { "content": "写文档", "status": "pending", "activeForm": "正在写文档" },
    ]);
    let mut script = vec![todo_call(0, pending)];
    script.extend((0..NUDGE_AFTER_CALLS).map(read_call));
    script.push(finish());
    // 清单停在没做完：收尾前会被提醒对账一次，模型再答一轮。
    script.push(finish());
    let provider = Arc::new(ScriptedProvider::new(script));
    let deps = mock_deps_with(
        Arc::clone(&provider) as _,
        tools(),
        Arc::new(FakeCompactor::default()),
    );

    let events = collect(state(), deps).await;

    assert!(matches!(
        events.last(),
        Some(AgentEvent::Done {
            reason: TerminalReason::Completed
        })
    ));
    let got = nudges(&events);
    assert_eq!(got.len(), 1, "恰好到线一次，提醒一次：{got:?}");
    assert!(
        got[0].contains("修 bug") && got[0].contains("写文档"),
        "{}",
        got[0]
    );
    assert!(
        got[0].contains("[in_progress]") && got[0].contains("[pending]"),
        "{}",
        got[0]
    );

    // 提醒紧跟在第 NUDGE_AFTER_CALLS 次 Read 的结果后面，而不是轮子结束时。
    let msgs: Vec<&Message> = events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::Message(m) => Some(m),
            _ => None,
        })
        .collect();
    let nudge_at = msgs
        .iter()
        .position(|m| matches!(m, Message::User { meta, content, .. } if meta.synthetic
            && content.iter().any(|c| matches!(c, UserContent::Attachment(Attachment::SystemReminder { .. })))))
        .expect("该有提醒");
    let last_read_at = msgs
        .iter()
        .position(|m| m.id().as_str() == format!("m_read{}", NUDGE_AFTER_CALLS - 1))
        .expect("该有最后一次 Read");
    assert_eq!(
        nudge_at,
        last_read_at + 2,
        "提醒该紧跟在触发它那次调用的 tool_result 之后"
    );
    assert!(riot_core::invariants::take_violations().is_empty());
}

#[tokio::test]
async fn 提醒后归零_继续无视再攒满才再提() {
    let pending = serde_json::json!([
        { "content": "修 bug", "status": "in_progress", "activeForm": "x" },
    ]);
    let mut script = vec![todo_call(0, pending)];
    // 两倍到线：第一次提醒后计数归零，再攒满一次才第二次提醒。
    script.extend((0..NUDGE_AFTER_CALLS * 2).map(read_call));
    script.push(finish());
    // 清单停在没做完：收尾前会被提醒对账一次，模型再答一轮。
    script.push(finish());
    let provider = Arc::new(ScriptedProvider::new(script));
    let deps = mock_deps_with(
        Arc::clone(&provider) as _,
        tools(),
        Arc::new(FakeCompactor::default()),
    );

    let events = collect(state(), deps).await;

    assert_eq!(nudges(&events).len(), 2, "两倍到线只该提两次，不是每批都催");
    assert!(riot_core::invariants::take_violations().is_empty());
}

#[tokio::test]
async fn 中途更新了清单就重新计数() {
    let pending = serde_json::json!([
        { "content": "修 bug", "status": "in_progress", "activeForm": "x" },
    ]);
    let mut script = vec![todo_call(0, pending.clone())];
    script.extend((0..NUDGE_AFTER_CALLS - 1).map(read_call));
    // 差一次到线时更新了清单 —— 计数归零，后面再来 NUDGE_AFTER_CALLS - 1 次也不到线。
    script.push(todo_call(1, pending));
    script.extend((NUDGE_AFTER_CALLS..NUDGE_AFTER_CALLS * 2 - 1).map(read_call));
    script.push(finish());
    // 清单停在没做完：收尾前会被提醒对账一次，模型再答一轮。
    script.push(finish());
    let provider = Arc::new(ScriptedProvider::new(script));
    let deps = mock_deps_with(
        Arc::clone(&provider) as _,
        tools(),
        Arc::new(FakeCompactor::default()),
    );

    let events = collect(state(), deps).await;

    assert!(nudges(&events).is_empty(), "模型自己在更新，不该被催");
    assert!(riot_core::invariants::take_violations().is_empty());
}

#[tokio::test]
async fn 清单全部完成或没用清单都不提醒() {
    let done = serde_json::json!([
        { "content": "修 bug", "status": "completed", "activeForm": "x" },
    ]);
    let mut script = vec![todo_call(0, done)];
    script.extend((0..NUDGE_AFTER_CALLS * 2).map(read_call));
    script.push(finish());
    let provider = Arc::new(ScriptedProvider::new(script));
    let deps = mock_deps_with(provider as _, tools(), Arc::new(FakeCompactor::default()));
    let events = collect(state(), deps).await;
    assert!(nudges(&events).is_empty(), "全部完成的清单没有可催的");

    let mut script: Vec<Vec<ProviderEvent>> = (0..NUDGE_AFTER_CALLS * 2).map(read_call).collect();
    script.push(finish());
    let provider = Arc::new(ScriptedProvider::new(script));
    let deps = mock_deps_with(provider as _, tools(), Arc::new(FakeCompactor::default()));
    let events = collect(state(), deps).await;
    assert!(
        nudges(&events).is_empty(),
        "没用清单是 prompt 的事，这里只管用了不更新"
    );
    assert!(riot_core::invariants::take_violations().is_empty());
}

#[tokio::test]
async fn 收尾时清单没做完会提醒对账一次() {
    let pending = serde_json::json!([
        { "content": "修 bug", "status": "completed", "activeForm": "x" },
        { "content": "写文档", "status": "in_progress", "activeForm": "x" },
    ]);
    let done = serde_json::json!([
        { "content": "修 bug", "status": "completed", "activeForm": "x" },
        { "content": "写文档", "status": "completed", "activeForm": "x" },
    ]);
    // 说完了却没勾清单 → 提醒 → 模型补一次 TodoWrite → 再说完。
    let script = vec![
        todo_call(0, pending),
        finish(),
        todo_call(1, done),
        finish(),
    ];
    let provider = Arc::new(ScriptedProvider::new(script));
    let deps = mock_deps_with(
        Arc::clone(&provider) as _,
        tools(),
        Arc::new(FakeCompactor::default()),
    );

    let events = collect(state(), deps).await;

    assert!(matches!(
        events.last(),
        Some(AgentEvent::Done {
            reason: TerminalReason::Completed
        })
    ));
    let got = closing(&events);
    assert_eq!(got.len(), 1, "{got:?}");
    assert!(got[0].contains("[in_progress] 写文档"), "{}", got[0]);
    assert!(!got[0].contains("修 bug"), "已完成的不该列：{}", got[0]);
    assert!(riot_core::invariants::take_violations().is_empty());
}

#[tokio::test]
async fn 对账提醒每个_run_只给一次() {
    let pending = serde_json::json!([
        { "content": "写文档", "status": "pending", "activeForm": "x" },
    ]);
    // 模型被提醒后仍不勾（真没做 / 用户叫停）：那就是事实，照常收尾，不再催。
    let script = vec![todo_call(0, pending), finish(), finish()];
    let provider = Arc::new(ScriptedProvider::new(script));
    let deps = mock_deps_with(
        Arc::clone(&provider) as _,
        tools(),
        Arc::new(FakeCompactor::default()),
    );

    let events = collect(state(), deps).await;

    assert!(matches!(
        events.last(),
        Some(AgentEvent::Done {
            reason: TerminalReason::Completed
        })
    ));
    assert_eq!(closing(&events).len(), 1);
}

#[tokio::test]
async fn 交给后台之后收尾不催对账() {
    let pending = serde_json::json!([
        { "content": "写文档", "status": "in_progress", "activeForm": "x" },
    ]);
    // 「转到后台」：分叉自己，剩下的项归后台那份做，前台立刻收尾是对的。
    let fork = vec![ProviderEvent::Message(assistant_tool_use(
        "m_fork",
        "t_fork",
        riot_core::todo_nudge::TASK,
        serde_json::json!({ "resume": "self", "description": "写文档", "prompt": "继续" }),
    ))];
    let script = vec![todo_call(0, pending), fork, finish()];
    let provider = Arc::new(ScriptedProvider::new(script));
    let mut results = HashMap::new();
    results.insert(
        TODO_WRITE.to_owned(),
        ScriptedResult::Ok {
            text: "清单已更新".into(),
        },
    );
    results.insert(
        riot_core::todo_nudge::TASK.to_owned(),
        ScriptedResult::Ok {
            text: "已在后台分叉".into(),
        },
    );
    let deps = mock_deps_with(
        Arc::clone(&provider) as _,
        Arc::new(ScriptedToolRunner::new(results)),
        Arc::new(FakeCompactor::default()),
    );

    let events = collect(state(), deps).await;

    assert!(matches!(
        events.last(),
        Some(AgentEvent::Done {
            reason: TerminalReason::Completed
        })
    ));
    assert!(closing(&events).is_empty(), "活在后台手里，不该催");
}
