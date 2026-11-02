/**
 * 正文里能认回块的 `/名字`：技能，以及不就地执行 / 展开的命令。文本 → 块
 * （[`promptToSegs`]：气泡、放回输入框、改已发消息）只认这份名单 ——
 * "/tmp 是什么"里的 `/tmp` 只是一个词。可执行的命令不在里面：它们发出去
 * 的是展开结果，正文里不会留下 `/名字`。
 *
 * 模块级缓存按项目根存：每个气泡都要用，各自拉一次就是一屏几十次 IPC。
 * 输入框拉到新清单时经 [`rememberSlashCommands`] 写进来，加了技能不用
 * 重启也能认。
 */

import { useEffect, useState } from "react";

import { type SlashCommand, slashCommands } from "../bridge";

const EMPTY: ReadonlySet<string> = new Set();

const cache = new Map<string, ReadonlySet<string>>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

/** 可执行 / 可展开的命令（一条消息只能有一个，总在句首）。 */
export function isRunnableSlash(c: SlashCommand | undefined): boolean {
  return c !== undefined && (c.source === "builtin" || c.expandInline);
}

/** 输入框拉到清单后调：更新这个项目的名单，已挂着的气泡跟着重画。 */
export function rememberSlashCommands(root: string | null, cmds: SlashCommand[]) {
  cache.set(root ?? "", new Set(cmds.filter((c) => !isRunnableSlash(c)).map((c) => c.name)));
  for (const cb of listeners) cb();
}

export function useInlineSlashNames(root: string | null): ReadonlySet<string> {
  const key = root ?? "";
  const [, bump] = useState(0);

  useEffect(() => {
    const cb = () => bump((n) => n + 1);
    listeners.add(cb);
    if (!cache.has(key) && !inflight.has(key)) {
      inflight.set(
        key,
        slashCommands(root)
          .then((cmds) => rememberSlashCommands(root, cmds))
          .catch(() => {})
          .finally(() => inflight.delete(key)),
      );
    }
    return () => {
      listeners.delete(cb);
    };
  }, [key, root]);

  return cache.get(key) ?? EMPTY;
}
