import type { PermissionMode } from "../../bridge";
import type { Seg } from "../../lib/promptText";
import type { Shot } from "../../lib/shots";

/** 草稿在本地存储里的键前缀（见 PersistentDrafts）。 */
const DRAFT_PREFIX = "riot.draft:";
/** 记各会话草稿最后写入时间的索引，超过 DRAFT_KEEP 条时删最旧的。 */
const DRAFT_INDEX = "riot.draft-index";
const DRAFT_KEEP = 50;
/** 单条草稿超过这么大就只留在内存里（粘贴块可能很大，别挤爆配额）。 */
const DRAFT_MAX_BYTES = 256 * 1024;
const DRAFT_SAVE_MS = 400;

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readIndex(ls: Storage): Record<string, number> {
  try {
    const v = JSON.parse(ls.getItem(DRAFT_INDEX) ?? "{}") as unknown;
    return v && typeof v === "object" ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/**
 * 草稿：内存里一份，本地存储里再落一份。
 *
 * 只放内存的话切会话不丢，但应用重启、页面刷新（网页版）就没了 —— 写了
 * 半天的长提示词一下归零。Claude 桌面版的草稿同样是持久的。写盘防抖：
 * 每敲一个字都序列化一次不值当；页面关掉前把攒着的那几笔补写掉。
 *
 * 继承 Map 是为了调用方不用改：get / set / delete 照旧，持久化藏在里面。
 * 本地存储读写都可能抛（隐私模式、配额满），一律退回只在内存。
 */
class PersistentDrafts extends Map<string, Seg[]> {
  private pending = new Map<string, number>();

  override get(id: string): Seg[] | undefined {
    if (super.has(id)) return super.get(id);
    try {
      const raw = storage()?.getItem(DRAFT_PREFIX + id);
      if (!raw) return undefined;
      const segs = JSON.parse(raw) as Seg[];
      if (!Array.isArray(segs)) return undefined;
      super.set(id, segs);
      return segs;
    } catch {
      return undefined;
    }
  }

  override set(id: string, segs: Seg[]): this {
    super.set(id, segs);
    this.schedule(id);
    return this;
  }

  override delete(id: string): boolean {
    const had = super.delete(id);
    this.schedule(id);
    return had;
  }

  private schedule(id: string) {
    window.clearTimeout(this.pending.get(id));
    this.pending.set(
      id,
      window.setTimeout(() => this.write(id), DRAFT_SAVE_MS),
    );
  }

  /** 把攒着没写的立刻写掉（页面关闭前）。 */
  flush() {
    for (const [id, timer] of this.pending) {
      window.clearTimeout(timer);
      this.write(id);
    }
  }

  private write(id: string) {
    this.pending.delete(id);
    const ls = storage();
    if (!ls) return;
    try {
      const index = readIndex(ls);
      const segs = super.get(id);
      const raw = segs ? JSON.stringify(segs) : null;
      if (raw && raw.length <= DRAFT_MAX_BYTES) {
        ls.setItem(DRAFT_PREFIX + id, raw);
        index[id] = Date.now();
      } else {
        ls.removeItem(DRAFT_PREFIX + id);
        delete index[id];
      }
      const ids = Object.keys(index).sort((a, b) => (index[b] ?? 0) - (index[a] ?? 0));
      for (const old of ids.slice(DRAFT_KEEP)) {
        ls.removeItem(DRAFT_PREFIX + old);
        delete index[old];
      }
      ls.setItem(DRAFT_INDEX, JSON.stringify(index));
    } catch {
      // 配额满、存储被禁用：草稿还在内存里，只是活不过重启。
    }
  }
}

/**
 * 输入框按会话存活的 UI 状态。Chat 按会话 id 重挂载，Composer 的本地
 * state 跟着一起丢 —— 这些 Map 让切走再切回时草稿、待发截图、模式都还在。
 * 草稿另外落盘，重启也在（见 PersistentDrafts）。
 */
export const drafts = new PersistentDrafts();
if (typeof window !== "undefined") {
  // 桌面版退出时未必有 pagehide，窗口藏起来（切走、最小化）时也补写一次。
  window.addEventListener("pagehide", () => drafts.flush());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) drafts.flush();
  });
}

/**
 * 权限模式的 UI 缓存，理由同上，但它错了会出安全问题而不只是显示问题。
 *
 * Chat 按会话 id 重挂载，Composer 的本地 state 跟着一起丢。少了这层
 * 缓存，模式就退回全局默认值显示，而宿主那边还是用户选的那个 ——
 * 屏幕上写着「每次询问」，实际每一步都在静默放行。
 */
export const modeCache = new Map<string, PermissionMode>();
/** 多任务开关的 UI 缓存。理由同 modeCache，只是错了不出安全问题。 */
export const multitaskCache = new Map<string, boolean>();
/** 进规划模式前记住的执行档，退出规划时恢复（例如切到多任务）。 */
export const execModeCache = new Map<string, PermissionMode>();

/** 会话设置弹窗选的权限档。带序号：连选两次同一档也要能触发。 */
export interface PermissionPick {
  mode: PermissionMode;
  seq: number;
}

/**
 * 每个会话待发的截图。和 drafts 同一个问题：Chat 按会话 id 重挂载，
 * 粘贴的图是组件 state，切走再切回就没了 —— 文字有 drafts 兜着，
 * 图同样是用户放进输入框的内容，不该丢。发送或删除后由同步 effect 清掉。
 */
export const shotsCache = new Map<string, Shot[]>();

/**
 * 会话没了，它在输入框这边留下的东西也该走。
 *
 * 这三个 Map 都按会话 id 长期存活，正常收敛只发生在"内容被清空"那条
 * 路上（草稿删干净、图发出去）。而用户删掉一个还留着草稿和待发截图的
 * 会话时，那条路根本不会走 —— 截图是 base64，留下就是几兆内存挂到
 * 进程退出。由 App 的 dropSessionWorkbench 统一调用。
 */
export function forgetComposerSession(sessionId: string) {
  drafts.delete(sessionId);
  modeCache.delete(sessionId);
  multitaskCache.delete(sessionId);
  execModeCache.delete(sessionId);
  shotsCache.delete(sessionId);
}

