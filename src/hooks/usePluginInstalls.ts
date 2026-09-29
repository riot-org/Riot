import { useSyncExternalStore } from "react";

import {
  type PluginProgress,
  type UiErrorPayload,
  describeError,
  isHostError,
  pluginsCommit,
  pluginsUpdate,
} from "../bridge";

/**
 * 插件安装任务的状态，存在模块级而不是组件里。
 *
 * 安装一跑起来就归宿主管了 —— 几百 MB 的下载，活到进程结束为止。而设置
 * 是个随手就关的 Modal：进度放在 `PluginsPane` 的 `useState` 里，用户一关
 * 面板组件就卸载，进度和"正在装"标记跟着没了。再打开时界面显示的是"未
 * 安装，点这里下载"，但后台其实还在下 —— 于是他会再点一次。
 *
 * 放在模块级，生命周期就和宿主那边的任务对上了：谁挂载谁就看到当前进度，
 * 中途没人看也不影响它继续走完。
 */
export interface PluginInstalls {
  /** 插件 id → 最近一条进度。装完/失败后留在原地，作为结果行。 */
  progress: Record<string, PluginProgress>;
  /** 正在装 / 升级的插件 id。 */
  running: Record<string, boolean>;
  /**
   * 已经跑完（成功或失败）多少次安装。挂载中的界面靠它知道该重拉一次清单——
   * 装完的那一刻面板可能根本没开着，没有别的信号能提醒它。
   */
  completed: number;
}

let state: PluginInstalls = { progress: {}, running: {}, completed: 0 };
const listeners = new Set<() => void>();

function set(next: PluginInstalls) {
  state = next;
  for (const notify of listeners) notify();
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}

/** 当前的安装状态。任何组件挂载后都能接上正在跑的任务。 */
export function usePluginInstalls(): PluginInstalls {
  return useSyncExternalStore(subscribe, () => state);
}

function track(id: string, run: (onProgress: (p: PluginProgress) => void) => Promise<void>): void {
  if (state.running[id]) return;
  // 占位用 starting 而不是某个真实阶段：git 升级和压缩包下载第一秒显示
  // "校验中"是在撒谎，宿主推来第一条真进度就会盖掉它。
  set({
    ...state,
    progress: { ...state.progress, [id]: { kind: "starting" } },
    running: { ...state.running, [id]: true },
  });

  void run((p) => {
    set({ ...state, progress: { ...state.progress, [id]: p } });
  })
    .catch((e: unknown) => {
      // 失败时宿主也会从 channel 推一条 failed，那条能指到是哪一步坏的，
      // 别拿命令的返回把它盖掉。
      if (state.progress[id]?.kind !== "failed") {
        reportPluginFailure(id, e);
      }
    })
    .finally(() => {
      const running = { ...state.running };
      delete running[id];
      set({ ...state, running, completed: state.completed + 1 });
    });
}

/** 确认页点了"安装"：按令牌落地。同一个插件已经在装就什么都不做。 */
export function startPluginCommit(id: string, token: string): void {
  track(id, (onProgress) => pluginsCommit(token, onProgress));
}

/** 升级一个已装的插件。 */
export function startPluginUpdate(id: string): void {
  track(id, (onProgress) => pluginsUpdate(id, onProgress));
}

/**
 * 把一条失败挂到某个插件上。卸载失败也走这里，和安装共用同一行结果。
 * 传 catch 到的原值：宿主的 HostError 保留键和参数，其它的包成 legacy。
 */
export function reportPluginFailure(id: string, e: unknown): void {
  const error: UiErrorPayload = isHostError(e)
    ? { key: e.key, args: e.args, detail: e.detail }
    : { key: "host.legacy", detail: describeError(e) };
  set({ ...state, progress: { ...state.progress, [id]: { kind: "failed", error } } });
}

/** 抹掉一个插件的结果行。卸载完还挂着上次的"完成"会很怪。 */
export function clearPluginProgress(id: string): void {
  if (!(id in state.progress)) return;
  const progress = { ...state.progress };
  delete progress[id];
  set({ ...state, progress });
}

/**
 * 抹掉所有"完成"的结果行。清单重拉之后调 —— 那时"已装 x.y.z"的徽章已经
 * 顶上来了，再挂一行"完成"是重复的，隔天再打开设置还看见它更像是没装完。
 * 失败的行留着：那个信息没有别处能看到。
 */
export function clearDonePluginProgress(): void {
  const done = Object.entries(state.progress)
    .filter(([, p]) => p.kind === "done")
    .map(([id]) => id);
  if (done.length === 0) return;
  const progress = { ...state.progress };
  for (const id of done) delete progress[id];
  set({ ...state, progress });
}
