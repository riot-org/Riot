//! 代码 / 纯文本预览，也是编辑器：打开就能改，⌘S 存回磁盘。
//!
//! 编辑器本体是 CodeMirror 6（lib/codeEditor，动态 import —— 只有真的
//! 打开代码文件才加载）。这里管编辑器之外的事：字节怎么解码、什么情况
//! 只读、保存、和磁盘上的改动（多半是 agent 写的）怎么对齐。
//!
//! 早先是 highlight.js 整篇高亮再一次贴进 DOM：250KB 的文件近三万个 span，
//! 抽屉开合时排版绘制压在动画中段，整个抽屉顿住。CodeMirror 只渲染视口
//! 附近的行，语法也是按需分片解析，见 lib/codeEditor 的头注释。

import { useEffect, useRef, useState } from "react";

import { isHostError, readFileBytes, writeFileText } from "../bridge";
import { useT } from "../i18n";
import type { EditorHandle } from "../lib/codeEditor";
import { sha256Hex } from "../lib/sha256";
import { markUnsaved } from "../lib/unsavedEdits";

/**
 * 进代码视图的扩展名（另有一路：名单外但嗅探像文本的，见 FilePreview）。
 * 语法由编辑器按文件名挑（language-data），这里只决定"走不走代码视图"。
 */
export const CODE_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "jsonc", "json5",
  "py", "rs", "go", "java", "c", "h", "cpp", "cc", "hpp", "cs", "php", "rb",
  "swift", "kt", "sql", "sh", "bash", "zsh", "yaml", "yml", "toml", "ini",
  "xml", "html", "htm", "vue", "svelte", "css", "scss", "less", "diff", "patch",
  "txt", "log",
]);

/**
 * 超过这个字节数只显示前段，并且只读 —— 截断的内容存回去等于把文件砍掉
 * 后半截。编辑器本身扛得住更大的文件（只渲染视口），卡的是一次过 IPC
 * 和解码的那份内存。
 */
const RENDER_MAX = 4 * 1024 * 1024;

/** 解码后的一份：编辑器的初始内容 + 存回去时要还原的格式。 */
export interface Decoded {
  text: string;
  /** 文件开头有 UTF-8 BOM。TextDecoder 会把它吃掉，存回去要补上。 */
  bom: boolean;
  lineSeparator: "\n" | "\r\n";
  /** 只读的原因（i18n 键的后缀）。null = 可编辑。 */
  readOnly: null | "lossy" | "mixedEol" | "truncated";
  /** 整份字节（不是截断后的）的 SHA-256 —— 保存时告诉宿主"我改的是这一版"。 */
  sha: string;
}

export function decode(buf: ArrayBuffer): Decoded {
  const bytes = new Uint8Array(buf);
  const sha = sha256Hex(bytes);
  const truncated = bytes.length > RENDER_MAX;
  const body = truncated ? bytes.subarray(0, RENDER_MAX) : bytes;
  const bom = body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf;
  let text: string;
  let lossy = false;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    // 非 UTF-8（老 GBK 文件、二进制误入）：显示成替换字符，但不许存 ——
    // 存回去就是把原文的字节全换成 U+FFFD。截断处切在多字节字符中间也会
    // 走到这里，那种本来就只读。
    text = new TextDecoder("utf-8", { fatal: false }).decode(body);
    lossy = true;
  }
  const crlf = text.includes("\r\n");
  // CRLF 文件里还夹着单独的 LF：按哪一种存都会改掉另一种的每一行。
  const mixed = crlf && /(^|[^\r])\n/.test(text);
  return {
    text,
    bom,
    lineSeparator: crlf && !mixed ? "\r\n" : "\n",
    readOnly: truncated ? "truncated" : lossy ? "lossy" : mixed ? "mixedEol" : null,
    sha,
  };
}

/** 编辑器外面那一条状态。null = 不显示。 */
type Bar =
  | { kind: "dirty" }
  | { kind: "saving" }
  | { kind: "error"; message: string }
  /** 磁盘上的文件变了，而这里有没存的修改。 */
  | { kind: "diskChanged"; disk: Decoded }
  /** 保存被宿主拒了：磁盘上已经不是打开时那一版。 */
  | { kind: "conflict" };

