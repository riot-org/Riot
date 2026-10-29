/**
 * 定时任务「跳过时段」的表单侧小工具。
 *
 * 判定（某个时刻落不落在时段里）只在宿主做 —— 时区和星期都按宿主的本地
 * 墙钟算，前端再算一遍迟早对不上。这里只管编辑：比较有没有改、切星期、
 * 给新时段一个像样的默认值，以及给人看的形态（跨午夜 / 全天）。
 */

import type { SkipWindow } from "../bridge";

/** 新加一段的默认值：A 股午休，最常见的那一段。 */
export function newSkipWindow(): SkipWindow {
  return { start: "11:30", end: "13:00" };
}

/** 星期列表（空 / 缺省 = 每天），排好序、去重。七天全选和不选是一回事。 */
function daysOf(w: SkipWindow): number[] {
  const days = [...new Set(w.weekdays ?? [])].sort((a, b) => a - b);
  return days.length === 7 ? [] : days;
}

/** 两组时段是否等价（详情面板据此判断有没有改动）。顺序敏感：顺序是用户排的。 */
export function sameSkipWindows(a: SkipWindow[], b: SkipWindow[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((w, i) => {
    const o = b[i];
    if (!o || w.start !== o.start || w.end !== o.end) return false;
    const x = daysOf(w);
    const y = daysOf(o);
    return x.length === y.length && x.every((d, j) => d === y[j]);
  });
}

/** 切换某个星期（1 = 周一 … 7 = 周日）。结果排好序；全部取消 = 每天。 */
export function toggleSkipWeekday(w: SkipWindow, weekday: number): SkipWindow {
  const days = w.weekdays ?? [];
  const next = days.includes(weekday) ? days.filter((d) => d !== weekday) : [...days, weekday];
  next.sort((a, b) => a - b);
  return next.length === 0 ? { start: w.start, end: w.end } : { ...w, weekdays: next };
}

/** 时段的形态：同日、跨午夜（结束早于开始）、全天（开始等于结束）。 */
export function skipWindowShape(w: SkipWindow): "sameDay" | "overnight" | "allDay" {
  if (w.start === w.end) return "allDay";
  return w.end < w.start ? "overnight" : "sameDay";
}
