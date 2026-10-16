/**
 * 文件预览里的代码编辑器（CodeMirror 6）。CodeView 动态 import 这个模块，
 * 只有真的打开代码文件才加载 —— 启动 bundle 不背编辑器。
 *
 * 为什么换掉"hljs 整篇高亮 + 一次贴进 DOM"：
 * - **虚拟化**。CodeMirror 只把视口附近的行放进 DOM。250KB 的 HTML 用 hljs
 *   整篇高亮是近三万个 span，一次排版绘制就是几百毫秒；这里同时在 DOM 里
 *   的只有几十行。
 * - **增量解析**。语法树按需、分片地解析，大文件不会在主线程上一口气算完。
 * - **能改**。打开就是编辑器，⌘S 保存（保存和冲突处理在 CodeView）。
 *
 * 配色不另配一套：记号打的是 highlight.js 的类名（见 HLJS_CLASSES），
 * 聊天代码块那份 github 主题（Markdown.tsx 全局注入、跟着深浅切换）直接
 * 生效 —— 预览和对话里的代码颜色一致。
 */

import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  indentOnInput,
  LanguageDescription,
  syntaxHighlighting,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Text, Transaction } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tagHighlighter, tags as t } from "@lezer/highlight";

/**
 * lezer 记号 → highlight.js 类名。没列的记号不上色（落到正文色），和
 * hljs 的默认一样。顺序无关：tagHighlighter 按记号的继承链挑最具体的那条。
 */
const HLJS_CLASSES = tagHighlighter([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], class: "hljs-keyword" },
  { tag: [t.definitionKeyword, t.moduleKeyword], class: "hljs-keyword" },
  { tag: [t.self, t.special(t.variableName)], class: "hljs-variable language_" },
  { tag: [t.typeName, t.namespace], class: "hljs-type" },
  { tag: [t.className, t.definition(t.typeName)], class: "hljs-title class_" },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))],
    class: "hljs-title function_",
  },
  { tag: [t.number, t.integer, t.float], class: "hljs-number" },
  { tag: [t.bool, t.null, t.atom], class: "hljs-literal" },
  { tag: [t.string, t.special(t.string), t.docString, t.character], class: "hljs-string" },
  { tag: t.regexp, class: "hljs-regexp" },
  { tag: t.escape, class: "hljs-char escape_" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: "hljs-comment" },
  { tag: [t.meta, t.processingInstruction, t.documentMeta, t.annotation], class: "hljs-meta" },
  { tag: [t.tagName, t.angleBracket], class: "hljs-name" },
  { tag: t.attributeName, class: "hljs-attr" },
  { tag: t.attributeValue, class: "hljs-string" },
  { tag: t.propertyName, class: "hljs-property" },
  { tag: [t.constant(t.variableName), t.standard(t.variableName)], class: "hljs-built_in" },
  { tag: t.operator, class: "hljs-operator" },
  { tag: t.heading, class: "hljs-section" },
  { tag: t.list, class: "hljs-bullet" },
  { tag: t.emphasis, class: "hljs-emphasis" },
  { tag: t.strong, class: "hljs-strong" },
  { tag: [t.link, t.url], class: "hljs-link" },
  { tag: t.inserted, class: "hljs-addition" },
  { tag: t.deleted, class: "hljs-deletion" },
  { tag: t.labelName, class: "hljs-symbol" },
]);

/**
 * language-data 按文件名认不出、但一看就知道是什么的那些（小写比对）。
 * 值是 language-data 里的语言名。
 */
const NAME_ALIASES: Record<string, string> = {
  ".bashrc": "Shell",
  ".zshrc": "Shell",
  ".profile": "Shell",
  ".bash_profile": "Shell",
  ".zprofile": "Shell",
  ".env": "Properties files",
  ".gitconfig": "Properties files",
  ".npmrc": "Properties files",
  ".editorconfig": "Properties files",
};
const EXT_ALIASES: Record<string, string> = {
  zsh: "Shell",
  json5: "JSON",
  jsonc: "JSON",
  svelte: "HTML",
};

function describeLanguage(name: string): LanguageDescription | null {
  const lower = name.toLowerCase();
  const alias =
    NAME_ALIASES[lower] ??
    (/^\.env(\.|$)/.test(lower) ? "Properties files" : undefined) ??
    EXT_ALIASES[lower.slice(lower.lastIndexOf(".") + 1)];
  if (alias) return LanguageDescription.matchLanguageName(languages, alias, false);
  return LanguageDescription.matchFilename(languages, name);
}

/**
 * 编辑器外观。字号、行高和回答里的代码块是同一档（13px / 20px 一行，对齐
 * Claude 桌面端的代码字号：正文 14px，代码只小一号 —— 小两号的话，代码里
 * 的中文注释紧挨着 14px 的对话正文，明显矮一截）。颜色全走 Riot 的 CSS
 * 变量 —— 深浅主题切换时不用重建编辑器。
 */
