import { useEffect, useMemo, useState } from "react";

import {
  type MemoryNote,
  type MemoryOverview,
  type ProjectMemory,
  memoryDelete,
  memoryList,
  memorySave,
  revealInFinder,
} from "../../bridge";
import { type MessageKey, useT } from "../../i18n";
import { revealInFileManagerLabel } from "../../lib/platform";
import { FieldSelect } from "../FieldSelect";
import { ResizableTextarea } from "../ResizableTextarea";
import { Card, CardBlock, Group, Row } from "./layout";
import { type AskConfirm, FormError } from "./shared";

/** 记忆的四种类型，顺序即列表里的分组顺序（和内核 scan 的排序一致）。 */
const KINDS = ["feedback", "user", "project", "reference"] as const;

const kindLabel = (k: string): MessageKey | null =>
  (KINDS as readonly string[]).includes(k) ? (`settings.memory.kind.${k}` as MessageKey) : null;

/** 名字只认短横线小写，和内核的校验同一条规则（这里先拦一道，省一次往返）。 */
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * 自动记忆。
 *
 * Agent 在对话里用 Memory 工具记下的笔记，按项目存在 Riot 配置目录。
 * 这里能看、改、删，也能手动加一条 —— 记忆会在之后每个会话开头注入，
 * 记错了的东西必须有地方能清掉，不然会一直误导后面的会话。
 *
 * 改动直接落盘，不经内核：只影响**之后新开**的会话（已开的会话在开头
 * 已经拿到了索引）。页面说明里写清这一点。
 */
