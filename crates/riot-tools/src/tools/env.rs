//! `RequestEnv`：请用户提供几个环境变量（API key、密码、令牌……）。
//!
//! # 为什么要有这个工具
//!
//! 没有它的时候，模型需要一把 key 只能在回复里说"请把 key 发给我"，用户
//! 照做 —— key 于是进了对话、进了 transcript、进了每一轮发给模型服务的
//! 上下文。这些值本来就不该经过模型：脚本要的只是进程环境里有它。
//!
//! # 它怎么工作
//!
//! 和 `AskUserQuestion` 一样走权限的 ask 通道，界面渲染成对话里的一张表单
//! （[`AskPreview::EnvVars`]）。用户填的值由表单**直接**存进设置（宿主的
//! `env_var_set`，落 auth.json），再由进程执行器注入每一条命令；ask 通道
//! 上回来的只有存好的名字（[`CHOSEN_KEY`]）。所以模型从头到尾只见过变量名。
//!
//! 要的变量都已经配好时不出卡片，直接放行 —— 让模型先查一遍再决定问不问
//! 的话，它得 `echo $KEY` 去查，那正是这个工具要避免的事。
//!
//! [`AskPreview::EnvVars`]: riot_protocol::permission::AskPreview::EnvVars

use async_trait::async_trait;
use riot_protocol::permission::{DecisionReason, EnvVarAsk, PermissionContext, PermissionResult};
use riot_protocol::text::UiText;
use riot_protocol::tool::{
    PromptContext, ResultBudget, Tool, ToolContext, ToolOutcome, UiPayload, ValidationError,
};
use riot_protocol::ui_text;
use serde::Deserialize;

use super::ask::CHOSEN_KEY;
use super::names::{BASH, REQUEST_ENV};

/// 一张表单最多几个变量。再多就不是"这个任务要一把 key"了，该让用户
/// 自己去设置页一次配好。
const MAX_VARS: usize = 8;

#[derive(Deserialize, schemars::JsonSchema)]
struct Input {
    /// 为什么需要这些变量，一句话（"调用 MOSS 语音合成接口需要 API key"）。
    /// 原文显示在表单顶上。
    reason: String,
    /// 要用户提供的变量，1 到 8 个。
    vars: Vec<InputVar>,
}

#[derive(Deserialize, schemars::JsonSchema)]
struct InputVar {
    /// 变量名，大写加下划线，例如 `MOSS_API_KEY`。命令里用 `$MOSS_API_KEY` 引用。
    name: String,
    /// 这个值是什么、去哪里拿。显示在输入框上方。
    #[serde(default)]
    description: String,
    /// 获取这个值的网页（控制台的 API key 页面）。没有就不填。
    #[serde(default)]
    link: Option<String>,
}

pub struct RequestEnv;

fn parse(input: &serde_json::Value) -> Option<Input> {
    serde_json::from_value(input.clone()).ok()
}

/// 名字合法：字母或下划线开头，后面字母、数字、下划线 —— shell 里能
/// 用 `$NAME` 引用的那种。和宿主 `config::valid_env_name` 同一条规则。
fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// 拆成表单的样子，供宿主渲染。放在这里而不是宿主里：字段名是这个工具的
/// 输入契约（理由同 `ask::preview_parts`）。
pub fn preview_parts(input: &serde_json::Value) -> Option<(String, Vec<EnvVarAsk>)> {
    let parsed = parse(input)?;
    Some((
        parsed.reason,
        parsed
            .vars
            .into_iter()
            .map(|v| EnvVarAsk {
                set: crate::user_env::is_set(&v.name),
                name: v.name,
                description: v.description,
                link: v
                    .link
                    .filter(|l| l.starts_with("https://") || l.starts_with("http://")),
            })
            .collect(),
    ))
}

