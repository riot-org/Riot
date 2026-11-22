import { useEffect, useState } from "react";

import { type ProjectTrust, projectTrustSet, projectTrustStatus } from "../../bridge";
import { type MessageKey, useT } from "../../i18n";

const KIND_LABEL: Record<string, MessageKey> = {
  hooks: "composer.trust.kind.hooks",
  skills: "composer.trust.kind.skills",
  commands: "composer.trust.kind.commands",
};

/**
 * 项目信任提示。
 *
 * 项目自带 `.riot/hooks.json`、技能或命令，而用户还没信任过这个项目时，
 * 它们**不会被加载**（hooks 是会被直接执行的命令 —— 克隆来的陌生仓库不能
 * 借它跑代码，见内核的 trust 模块）。这里说清楚少了什么、点一下就能信任。
 *
 * 没带任何配置的项目不打扰：没有东西要挡，也就没有东西要问。
 */
export function TrustBanner({ workspace }: { workspace: string }) {
  const { t } = useT();
  const [state, setState] = useState<ProjectTrust | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    setState(null);
    setOpen(false);
    if (!workspace) return;
    projectTrustStatus(workspace)
      .then((s) => alive && setState(s))
      .catch(() => alive && setState(null));
    return () => {
      alive = false;
    };
  }, [workspace]);

  if (!state || state.trusted || state.items.length === 0) return null;

  const summary = state.items
    .map((i) => t(KIND_LABEL[i.kind] ?? "composer.trust.kind.other", { count: i.count }))
    .join(t("composer.trust.sep"));

  const trust = async () => {
    setError("");
    try {
      await projectTrustSet(workspace, true);
      setState({ ...state, trusted: true });
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="key-banner trust-banner" role="status">
      <button className="trust-banner-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {t("composer.trust.banner", { summary })}
      </button>
      {open ? (
        <div className="trust-banner-body">
          <p>{t("composer.trust.why")}</p>
          <ul>
            {state.items.map((i) => (
              <li key={i.path}>
                <code>{i.path}</code>
              </li>
            ))}
          </ul>
          {error ? <p className="form-error">{error}</p> : null}
          <div className="trust-banner-actions">
            <button onClick={() => setOpen(false)}>{t("composer.trust.later")}</button>
            <button className="primary" onClick={() => void trust()}>
              {t("composer.trust.confirm")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
