/**
 * 输入区：contenteditable 编辑器（引用块/命令块）、附件（截图/文件）、
 * 斜杠菜单、@ 补全、模式与模型选择、排队面板。从 App.tsx 拆出。
 *
 * 消息内联编辑也走这一个组件（`variant: "edit"`）：同一套附件条、`+`、
 * 粘贴/拖放，不要再养一个只能改字的精简框。
 *
 * 纯文本解析在 `../lib/promptText`（与 Transcript 共用一份规则）；
 * contenteditable 的块机械在 `../lib/chipEditor`。
 *
 * 本文件只做分派；实现按职责拆在 `./composer/`：底部输入框（ComposerDock）、
 * 消息内联编辑（ComposerEdit）、排队面板、构建键，以及按会话存活的输入框
 * 状态（草稿、待发截图、模式缓存）。
 */

import { memo } from "react";

import { ComposerDock } from "./composer/ComposerDock";
import { ComposerEdit, type ComposerEditProps } from "./composer/ComposerEdit";

export type { ComposerEditProps } from "./composer/ComposerEdit";
export { QueuePanel } from "./composer/QueuePanel";
export { type PermissionPick, forgetComposerSession } from "./composer/state";

type ComposerDockProps = Parameters<typeof ComposerDock>[0];

function isComposerEdit(props: ComposerEditProps | ComposerDockProps): props is ComposerEditProps {
  return "variant" in props && props.variant === "edit";
}

/**
 * 输入框 dock 是 memo 的。流式输出时 Chat 每帧都重渲染（正文在长），
 * 而输入框的 props 在那期间一个都没变 —— 不挡的话，模型说一句话，
 * 输入框连同两个选择器、上下文环、排队面板跟着重画几百遍，打字都会
 * 被拖慢。调用方要给稳定的回调（见 App 里 Chat 的 send）。
 */
const ComposerDockMemo = memo(ComposerDock);

export function Composer(props: ComposerEditProps): ReturnType<typeof ComposerEdit>;
export function Composer(props: ComposerDockProps): ReturnType<typeof ComposerDock>;
export function Composer(props: ComposerEditProps | ComposerDockProps) {
  if (isComposerEdit(props)) return <ComposerEdit {...props} />;
  return <ComposerDockMemo {...props} />;
}

