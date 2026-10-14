import { useCallback, useEffect, useRef, useState } from "react";

import type { SessionInfo } from "../bridge";
import { LS, loadRecency } from "../lib/layout";

/**
 * 侧栏的"最近聊过"顺序：每个会话最近一次真开聊的时刻，存 localStorage。
 *
 * 会话开跑（含后台定时任务）时顶到它那组最前；会话删掉后从表里拿掉。
 * 从 App 拆出 —— 它只依赖会话列表和"启动完了没有"。
 */
export function useSessionRecency(sessions: SessionInfo[], booting: boolean) {
  /** 每个会话最近一次真开聊的时刻。侧栏同项目里按它倒序。 */
  const [recency, setRecency] = useState(loadRecency);
  /**
   * 把会话顶到它那组最前。
   *
   * `[约束]` 只在**真开聊**（开轮）和新建时调，切换会话不算。翻旧会话
   * 找一句话是高频动作，跟着改顺序的话，用户扫两眼列表就被重排一遍，
   * 再也回不到刚才看的位置。
   */
  const touchSession = useCallback((id: string) => {
    setRecency((prev) => {
      const next = { ...prev, [id]: Date.now() };
      localStorage.setItem(LS.recency, JSON.stringify(next));
      return next;
    });
  }, []);
  const sawBusy = useRef(new Set<string>());
  // 会话刚开跑（含后台定时任务）顶到该项目最前。启动那次 busy 快照
  // 不当作一次新的聊天 —— 否则每次打开 App 列表都会被正在跑的会话打乱。
  useEffect(() => {
    const now = new Set(sessions.filter((s) => s.busy).map((s) => s.id));
    if (!booting) {
      for (const id of now) {
        if (!sawBusy.current.has(id)) touchSession(id);
      }
    }
    sawBusy.current = now;
  }, [sessions, booting, touchSession]);

  // 删掉的会话从顺序表里拿掉，免得 localStorage 越积越大。
  useEffect(() => {
    if (booting) return;
    const alive = new Set(sessions.map((s) => s.id));
    setRecency((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const id of Object.keys(next)) {
        if (!alive.has(id)) {
          delete next[id];
          changed = true;
        }
      }
      if (!changed) return prev;
      localStorage.setItem(LS.recency, JSON.stringify(next));
      return next;
    });
  }, [sessions, booting]);

  return { recency, touchSession };
}