/// 宿主回灌的、用户实际填好（或沿用已有值）的变量名。
fn saved(input: &serde_json::Value) -> Vec<String> {
    input
        .get(CHOSEN_KEY)
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

#[async_trait]
impl Tool for RequestEnv {
    fn name(&self) -> &str {
        REQUEST_ENV
    }

    fn input_schema(&self) -> schemars::Schema {
        schemars::schema_for!(Input)
    }

    fn prompt(&self, _ctx: &PromptContext) -> String {
        format!(
            "Ask the user for environment variables a task needs — API keys, passwords, tokens, \
             account IDs, anything secret or personal. The conversation shows the user a form; \
             what they type is saved to Riot's Settings → Environment Variables and injected \
             into every command you run from then on (including the next one in this turn). \
             You never see the values: reference them as `$NAME` in {BASH} commands and scripts, \
             and read them from the environment in code (`os.environ[\"NAME\"]`).\n\n\
             Use this instead of asking in chat. NEVER ask the user to paste a key, password or \
             token into the conversation, and never write one into a file yourself.\n\n\
             Call it when you are about to need the value, not before. If every variable you ask \
             for is already configured the call returns at once without bothering the user, so \
             you do not need to check first — and do not try to check with `echo $NAME`.\n\n\
             Name variables the way the service's docs do (`OPENAI_API_KEY`), uppercase with \
             underscores. In `description`, say what the value is and where to get it; put the \
             page that issues it in `link`.\n\n\
             Command output that contains a configured value reaches you as \
             `[已遮蔽：$NAME]` — that is expected, the command did see the real value."
        )
    }

    fn describe(&self, input: &serde_json::Value) -> UiText {
        let names = parse(input)
            .map(|p| {
                p.vars
                    .into_iter()
                    .map(|v| v.name)
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default();
        ui_text!("tools.env.request", names = names)
    }

    /// 只是出一张表单，不碰任何东西。
    fn is_read_only(&self, _input: &serde_json::Value) -> bool {
        true
    }

    /// 两张表单叠在对话末尾，用户填完第一张才看得见第二张。
    fn is_concurrency_safe(&self, _input: &serde_json::Value) -> bool {
        false
    }

    fn result_budget(&self) -> ResultBudget {
        ResultBudget::Unlimited
    }

    /// 要的都配好了就放行，否则出表单。
    ///
    /// `[约束]` 出表单时理由必须是 [`DecisionReason::UserChoice`]（和
    /// `AskUserQuestion` 同一个暗号）：换成别的，「全部放行」/ 无人值守
    /// 会把表单收敛成自动放行，用户看不到它，模型收到一个空答案。
    fn check_permissions(
        &self,
        input: &serde_json::Value,
        _ctx: &PermissionContext,
    ) -> PermissionResult {
        let all_set = parse(input).is_some_and(|p| {
            !p.vars.is_empty() && p.vars.iter().all(|v| crate::user_env::is_set(&v.name))
        });
        if all_set {
            return PermissionResult::Allow {
                updated_input: None,
                reason: DecisionReason::Preapproved {
                    what: "要的环境变量都已配置".into(),
                },
            };
        }
        PermissionResult::Ask {
            message: ui_text!("tools.env.decision"),
            suggestions: Vec::new(),
            reason: DecisionReason::UserChoice { remembered: false },
        }
    }

    async fn validate_input(
        &self,
        input: &serde_json::Value,
        _ctx: &ToolContext,
    ) -> Result<(), ValidationError> {
        let parsed = parse(input).ok_or_else(|| {
            ValidationError::rejected("参数不对：要有 reason 和 vars（每项至少有 name）。")
        })?;
        if parsed.reason.trim().is_empty() {
            return Err(ValidationError::rejected(
                "reason 是空的 —— 用一句话告诉用户为什么需要这些变量。",
            ));
        }
        if parsed.vars.is_empty() || parsed.vars.len() > MAX_VARS {
            return Err(ValidationError::rejected(format!(
                "vars 要有 1 到 {MAX_VARS} 个，现在有 {}。",
                parsed.vars.len()
            )));
        }
        let mut seen = std::collections::HashSet::new();
        for v in &parsed.vars {
            if !valid_name(&v.name) {
                return Err(ValidationError::rejected(format!(
                    "变量名「{}」不合法：只能用字母、数字、下划线，且不能以数字开头。",
                    v.name
                )));
            }
            if !seen.insert(v.name.as_str()) {
                return Err(ValidationError::rejected(format!(
                    "变量「{}」重复了。",
                    v.name
                )));
            }
        }
        Ok(())
    }

    async fn call(&self, input: serde_json::Value, _ctx: ToolContext) -> ToolOutcome {
        let Some(parsed) = parse(&input) else {
            return ToolOutcome::failed("参数解析不了，重新组织一下 reason 和 vars。");
        };
        let asked: Vec<String> = parsed.vars.into_iter().map(|v| v.name).collect();
        // 放行有两条路：用户填了表单（名字从 CHOSEN_KEY 回来），或者要的
        // 本来就全配好了（没出表单）。以表为准再核一遍 —— 表单上留空的
        // 变量不会被写进设置。
        let mut ready: Vec<&str> = Vec::new();
        let mut missing: Vec<&str> = Vec::new();
        let filled = saved(&input);
        for name in &asked {
            if crate::user_env::is_set(name) || filled.iter().any(|f| f == name) {
                ready.push(name);
            } else {
                missing.push(name);
            }
        }

        let refs = ready
            .iter()
            .map(|n| format!("${n}"))
            .collect::<Vec<_>>()
            .join("、");
        let mut text = if ready.is_empty() {
            "用户没有填写任何变量。".to_owned()
        } else {
            format!(
                "已配置：{refs}。之后的每条命令都带着这些环境变量（包括这一轮接下来的），\
                 在命令和脚本里直接引用即可。值对你不可见，输出里出现会被遮蔽成 [已遮蔽：$NAME]。"
            )
        };
        if !missing.is_empty() {
            text.push_str(&format!(
                "\n还没配置：{}。用户这次没有填，不要立刻再问；需要它的那一步先别做，\
                 在回复里说明缺什么、去哪里拿，等用户配好。",
                missing.join("、")
            ));
        }

        ToolOutcome::Ok {
            model_content: riot_protocol::message::ToolResultContent::text(text),
            ui_payload: Some(UiPayload::Message {
                text: if missing.is_empty() {
                    ui_text!("tools.env.ready", names = ready.join(", "))
                } else {
                    ui_text!(
                        "tools.env.partial",
                        names = ready.join(", "),
                        missing = missing.join(", ")
                    )
                },
            }),
            side_messages: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use riot_protocol::id::{SessionId, ToolUseId};
    use riot_protocol::message::ToolResultContent;
    use serde_json::json;
    use tokio_util::sync::CancellationToken;

    /// 不碰 fs / proc / 网络，注入项全给占位（照抄 ask.rs）。
    fn tctx() -> ToolContext {
        let id = ToolUseId::from_raw("t1");
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        ToolContext {
            session_id: SessionId::from_raw("s1"),
            tool_use_id: id.clone(),
            cwd: "/work".into(),
            artifacts_dir: "/artifacts".into(),
            cancel: CancellationToken::new(),
            progress: riot_protocol::tool::ProgressSink::new(id, tx),
            file_state: Arc::new(crate::tools::memfs::MemFileState::new()),
            fs: Arc::new(crate::tools::memfs::MemFs::new()),
            proc: Arc::new(crate::testing::NullProc),
            web: Arc::new(riot_protocol::web::NoWeb),
            browser: Arc::new(riot_protocol::browser::NoBrowser),
            terminal: Arc::new(riot_protocol::terminal::NoTerminal),
            jobs: std::sync::Arc::new(riot_protocol::jobs::NoJobs),
            vision: Arc::new(riot_protocol::vision::NoVision),
            clock: Arc::new(crate::testing::FixedClock::default()),
        }
    }

    fn input() -> serde_json::Value {
        json!({
            "reason": "调用 MOSS 语音合成需要 API key",
            "vars": [
                { "name": "MOSS_API_KEY", "description": "控制台的 API key", "link": "https://platform.mosi.cn" },
                { "name": "MOSS_GROUP", "description": "组 ID" },
            ]
        })
    }

    fn pctx() -> PermissionContext {
        PermissionContext::default()
    }

    #[test]
    fn 没配齐就出表单_配齐了直接放行() {
        let _g = crate::user_env::test_lock();
        crate::user_env::set(vec![("MOSS_API_KEY".into(), "sk-moss-123456".into())]);
        assert!(matches!(
            RequestEnv.check_permissions(&input(), &pctx()),
            PermissionResult::Ask {
                reason: DecisionReason::UserChoice { .. },
                ..
            }
        ));
        let (_, vars) = preview_parts(&input()).unwrap();
        assert_eq!(
            vars.iter()
                .map(|v| (v.name.as_str(), v.set))
                .collect::<Vec<_>>(),
            [("MOSS_API_KEY", true), ("MOSS_GROUP", false)]
        );

        crate::user_env::set(vec![
            ("MOSS_API_KEY".into(), "sk-moss-123456".into()),
            ("MOSS_GROUP".into(), "g-1".into()),
        ]);
        assert!(matches!(
            RequestEnv.check_permissions(&input(), &pctx()),
            PermissionResult::Allow { .. }
        ));
        crate::user_env::set(Vec::new());
    }

    /// 同步测试：要拿 user_env 的测试锁，而那把锁不能跨 await 持有。
    #[test]
    fn 结果只有名字_没填的说清楚() {
        let _g = crate::user_env::test_lock();
        crate::user_env::set(Vec::new());
        let mut i = input();
        i[CHOSEN_KEY] = json!(["MOSS_API_KEY"]);
        let out = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("建运行时")
            .block_on(RequestEnv.call(i, tctx()));
        let ToolOutcome::Ok {
            model_content: ToolResultContent::Text { text },
            ..
        } = out
        else {
            panic!("该成功：{out:?}")
        };
        assert!(text.contains("$MOSS_API_KEY"), "{text}");
        assert!(text.contains("还没配置：MOSS_GROUP"), "{text}");
    }

    #[tokio::test]
    async fn 名字不合法或重复要拦() {
        let ctx = tctx();
        let bad = json!({ "reason": "x", "vars": [{ "name": "MOSS-KEY" }] });
        assert!(RequestEnv.validate_input(&bad, &ctx).await.is_err());
        let dup = json!({ "reason": "x", "vars": [{ "name": "A" }, { "name": "A" }] });
        assert!(RequestEnv.validate_input(&dup, &ctx).await.is_err());
        assert!(RequestEnv.validate_input(&input(), &ctx).await.is_ok());
    }
}
