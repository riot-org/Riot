import { useEffect, useMemo, useState, type ReactNode } from "react";

import type { UserEnvEntry } from "../../bridge";
import { useT } from "../../i18n";
import { Chevron } from "../Chevron";
import { PencilIcon, PlusIcon, TrashIcon } from "../icons";
import { SmoothFold } from "../SmoothFold";
import { envFieldName, groupEnvVars, type EnvGroup } from "./envGroups";

/** 展开着的组，纯界面偏好。没存过 = 全部收起：变量一多，先看全貌。 */
const OPEN_KEY = "riot.env.openGroups";
/** 「其他」那组在展开表里的键。真实组名是合法变量名前缀，撞不上。 */
const LOOSE = "\0other";
/** 变量少于这个数不出搜索框：几行字一眼就看完了。 */
const SEARCH_MIN = 8;

function loadOpen(): Set<string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]");
    return new Set(
      Array.isArray(v)
        ? v.filter((x): x is string => typeof x === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

function saveOpen(open: Set<string>) {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify([...open]));
  } catch {
    // 存不下只是下次打开又是收起的，不影响使用。
  }
}

const groupKey = (g: EnvGroup<unknown>) => g.prefix ?? LOOSE;

export interface EnvRowActions {
  editing: string | null;
  /** 编辑态的输入框，由外面管值和提交。 */
  editor: ReactNode;
  onEdit: (name: string) => void;
  onRemove: (v: UserEnvEntry) => void;
  onAddToGroup: (stem: string) => void;
}

/**
 * 环境变量按组折叠显示。
 *
 * 组头收起时也给足信息：组名、个数、组里有哪些字段、被哪些 MCP 用着 ——
 * 不展开就能认出"这是哪台服务器的那一套"。只有一组时不出组头，就是
 * 一张平铺的卡。
 */
export function EnvGroupList({
  vars,
  reveal,
  actions,
}: {
  vars: UserEnvEntry[];
  /** 刚加的变量：它所在的组自动展开，不然加完看不见。 */
  reveal: string | null;
  actions: EnvRowActions;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(loadOpen);
  const [query, setQuery] = useState("");

  const groups = useMemo(() => groupEnvVars(vars), [vars]);
  const q = query.trim().toUpperCase();
  const shown = useMemo(
    () =>
      q
        ? groups
            .map((g) => ({ ...g, items: g.items.filter((v) => matches(v, q)) }))
            .filter((g) => g.items.length > 0)
        : groups,
    [groups, q],
  );

  const update = (next: Set<string>) => {
    setOpen(next);
    saveOpen(next);
  };
  const toggle = (key: string) => {
    const next = new Set(open);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    update(next);
  };

  useEffect(() => {
    if (!reveal) return;
    const g = groups.find((g) => g.items.some((v) => v.name === reveal));
    if (g && !open.has(groupKey(g))) update(new Set(open).add(groupKey(g)));
    // 只在 reveal 变了时对一次；open 变了不该重新强开。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal, groups]);

  const only = groups.length === 1 ? groups[0] : undefined;
  const flat = only?.prefix === null ? only : undefined;
  const allOpen = groups.every((g) => open.has(groupKey(g)));

  const row = (v: UserEnvEntry, prefix: string | null) => {
    const field = envFieldName(v.name, prefix);
    const editingThis = actions.editing === v.name;
    return (
      <div
        key={v.name}
        className={editingThis ? "env-item editing" : "env-item"}
      >
        <div className="env-item-main">
          <div className="env-item-name">
            <code className="env-field">{field}</code>
            {field !== v.name ? (
              <code className="env-full">${v.name}</code>
            ) : null}
          </div>
          {editingThis ? null : (
            <div className="env-item-meta">
              <span className="env-masked">{v.masked}</span>
              {v.usedBy?.map((id) => (
                <span
                  key={id}
                  className="env-pill"
                  title={t("settings.env.usedBy", { servers: id })}
                >
                  MCP · {id}
                </span>
              ))}
            </div>
          )}
        </div>
        {editingThis ? (
          <div className="env-item-editor">{actions.editor}</div>
        ) : (
          <div className="env-item-actions">
            <button
              type="button"
              title={t("settings.env.change")}
              aria-label={`${t("settings.env.change")} ${v.name}`}
              onClick={() => actions.onEdit(v.name)}
            >
              <PencilIcon />
            </button>
            <button
              type="button"
              className="danger"
              title={t("common.delete")}
              aria-label={`${t("common.delete")} ${v.name}`}
              onClick={() => actions.onRemove(v)}
            >
              <TrashIcon />
            </button>
          </div>
        )}
      </div>
    );
  };

  if (flat) {
    return (
      <div className="set-card env-folder">
        {flat.items.map((v) => row(v, null))}
      </div>
    );
  }

  return (
    <>
      <div className="env-toolbar">
        {vars.length >= SEARCH_MIN ? (
          <input
            className="env-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder={t("settings.env.search")}
            aria-label={t("settings.env.search")}
            spellCheck={false}
          />
        ) : (
          <span />
        )}
        <button
          type="button"
          className="env-toggle-all"
          onClick={() =>
            update(allOpen ? new Set() : new Set(groups.map(groupKey)))
          }
        >
          {allOpen
            ? t("settings.env.collapseAll")
            : t("settings.env.expandAll")}
        </button>
      </div>

      {shown.length === 0 ? (
        <p className="env-search-empty">
          {t("settings.env.searchEmpty", { query: query.trim() })}
        </p>
      ) : null}

      <div className="env-folders">
        {shown.map((g) => {
          const key = groupKey(g);
          // 搜索时命中的组一律摊开，不然得一个个点开找。
          const isOpen = q !== "" || open.has(key);
          const users = [...new Set(g.items.flatMap((v) => v.usedBy ?? []))];
          return (
            <div
              key={key}
              className={
                isOpen ? "set-card env-folder open" : "set-card env-folder"
              }
            >
              <div className="env-folder-head">
                <button
                  type="button"
                  className="env-folder-toggle"
                  aria-expanded={isOpen}
                  onClick={() => toggle(key)}
                >
                  <Chevron open={isOpen} />
                  <span className="env-folder-title">
                    {g.prefix ? (
                      <code>{g.prefix}</code>
                    ) : (
                      t("settings.env.group.other")
                    )}
                  </span>
                  <span className="env-count">{g.items.length}</span>
                  {isOpen ? null : (
                    <span className="env-folder-peek">
                      {g.items
                        .map((v) => envFieldName(v.name, g.prefix))
                        .join(" · ")}
                    </span>
                  )}
                </button>
                {users.map((id) => (
                  <span key={id} className="env-pill">
                    MCP · {id}
                  </span>
                ))}
                {g.prefix ? (
                  <button
                    type="button"
                    className="env-folder-add"
                    title={t("settings.env.group.add")}
                    aria-label={t("settings.env.group.add")}
                    onClick={() => actions.onAddToGroup(g.stem)}
                  >
                    <PlusIcon />
                  </button>
                ) : null}
              </div>
              <SmoothFold open={isOpen}>
                <div className="env-folder-body">
                  {g.items.map((v) => row(v, g.prefix))}
                </div>
              </SmoothFold>
            </div>
          );
        })}
      </div>
    </>
  );
}

function matches(v: UserEnvEntry, q: string): boolean {
  return (
    v.name.toUpperCase().includes(q) ||
    (v.usedBy ?? []).some((id) => id.toUpperCase().includes(q))
  );
}
