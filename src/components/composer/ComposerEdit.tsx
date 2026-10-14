import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  clipboardPaths,
  existingDirs,
  host,
  type ImageInput,
  pickFiles,
  readImage,
} from "../../bridge";
import { useT } from "../../i18n";
import { promptToSegs, segsToPrompt } from "../../lib/promptText";
import { registerFileDrop } from "../../lib/fileDrag";
import {
  IMAGE_EXT,
  MAX_SHOTS,
  type Shot,
  hasAttachment,
  mergeShots,
  shotToInput,
  shotsFromDataUrls,
  toShot,
} from "../../lib/shots";
import { asDirRef } from "../../pathDisplay";
import {
  caretToEnd,
  guardChipDeletes,
  handleChipKey,
  IME_TAIL_MS,
  insertChipAtCaret,
  insertLineBreak,
  normalizePads,
  readEditor,
  writeEditor,
} from "../../lib/chipEditor";
import { PlusIcon } from "../icons";
import { ProjectRootContext } from "../Markdown";
import { ShotViewer } from "../ToolCard";

/**
 * 对话流里改一条消息。皮和底部输入框是同一个 Composer：附件条、`+`、
 * contenteditable、粘贴/拖放。没有模式/模型/排队 —— 那些是会话级的，
 * 改一条历史不该动它们。
 *
 * 用户消息解析块、允许附图；助手消息保持纯文本，回复里长得像 `@路径`
 * 的字符串是内容，解析成块再序列化会改写它。
 *
 * 两种落法：发送（丢掉之后的一切再跑）和保存（只换上下文原文）。
 * Esc 取消。落不成时框留着，草稿不能丢。
 */
export type ComposerEditProps = {
  variant: "edit";
  initial: string;
  initialImages?: string[];
  parseChips?: boolean;
  allowImages?: boolean;
  onSave: (text: string, images?: ImageInput[]) => Promise<boolean>;
  onResend?: (text: string, images?: ImageInput[]) => Promise<boolean>;
  /**
   * 点发送之后、进入发送态之前。用来弹「会回退文件」的确认。
   * false = 用户取消，框留着、不进发送中。
   */
  onBeforeResend?: () => Promise<boolean>;
  onCancel: () => void;
};