const THEME = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  // 不回弹：抽屉里的独立面板，滚到头没有外层要接力（同 .file-tree-list）。
  ".cm-scroller": {
    fontFamily: "var(--mono)",
    lineHeight: "1.5385",
    overflowX: "hidden",
    overscrollBehavior: "none",
  },
  ".cm-content": { padding: "12px 0", caretColor: "var(--text)" },
  ".cm-line": { padding: "0 16px 0 14px" },
  ".cm-gutters": {
    backgroundColor: "var(--bg)",
    color: "color-mix(in srgb, var(--text-faint) 70%, transparent)",
    borderRight: "1px solid var(--border)",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 14px", minWidth: "28px" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--text) 4%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text-dim)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground":
    { backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent)" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--accent) 16%, transparent)" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "color-mix(in srgb, var(--accent) 22%, transparent)",
    outline: "none",
  },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--warn) 30%, transparent)" },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "color-mix(in srgb, var(--warn) 55%, transparent)",
  },
  ".cm-panels": {
    backgroundColor: "var(--bg-card)",
    color: "var(--text)",
    borderColor: "var(--border)",
  },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
});

export interface EditorHandle {
  /** 磁盘上的新内容换进来（agent 改了文件、用户选了载入磁盘版本）。不进撤销栈。 */
  replaceDoc(text: string): void;
  /** 当前全文，行分隔符按文件原样（CRLF 文件还是 CRLF）。 */
  text(): string;
  doc(): Text;
  focus(): void;
  destroy(): void;
}

export interface EditorOptions {
  doc: string;
  /** 文件名，按它挑语法。 */
  filename: string;
  /** 文件原本的换行。CRLF 文件改完存回去还是 CRLF，不会整篇进 diff。 */
  lineSeparator: "\n" | "\r\n";
  readOnly: boolean;
  /** 每次文档变化（含 replaceDoc）。 */
  onDocChange(doc: Text): void;
  /** ⌘S / Ctrl+S。 */
  onSave(): void;
}

export function createEditor(parent: HTMLElement, opts: EditorOptions): EditorHandle {
  const language = new Compartment();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: opts.doc,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        highlightSelectionMatches(),
        search({ top: true }),
        syntaxHighlighting(HLJS_CLASSES),
        language.of([]),
        // 自动换行，不出横向滚动条：抽屉窄，横着滚读长行比折行难受。
        // CodeMirror 的折行带 overflow-wrap: anywhere，base64、长 URL 这类
        // 没有断点的长串也会折。
        EditorView.lineWrapping,
        EditorState.lineSeparator.of(opts.lineSeparator),
        EditorState.readOnly.of(opts.readOnly),
        // `hljs` 类给正文上 hljs 主题的基础字色（深色 #adbac7）。它自带的
        // 底色由 styles.css 的 .code-view 规则清掉。
        EditorView.contentAttributes.of({ class: "hljs" }),
        keymap.of([
          // 保存放最前：Mod-s 不能被别的键位先吃掉。
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              opts.onSave();
              return true;
            },
          },
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          // Tab 缩进而不是跳焦点。Esc 之后再按 Tab 照常离开编辑器（CM 自带）。
          indentWithTab,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) opts.onDocChange(u.state.doc);
        }),
        THEME,
      ],
    }),
  });

  // 语法异步加载（language-data 每种语言一个 chunk）。加载完之前是纯文本，
  // 落定后语法树在后台分片解析 —— 不阻塞首屏。
  const desc = describeLanguage(opts.filename);
  if (desc) {
    void desc.load().then(
      (support) => {
        if (!view.dom.isConnected) return;
        view.dispatch({ effects: language.reconfigure(support) });
      },
      () => {
        /* 语法包加载失败就留在纯文本，不影响查看和编辑 */
      },
    );
  }

  return {
    replaceDoc(text) {
      // `[约束]` 在"换行算一个字符"的形态上比。文档位置里一个换行就是
      // 一格，而 CRLF 文件的原文每个换行占两个字符 —— 拿原文算出来的偏移
      // 去改文档，从第一个换行往后全部错位。插入时再换回文件自己的换行
      // （按 lineSeparator 切行，给 \n 会被当成行内字符）。
      const sep = opts.lineSeparator;
      const next = sep === "\n" ? text : text.replace(/\r\n/g, "\n");
      const cur = view.state.doc.toString();
      if (cur === next) return;
      // 只替换真正变了的那一段（掐掉首尾相同的部分）。整篇替换会把光标、
      // 选区甩回开头，而用户多半正盯着某一段看 agent 改了什么。
      let head = 0;
      const max = Math.min(cur.length, next.length);
      while (head < max && cur.charCodeAt(head) === next.charCodeAt(head)) head++;
      let tail = 0;
      while (
        tail < max - head &&
        cur.charCodeAt(cur.length - 1 - tail) === next.charCodeAt(next.length - 1 - tail)
      ) {
        tail++;
      }
      const insert = next.slice(head, next.length - tail);
      view.dispatch({
        changes: {
          from: head,
          to: cur.length - tail,
          insert: sep === "\n" ? insert : insert.replace(/\n/g, sep),
        },
        // 磁盘来的改动不进撤销栈：⌘Z 撤的是用户自己的编辑，不是把 agent
        // 刚写的东西撤回去。
        annotations: Transaction.addToHistory.of(false),
      });
    },
    text: () => view.state.sliceDoc(),
    doc: () => view.state.doc,
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
