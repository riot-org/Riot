//! ReloadConfig 工具：模型改完 `config.json` 后让宿主重新读入。
//!
//! 配置归宿主（设置页、MCP 连接都在那边），宿主只在启动和设置页保存时
//! 读它。模型绕过设置页改了文件，就得显式喊一声 —— 宿主不盯文件，猜
//! 不出什么时候改完了；显式调用还能把"读不懂 / 校验不过 / 哪个 MCP 连
//! 不上"当场交回给模型。
//!
//! 工具清单在开轮时定死，新连上的 MCP 工具这一轮调不到。所以重载出新
//! 工具时，这里把新清单交给会话（[`McpRefresh`]），并让模型收尾：轮末
//! 会话用新清单自动续一轮，用户不用再发一句"继续"。

use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use riot_protocol::hostcall::{HostRequest, HostResponse};
use riot_protocol::text::UiText;
use riot_protocol::tool::{PromptContext, Tool, ToolContext, ToolOutcome};
use riot_protocol::ui_text;
use serde::Deserialize;

use crate::bridge::HostBridge;
use crate::session::McpRefresh;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct NoInput {}

pub struct ReloadConfigTool {
    bridge: Arc<HostBridge>,
    mcp: Arc<riot_mcp::McpHub>,
    /// 开轮时已经在工具清单里的 MCP 工具名。重载后多出来的才算"新"。
    known: HashSet<String>,
    refresh: McpRefresh,
}

impl ReloadConfigTool {
    pub fn new(
        bridge: Arc<HostBridge>,
        mcp: Arc<riot_mcp::McpHub>,
        known: HashSet<String>,
        refresh: McpRefresh,
    ) -> Self {
        Self {
            bridge,
            mcp,
            known,
            refresh,
        }
    }

    /// 重载后 hub 里有本轮清单之外的工具吗。有就交给会话续轮，回一句
    /// 给模型的收尾说明；没有回 None。
    async fn hand_over_new_tools(&self) -> Option<String> {
        let fresh = self.mcp.tools().await;
        let new = fresh
            .iter()
            .filter(|t| !self.known.contains(t.name()))
            .count();
        if new == 0 {
            return None;
        }
        *self.refresh.lock().unwrap_or_else(|e| e.into_inner()) = Some(fresh);
        Some(format!(
            "\n\n新连上了 {new} 个 MCP 工具，但工具清单在每轮开始时固定，本轮调不到它们\
             （ToolSearch 也找不到）。不要改用浏览器、网页搜索等别的途径绕过：用一句话\
             告诉用户配置已生效、马上继续，然后直接结束本轮回复，不要再调用工具。\
             本轮结束后 Riot 会自动开启新一轮，届时这些工具可用，接着做原来的任务。"
        ))
    }
}

#[async_trait]
impl Tool for ReloadConfigTool {
    fn name(&self) -> &'static str {
        "ReloadConfig"
    }

    fn input_schema(&self) -> schemars::Schema {
        schemars::schema_for!(NoInput)
    }

    fn prompt(&self, _ctx: &PromptContext) -> String {
        "你直接改了 Riot 的 config.json（比如 mcpServers）之后调用：让应用重新读入、\
         连接 MCP 服务器，返回每个服务器的连接结果。不调的话改动要等用户重启应用\
         才生效，而且用户下次在设置页保存时会被旧配置覆盖。\
         读不懂或校验不过的文件不会被采纳，结果里会说原因，改好再调一次。\
         也可以用来重连失败的 MCP 服务器。技能、命令、hooks、AGENTS.md 不用它。"
            .to_owned()
    }

    fn describe(&self, _input: &serde_json::Value) -> UiText {
        ui_text!("tools.reloadConfig")
    }

    async fn call(&self, _input: serde_json::Value, _ctx: ToolContext) -> ToolOutcome {
        match self.bridge.call(HostRequest::ConfigReload).await {
            Ok(HostResponse::Text { mut text }) => {
                if let Some(note) = self.hand_over_new_tools().await {
                    text.push_str(&note);
                }
                ToolOutcome::ok_text(text)
            }
            Ok(HostResponse::Error { message, .. }) => ToolOutcome::failed(message),
            Ok(other) => ToolOutcome::failed(format!("unexpected host response: {other:?}")),
            Err(e) => ToolOutcome::failed(format!("应用没有响应：{e}")),
        }
    }
}
