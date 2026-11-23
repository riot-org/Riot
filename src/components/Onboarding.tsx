import { useEffect, useMemo, useState } from "react";

import {
  type AppConfig,
  type CliStatus,
  type ConfigStatus,
  type PermissionMode,
  type SandboxStatus,
  type ToolCheck,
  cliInstall,
  cliStatus,
  hasActiveKey,
  openInBrowser,
  sandboxInstall,
  sandboxStatus,
  setApiKey,
  setConfig,
  testConnection,
  testVision,
  toolchainCheck,
} from "../bridge";
import { type MessageKey, useT } from "../i18n";
import {
  PROVIDER_PRESETS,
  type ProviderPreset,
  activeModelConfig,
  providerFromPreset,
  uniqueProviderId,
  visionCandidates,
  visionPresets,
} from "../lib/providerPresets";
import { Modal } from "./Modal";

/** 「先跳过」记在本机：没配服务方时不再每次启动都弹。设置里随时能重开。 */
export const ONBOARDING_SKIPPED_KEY = "riot.onboarding.skipped";

export function onboardingSkipped(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_SKIPPED_KEY) === "1";
  } catch {
    return false;
  }
}

type Step = 1 | 2 | 3;

/**
 * 引导页：接上模型（含视觉）→ 安全设置 → 开始用。
 *
 * 新用户没有配服务方时自动出现；老用户从「设置 → 通用」或欢迎页重开时，
 * 每一步都读现有配置、预先填好 —— 相当于一次配置体检。
 *
 * `[约束]` 只增不删：引导页从不删除或覆盖已有的服务方和设置，只在用户明确
 * 改动的地方写入（新增服务方、换主模型、设视觉兼容、改默认权限模式）。
 */
