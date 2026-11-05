/**
 * 模型菜单的「最近使用」：最近选过的几个「服务方 + 模型」。纯 UI 偏好，
 * 存 localStorage，不进宿主配置。
 */

const KEY = "riot.model.recent";
const MAX = 3;

export interface Endpoint {
  provider: string;
  model: string;
}

/** 菜单项 id。换行不会出现在服务方或模型 id 里。 */
export function endpointKey(e: Endpoint): string {
  return `${e.provider}\n${e.model}`;
}

export function parseEndpointKey(key: string): Endpoint {
  const i = key.indexOf("\n");
  return i < 0 ? { provider: "", model: key } : { provider: key.slice(0, i), model: key.slice(i + 1) };
}

export function loadRecentModels(): Endpoint[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(v)) return [];
    return v.filter(
      (e): e is Endpoint =>
        !!e && typeof e === "object" && typeof e.provider === "string" && typeof e.model === "string",
    );
  } catch {
    return [];
  }
}

export function pushRecentModel(e: Endpoint): Endpoint[] {
  const next = [e, ...loadRecentModels().filter((x) => endpointKey(x) !== endpointKey(e))].slice(
    0,
    MAX,
  );
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // 存不下就只在这次进程里生效，不影响切换本身。
  }
  return next;
}