export default function CodeView({
  buf,
  name,
  path,
}: {
  buf: ArrayBuffer;
  /** 文件名。按它挑语法（Makefile / Dockerfile 这类没扩展名的也认）。 */
  name: string;
  /** 绝对路径，保存用。 */
  path: string;
}) {
  const { t } = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<EditorHandle | null>(null);
  const [ready, setReady] = useState(false);
  const [readOnly, setReadOnly] = useState<Decoded["readOnly"]>(null);
  const [bar, setBar] = useState<Bar | null>(null);

  /**
   * 编辑器内容是从磁盘的哪一版来的、存回去之前长什么样。
   *
   * 放 ref 不放 state：⌘S 是编辑器键位里调的回调，建编辑器时就绑死了，
   * 读 state 拿到的永远是第一次渲染的值。
   */
  const disk = useRef<{ decoded: Decoded; savedDoc: string } | null>(null);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);

  /** 脏不脏的唯一写入口：同步报给标签栏（圆点、关标签前确认）。 */
  const trackDirty = (d: boolean) => {
    if (dirtyRef.current === d) return;
    dirtyRef.current = d;
    markUnsaved(path, d);
  };

  const setDirty = (d: boolean) => {
    trackDirty(d);
    setBar((b) => {
      // 冲突、报错这类要用户处理的提示，不被"又敲了一个字"盖掉。
      if (b && b.kind !== "dirty") return b;
      return d ? { kind: "dirty" } : null;
    });
  };

  const save = async (opts?: { force?: boolean }) => {
    const ed = editorRef.current;
    const cur = disk.current;
    if (!ed || !cur || savingRef.current || cur.decoded.readOnly) return;
    if (!dirtyRef.current && !opts?.force) return;
    savingRef.current = true;
    setBar({ kind: "saving" });
    const body = ed.text();
    try {
      let base = cur.decoded.sha;
      if (opts?.force) {
        // "仍然覆盖"：拿磁盘现状的哈希当 base，宿主就放行。
        base = sha256Hex(new Uint8Array(await readFileBytes(path)));
      }
      const sha = await writeFileText(path, (cur.decoded.bom ? "﻿" : "") + body, base);
      // text 也要跟着换成存下去的这份：之后"放弃修改"回到的是刚存的版本，
      // 不是打开时那一版。
      disk.current = {
        decoded: { ...cur.decoded, sha, text: body },
        savedDoc: ed.doc().toString(),
      };
      // 保存期间又敲了字的话，存下去的是按 ⌘S 那一刻的内容，现在仍然是脏的。
      const stillDirty = ed.doc().toString() !== disk.current.savedDoc;
      trackDirty(stillDirty);
      setBar(stillDirty ? { kind: "dirty" } : null);
    } catch (e) {
      if (isHostError(e) && e.is("host.file.changedOnDisk")) {
        setBar({ kind: "conflict" });
      } else {
        setBar({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      savingRef.current = false;
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  // 建编辑器。只建一次（按 path 做 key 的组件，换文件是换实例）；之后
  // 磁盘内容的变化走下面那个 effect 原地换。
  //
  // 不等抽屉动画播完（MarkdownView 那种 useSlideSettled）：CodeMirror 只
  // 渲染视口里的几十行，建出来的 DOM 和文件大小无关，挂载那一下压在
  // 动画里也不掉帧。
  useEffect(() => {
    if (editorRef.current) return;
    let cancelled = false;
    const decoded = decode(buf);
    disk.current = { decoded, savedDoc: decoded.text.replace(/\r\n/g, "\n") };
    setReadOnly(decoded.readOnly);
    void import("../lib/codeEditor").then(({ createEditor }) => {
      if (cancelled || !hostRef.current) return;
      editorRef.current = createEditor(hostRef.current, {
        doc: decoded.text,
        filename: name,
        lineSeparator: decoded.lineSeparator,
        readOnly: decoded.readOnly !== null,
        onDocChange: (doc) => {
          const saved = disk.current?.savedDoc;
          // 先比长度：绝大多数按键之后长度就不一样，省掉一次整篇 toString。
          setDirty(saved === undefined || doc.length !== saved.length || doc.toString() !== saved);
        },
        onSave: () => void saveRef.current(),
      });
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
    // buf 只取建编辑器那一刻的；之后的新字节交给下一个 effect。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  useEffect(
    () => () => {
      editorRef.current?.destroy();
      editorRef.current = null;
      // 标签关了（确认过丢弃）：圆点跟着撤。
      if (dirtyRef.current) markUnsaved(path, false);
      dirtyRef.current = false;
    },
    // path 不会变（按 path 做 key 的组件）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // 磁盘上的字节变了（agent 改了文件、轮次结束重读、或者就是自己刚存的
  // 那一版读回来了）。
  useEffect(() => {
    const ed = editorRef.current;
    const cur = disk.current;
    if (!ready || !ed || !cur) return;
    const next = decode(buf);
    // 自己刚存的那一版：哈希对得上，什么都不用做。
    if (next.sha === cur.decoded.sha) return;
    if (dirtyRef.current) {
      // 这里有没存的修改，不能拿磁盘版本盖掉 —— 让用户选。
      setBar({ kind: "diskChanged", disk: next });
      return;
    }
    loadDisk(next);
    // loadDisk 只碰 ref 和 setState，每次渲染重建也没有要追的新值。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buf, ready]);

  /** 把编辑器换成磁盘上的这一版，丢掉这里的修改。 */
  const loadDisk = (next: Decoded) => {
    const ed = editorRef.current;
    if (!ed) return;
    disk.current = { decoded: next, savedDoc: next.text.replace(/\r\n/g, "\n") };
    ed.replaceDoc(next.text);
    setReadOnly(next.readOnly);
    trackDirty(false);
    setBar(null);
  };

  const reloadFromDisk = async () => {
    try {
      loadDisk(decode(await readFileBytes(path)));
    } catch (e) {
      setBar({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const discard = () => {
    const cur = disk.current;
    if (!cur) return;
    loadDisk(cur.decoded);
  };

  /**
   * 磁盘变了但保留这里的修改：认下磁盘上那一版是新的基准。之后"保存"
   * 覆盖它（哈希对得上，宿主放行），"放弃修改"回到它 —— 而不是回到
   * 最早打开、早已过时的那一版。
   */
  const keepMine = () => {
    if (bar?.kind !== "diskChanged") return;
    const d = bar.disk;
    disk.current = { decoded: d, savedDoc: d.text.replace(/\r\n/g, "\n") };
    setBar(null);
    setDirty(editorRef.current?.doc().toString() !== disk.current.savedDoc);
  };

  return (
    <div className="code-view">
      {readOnly ? (
        <div className="code-view-note">
          {readOnly === "truncated"
            ? t("transcript.fileEdit.readOnlyTruncated", { size: "4 MB" })
            : readOnly === "lossy"
              ? t("transcript.fileEdit.readOnlyLossy")
              : t("transcript.fileEdit.readOnlyMixedEol")}
        </div>
      ) : null}
      {bar ? (
        <EditBar
          bar={bar}
          onSave={save}
          onDiscard={discard}
          onLoadDisk={(d) => (d ? loadDisk(d) : void reloadFromDisk())}
          onKeepMine={keepMine}
        />
      ) : null}
      {ready ? null : (
        <div className="preview-panel-state">{t("transcript.preview.loadingEditor")}</div>
      )}
      {/* 建编辑器时就要挂在 DOM 里；建好之前藏着，占位那一行才居中。 */}
      <div
        ref={hostRef}
        className="code-view-editor"
        style={ready ? undefined : { display: "none" }}
      />
    </div>
  );
}

/** 编辑器上方的一条：没存的修改、保存中、冲突、报错。 */
function EditBar({
  bar,
  onSave,
  onDiscard,
  onLoadDisk,
  onKeepMine,
}: {
  bar: Bar;
  onSave: (opts?: { force?: boolean }) => Promise<void>;
  onDiscard: () => void;
  /** 传了就载入这一版；没传就现读一次磁盘。 */
  onLoadDisk: (disk?: Decoded) => void;
  onKeepMine: () => void;
}) {
  const { t } = useT();
  const mod = navigator.platform.toLowerCase().includes("mac") ? "⌘S" : "Ctrl+S";
  switch (bar.kind) {
    case "dirty":
      return (
        <div className="code-edit-bar">
          <span className="code-edit-bar-text">{t("transcript.fileEdit.unsaved")}</span>
          <button type="button" className="ghost" onClick={onDiscard}>
            {t("transcript.fileEdit.discard")}
          </button>
          <button type="button" className="primary" onClick={() => void onSave()} title={mod}>
            {t("transcript.fileEdit.save")}
          </button>
        </div>
      );
    case "saving":
      return (
        <div className="code-edit-bar">
          <span className="code-edit-bar-text">{t("transcript.fileEdit.saving")}</span>
        </div>
      );
    case "error":
      return (
        <div className="code-edit-bar warn">
          <span className="code-edit-bar-text">
            {t("transcript.fileEdit.saveFailed", { error: bar.message })}
          </span>
          <button type="button" className="primary" onClick={() => void onSave()}>
            {t("transcript.fileEdit.save")}
          </button>
        </div>
      );
    case "diskChanged":
      return (
        <div className="code-edit-bar warn">
          <span className="code-edit-bar-text">{t("transcript.fileEdit.diskChanged")}</span>
          <button type="button" className="ghost" onClick={onKeepMine}>
            {t("transcript.fileEdit.keepMine")}
          </button>
          <button type="button" className="primary" onClick={() => onLoadDisk(bar.disk)}>
            {t("transcript.fileEdit.loadDisk")}
          </button>
        </div>
      );
    case "conflict":
      return (
        <div className="code-edit-bar warn">
          <span className="code-edit-bar-text">{t("transcript.fileEdit.conflict")}</span>
          <button type="button" className="ghost" onClick={() => onLoadDisk()}>
            {t("transcript.fileEdit.loadDisk")}
          </button>
          <button type="button" className="primary" onClick={() => void onSave({ force: true })}>
            {t("transcript.fileEdit.overwrite")}
          </button>
        </div>
      );
  }
}
