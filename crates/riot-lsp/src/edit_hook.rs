//! 改完文件，顺手把新的错误告诉模型。
//!
//! [`WithDiagnostics`] 包在 Edit / Write 外面：名字、描述、权限、校验全部
//! 原样转给里面的工具，只在成功之后多做一件事 —— 如果这个文件所属项目
//! 的语言服务器**已经在跑而且就绪**，把文件同步过去、等一小会儿诊断，
//! 有错误就附在结果末尾。
//!
//! `[约束]` 只用已经在跑的服务器，绝不在这里拉起新的。理由三条：
//! 1. 拉起服务器要权限确认（见 [`crate::tool`]），Edit 的确认不包含它；
//! 2. rust-analyzer 冷启动几十秒，不能让每次 Edit 都等；
//! 3. 黄金回放和内核测试里没有服务器在跑 —— 那时这个包装器必须和
//!    里面的工具逐字节一致。
//!
//! 没有错误就什么都不加：成功的编辑结果保持原样，不制造噪音。

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use riot_protocol::message::ToolResultContent;
use riot_protocol::permission::{PermissionContext, PermissionResult};
use riot_protocol::text::UiText;
use riot_protocol::tool::{
    InterruptBehavior, PromptContext, ResultBudget, Tool, ToolContext, ToolOutcome, ValidationError,
};
use serde_json::Value;

use crate::render::{self, Lines};
use crate::servers::{Language, find_root};
use crate::{LspHub, strip_verbatim};

/// 编辑后等诊断的上限。比 Lsp 工具短：这是顺带的，不能拖慢每次编辑。
const EDIT_DIAG_WAIT: Duration = Duration::from_secs(3);

/// 最多附几条。再多说明改坏了一大片，模型应该自己去跑 Diagnostics。
const MAX_EDIT_ERRORS: usize = 10;

pub struct WithDiagnostics {
    inner: Arc<dyn Tool>,
    hub: Arc<LspHub>,
}

impl WithDiagnostics {
    pub fn wrap(inner: Arc<dyn Tool>, hub: Arc<LspHub>) -> Arc<dyn Tool> {
        Arc::new(Self { inner, hub })
    }

    async fn errors_after(
        &self,
        path: PathBuf,
        ctx: &ToolContext,
        before: Snapshot,
    ) -> Option<String> {
        let Snapshot::Ready { client, generation } = before else {
            return None;
        };
        if !client.sync_file(&path).await.ok()? {
            return None;
        }
        let items = client
            .wait_diagnostics(&path, generation, EDIT_DIAG_WAIT)
            .await?;
        let errors: Vec<_> = items.into_iter().filter(|d| d.severity == 1).collect();
        if errors.is_empty() {
            return None;
        }
        let mut lines = Lines::default();
        let shown: Vec<_> = errors.iter().take(MAX_EDIT_ERRORS).cloned().collect();
        let list = render::diagnostics(&path, &shown, &ctx.cwd, client.encoding(), &mut lines, 1);
        let more = if errors.len() > MAX_EDIT_ERRORS {
            format!("\n… {} more errors.", errors.len() - MAX_EDIT_ERRORS)
        } else {
            String::new()
        };
        Some(format!(
            "\n\n<lsp-diagnostics server=\"{}\">\nAfter this change the language server reports \
             errors in this file (some may predate the edit):\n{}{more}\nStatic analysis only — \
             fix what you introduced, and confirm with the real build.\n</lsp-diagnostics>",
            client.lang.server_name(),
            list.trim_end()
        ))
    }
}

enum Snapshot {
    None,
    Ready {
        client: Arc<crate::client::Client>,
        generation: u64,
    },
}

