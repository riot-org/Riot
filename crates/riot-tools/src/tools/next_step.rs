//! NextStep：一轮做完时的收尾卡片 —— 两三句小结，需要用户拍板时再带
//! 一个问题和最多两个按钮（前端 components/NextStepCard.tsx）。
//!
//! # 为什么要有这个工具
//!
//! 很多轮结束时用户要做的只是「提交」「先不提交」「按方案开工」，却得
//! 自己打字；而"现在什么状态、还差什么"散在长回答的末尾，要找。卡片把
//! 这两件事钉在回答下面：小结一眼看完，按钮点一下就是回复。
//!
//! # 和 AskUserQuestion 的分工
//!
//! AskUserQuestion 在一轮**中间**用，卡住这一轮等答案；NextStep 在一轮
//! **结束**时用，不卡任何东西 —— 用户不理它、直接打字也完全可以。
//!
//! # 形状
//!
//! - `recap`：现在是什么状态、还有什么没做或没验证。必填。
//! - `ask`：一个需要用户决定的问题。可选 —— 没有待决的事就不问。
//! - `options`：一到两个按钮，每个就是用户的一句回复（「提交」「先不提交」）。
//!   有按钮必须有问题。
//!
//! 调用即返回，结果告诉模型"已经展示，这一轮到此为止"。子 agent 用不了
//! （它的收尾是交给父会话的汇报，不是给用户的卡片）。

use async_trait::async_trait;
use serde::Deserialize;

use riot_protocol::permission::{DecisionReason, PermissionContext, PermissionResult};
use riot_protocol::text::UiText;
use riot_protocol::tool::{PromptContext, Tool, ToolContext, ToolOutcome, ValidationError};
use riot_protocol::ui_text;

use super::names::{ASK_USER_QUESTION, NEXT_STEP};

/// 小结、问题、按钮文字各自的上限（字符数）。卡片是一眼扫完的东西，
/// 写成一段话就失去了意义；超了打回让模型压短，比界面上截断强。
pub const RECAP_MAX: usize = 300;
pub const ASK_MAX: usize = 100;
pub const OPTION_MAX: usize = 16;
pub const OPTIONS_MAX: usize = 2;

#[derive(Deserialize, schemars::JsonSchema)]
struct Input {
    /// Two or three short sentences: what is now true, and what is not done or
    /// not verified yet (e.g. "nothing committed"). Plain text, no Markdown.
    recap: String,
    /// One question, only when the next move is the user's decision
    /// (commit or not, which approach, go ahead or not). Omit otherwise.
    #[serde(default)]
    ask: Option<String>,
    /// One or two short answers to `ask`, written as the user's own reply
    /// ("Commit", "Not now"). The first is your recommendation. Requires `ask`.
    #[serde(default)]
    options: Vec<String>,
}

pub struct NextStep;

fn chars(s: &str) -> usize {
    s.chars().count()
}

#[async_trait]
impl Tool for NextStep {
    fn name(&self) -> &str {
        NEXT_STEP
    }

    fn input_schema(&self) -> schemars::Schema {
        schemars::schema_for!(Input)
    }

    fn prompt(&self, _ctx: &PromptContext) -> String {
        format!(
            "Pins a short wrap-up card under your reply when a turn of real work is done: \
             a recap, and — only if the next move is the user's call — one question with \
             one or two answer buttons. Clicking a button sends that answer as the user's \
             message.\n\n\
             ## When to use\n\
             - You changed files, ran things, or finished a multi-step task, and the user \
             should know where it stands (what is done, what is not verified, nothing \
             committed…)\n\
             - Add `ask` + `options` only when a decision is genuinely pending: commit or \
             not, approach A or B, go ahead with the plan or not\n\n\
             ## When NOT to use\n\
             - Answering a question, chatting, or a quick one-line fix: just answer\n\
             - In the middle of a turn, or to make the user choose before you can \
             continue: that is {ASK_USER_QUESTION}\n\
             - To ask \"anything else?\" or offer something the user already declined\n\n\
             ## How\n\
             - Write your full answer first. Call {NEXT_STEP} last, at most once per \
             turn, then stop — write nothing after it\n\
             - recap: at most {RECAP_MAX} characters, plain text, in the user's language; \
             don't repeat it in your answer\n\
             - ask: one question, at most {ASK_MAX} characters, no reasons or option \
             lists in it\n\
             - options: at most {OPTIONS_MAX}, each at most {OPTION_MAX} characters, \
             written as the user's own reply; first one is your recommendation"
        )
    }

    fn describe(&self, input: &serde_json::Value) -> UiText {
        let recap = input.get("recap").and_then(|v| v.as_str()).unwrap_or("");
        ui_text!("tools.nextStep.describe", recap = recap.to_owned())
    }