export function Onboarding({
  status,
  onStatus,
  onClose,
  onOpenProject,
}: {
  status: ConfigStatus;
  onStatus: (s: ConfigStatus) => void;
  onClose: () => void;
  onOpenProject: () => void;
}) {
  const { t } = useT();
  const [step, setStep] = useState<Step>(1);
  /** 第 1 步的表单开着（填到一半、或者测试没通过）：不能往下走。 */
  const [editing, setEditing] = useState(false);
  const ready = status.config.providers.length > 0 && hasActiveKey(status) && !editing;

  const skip = () => {
    try {
      localStorage.setItem(ONBOARDING_SKIPPED_KEY, "1");
    } catch {
      /* 存不下就下次再问 */
    }
    onClose();
  };

  const steps: { n: Step; key: MessageKey }[] = [
    { n: 1, key: "app.onboarding.step.model" },
    { n: 2, key: "app.onboarding.step.safety" },
    { n: 3, key: "app.onboarding.step.start" },
  ];

  return (
    <Modal className="onboarding" label={t("app.onboarding.title")} onClose={onClose}>
      <div className="onboarding-head">
        <span className="modal-title">{t("app.onboarding.title")}</span>
        <ol className="onboarding-steps">
          {steps.map((s) => (
            <li key={s.n} className={s.n === step ? "current" : s.n < step ? "done" : ""}>
              <span className="onboarding-step-n">{s.n < step ? "✓" : s.n}</span>
              {t(s.key)}
            </li>
          ))}
        </ol>
        <button className="ghost" onClick={onClose} aria-label={t("common.close")}>
          ✕
        </button>
      </div>

      <div className="onboarding-body">
        {step === 1 ? <ModelStep status={status} onStatus={onStatus} onEditing={setEditing} /> : null}
        {step === 2 ? <SafetyStep status={status} onStatus={onStatus} /> : null}
        {step === 3 ? (
          <StartStep
            onOpenProject={() => {
              onClose();
              onOpenProject();
            }}
          />
        ) : null}
      </div>

      <div className="onboarding-foot">
        {step === 1 && !ready ? (
          <button className="link-button" onClick={skip}>
            {t("app.onboarding.skip")}
          </button>
        ) : (
          <span />
        )}
        <div className="editor-foot-actions">
          {step > 1 ? (
            <button onClick={() => setStep((s) => (s - 1) as Step)}>{t("app.onboarding.back")}</button>
          ) : null}
          {step < 3 ? (
            <button
              className="primary"
              disabled={step === 1 && !ready}
              title={step === 1 && !ready ? t("app.onboarding.needModel") : undefined}
              onClick={() => setStep((s) => (s + 1) as Step)}
            >
              {t("app.onboarding.next")}
            </button>
          ) : (
            <button className="primary" onClick={onClose}>
              {t("app.onboarding.done")}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ────────────────────────────────────────────────────────────
// 第 1 步：模型 + 视觉
// ────────────────────────────────────────────────────────────

function ModelStep({
  status,
  onStatus,
  onEditing,
}: {
  status: ConfigStatus;
  onStatus: (s: ConfigStatus) => void;
  onEditing: (on: boolean) => void;
}) {
  const { t } = useT();
  const cfg = status.config;
  const configured = cfg.providers.length > 0 && hasActiveKey(status);
  const [adding, setAdding] = useState<ProviderPreset | null>(null);
  const [picking, setPicking] = useState(!configured);
  useEffect(() => onEditing(adding !== null), [adding, onEditing]);

  const active = cfg.providers.find((p) => p.id === cfg.activeProvider);
  const activeModel = activeModelConfig(cfg);

  if (adding) {
    return (
      <ProviderForm
        preset={adding}
        status={status}
        onStatus={onStatus}
        onDone={() => {
          setAdding(null);
          setPicking(false);
        }}
        onCancel={() => setAdding(null)}
      />
    );
  }

  return (
    <>
      <h2 className="onboarding-h">{t("app.onboarding.model.title")}</h2>
      <p className="hint">{t("app.onboarding.model.desc")}</p>

      {configured && active ? (
        <div className="onboarding-current">
          <span className="env-status ok">
            <span aria-hidden>✓</span> {t("app.onboarding.model.current")}
          </span>
          <strong>
            {active.name} · {activeModel?.name || cfg.activeModel}
          </strong>
          {!picking ? (
            <button className="link-button" onClick={() => setPicking(true)}>
              {t("app.onboarding.model.addAnother")}
            </button>
          ) : null}
        </div>
      ) : null}

      {picking ? (
        <div className="preset-grid">
          {PROVIDER_PRESETS.map((p) => (
            <button key={p.id} className="preset-card" onClick={() => setAdding(p)}>
              <strong>{p.name || t("app.onboarding.preset.custom")}</strong>
              <span className="hint">
                {p.id === "custom"
                  ? t("app.onboarding.preset.customHint")
                  : p.id === "ollama"
                    ? t("app.onboarding.preset.ollamaHint")
                    : p.model}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {configured && activeModel && !activeModel.vision ? (
        <VisionSection status={status} onStatus={onStatus} />
      ) : null}
    </>
  );
}

function ProviderForm({
  preset,
  status,
  onStatus,
  onDone,
  onCancel,
}: {
  preset: ProviderPreset;
  status: ConfigStatus;
  onStatus: (s: ConfigStatus) => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const custom = preset.id === "custom";
  const [name, setName] = useState(preset.name);
  const [baseUrl, setBaseUrl] = useState(preset.baseUrl);
  const [key, setKey] = useState("");
  const [model, setModel] = useState(preset.model);
  const [vision, setVision] = useState(preset.vision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** 这一轮表单里已经建出来的服务方 —— 测试失败后改 key 重试时改它，不再新建一个。 */
  const [createdId, setCreatedId] = useState<string | null>(null);
  /** 表单打开前的主模型。取消时还原 —— 引导页只增不删，取消就等于没来过。 */
  const [before] = useState(() => ({
    provider: status.config.activeProvider,
    model: status.config.activeModel,
  }));

  const cancel = async () => {
    if (createdId) {
      try {
        const cfg = status.config;
        onStatus(
          await setConfig({
            ...cfg,
            providers: cfg.providers.filter((p) => p.id !== createdId),
            activeProvider: before.provider,
            activeModel: before.model,
          }),
        );
      } catch (e) {
        setError(String(e));
        return;
      }
    }
    onCancel();
  };

  const canSave =
    model.trim() !== "" && baseUrl.trim() !== "" && (preset.noKey || key.trim() !== "") && (!custom || name.trim() !== "");

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const cfg = status.config;
      const id = createdId ?? uniqueProviderId(custom ? "custom" : preset.id, cfg);
      const p = providerFromPreset(preset, id, {
        name,
        baseUrl,
        models: [{ id: model.trim(), vision }],
      });
      const providers = createdId
        ? cfg.providers.map((x) => (x.id === id ? p : x))
        : [...cfg.providers, p];
      let next = await setConfig({ ...cfg, providers, activeProvider: id, activeModel: model.trim() });
      setCreatedId(id);
      // Ollama 不校验 key，但宿主取不到 key 会拒绝发请求 —— 存一个占位值。
      next = await setApiKey(id, preset.noKey ? "ollama" : key.trim());
      onStatus(next);
      await testConnection(id, model.trim());
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h2 className="onboarding-h">{preset.name || t("app.onboarding.preset.custom")}</h2>
      <div className="onboarding-form">
        {custom ? (
          <label>
            {t("app.onboarding.form.name")}
            <input value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
          </label>
        ) : null}
        {custom || preset.id === "ollama" ? (
          <label>
            {t("app.onboarding.form.baseUrl")}
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com/v1"
              spellCheck={false}
            />
          </label>
        ) : null}
        {!preset.noKey ? (
          <label>
            <span className="onboarding-label-row">
              API Key
              {preset.keyUrl ? (
                <button className="link-button" onClick={() => void openInBrowser(preset.keyUrl!)}>
                  {t("app.onboarding.form.getKey")} ↗
                </button>
              ) : null}
            </span>
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoFocus
              spellCheck={false}
              autoComplete="off"
            />
          </label>
        ) : null}
        <label>
          {t("app.onboarding.form.model")}
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={preset.id === "ollama" ? "qwen3" : ""}
            spellCheck={false}
          />
        </label>
        <button className="toggle-row" role="switch" aria-checked={vision} onClick={() => setVision(!vision)}>
          <span className={vision ? "toggle-track on" : "toggle-track"}>
            <span className="toggle-knob" />
          </span>
          <span>
            {t("app.onboarding.form.vision")}
            <span className="hint"> · {t("app.onboarding.form.visionHint")}</span>
          </span>
        </button>
      </div>
      {error ? <FriendlyError raw={error} /> : null}
      <div className="onboarding-inline-actions">
        <button onClick={() => void cancel()} disabled={busy}>
          {t("common.cancel")}
        </button>
        <button className="primary" disabled={!canSave || busy} onClick={() => void save()}>
          {busy ? t("app.onboarding.form.testing") : t("app.onboarding.form.save")}
        </button>
      </div>
    </>
  );
}

/**
 * 主模型看不了图时：配一个视觉兼容模型（先把图转成文字，再交给主模型）。
 * 三条路：用已经配好的视觉模型；快速添加一个；先不用。
 */
function VisionSection({
  status,
  onStatus,
}: {
  status: ConfigStatus;
  onStatus: (s: ConfigStatus) => void;
}) {
  const { t } = useT();
  const cfg = status.config;
  const candidates = useMemo(() => visionCandidates(cfg), [cfg]);
  const current = candidates.find((c) => c.value === cfg.visionModel);
  const [dismissed, setDismissed] = useState(false);
  const [adding, setAdding] = useState<{ preset: ProviderPreset; model: string } | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [verified, setVerified] = useState<string | null>(null);

  // 主模型所属的那一家有没有自己的视觉模型（智谱、千问）：有就复用同一个 key。
  const active = cfg.providers.find((p) => p.id === cfg.activeProvider);
  const sameVendor = PROVIDER_PRESETS.find(
    (p) => p.visionModel && active && p.baseUrl === active.baseUrl,
  );

  const use = async (next: AppConfig, providerId: string, model: string) => {
    setBusy(true);
    setError("");
    try {
      const saved = await setConfig({ ...next, visionModel: `${providerId}/${model}` });
      onStatus(saved);
      await testVision(providerId, model);
      setVerified(`${providerId}/${model}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (current && !error) {
    return (
      <div className="onboarding-vision">
        <span className="env-status ok">
          <span aria-hidden>✓</span> {t("app.onboarding.vision.set", { model: current.label })}
        </span>
        {verified === current.value ? <span className="hint"> · {t("app.onboarding.vision.verified")}</span> : null}
      </div>
    );
  }
  if (dismissed) return null;

  return (
    <div className="onboarding-vision">
      <h3>{t("app.onboarding.vision.title")}</h3>
      <p className="hint">{t("app.onboarding.vision.desc")}</p>

      {candidates.length > 0 ? (
        <div className="onboarding-chip-row">
          {candidates.map((c) => {
            const [pid, ...rest] = c.value.split("/");
            return (
              <button key={c.value} disabled={busy} onClick={() => void use(cfg, pid!, rest.join("/"))}>
                {t("app.onboarding.vision.useExisting", { model: c.label })}
              </button>
            );
          })}
        </div>
      ) : null}

      {sameVendor && active ? (
        <div className="onboarding-chip-row">
          <button
            disabled={busy}
            onClick={() => {
              const model = sameVendor.visionModel!;
              const providers = cfg.providers.map((p) =>
                p.id === active.id && !p.models.some((m) => m.id === model)
                  ? { ...p, models: [...p.models, { id: model, vision: true }] }
                  : p,
              );
              void use({ ...cfg, providers }, active.id, model);
            }}
          >
            {t("app.onboarding.vision.sameVendor", { model: sameVendor.visionModel! })}
          </button>
        </div>
      ) : null}

      {adding ? (
        <div className="onboarding-form">
          <label>
            {t("app.onboarding.vision.keyFor", { name: adding.preset.name })}
            <input type="password" value={key} onChange={(e) => setKey(e.target.value)} autoFocus autoComplete="off" />
          </label>
          <div className="onboarding-inline-actions">
            <button onClick={() => setAdding(null)} disabled={busy}>
              {t("common.cancel")}
            </button>
            <button
              className="primary"
              disabled={busy || key.trim() === ""}
              onClick={() => {
                const id = uniqueProviderId(adding.preset.id, cfg);
                const p = providerFromPreset(adding.preset, id, {
                  models: [{ id: adding.model, vision: true }],
                });
                setBusy(true);
                void setConfig({ ...cfg, providers: [...cfg.providers, p] })
                  .then(() => setApiKey(id, key.trim()))
                  .then((s) => {
                    setBusy(false);
                    return use(s.config, id, adding.model);
                  })
                  .catch((e: unknown) => {
                    setBusy(false);
                    setError(String(e));
                  });
              }}
            >
              {busy ? t("app.onboarding.form.testing") : t("app.onboarding.vision.addAndTest")}
            </button>
          </div>
        </div>
      ) : (
        <div className="onboarding-chip-row">
          {visionPresets()
            .filter(({ preset }) => !sameVendor || preset.id !== sameVendor.id)
            .map(({ preset, model }) => (
              <button key={preset.id} disabled={busy} onClick={() => setAdding({ preset, model })}>
                {t("app.onboarding.vision.add", { name: preset.name, model })}
              </button>
            ))}
          <button className="link-button" onClick={() => setDismissed(true)}>
            {t("app.onboarding.vision.later")}
          </button>
        </div>
      )}
      {error ? <FriendlyError raw={error} vision /> : null}
      <p className="hint onboarding-small">{t("app.onboarding.vision.tradeoff")}</p>
    </div>
  );
}

/**
 * 连接失败先说人话（Key 不对 / 连不上 / 没这个模型 / 看不了图），原始报错
 * 用小字跟在后面 —— 排查时要它，但第一眼不该是一串 HTTP 401。
 */
function FriendlyError({ raw, vision }: { raw: string; vision?: boolean }) {
  const { t } = useT();
  const key: MessageKey = vision && /does not seem to see images|can't see|cannot see/i.test(raw)
    ? "app.onboarding.err.noVision"
    : /\b40[13]\b|auth|unauthori[sz]ed|invalid.{0,20}key|api key/i.test(raw)
      ? "app.onboarding.err.badKey"
      : /\b404\b|model.{0,30}(not.{0,10}(found|exist)|does not exist)|no such model/i.test(raw)
        ? "app.onboarding.err.badModel"
        : /timed? ?out|no (response|answer)|within \d+ seconds|connect|dns|resolve|network|proxy|refused|unreachable|ssl|tls/i.test(raw)
          ? "app.onboarding.err.network"
          : "app.onboarding.err.other";
  return (
    <div className="form-error onboarding-error">
      <strong>{t(key)}</strong>
      <span className="onboarding-error-raw">{raw}</span>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// 第 2 步：安全
// ────────────────────────────────────────────────────────────

const MODES: { mode: PermissionMode; key: MessageKey; desc: MessageKey }[] = [
  { mode: "bypassPermissions", key: "app.onboarding.mode.bypass", desc: "app.onboarding.mode.bypass.desc" },
  { mode: "auto", key: "app.onboarding.mode.auto", desc: "app.onboarding.mode.auto.desc" },
  { mode: "default", key: "app.onboarding.mode.ask", desc: "app.onboarding.mode.ask.desc" },
];

function SafetyStep({
  status,
  onStatus,
}: {
  status: ConfigStatus;
  onStatus: (s: ConfigStatus) => void;
}) {
  const { t } = useT();
  const [sbx, setSbx] = useState<SandboxStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState("");
  const cfg = status.config;

  const refresh = () =>
    void sandboxStatus()
      .then(setSbx)
      .catch(() => setSbx(null));
  useEffect(refresh, []);

  // 推荐档跟着沙箱走：命令隔离着才敢默认放行。
  const recommended: PermissionMode = sbx?.ready ? "bypassPermissions" : "auto";

  return (
    <>
      <h2 className="onboarding-h">{t("app.onboarding.safety.title")}</h2>
      <div className="onboarding-box">
        <span className={sbx?.ready ? "env-status ok" : "env-status bad"}>
          <span aria-hidden>{sbx?.ready ? "✓" : "✗"}</span> {t("settings.env.check.sandbox")}
        </span>
        <p className="hint">
          {sbx === null
            ? t("settings.ext.loading")
            : sbx.ready
              ? t("app.onboarding.safety.sandboxReady")
              : sbx.implemented
                ? t("app.onboarding.safety.sandboxInstall")
                : t("app.onboarding.safety.sandboxNone")}
        </p>
        {sbx && !sbx.ready && sbx.blocker?.kind === "needsElevatedInstall" ? (
          <button
            disabled={installing}
            onClick={() => {
              setInstalling(true);
              setError("");
              void sandboxInstall()
                .then(refresh)
                .catch((e: unknown) => setError(String(e)))
                .finally(() => setInstalling(false));
            }}
          >
            {installing ? t("settings.permission.sandbox.waitingUac") : t("settings.permission.sandbox.install")}
          </button>
        ) : null}
        {error ? <p className="form-error">{error}</p> : null}
      </div>

      <h3 className="onboarding-sub">{t("app.onboarding.safety.modeTitle")}</h3>
      <div className="onboarding-modes" role="radiogroup">
        {MODES.map((m) => (
          <button
            key={m.mode}
            role="radio"
            aria-checked={cfg.defaultMode === m.mode}
            className={cfg.defaultMode === m.mode ? "onb-mode active" : "onb-mode"}
            onClick={() => void setConfig({ ...cfg, defaultMode: m.mode }).then(onStatus)}
          >
            <strong>
              {t(m.key)}
              {m.mode === recommended ? <span className="onb-mode-badge">{t("app.onboarding.recommended")}</span> : null}
            </strong>
            <span className="hint">{t(m.desc)}</span>
          </button>
        ))}
      </div>
      <p className="hint onboarding-small">{t("app.onboarding.safety.modeNote")}</p>
    </>
  );
}

// ────────────────────────────────────────────────────────────
// 第 3 步：开始用
// ────────────────────────────────────────────────────────────

function StartStep({ onOpenProject }: { onOpenProject: () => void }) {
  const { t } = useT();
  const [cli, setCli] = useState<CliStatus | null>(null);
  const [tools, setTools] = useState<ToolCheck[] | null>(null);
  const [cliError, setCliError] = useState("");

  useEffect(() => {
    void cliStatus()
      .then(setCli)
      .catch(() => setCli(null));
    void toolchainCheck(null)
      .then(setTools)
      .catch(() => setTools([]));
  }, []);

  return (
    <>
      <h2 className="onboarding-h">{t("app.onboarding.start.title")}</h2>
      <button className="primary onboarding-big" onClick={onOpenProject}>
        {t("app.onboarding.start.open")}
      </button>
      <p className="hint">{t("app.onboarding.start.openHint")}</p>

      <h3 className="onboarding-sub">{t("app.onboarding.start.optional")}</h3>
      <ul className="onboarding-checks">
        {cli?.available ? (
          <li>
            <span className={cli.installed ? "env-status ok" : "env-status bad"}>
              <span aria-hidden>{cli.installed ? "✓" : "✗"}</span> {t("settings.env.cli")}
            </span>
            {!cli.installed ? (
              <button
                className="btn-compact"
                onClick={() => {
                  setCliError("");
                  void cliInstall()
                    .then(setCli)
                    .catch((e: unknown) => setCliError(String(e)));
                }}
              >
                {t("settings.env.cli.install")}
              </button>
            ) : null}
            {cliError ? <span className="form-error"> {cliError}</span> : null}
          </li>
        ) : null}
        {tools === null ? (
          <li className="hint">{t("settings.ext.loading")}</li>
        ) : (
          tools.map((c) => (
            <li key={c.id}>
              <span className={c.ok ? "env-status ok" : "env-status bad"}>
                <span aria-hidden>{c.ok ? "✓" : "✗"}</span> {c.id}
              </span>
              {!c.ok && c.fix ? <code className="env-fix">{c.fix}</code> : null}
            </li>
          ))
        )}
      </ul>
      <p className="hint onboarding-small">{t("app.onboarding.start.later")}</p>
    </>
  );
}
