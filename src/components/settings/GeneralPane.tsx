import { useEffect, useState } from "react";

import {
  type CliStatus,
  type SandboxStatus,
  type ToolCheck,
  cliInstall,
  cliStatus,
  sandboxStatus,
  toolchainCheck,
} from "../../bridge";
import { type MessageKey } from "../../i18n";
import { FieldSelect } from "../FieldSelect";
import { LOCALE_NAMES, LOCALES, isLocale, setLocaleChoice, useLocaleChoice, useT } from "../../i18n";
import { isTheme, setThemeChoice, useThemeChoice } from "../../theme";
import { Card, CardBlock, Group, Row } from "./layout";

/** 下拉里"跟随系统"那一项的值。语言代码和主题名里都不会出现，不会撞。 */
const SYSTEM = "system";

export function GeneralPane({ activeRoot }: { activeRoot: string | null }) {
  const { t } = useT();
  const choice = useLocaleChoice();
  const theme = useThemeChoice();

  const options = [
    { value: SYSTEM, label: t("settings.general.language.system") },
    ...LOCALES.map((l) => ({ value: l, label: LOCALE_NAMES[l] })),
  ];

  const themeOptions = [
    { value: SYSTEM, label: t("settings.general.theme.system") },
    { value: "light", label: t("settings.general.theme.light") },
    { value: "dark", label: t("settings.general.theme.dark") },
  ];

  return (
    <>
      {/* 第一组不给标题：页面标题已经叫「通用」，再写一遍是重复。 */}
      <Group>
      <Card>
        <Row title={t("settings.general.language")} desc={t("settings.general.language.desc")}>
          <FieldSelect
            value={choice ?? SYSTEM}
            options={options}
            onChange={(v) => setLocaleChoice(isLocale(v) ? v : null)}
          />
        </Row>
        <Row title={t("settings.general.theme")} desc={t("settings.general.theme.desc")}>
          <FieldSelect
            value={theme ?? SYSTEM}
            options={themeOptions}
            onChange={(v) => setThemeChoice(isTheme(v) ? v : null)}
          />
        </Row>
      </Card>
      </Group>
      <EnvironmentGroup activeRoot={activeRoot} />
    </>
  );
}

/** 各能力依赖的外部程序：缺了不会报错，只是悄悄不可用，所以在这里一次列清。 */
const TOOL_USE: Record<string, MessageKey> = {
  git: "settings.env.tool.git",
  gh: "settings.env.tool.gh",
  node: "settings.env.tool.node",
  "rust-analyzer": "settings.env.tool.lsp",
  "typescript-language-server": "settings.env.tool.lsp",
  pyright: "settings.env.tool.lsp",
};

function EnvironmentGroup({ activeRoot }: { activeRoot: string | null }) {
  const { t } = useT();
  const [tools, setTools] = useState<ToolCheck[] | null>(null);
  const [sbx, setSbx] = useState<SandboxStatus | null>(null);
  const [cli, setCli] = useState<CliStatus | null>(null);
  const [cliError, setCliError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    setBusy(true);
    void Promise.allSettled([toolchainCheck(activeRoot), sandboxStatus(), cliStatus()]).then(
      ([a, b, c]) => {
        setTools(a.status === "fulfilled" ? a.value : []);
        setSbx(b.status === "fulfilled" ? b.value : null);
        setCli(c.status === "fulfilled" ? c.value : null);
        setBusy(false);
      },
    );
  };
  useEffect(refresh, [activeRoot]);

  return (
    <Group
      title={t("settings.env.check.title")}
      desc={t("settings.env.check.desc")}
      action={
        <button className="btn-compact" disabled={busy} onClick={refresh}>
          {busy ? t("settings.env.check.running") : t("common.refresh")}
        </button>
      }
    >
      <Card>
        <Row
          title={<StatusTitle ok={!!sbx?.ready} name={t("settings.env.check.sandbox")} />}
          desc={
            sbx === null
              ? t("settings.ext.loading")
              : sbx.ready
                ? t("settings.env.check.sandbox.ready")
                : t("settings.env.check.sandbox.notReady")
          }
        />
        {cli?.available ? (
          <Row
            title={<StatusTitle ok={cli.installed && cli.onPath} name={t("settings.env.cli")} />}
            desc={
              <>
                {cli.installed
                  ? cli.onPath
                    ? t("settings.env.cli.ready", { path: cli.path })
                    : t("settings.env.cli.notOnPath", { path: cli.path })
                  : t("settings.env.cli.missing")}
                {cli.installed && !cli.onPath && cli.hint ? (
                  <>
                    <br />
                    <code className="env-fix">{cli.hint}</code>
                  </>
                ) : null}
                {cliError ? <span className="form-error"> {cliError}</span> : null}
              </>
            }
          >
            {!cli.installed ? (
              <button
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
          </Row>
        ) : null}
        {tools === null ? (
          <CardBlock>
            <p className="hint" style={{ margin: 0 }}>
              {t("settings.ext.loading")}
            </p>
          </CardBlock>
        ) : (
          tools.map((c) => {
            const use = TOOL_USE[c.id];
            return (
              <Row
                key={c.id}
                title={<StatusTitle ok={c.ok} name={c.id} />}
                desc={
                  <>
                    {use ? `${t(use)} · ` : null}
                    {c.detail}
                  </>
                }
              >
                {!c.ok && c.fix ? <code className="env-fix">{c.fix}</code> : null}
              </Row>
            );
          })
        )}
      </Card>
    </Group>
  );
}

function StatusTitle({ ok, name }: { ok: boolean; name: string }) {
  return (
    <span className={ok ? "env-status ok" : "env-status bad"}>
      <span aria-hidden>{ok ? "✓" : "✗"}</span> {name}
    </span>
  );
}
