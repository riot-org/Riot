import { useState } from "react";

import {
  envVarSet,
  openInBrowser,
  type PermissionAsk,
  type PermissionMode,
  type PermissionResponse,
  renderUiText,
} from "../bridge";
import { useImeGuard } from "../hooks/useImeGuard";
import { useT } from "../i18n";
import { Markdown } from "./Markdown";
import { MODE_LABEL_KEY } from "./pickers";

/**
 * 权限确认（Bash、写文件、删文件、联网……）。长在对话流末尾，不弹窗。
 *
 * 照 Claude Code：权限请求是对话里的一步，不是盖住界面的系统对话框。
 * 回合停在等用户决定时（见内核 riot_protocol::suspend）会话是空闲的，
 * 卡片能挂很久、重启后还在 —— 一层遮罩挡住的正是"模型为什么要跑这条
 * 命令"的上下文。
 *
 * `[约束]` 必须显示**将要执行的原文** —— 完整命令、完整路径、完整 diff。
 * 显示摘要等于让用户盲签：他点"允许"时以为批准的是摘要里那件事。
 *
 * 不抢焦点：焦点多半在输入框，回车属于输入框，一个习惯性的回车不该
 * 批准任何东西。焦点在卡片里时 Esc 等于拒绝（键盘用户的捷径）。
 */
export function PermissionCard({
  ask,
  onAnswer,
}: {
  ask: PermissionAsk;
  onAnswer: (r: PermissionResponse) => void;
}) {
  const { t } = useT();
  // 答过一次就锁死所有按钮 —— IPC 慢时连点会重复提交同一个决定。
  const [answered, setAnswered] = useState(false);

  const answer = (r: PermissionResponse) => {
    if (answered) return;
    setAnswered(true);
    onAnswer(r);
  };

  // 内核给出了"可以记住"的规则建议时才显示"总是允许"。没有建议
  // 却显示这个按钮，等于许诺一个不会兑现的行为。
  const rememberable = ask.suggestions.filter((s) => s.type === "add_rule");
  const rules = rememberable
    .map((s) => `${s.tool}${s.pattern ? `(${s.pattern})` : ""}`)
    .join(t("transcript.listSep"));

  return (
    <div
      className="plan-card perm-card"
      role="region"
      aria-label={t("transcript.permission.title")}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          answer({ decision: "deny" });
        }
      }}
    >
      <div className="plan-card-head">
        <span className="plan-card-badge">{t("transcript.permission.badge")}</span>
        <span className="modal-tool">{ask.tool_name}</span>
        <span className="plan-card-title">
          {ask.agent_label
            ? t("transcript.permission.fromTask", { label: ask.agent_label, summary: renderUiText(ask.summary) })
            : renderUiText(ask.summary)}
        </span>
      </div>

      <Preview preview={ask.preview} />

      <div className="plan-card-actions">
        <button className="btn-deny" disabled={answered} onClick={() => answer({ decision: "deny" })}>
          {t("transcript.permission.deny")}
        </button>
        {/* 把危险的"总是允许"（写永久规则）推到左侧、降成弱按钮，和
            右下角的主操作"允许一次"拉开距离 —— 相邻且等重时误点一下
            就是持久放权。 */}
        <span className="plan-card-spacer" />
        {rememberable.length > 0 ? (
          <button
            className="btn-allow-always"
            title={t("transcript.permission.alwaysTitle", { rules })}
            disabled={answered}
            onClick={() => answer({ decision: "allow", remember: rememberable })}
          >
            {t("transcript.permission.always")}
            <span className="allow-always-sub">{t("transcript.permission.alwaysSub", { rules })}</span>
          </button>
        ) : null}
        <button className="btn-allow" disabled={answered} onClick={() => answer({ decision: "allow" })}>
          {t("transcript.permission.once")}
        </button>
      </div>
    </div>
  );
}

/**
 * 与 `ask.rs` 的 `OTHER_PREFIX` 对齐。用户点「其他」自己填写时，这段话
 * 编进 `choice` 数组；工具侧剥掉前缀再送给模型。改一边必须改另一边。
 */
const OTHER_PREFIX = "__other:";

/**
 * 模型主动提问（AskUserQuestion）。长在对话流里，不弹窗。
 *
 * 选择题不是危险操作，糊一层遮罩会把正在读的对话挡掉，也打断输入。
 * 交互对齐 Cursor：现成选项点一下就交；「其他」展开输入框，用户自己写。
 *
 * 不绑 Esc、不抢焦点 —— 那是权限弹窗的规矩。这张卡跟在工具卡后面，
 * 用户可能还想回头看上面的上下文，焦点留在输入框更合适。
 */