export function MemoryPane({
  activeRoot,
  askConfirm,
  onSaved,
}: {
  activeRoot: string | null;
  askConfirm: AskConfirm;
  onSaved: () => void;
}) {
  const { t } = useT();
  const [data, setData] = useState<MemoryOverview | null>(null);
  const [loadError, setLoadError] = useState("");
  const [projectKey, setProjectKey] = useState<string>("");
  /** 选中的笔记名；`""` + creating = 正在新建。 */
  const [selName, setSelName] = useState("");
  const [creating, setCreating] = useState(false);

  const refresh = async (keep?: { key?: string; name?: string }) => {
    setLoadError("");
    try {
      const d = await memoryList(activeRoot);
      setData(d);
      const key =
        keep?.key && d.projects.some((p) => p.key === keep.key)
          ? keep.key
          : (d.currentKey ?? d.projects[0]?.key ?? "");
      setProjectKey(key);
      const proj = d.projects.find((p) => p.key === key);
      const name =
        keep?.name && proj?.notes.some((n) => n.name === keep.name)
          ? keep.name
          : (proj?.notes[0]?.name ?? "");
      setSelName(name);
    } catch (e) {
      setData(null);
      setLoadError(String(e));
    }
  };
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoot]);

  const project: ProjectMemory | undefined = data?.projects.find((p) => p.key === projectKey);
  const note = project?.notes.find((n) => n.name === selName);

  const projectOptions = useMemo(
    () =>
      (data?.projects ?? []).map((p) => ({
        value: p.key,
        label: projectLabel(p),
        hint:
          p.key === data?.currentKey
            ? t("settings.memory.project.current")
            : t("settings.memory.count", { count: p.notes.length }),
      })),
    [data, t],
  );

  if (loadError) {
    return (
      <div className="empty-state">
        <p className="form-error" style={{ margin: 0 }}>
          {t("settings.ext.loadFailed", { error: loadError })}
        </p>
        <button onClick={() => void refresh()}>{t("common.retry")}</button>
      </div>
    );
  }
  if (!data) {
    return (
      <Card>
        <CardBlock>
          <p className="hint" style={{ margin: 0 }}>
            {t("settings.ext.loading")}
          </p>
        </CardBlock>
      </Card>
    );
  }
  if (data.projects.length === 0) {
    return (
      <div className="empty-state">
        <p className="empty-title">{t("settings.memory.none.title")}</p>
        <p className="hint">{t("settings.memory.none.hint")}</p>
      </div>
    );
  }

  const remove = (n: MemoryNote) => {
    if (!project) return;
    askConfirm({
      title: t("settings.memory.remove.title", { name: n.name }),
      body: t("settings.memory.remove.body"),
      confirmLabel: t("common.delete"),
      action: () => {
        void memoryDelete(project.key, n.name)
          .then(() => {
            onSaved();
            return refresh({ key: project.key });
          })
          .catch((e: unknown) => setLoadError(String(e)));
      },
    });
  };

  return (
    <>
      <Group title={t("settings.memory.project")}>
        <Card>
          <Row
            title={projectLabel(project)}
            desc={project ? <code>{project.dir}</code> : null}
          >
            <div className="set-group-actions">
              {data.projects.length > 1 ? (
                <FieldSelect
                  value={projectKey}
                  onChange={(k) => {
                    setProjectKey(k);
                    setCreating(false);
                    setSelName(data.projects.find((p) => p.key === k)?.notes[0]?.name ?? "");
                  }}
                  options={projectOptions}
                  menuMinWidth={320}
                />
              ) : null}
              {project && project.notes.length > 0 ? (
                <button onClick={() => void revealInFinder(project.dir)}>
                  {revealInFileManagerLabel()}
                </button>
              ) : null}
            </div>
          </Row>
        </Card>
      </Group>

      <Group
        title={t("settings.memory.notes", { count: project?.notes.length ?? 0 })}
        action={
          <div className="set-group-actions">
            <button className="btn-compact" onClick={() => void refresh({ key: projectKey, name: selName })}>
              {t("common.refresh")}
            </button>
            <button
              className="btn-compact"
              onClick={() => {
                setCreating(true);
                setSelName("");
              }}
            >
              {t("common.add")}
            </button>
          </div>
        }
      >
        {project && project.notes.length > 0 ? (
          <ul className="preset-list">
            {project.notes.map((n) => {
              const kl = kindLabel(n.kind);
              return (
                <li key={n.name}>
                  <button
                    className={!creating && n.name === selName ? "preset-row active" : "preset-row"}
                    onClick={() => {
                      setCreating(false);
                      setSelName(n.name);
                    }}
                    title={n.description}
                  >
                    <span className="preset-row-name">{n.name}</span>
                    <span className="preset-row-meta">
                      {kl ? `${t(kl)} · ` : ""}
                      {n.description}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : !creating ? (
          <div className="empty-state">
            <p className="empty-title">{t("settings.memory.empty.title")}</p>
            <p className="hint">{t("settings.memory.empty.hint")}</p>
          </div>
        ) : null}
      </Group>

      {project && (creating || note) ? (
        <NoteEditor
          key={creating ? "\u0000new" : `${project.key}/${note?.name}`}
          note={creating ? null : (note ?? null)}
          existingNames={project.notes.map((n) => n.name)}
          onSave={async (v) => {
            await memorySave({ root: activeRoot, key: project.key, ...v });
            onSaved();
            setCreating(false);
            await refresh({ key: project.key, name: v.name });
          }}
          onCancel={creating ? () => setCreating(false) : undefined}
          onRemove={note && !creating ? () => remove(note) : undefined}
        />
      ) : null}
    </>
  );
}

function projectLabel(p: ProjectMemory | undefined): string {
  if (!p) return "";
  return p.root ?? p.key;
}

function NoteEditor({
  note,
  existingNames,
  onSave,
  onCancel,
  onRemove,
}: {
  /** null = 新建。 */
  note: MemoryNote | null;
  existingNames: string[];
  onSave: (v: { name: string; kind: string; description: string; body: string }) => Promise<void>;
  onCancel?: (() => void) | undefined;
  onRemove?: (() => void) | undefined;
}) {
  const { t } = useT();
  const [name, setName] = useState(note?.name ?? "");
  const [kind, setKind] = useState<string>(note?.kind && kindLabel(note.kind) ? note.kind : "feedback");
  const [description, setDescription] = useState(note?.description ?? "");
  const [body, setBody] = useState(note?.body ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const dirty =
    note === null ||
    kind !== note.kind ||
    description !== note.description ||
    body.trim() !== note.body.trim();

  const save = async () => {
    setError("");
    const n = name.trim();
    if (!NAME_RE.test(n) || n === "memory") {
      setError(t("settings.memory.name.invalid"));
      return;
    }
    if (note === null && existingNames.includes(n)) {
      setError(t("settings.memory.name.taken", { name: n }));
      return;
    }
    if (!description.trim() || !body.trim()) {
      setError(t("settings.memory.required"));
      return;
    }
    setBusy(true);
    try {
      await onSave({ name: n, kind, description: description.trim(), body: body.trim() });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Group title={note ? note.name : t("settings.memory.new")}>
      <Card>
        {note === null ? (
          <Row title={t("settings.common.name")} desc={t("settings.memory.name.desc")}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              placeholder="prefers-small-commits"
              spellCheck={false}
              aria-label={t("settings.common.name")}
            />
          </Row>
        ) : null}
        <Row title={t("settings.memory.kind")} desc={t("settings.memory.kind.desc")}>
          <FieldSelect
            value={kind}
            onChange={setKind}
            options={KINDS.map((k) => ({
              value: k,
              label: t(`settings.memory.kind.${k}` as MessageKey),
              hint: t(`settings.memory.kind.${k}.hint` as MessageKey),
            }))}
            menuMinWidth={280}
          />
        </Row>
        <Row title={t("settings.memory.description")} desc={t("settings.memory.description.desc")} stack>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={200}
            spellCheck={false}
            aria-label={t("settings.memory.description")}
          />
        </Row>
        <Row title={t("settings.memory.body")} desc={t("settings.memory.body.desc")} stack>
          <ResizableTextarea
            className="preset-body-input"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={8}
            maxLength={4000}
            spellCheck={false}
            aria-label={t("settings.memory.body")}
          />
        </Row>
      </Card>
      {error ? <FormError text={error} /> : null}
      <div className="editor-foot">
        <span className="hint">
          {note?.updatedMs ? t("settings.memory.updated", { time: new Date(note.updatedMs).toLocaleString() }) : ""}
        </span>
        <div className="editor-foot-actions">
          {onRemove ? (
            <button className="btn-danger ghost-danger" onClick={onRemove}>
              {t("common.delete")}
            </button>
          ) : null}
          {onCancel ? <button onClick={onCancel}>{t("common.cancel")}</button> : null}
          <button className="primary" disabled={busy || !dirty} onClick={() => void save()}>
            {t("common.save")}
          </button>
        </div>
      </div>
    </Group>
  );
}
