import { useEffect, useState } from "react";

import { envVarSet, envVarsList, type UserEnvEntry } from "../../bridge";
import { useT } from "../../i18n";
import { Card, CardBlock, Group, Row } from "./layout";
import { type AskConfirm, FormError } from "./shared";

/** 和宿主 `config::valid_env_name` 同一条规则：shell 里能 `$NAME` 引用的名字。 */
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 设置 → 环境变量。
 *
 * 给 API key、密码这类**不该喂给模型**的值一个去处：存在本机的 auth.json
 * （0600，和模型 key 同一个文件），注入 agent 跑的每一条命令，命令和脚本
 * 里用 `$NAME` 引用。模型只知道名字；输出里冒出值来也会被遮蔽。
 *
 * 值只进不出：列表里是打码后的样子，改就是整个重填。整值从不回到前端 ——
 * 网页版（远程访问）的浏览器里也一样。
 */
export function EnvPane({ askConfirm, onSaved }: { askConfirm: AskConfirm; onSaved: () => void }) {
  const { t, tx } = useT();
  const [vars, setVars] = useState<UserEnvEntry[] | null>(null);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  /** 正在改值的那个变量。 */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    envVarsList()
      .then(setVars)
      .catch((e) => setError(String(e)));
  }, []);

  const save = async (n: string, v: string): Promise<boolean> => {
    setError("");
    try {
      setVars(await envVarSet(n, v));
      onSaved();
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    }
  };

  const trimmed = name.trim();
  const nameBad = trimmed !== "" && !NAME_RE.test(trimmed);
  const exists = vars?.some((v) => v.name === trimmed) ?? false;

  const add = async () => {
    if (!trimmed || nameBad || !value.trim()) return;
    if (await save(trimmed, value)) {
      setName("");
      setValue("");
    }
  };

  const remove = (n: string) =>
    askConfirm({
      title: t("settings.env.remove.title", { name: n }),
      body: t("settings.env.remove.body"),
      confirmLabel: t("common.delete"),
      action: () => void save(n, ""),
    });

  const commitEdit = async () => {
    if (!editing || !draft.trim()) return;
    if (await save(editing, draft)) {
      setEditing(null);
      setDraft("");
    }
  };

  return (
    <>
      <Group
        title={t("settings.env.list")}
        desc={tx("settings.env.list.desc", { ref: <code>$NAME</code> })}
      >
        <Card>
          {vars === null ? null : vars.length === 0 ? (
            <CardBlock>
              <div className="empty-state">
                <p className="empty-title">{t("settings.env.empty.title")}</p>
                <p className="hint">{t("settings.env.empty.hint")}</p>
              </div>
            </CardBlock>
          ) : (
            vars.map((v) =>
              editing === v.name ? (
                <Row key={v.name} title={<code>{v.name}</code>} stack>
                  <div className="key-row">
                    <input
                      type="password"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void commitEdit();
                        if (e.key === "Escape") setEditing(null);
                      }}
                      placeholder={t("settings.env.newValue")}
                      autoComplete="off"
                      spellCheck={false}
                      autoFocus
                      aria-label={t("settings.env.newValue")}
                    />
                    <button onClick={() => setEditing(null)}>{t("common.cancel")}</button>
                    <button
                      className="primary"
                      onClick={() => void commitEdit()}
                      disabled={!draft.trim()}
                    >
                      {t("common.save")}
                    </button>
                  </div>
                </Row>
              ) : (
                <Row
                  key={v.name}
                  title={<code>{v.name}</code>}
                  desc={<span className="env-masked">{v.masked}</span>}
                >
                  <div className="key-row">
                    <button
                      className="btn-compact"
                      onClick={() => {
                        setEditing(v.name);
                        setDraft("");
                      }}
                    >
                      {t("settings.env.change")}
                    </button>
                    <button className="btn-compact" onClick={() => remove(v.name)}>
                      {t("common.delete")}
                    </button>
                  </div>
                </Row>
              ),
            )
          )}
        </Card>
      </Group>

      <Group title={t("settings.env.add")}>
        <Card>
          <Row
            title={t("settings.env.name")}
            desc={
              nameBad
                ? t("settings.env.name.bad")
                : exists
                  ? t("settings.env.name.exists")
                  : t("settings.env.name.desc")
            }
            htmlFor="env-new-name"
          >
            <input
              id="env-new-name"
              className="env-name-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="EXAMPLE_API_KEY"
              autoComplete="off"
              spellCheck={false}
            />
          </Row>
          <Row title={t("settings.env.value")} desc={t("settings.env.value.desc")} stack>
            <div className="key-row">
              <input
                type="password"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void add()}
                placeholder={t("settings.env.value.placeholder")}
                autoComplete="off"
                spellCheck={false}
                aria-label={t("settings.env.value")}
              />
              <button
                className="primary"
                onClick={() => void add()}
                disabled={!trimmed || nameBad || !value.trim()}
              >
                {exists ? t("settings.env.replace") : t("settings.env.addButton")}
              </button>
            </div>
          </Row>
        </Card>
        {error ? <FormError text={error} /> : null}
      </Group>
    </>
  );
}
