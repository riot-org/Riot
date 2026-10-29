import { describe, expect, it } from "vitest";

import { newSkipWindow, sameSkipWindows, skipWindowShape, toggleSkipWeekday } from "./skipWindows";

describe("sameSkipWindows", () => {
  it("treats missing, empty and all-seven weekdays as the same (every day)", () => {
    expect(
      sameSkipWindows(
        [{ start: "11:30", end: "13:00" }],
        [{ start: "11:30", end: "13:00", weekdays: [] }],
      ),
    ).toBe(true);
    expect(
      sameSkipWindows(
        [{ start: "11:30", end: "13:00", weekdays: [1, 2, 3, 4, 5, 6, 7] }],
        [{ start: "11:30", end: "13:00" }],
      ),
    ).toBe(true);
  });

  it("ignores weekday order but not times or count", () => {
    expect(
      sameSkipWindows(
        [{ start: "00:00", end: "00:00", weekdays: [7, 6] }],
        [{ start: "00:00", end: "00:00", weekdays: [6, 7] }],
      ),
    ).toBe(true);
    expect(sameSkipWindows([newSkipWindow()], [{ start: "11:30", end: "13:30" }])).toBe(false);
    expect(sameSkipWindows([newSkipWindow()], [])).toBe(false);
    expect(
      sameSkipWindows(
        [{ start: "11:30", end: "13:00", weekdays: [1] }],
        [{ start: "11:30", end: "13:00" }],
      ),
    ).toBe(false);
  });
});

describe("toggleSkipWeekday", () => {
  it("adds in sorted order and drops the field when nothing is left", () => {
    const w = toggleSkipWeekday(toggleSkipWeekday(newSkipWindow(), 7), 6);
    expect(w.weekdays).toEqual([6, 7]);
    const back = toggleSkipWeekday(toggleSkipWeekday(w, 6), 7);
    expect(back).toEqual({ start: "11:30", end: "13:00" });
  });
});

describe("skipWindowShape", () => {
  it("tells same-day, overnight and all-day apart", () => {
    expect(skipWindowShape({ start: "11:30", end: "13:00" })).toBe("sameDay");
    expect(skipWindowShape({ start: "15:00", end: "09:30" })).toBe("overnight");
    expect(skipWindowShape({ start: "00:00", end: "00:00" })).toBe("allDay");
  });
});
