/**
 * 环境变量按名字前缀归组，给设置页分块显示用。存储和注入仍是扁平的：
 * shell 只认 `$NAME`，组只是看的时候的结构。
 *
 * 两条规则，先显式后推断：
 * - 名字里有 `__`：前面那段就是组（`SSH_PROD__HOST` → `SSH_PROD`）。用户
 *   这么起名就是想分组，只有一个变量也成组。
 * - 否则取至少两个变量共有的最长 `_` 前缀（`PERF_SYSTEM_URL`、
 *   `PERF_SYSTEM_USER` → `PERF_SYSTEM`）。凑不出两个的不成组。
 */

export interface EnvGroup<T> {
  /** 组名；`null` 是没归进任何组的那些。 */
  prefix: string | null;
  /** 组内新加变量时名字的前缀（`SSH_PROD__` / `PERF_SYSTEM_`）。 */
  stem: string;
  items: T[];
}

export function groupEnvVars<T extends { name: string }>(
  vars: T[],
): EnvGroup<T>[] {
  const groups = new Map<string, { stem: string; items: T[] }>();
  const loose: T[] = [];
  const add = (key: string, stem: string, v: T) => {
    const g = groups.get(key);
    if (g) g.items.push(v);
    else groups.set(key, { stem, items: [v] });
  };

  const implicit: T[] = [];
  for (const v of vars) {
    const i = v.name.indexOf("__");
    if (i > 0) add(v.name.slice(0, i), `${v.name.slice(0, i)}__`, v);
    else implicit.push(v);
  }

  const inferred = new Map<string, T[]>();
  for (const v of implicit) {
    const key = sharedPrefix(v.name, implicit);
    if (key === null) {
      loose.push(v);
      continue;
    }
    const list = inferred.get(key);
    if (list) list.push(v);
    else inferred.set(key, [v]);
  }
  // 各取最长前缀后可能落单（`A_B_C`、`A_B_D`、`A_E` 里的 `A_E`）。
  for (const [key, items] of inferred) {
    if (items.length < 2 && !groups.has(key)) loose.push(...items);
    else for (const v of items) add(key, `${key}_`, v);
  }

  const out: EnvGroup<T>[] = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([prefix, g]) => ({ prefix, stem: g.stem, items: g.items }));
  if (loose.length > 0) {
    loose.sort((a, b) => a.name.localeCompare(b.name));
    out.push({ prefix: null, stem: "", items: loose });
  }
  return out;
}

/** `name` 和 `pool` 里至少另一个变量共有的最长 `_` 前缀。 */
function sharedPrefix<T extends { name: string }>(
  name: string,
  pool: T[],
): string | null {
  const tokens = name.split("_");
  for (let k = tokens.length - 1; k >= 1; k--) {
    const prefix = tokens.slice(0, k).join("_");
    if (!prefix) continue;
    const head = `${prefix}_`;
    if (pool.some((o) => o.name !== name && o.name.startsWith(head)))
      return prefix;
  }
  return null;
}

/** 组内显示用的短名：去掉组前缀和连接的下划线。 */
export function envFieldName(name: string, prefix: string | null): string {
  if (!prefix || !name.startsWith(prefix)) return name;
  return name.slice(prefix.length).replace(/^_+/, "") || name;
}