#[async_trait]
impl Tool for WithDiagnostics {
    fn name(&self) -> &str {
        self.inner.name()
    }
    fn input_schema(&self) -> schemars::Schema {
        self.inner.input_schema()
    }
    fn prompt(&self, ctx: &PromptContext) -> String {
        self.inner.prompt(ctx)
    }
    fn describe(&self, input: &Value) -> UiText {
        self.inner.describe(input)
    }
    fn is_read_only(&self, input: &Value) -> bool {
        self.inner.is_read_only(input)
    }
    fn is_concurrency_safe(&self, input: &Value) -> bool {
        self.inner.is_concurrency_safe(input)
    }
    fn is_destructive(&self, input: &Value) -> bool {
        self.inner.is_destructive(input)
    }
    fn interrupt_behavior(&self) -> InterruptBehavior {
        self.inner.interrupt_behavior()
    }
    fn cascades_on_failure(&self) -> bool {
        self.inner.cascades_on_failure()
    }
    fn result_budget(&self) -> ResultBudget {
        self.inner.result_budget()
    }
    fn check_permissions(&self, input: &Value, ctx: &PermissionContext) -> PermissionResult {
        self.inner.check_permissions(input, ctx)
    }
    async fn validate_input(
        &self,
        input: &Value,
        ctx: &ToolContext,
    ) -> Result<(), ValidationError> {
        self.inner.validate_input(input, ctx).await
    }
    fn classifier_input(&self, input: &Value) -> Option<String> {
        self.inner.classifier_input(input)
    }
    fn target_path(&self, input: &Value) -> Option<PathBuf> {
        self.inner.target_path(input)
    }
    fn should_defer(&self) -> bool {
        self.inner.should_defer()
    }
    fn user_facing_name(&self) -> &str {
        self.inner.user_facing_name()
    }
    fn agent_label(&self) -> Option<&str> {
        self.inner.agent_label()
    }
    fn aliases(&self) -> &[&'static str] {
        self.inner.aliases()
    }

    async fn call(&self, input: Value, ctx: ToolContext) -> ToolOutcome {
        // 编辑之前先记下诊断代数：等的是"比这次编辑新"的那一批。
        let target = self
            .inner
            .target_path(&input)
            .map(|p| if p.is_absolute() { p } else { ctx.cwd.join(p) });
        let mut snapshot = Snapshot::None;
        let mut resolved = None;
        if let Some(p) = target
            && let Some(lang) = Language::for_path(&p)
        {
            let parent = p
                .parent()
                .map(|d| d.to_path_buf())
                .unwrap_or_else(|| ctx.cwd.clone());
            // 文件可能还不存在（Write 新建）：用父目录定位项目根。
            let dir = strip_verbatim(ctx.fs.canonicalize(&parent).await.unwrap_or(parent));
            let file = p.file_name().map(|n| dir.join(n));
            let root = strip_verbatim(
                ctx.fs
                    .canonicalize(&find_root(lang, &dir, &ctx.cwd))
                    .await
                    .unwrap_or_else(|_| ctx.cwd.clone()),
            );
            if let Some(client) = self.hub.running(lang, &root).await
                && client.is_ready()
                && let Some(file) = file
            {
                snapshot = Snapshot::Ready {
                    generation: client.diag_generation(&file),
                    client,
                };
                resolved = Some(file);
            }
        }

        let outcome = self.inner.call(input, ctx.clone()).await;
        let (
            Some(path),
            ToolOutcome::Ok {
                model_content: ToolResultContent::Text { .. },
                ..
            },
        ) = (resolved, &outcome)
        else {
            return outcome;
        };
        let extra = self.errors_after(path, &ctx, snapshot).await;
        match (outcome, extra) {
            (
                ToolOutcome::Ok {
                    model_content: ToolResultContent::Text { text },
                    ui_payload,
                    side_messages,
                },
                Some(extra),
            ) => ToolOutcome::Ok {
                model_content: ToolResultContent::Text {
                    text: format!("{text}{extra}"),
                },
                ui_payload,
                side_messages,
            },
            (o, _) => o,
        }
    }
}
