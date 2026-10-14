import { type SessionInfo, isHostError } from "../bridge";


export function samplingEq(a: SessionInfo["sampling"], b: SessionInfo["sampling"]): boolean {
  return (
    a.temperature === b.temperature &&
    a.topP === b.topP &&
    a.topK === b.topK &&
    a.maxOutputTokens === b.maxOutputTokens
  );
}

export function thinkingEq(a: SessionInfo["thinking"], b: SessionInfo["thinking"]): boolean {
  if (a.mode !== b.mode) return false;
  // fixed 之外的几档没有别的字段，mode 相同就是相同。
  return (a.mode === "fixed" ? a.level : null) === (b.mode === "fixed" ? b.level : null);
}

/**
 * 两条会话在界面看得见的层面上是不是同一份。
 *
 * `[约束]` 字段增删要跟着 `SessionInfo` 走。漏比一个字段的表现是"改了
 * 设置侧栏不更新"，而不是报错 —— 所以宁可多比一个也别漏。
 */
export function sessionEq(a: SessionInfo, b: SessionInfo): boolean {
  return (
    a.id === b.id &&
    a.root === b.root &&
    a.title === b.title &&
    a.seq === b.seq &&
    a.mode === b.mode &&
    a.multitask === b.multitask &&
    a.pythonVenv === b.pythonVenv &&
    a.systemPrompt === b.systemPrompt &&
    a.provider === b.provider &&
    a.model === b.model &&
    a.busy === b.busy &&
    thinkingEq(a.thinking, b.thinking) &&
    samplingEq(a.sampling, b.sampling)
  );
}

export function sessionListEq(a: SessionInfo[], b: SessionInfo[]): boolean {
  return (
    a.length === b.length &&
    a.every((s, i) => {
      const o = b[i];
      return o !== undefined && sessionEq(s, o);
    })
  );
}

/** 宿主把缺目录收成 `host.project.missing`；路径解析不了的也当同一类处理。按键判，不比文案。 */
export function isMissingProjectError(e: unknown): boolean {
  return isHostError(e) && (e.is("host.project.missing") || e.is("host.fence.unresolvable"));
}

/** 两个字符串集合装的是不是同一批东西。 */
export function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

/** patch 里的每个字段是不是都已经是这个值了。 */
export function patchApplied(cur: SessionInfo, patch: Partial<SessionInfo>): boolean {
  return (Object.keys(patch) as (keyof SessionInfo)[]).every((k) => cur[k] === patch[k]);
}