export function ComposerEdit({
  initial,
  initialImages = [],
  parseChips = false,
  allowImages = false,
  onSave,
  onResend,
  onBeforeResend,
  onCancel,
}: ComposerEditProps) {
  const { t } = useT();
  const workspace = useContext(ProjectRootContext);
  const [saving, setSaving] = useState<"save" | "resend" | null>(null);
  /** 发送前确认框还开着：别让 Esc / 取消把编辑框拆掉。 */
  const [gating, setGating] = useState(false);
  const [hasText, setHasText] = useState(!!initial.trim());
  const [shots, setShots] = useState<Shot[]>(() => shotsFromDataUrls(initialImages));
  const [viewShot, setViewShot] = useState<Shot | null>(null);
  const [dropError, setDropError] = useState("");
  const [treeOver, setTreeOver] = useState(false);
  const shotsLive = useRef(shots);
  shotsLive.current = shots;
  const ref = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imeRef = useRef(false);
  const imeEndAt = useRef(-Infinity);

  const read = () => (ref.current ? segsToPrompt(readEditor(ref.current)) : "");

  const refresh = () => {
    const el = ref.current;
    if (!el) return;
    if (!imeRef.current) normalizePads(el);
    setHasText(read().trim().length > 0);
  };

  const canCommit = hasText || (allowImages && shots.length > 0);

  const addShots = async (items: { data: string; mediaType: string; name: string }[]) => {
    const { shots: next, extra } = await mergeShots(shotsLive.current, items);
    if (extra) setDropError(t("composer.attach.tooMany", { max: MAX_SHOTS, extra }));
    setShots(next);
  };

  const takeFiles = async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith("image/"));
    const rest = files.filter((f) => !f.type.startsWith("image/"));
    if (images.length) {
      await addShots(await Promise.all(images.map(toShot)));
    }
    if (rest.length) {
      setDropError(
        t("composer.attach.notImage", { name: rest[0]?.name ?? t("composer.attach.thisFile") }),
      );
    }
  };

  const takePaths = async (paths: string[]) => {
    const images = paths.filter((p) => IMAGE_EXT.test(p));
    const files = paths.filter((p) => !IMAGE_EXT.test(p));
    if (images.length && allowImages) {
      const readPaths = await Promise.all(
        images.map((p) => readImage(p).catch((e: unknown) => String(e))),
      );
      const ok = readPaths.filter(
        (r): r is Awaited<ReturnType<typeof readImage>> => typeof r !== "string",
      );
      await addShots(ok);
      const failed = readPaths.filter((r): r is string => typeof r === "string");
      if (failed.length) setDropError(failed[0] ?? "");
    }
    if (files.length && parseChips) {
      const el = ref.current;
      if (el) {
        el.focus();
        const sel = window.getSelection();
        const inside =
          sel && sel.rangeCount > 0 && el.contains(sel.getRangeAt(0).startContainer);
        if (!inside) caretToEnd(el);
        const dirs = await existingDirs(files).catch(() => new Set<string>());
        for (const p of files) {
          const inWs = workspace && (p.startsWith(`${workspace}/`) || p.startsWith(`${workspace}\\`));
          const value = inWs ? p.slice(workspace.length + 1) : p;
          insertChipAtCaret(el, {
            kind: "ref",
            value: dirs.has(p) ? asDirRef(value) : value,
          });
        }
        refresh();
      }
    }
  };

  const pasteFiles = async (files: File[]): Promise<boolean> => {
    const paths = await clipboardPaths().catch(() => []);
    if (paths.length) {
      await takePaths(paths);
      return true;
    }
    if (files.length) {
      await takeFiles(files);
      return true;
    }
    return false;
  };

  const pickAttachments = () => {
    if (host.nativePaths) {
      void pickFiles().then(takePaths).catch(() => {});
      return;
    }
    fileInputRef.current?.click();
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    writeEditor(el, parseChips ? promptToSegs(initial) : [{ kind: "text", value: initial }]);
    el.focus();
    caretToEnd(el);
    // 只在挂载时灌一次：编辑区是非受控的，内容住在 DOM 里。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return guardChipDeletes(
      el,
      () => imeRef.current || performance.now() - imeEndAt.current < IME_TAIL_MS,
      refresh,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const takePathsRef = useRef(takePaths);
  takePathsRef.current = takePaths;
  useEffect(() => {
    const el = formRef.current;
    if (!el) {
      setTreeOver(false);
      return;
    }
    return registerFileDrop({
      el,
      onOver: setTreeOver,
      onDrop: (item) => {
        setTreeOver(false);
        void takePathsRef.current([item.abs]);
      },
    });
  }, []);

  const commit = async (
    kind: "save" | "resend",
    op: (text: string, images?: ImageInput[]) => Promise<boolean>,
  ) => {
    const text = read().trim();
    if (saving || (!text && shotsLive.current.length === 0)) return;
    const images = allowImages ? shotsLive.current.map(shotToInput) : undefined;
    setSaving(kind);
    try {
      await op(text, images);
    } finally {
      setSaving(null);
    }
  };
  const save = () => commit("save", onSave);
  const blocked = saving !== null || gating;
  const primary = async () => {
    if (blocked) return;
    if (!onResend) {
      save();
      return;
    }
    if (onBeforeResend) {
      setGating(true);
      try {
        if (!(await onBeforeResend())) return;
      } finally {
        setGating(false);
      }
    }
    void commit("resend", onResend);
  };

  return (
    <div className="composer-wrap">
      {dropError ? (
        <button
          type="button"
          className="key-banner"
          onClick={() => setDropError("")}
          title={t("composer.banner.dismiss")}
        >
          {dropError}
        </button>
      ) : null}

      <form
        ref={formRef}
        className={treeOver ? "composer dragging" : "composer"}
        onSubmit={(e) => {
          e.preventDefault();
          void primary();
        }}
      >
        {allowImages && shots.length ? (
          <div className="attachments">
            {shots.map((s) => (
              <div className="attachment" key={s.id} title={s.name}>
                <button
                  type="button"
                  className="attachment-view"
                  onClick={() => setViewShot(s)}
                  aria-label={t("composer.attach.view", { name: s.name })}
                >
                  <img src={`data:${s.mediaType};base64,${s.data}`} alt={s.name} />
                </button>
                <button
                  type="button"
                  className="attachment-remove"
                  onClick={() => setShots((prev) => prev.filter((x) => x.id !== s.id))}
                  aria-label={t("common.remove")}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {viewShot ? (
          <ShotViewer
            src={`data:${viewShot.mediaType};base64,${viewShot.data}`}
            alt={viewShot.name}
            onClose={() => setViewShot(null)}
          />
        ) : null}

        <div
          ref={ref}
          className={hasText || shots.length ? "composer-input" : "composer-input empty"}
          contentEditable={!blocked}
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label={t("transcript.msg.editLabel")}
          onInput={refresh}
          onCompositionStart={() => {
            imeRef.current = true;
          }}
          onCompositionEnd={() => {
            imeEndAt.current = performance.now();
            setTimeout(() => {
              imeRef.current = false;
            }, 0);
            refresh();
          }}
          onPaste={(e) => {
            e.preventDefault();
            const text = e.clipboardData.getData("text/plain");
            if (allowImages && hasAttachment(e.clipboardData)) {
              void pasteFiles(Array.from(e.clipboardData.files)).then((took) => {
                if (took) return;
                ref.current?.focus();
                document.execCommand("insertText", false, text);
                refresh();
              });
              return;
            }
            document.execCommand("insertText", false, text);
            refresh();
          }}
          onKeyDown={(e) => {
            const el = ref.current;
            const imeKey = e.nativeEvent.isComposing || e.keyCode === 229 || imeRef.current;
            if (el && !imeKey) {
              const lineBreak = e.key === "Enter" && !e.metaKey && !e.ctrlKey;
              if (handleChipKey(e, el) || (lineBreak && insertLineBreak(el))) {
                e.preventDefault();
                refresh();
                return;
              }
            }
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void primary();
            } else if (e.key === "Escape" && !imeKey && !blocked) {
              e.preventDefault();
              e.stopPropagation();
              onCancel();
            }
          }}
        />

        <div className="composer-bar">
          <div className="composer-tools">
            {allowImages ? (
              <>
                <button
                  type="button"
                  className="composer-icon"
                  onClick={pickAttachments}
                  disabled={blocked}
                  title={host.nativePaths ? t("composer.attach.title") : t("composer.attach.title.web")}
                  aria-label={t("composer.attach.title")}
                >
                  <PlusIcon />
                </button>
                {host.nativePaths ? null : (
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    hidden
                    onChange={(e) => {
                      const files = Array.from(e.target.files ?? []);
                      e.target.value = "";
                      if (files.length) void takeFiles(files);
                    }}
                  />
                )}
              </>
            ) : null}
            <span className="composer-edit-hint">
              {onResend ? t("transcript.editor.hintResend") : t("transcript.editor.hintSave")}
            </span>
          </div>
          <div className="composer-actions">
            <button type="button" onClick={onCancel} disabled={blocked}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className={onResend ? undefined : "composer-edit-save"}
              onClick={() => void save()}
              disabled={blocked || !canCommit}
              title={onResend ? t("transcript.editor.saveOnlyTitle") : undefined}
            >
              {saving === "save" ? t("common.saving") : t("common.save")}
            </button>
            {onResend ? (
              <button
                type="submit"
                className="composer-edit-save"
                disabled={blocked || !canCommit}
                title={t("transcript.editor.resendTitle")}
              >
                {saving === "resend" ? t("transcript.editor.sending") : t("transcript.editor.send")}
              </button>
            ) : null}
          </div>
        </div>
      </form>
    </div>
  );
}

