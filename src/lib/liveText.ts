import { useSyncExternalStore } from "react";

/**
 * 正在流的正文和思考，单独放一个小 store。
 *
 * `[约束]` 不能作为 prop 一路传给 Transcript。流式期间它每帧都在变，
 * 作为 prop 就是整个 Transcript 每帧重跑一遍：几百个 memo 行逐个比对、
 * 分组和各个 effect 的依赖也跟着重新求值 —— 开销跟会话长度成正比，越
 * 长的会话生成时越卡。Claude 桌面版的做法：对话列表结构在流式期间保持
 * 不变，正在长的那段文字放在列表外面，只有画它的那个叶子组件订阅。这里
 * 照做：Transcript 只拿"有没有在流"两个布尔值，正文 / 思考由
 * LiveMarkdown 这类叶子各自订阅（见 useLiveText）。
 */
export interface LiveText {
  text: string;
  thinking: string;
}

export interface LiveTextStore {
  get(): LiveText;
  set(next: LiveText): void;
  subscribe(fn: () => void): () => void;
}

export function createLiveTextStore(initial: LiveText): LiveTextStore {
  let cur = initial;
  const subs = new Set<() => void>();
  return {
    get: () => cur,
    set(next) {
      if (next.text === cur.text && next.thinking === cur.thinking) return;
      cur = next;
      for (const fn of subs) fn();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

/** 订阅 store 里的一个字段。只在这个字段变了时重渲染。 */
export function useLiveText(store: LiveTextStore, field: keyof LiveText): string {
  return useSyncExternalStore(
    store.subscribe,
    () => store.get()[field],
    () => store.get()[field],
  );
}