    /// 主对话里放行（没有副作用面，弹窗只会烦人）；子 agent 里拦下 ——
    /// 它的收尾是交给父会话的汇报，卡片画不到用户眼前。
    fn check_permissions(
        &self,
        _input: &serde_json::Value,
        ctx: &PermissionContext,
    ) -> PermissionResult {
        if !ctx.can_prompt_user {
            return PermissionResult::Deny {
                message: format!(
                    "{NEXT_STEP} is only for the main conversation. Put your summary in \
                     your final report instead."
                ),
                reason: DecisionReason::Preapproved {
                    what: "收尾卡片只在主对话".into(),
                },
            };
        }
        PermissionResult::Allow {
            updated_input: None,
            reason: DecisionReason::Preapproved {
                what: "收尾卡片".into(),
            },
        }
    }

    async fn validate_input(
        &self,
        input: &serde_json::Value,
        _ctx: &ToolContext,
    ) -> Result<(), ValidationError> {
        let input: Input = serde_json::from_value(input.clone())
            .map_err(|e| ValidationError::Rejected(format!("bad input: {e}")))?;
        if input.recap.trim().is_empty() {
            return Err(ValidationError::Rejected("recap is empty".into()));
        }
        if chars(&input.recap) > RECAP_MAX {
            return Err(ValidationError::Rejected(format!(
                "recap is {} characters; keep it to {RECAP_MAX} (two or three short sentences)",
                chars(&input.recap)
            )));
        }
        let ask = input.ask.as_deref().map(str::trim).filter(|a| !a.is_empty());
        if let Some(a) = ask
            && chars(a) > ASK_MAX
        {
            return Err(ValidationError::Rejected(format!(
                "ask is {} characters; keep it to {ASK_MAX}: the question alone",
                chars(a)
            )));
        }
        if !input.options.is_empty() && ask.is_none() {
            return Err(ValidationError::Rejected(
                "options answer a question: add `ask`, or drop the options".into(),
            ));
        }
        if input.options.len() > OPTIONS_MAX {
            return Err(ValidationError::Rejected(format!(
                "at most {OPTIONS_MAX} options"
            )));
        }
        for o in &input.options {
            if o.trim().is_empty() {
                return Err(ValidationError::Rejected("an option is empty".into()));
            }
            if chars(o) > OPTION_MAX {
                return Err(ValidationError::Rejected(format!(
                    "option \"{o}\" is too long; at most {OPTION_MAX} characters, \
                     written as the user's own short reply"
                )));
            }
        }
        Ok(())
    }

    async fn call(&self, _input: serde_json::Value, _ctx: ToolContext) -> ToolOutcome {
        ToolOutcome::Ok {
            model_content: riot_protocol::message::ToolResultContent::text(
                "Shown to the user under your reply. This turn is done: stop here without \
                 writing more.",
            ),
            // 卡片由前端照着工具输入画（见 NextStepCard），结果不另显示。
            ui_payload: None,
            side_messages: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{FixedClock, NullFileState, NullFs, NullProc};
    use riot_protocol::id::{SessionId, ToolUseId};
    use riot_protocol::tool::ProgressSink;
    use serde_json::json;
    use std::sync::Arc;

    fn ctx() -> ToolContext {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let id = ToolUseId::from_raw("t1");
        ToolContext {
            session_id: SessionId::from_raw("s1"),
            tool_use_id: id.clone(),
            cwd: "/w".into(),
            artifacts_dir: "/a".into(),
            cancel: tokio_util::sync::CancellationToken::new(),
            progress: ProgressSink::new(id, tx),
            file_state: Arc::new(NullFileState),
            fs: Arc::new(NullFs),
            proc: Arc::new(NullProc),
            web: Arc::new(riot_protocol::web::NoWeb),
            browser: Arc::new(riot_protocol::browser::NoBrowser),
            terminal: Arc::new(riot_protocol::terminal::NoTerminal),
            jobs: std::sync::Arc::new(riot_protocol::jobs::NoJobs),
            vision: Arc::new(riot_protocol::vision::NoVision),
            clock: Arc::new(FixedClock::default()),
        }
    }

    async fn check(v: serde_json::Value) -> Result<(), String> {
        NextStep
            .validate_input(&v, &ctx())
            .await
            .map_err(|e| e.to_string())
    }

    #[tokio::test]
    async fn 只有小结可以() {
        assert!(check(json!({"recap": "改好了，还没提交。"})).await.is_ok());
    }

    #[tokio::test]
    async fn 问题加两个按钮可以() {
        let v = json!({"recap": "改好了。", "ask": "要提交吗？", "options": ["提交", "先不提交"]});
        assert!(check(v).await.is_ok());
    }

    #[tokio::test]
    async fn 有按钮没问题要打回() {
        let v = json!({"recap": "改好了。", "options": ["提交"]});
        assert!(check(v).await.unwrap_err().contains("ask"));
    }

    #[tokio::test]
    async fn 太长和太多要打回() {
        let long = "字".repeat(RECAP_MAX + 1);
        assert!(check(json!({"recap": long})).await.is_err());
        let v = json!({"recap": "ok", "ask": "?", "options": ["a", "b", "c"]});
        assert!(check(v).await.is_err());
        let v = json!({"recap": "ok", "ask": "?", "options": ["这是一个特别特别特别特别长的按钮文字"]});
        assert!(check(v).await.is_err());
        assert!(check(json!({"recap": "  "})).await.is_err());
    }
}