export function AskChoiceCard({
  ask,
  onAnswer,
}: {
  ask: PermissionAsk;
  onAnswer: (r: PermissionResponse) => void;
}) {
  const { t } = useT();
  const q = ask.preview.kind === "choice" ? ask.preview : null;
  const [picked, setPicked] = useState<string[]>([]);
  const [otherOn, setOtherOn] = useState(false);
  const [other, setOther] = useState("");
  const [answered, setAnswered] = useState(false);
  const ime = useImeGuard();

  if (!q) return null;

  const submit = (ids: string[], includeOther: boolean) => {
    if (answered) return;
    const choice = [...ids];
    if (includeOther) {
      const custom = other.trim();
      if (custom) choice.push(`${OTHER_PREFIX}${custom}`);
    }
    if (choice.length === 0) return;
    setAnswered(true);
    // 输入内容到提交才算用完 —— 收起「其他」时清掉会把半段话静默丢弃
    setOther("");
    onAnswer({ decision: "allow", choice });
  };

  const deny = () => {
    if (answered) return;
    setAnswered(true);
    onAnswer({ decision: "deny" });
  };

  const toggle = (id: string) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const canSubmit = picked.length > 0 || other.trim().length > 0;
  const needConfirm = q.allow_multiple || otherOn;

  return (
    <div className="plan-card ask-card" role="region" aria-label={t("transcript.ask.ariaLabel")}>
      <div className="plan-card-head">
        <span className="plan-card-badge">{t("transcript.ask.badge")}</span>
        <span className="plan-card-title">{q.question}</span>
      </div>

      <div className="choice-list ask-choices">
        {q.options.map((o) => (
          <button
            key={o.id}
            type="button"
            className={q.allow_multiple && picked.includes(o.id) ? "choice-opt on" : "choice-opt"}
            disabled={answered}
            onClick={() => (q.allow_multiple ? toggle(o.id) : submit([o.id], false))}
          >
            {o.label}
          </button>
        ))}
        <button
          type="button"
          className={otherOn ? "choice-opt on choice-opt-other" : "choice-opt choice-opt-other"}
          disabled={answered}
          onClick={() => setOtherOn((v) => !v)}
        >
          {t("transcript.ask.other")}
        </button>
      </div>

      {otherOn ? (
        <textarea
          className="plan-feedback"
          value={other}
          onChange={(e) => setOther(e.target.value)}
          onCompositionStart={ime.onCompositionStart}
          onCompositionEnd={ime.onCompositionEnd}
          onKeyDown={(e) => {
            // 组字中的回车是确认候选词，不是提交。
            if (e.key === "Enter" && !e.shiftKey && !ime.isComposing(e)) {
              e.preventDefault();
              if (canSubmit) submit(q.allow_multiple ? picked : [], true);
            }
          }}
          placeholder={t("transcript.ask.otherPlaceholder")}
          rows={2}
          spellCheck={false}
          autoFocus
        />
      ) : null}

      <div className="plan-card-actions">
        <button className="btn-deny" disabled={answered} onClick={deny}>
          {t("transcript.ask.skip")}
        </button>
        <span className="plan-card-spacer" />
        {needConfirm ? (
          <button
            className="btn-allow"
            disabled={answered || !canSubmit}
            onClick={() => submit(q.allow_multiple ? picked : [], true)}
          >
            {t("common.ok")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 模型要几个环境变量（RequestEnv 工具）：API key、密码这类不该进对话的值。
 * 长在对话流里，和选择题卡同一个壳。
 *
 * `[约束]` 值**不走** `onAnswer`。每个填了的变量先经 `envVarSet` 直接存进
 * 设置（宿主写 auth.json，内核随即拿到、注入命令），回答里只带存好的
 * 名字 —— 走 ask 通道的话值会进工具输入，进而进 transcript 和模型上下文。
 *
 * 已经配过的变量显示「已配置」，留空就沿用；填了就覆盖。
 */
export function EnvVarsCard({
  ask,
  onAnswer,
}: {
  ask: PermissionAsk;
  onAnswer: (r: PermissionResponse) => void;
}) {
  const { t } = useT();
  const form = ask.preview.kind === "env_vars" ? ask.preview : null;
  const [values, setValues] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [answered, setAnswered] = useState(false);
  const [error, setError] = useState("");

  if (!form) return null;

  // 能提交：每个还没配过的变量都填了。已配过的可以留空沿用。
  const ready = form.vars.every((v) => v.set || (values[v.name] ?? "").trim() !== "");

  const submit = async () => {
    if (answered || saving || !ready) return;
    setSaving(true);
    setError("");
    try {
      for (const v of form.vars) {
        const value = (values[v.name] ?? "").trim();
        if (value) await envVarSet(v.name, value);
      }
    } catch (e) {
      setError(String(e));
      setSaving(false);
      return;
    }
    setAnswered(true);
    setSaving(false);
    // 值在宿主那边了，这里不再留着。
    setValues({});
    onAnswer({ decision: "allow", choice: form.vars.map((v) => v.name) });
  };

  const skip = () => {
    if (answered || saving) return;
    setAnswered(true);
    setValues({});
    onAnswer({ decision: "deny" });
  };

  const busy = answered || saving;

  return (
    <div className="plan-card ask-card env-card" role="region" aria-label={t("transcript.env.ariaLabel")}>
      <div className="plan-card-head">
        <span className="plan-card-badge">{t("transcript.env.badge")}</span>
        <span className="plan-card-title">{form.reason}</span>
      </div>

      <div className="env-card-fields">
        {form.vars.map((v, i) => (
          <label className="env-card-field" key={v.name}>
            <span className="env-card-label">
              <code className="env-card-name">{v.name}</code>
              {v.set ? <span className="env-card-set">{t("transcript.env.alreadySet")}</span> : null}
              {v.link ? (
                <button
                  type="button"
                  className="env-card-link"
                  onClick={(e) => {
                    e.preventDefault();
                    void openInBrowser(v.link!);
                  }}
                >
                  {t("transcript.env.getIt")}
                </button>
              ) : null}
            </span>
            {v.description ? <span className="env-card-desc">{v.description}</span> : null}
            <span className="env-card-input">
              <input
                type={shown[v.name] ? "text" : "password"}
                value={values[v.name] ?? ""}
                onChange={(e) => setValues((s) => ({ ...s, [v.name]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void submit();
                  }
                }}
                placeholder={v.set ? t("transcript.env.keepPlaceholder") : t("transcript.env.placeholder")}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                // 第一个空着的框拿焦点：卡片冒出来就能直接粘贴。
                autoFocus={i === form.vars.findIndex((x) => !x.set)}
              />
              <button
                type="button"
                className="env-card-eye"
                onClick={(e) => {
                  e.preventDefault();
                  setShown((s) => ({ ...s, [v.name]: !s[v.name] }));
                }}
                aria-label={shown[v.name] ? t("transcript.env.hide") : t("transcript.env.show")}
                title={shown[v.name] ? t("transcript.env.hide") : t("transcript.env.show")}
                disabled={busy}
              >
                {shown[v.name] ? t("transcript.env.hide") : t("transcript.env.show")}
              </button>
            </span>
          </label>
        ))}
      </div>

      <p className="env-card-note">{t("transcript.env.note")}</p>
      {error ? <p className="env-card-error">{error}</p> : null}

      <div className="plan-card-actions">
        <button className="btn-deny" disabled={busy} onClick={skip}>
          {t("transcript.ask.skip")}
        </button>
        <span className="plan-card-spacer" />
        <button className="btn-allow" disabled={busy || !ready} onClick={() => void submit()}>
          {saving ? t("transcript.env.saving") : t("transcript.env.save")}
        </button>
      </div>
    </div>
  );
}

/**
 * 模型建议换工作方式（SwitchMode 工具）。长在对话流里，不弹窗（Cursor 同款）。
 *
 * 两个方向：agent → plan（"这活改动面大，先定方案"）和 plan → agent
 * （用户在聊天里说"开始做吧"，模型请他确认）。卡上放模型给的理由原文，
 * 用户看着理由决定；「切换」把 set_mode 一并交回宿主 —— 同一轮内立即
 * 生效，模型的下一个工具调用已经按新模式判定。
 *
 * 切回 agent 用的是**进规划前那一档**（`execMode`），不是内核建议里的
 * 兜底值：用户开着「编辑放行」进的规划，出来不该变成逐步确认。
 *
 * 不绑 Esc、不抢焦点 —— 那是权限弹窗的规矩。这张卡不是危险操作，用户
 * 可能还想回头看上面的上下文。
 */
export function ModeSwitchCard({
  ask,
  execMode,
  onAnswer,
}: {
  ask: PermissionAsk;
  /** 这个会话进规划前用的权限档，切回 agent 时落成它。 */
  execMode: PermissionMode;
  onAnswer: (r: PermissionResponse) => void;
}) {
  const { t } = useT();
  const [answered, setAnswered] = useState(false);
  const target = ask.suggestions.find((s) => s.type === "set_mode")?.mode ?? "plan";
  const toPlan = target === "plan";
  // 理由是模型原文（raw）；plain 是词典键，只在模型没给理由时出现。
  const why =
    ask.preview.kind === "raw"
      ? ask.preview.text
      : ask.preview.kind === "plain"
        ? renderUiText(ask.preview.text)
        : "";
  const execLabelKey = MODE_LABEL_KEY[execMode];
  const execLabel = execLabelKey ? t(execLabelKey) : execMode;

  const answer = (r: PermissionResponse) => {
    if (answered) return;
    setAnswered(true);
    onAnswer(r);
  };

  return (
    <div className="plan-card mode-card" role="region" aria-label={t("transcript.mode.ariaLabel")}>
      <div className="plan-card-head">
        <span className="plan-card-badge">{t("transcript.mode.badge")}</span>
        <span className="plan-card-title">
          {toPlan ? t("transcript.mode.toPlanTitle") : t("transcript.mode.toAgentTitle")}
        </span>
      </div>

      {why ? (
        <div className="mode-card-why">
          <Markdown text={why} />
        </div>
      ) : null}

      <div className="plan-card-actions">
        <button className="btn-deny" disabled={answered} onClick={() => answer({ decision: "deny" })}>
          {toPlan ? t("transcript.mode.stayAgent") : t("transcript.mode.stayPlan")}
        </button>
        <span className="plan-card-spacer" />
        <button
          className="btn-allow"
          disabled={answered}
          onClick={() =>
            answer({
              decision: "allow",
              remember: [{ type: "set_mode", mode: toPlan ? "plan" : execMode, scope: "session" }],
            })
          }
        >
          {toPlan ? t("transcript.mode.switchPlan") : t("transcript.mode.switchAgent")}
          <span className="allow-always-sub">
            {toPlan
              ? t("transcript.mode.switchPlanSub")
              : t("transcript.mode.switchAgentSub", { mode: execLabel })}
          </span>
        </button>
      </div>
    </div>
  );
}

function Preview({ preview }: { preview: PermissionAsk["preview"] }) {
  const { t, tn } = useT();
  switch (preview.kind) {
    case "command":
      return (
        <div className="preview">
          <div className="preview-label">{t("transcript.preview.runIn", { cwd: preview.cwd })}</div>
          <pre className="preview-cmd">{preview.command}</pre>
        </div>
      );

    case "file_write":
      return (
        <div className="preview">
          <div className="preview-label">
            {t("transcript.preview.writeFile", { lines: preview.lines, bytes: preview.bytes })}
          </div>
          <pre className="preview-cmd">{preview.path}</pre>
          {/* 内容前 N 行 —— 只给路径和字节数等于让用户盲签。 */}
          {preview.preview ? (
            <pre className="preview-diff">
              {preview.preview.split("\n").map((line, i) => (
                <div key={i} className="add">
                  + {line}
                </div>
              ))}
              {preview.truncated ? (
                <div className="preview-more">
                  {tn("transcript.preview.truncated", preview.lines)}
                </div>
              ) : null}
            </pre>
          ) : null}
        </div>
      );

    case "file_delete":
      return (
        <div className="preview">
          <div className="preview-label">
            {preview.lines > 0
              ? t("transcript.preview.deleteFile", { lines: preview.lines })
              : t("transcript.preview.deleteFileNoCount")}
          </div>
          <pre className="preview-cmd">{preview.path}</pre>
          {/* 要删掉的正文前 N 行，整段标红 —— 只给路径等于让用户盲签一次删除。 */}
          {preview.preview ? (
            <pre className="preview-diff">
              {preview.preview.split("\n").map((line, i) => (
                <div key={i} className="del">
                  - {line}
                </div>
              ))}
              {preview.truncated ? (
                <div className="preview-more">
                  {tn("transcript.preview.truncated", preview.lines)}
                </div>
              ) : null}
            </pre>
          ) : null}
        </div>
      );

    case "file_edit":
      return (
        <div className="preview">
          <div className="preview-label">
            {t("transcript.preview.editFile", { path: preview.path })}
          </div>
          <pre className="preview-diff">
            {preview.diff.split("\n").map((line, i) => (
              <div key={i} className={line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : ""}>
                {line}
              </div>
            ))}
          </pre>
        </div>
      );

    case "network_fetch":
      return (
        <div className="preview">
          <div className="preview-label">{t("transcript.preview.network")}</div>
          <pre className="preview-cmd">{preview.url}</pre>
        </div>
      );

    // choice / env_vars 由对话里的内联卡渲染，权限弹窗走不到这里。
    case "choice":
    case "env_vars":
      return null;

    case "plain":
      return (
        <div className="preview">
          <pre className="preview-cmd">{renderUiText(preview.text)}</pre>
        </div>
      );

    default:
      return (
        <div className="preview">
          <pre className="preview-cmd">{preview.text}</pre>
        </div>
      );
  }
}
