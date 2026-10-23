import { useCallback, useEffect, useState } from "react";

import {
  type MissedRun,
  type ScheduledTask,
  type SessionInfo,
  listSessions,
  notify,
  renderUiError,
  scheduleAckMissed,
  scheduleList,
  scheduleMissed,
  subscribeScheduleChanges,
  subscribeScheduleRuns,
} from "../bridge";
import { useT } from "../i18n";

/**
 * 定时任务的清单和"错过了什么"：启动时拉一次，表变了（模型调工具创建 /
 * 删除）就重拉，任务跑完发系统通知。任务开跑 / 跑完时后台可能新建了
 * 会话，经 `applySessions` 让侧栏马上对齐。从 App 拆出。
 */
export function useSchedules(applySessions: (next: SessionInfo[]) => void) {
  const { t } = useT();
  /** 定时任务清单（任务页展示）。 */
  const [schedules, setSchedules] = useState<ScheduledTask[]>([]);
  /** 启动时发现的错过运行。行上标黄；补跑/忽略后逐条消掉。 */
  const [missedSchedules, setMissedSchedules] = useState<MissedRun[]>([]);
  /** 重拉任务清单（创建/删除/到点运行后侧栏要立即对齐）。 */
  const reloadSchedules = useCallback(() => {
    scheduleList()
      .then(setSchedules)
      .catch(() => {});
  }, []);

  // 定时任务：启动时拉清单和"错过了什么"；表变了（模型调工具创建/
  // 删除）就重拉；任务开跑/跑完时还要对齐会话列表 —— 后台新建的会话
  // 要马上出现在侧栏，不能等下一次轮询。
  useEffect(() => {
    reloadSchedules();
    scheduleMissed()
      .then(setMissedSchedules)
      .catch(() => {});
    const offRuns = subscribeScheduleRuns((run) => {
      reloadSchedules();
      listSessions()
        .then(applySessions)
        .catch(() => {});
      // 系统通知由前端发：文案要跟界面语言走，宿主那边没有词典。
      // 只在跑完、或停在等用户决定那一拍发，开跑不打扰。
      if (run.phase === "waiting") {
        void notify(t("app.notify.scheduleWaiting.title"), t("app.notify.scheduleWaiting.body", { name: run.name }));
      }
      if (run.phase === "done") {
        if (run.error) {
          void notify(
            t("app.notify.scheduleFailed.title"),
            t("app.notify.scheduleFailed.body", { name: run.name, error: renderUiError(run.error) }),
          );
        } else {
          void notify(
            t("app.notify.scheduleDone.title"),
            t("app.notify.scheduleDone.body", { name: run.name }),
          );
        }
      }
    });
    const offChanges = subscribeScheduleChanges(reloadSchedules);
    return () => {
      offRuns();
      offChanges();
    };
  }, [reloadSchedules, applySessions, t]);

  /**
   * 处理掉一条错过记录（补跑或忽略）。全部处理完才告诉宿主清空 ——
   * 宿主只有整体 ack，逐条的账在前端记。
   */
  const settleMissed = useCallback((taskId: string) => {
    setMissedSchedules((prev) => {
      const left = prev.filter((m) => m.taskId !== taskId);
      if (left.length === 0 && prev.length > 0) void scheduleAckMissed().catch(() => {});
      return left;
    });
  }, []);

  return {
    schedules,
    setSchedules,
    missedSchedules,
    setMissedSchedules,
    reloadSchedules,
    settleMissed,
  };
}
