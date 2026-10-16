import { useCallback, useEffect, useRef, useState } from "react";

import { subscribeFullscreen } from "../bridge";
import {
  DRAWER_MIN,
  LS,
  SCHED_DETAIL,
  SIDEBAR,
  TERM,
  drawerDefault,
  loadPx,
  rightPanelMax,
} from "../lib/layout";
import { isMobileNow, useIsMobile } from "./useIsMobile";

/**
 * 主窗口各面板的尺寸与开合：侧栏、工作台抽屉、终端、任务详情。拖出来的
 * 尺寸记在 localStorage；窗口变窄时右侧面板自动让位（见那个 resize effect）。
 * 从 App 拆出 —— 这些状态只和窗口几何有关，跟会话、标签都无关。
 */
export function usePanelLayout() {
  /** 详情侧栏宽度（拖出来的值）。 */
  const [schedDetailW, setSchedDetailW] = useState(() => {
    const v = loadPx(LS.schedDetail, SCHED_DETAIL.def);
    // 旧默认 340，加宽之后低于新下限的存值作废。
    return v < SCHED_DETAIL.min ? SCHED_DETAIL.def : v;
  });
  /** 窄屏（手机）。侧栏和右侧面板在这档下都是浮层，行为跟着改：
   *  默认收起、选中会话后自动收起、点遮罩收起。 */
  const isMobile = useIsMobile();
  // 窄屏上侧栏是盖在对话上的抽屉，开着就看不见对话 —— 起步一律收起，
  // 不读桌面上记住的偏好。
  const [sidebarOpen, setSidebarOpen] = useState(
    () => !isMobileNow() && localStorage.getItem(LS.sidebarOpen) !== "0",
  );
  /** 侧栏壳真正改宽度的那一拍。顶栏让位跟这个走，不能跟 sidebarOpen。 */
  const [sidebarVisual, setSidebarVisual] = useState(
    () => !isMobileNow() && localStorage.getItem(LS.sidebarOpen) !== "0",
  );
  // 旋转 / 拉窄跨过阈值那一刻收起侧栏：桌面态开着的侧栏到了手机态就是
  // 一整屏遮罩，用户什么都点不到。
  useEffect(() => {
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);
  /** 窄屏上选完东西把抽屉收掉；桌面上不动。 */
  const closeSidebarIfMobile = useCallback(() => {
    if (isMobileNow()) setSidebarOpen(false);
  }, []);
  const [sidebarW, setSidebarW] = useState(() => loadPx(LS.sidebar, SIDEBAR.def));
  const [drawerW, setDrawerW] = useState(() => loadPx(LS.drawer, drawerDefault()));
  const [termH, setTermH] = useState(() => loadPx(LS.term, TERM.def));
  const [fullscreen, setFullscreen] = useState(false);
  /** 正在拖的分隔线：按下时的尺寸 + 拖动中的最新值（onEnd 写盘用）。
   *  同一时刻只可能拖一条线，所以三条线共用这一对 ref。 */
  const dragFrom = useRef(0);
  const dragLive = useRef(0);

  useEffect(() => subscribeFullscreen(setFullscreen), []);

  // 拖宽侧栏、把窗口拉窄，都会吃掉右侧面板站的地方，而面板壳是
  // flex-shrink:0 不会自己让 —— 不主动收就是右缘顶出窗口被裁掉。
  // 只改内存里的值：盘上存的宽度留着，窗口回大时下次启动还能回来。
  useEffect(() => {
    const fit = () => {
      const side = sidebarOpen ? sidebarW : 0;
      setDrawerW((w) => Math.min(w, rightPanelMax(side, DRAWER_MIN)));
      setSchedDetailW((w) =>
        Math.min(w, SCHED_DETAIL.max, rightPanelMax(side, SCHED_DETAIL.min)),
      );
    };
    // 拖窗口期间把面板的开合过渡摘掉。过渡现在是常挂的（见 styles.css
    // 的 .slide-panel），而这里每来一个 resize 就 clamp 一次宽度 ——
    // 挂着过渡的话面板右缘追不上窗口边，会被 .shell 的 overflow 裁掉。
    // 走 DOM 属性而不是 React state：这只是给 CSS 看的开关，没必要为它
    // 在拖窗口的每一帧重渲染整棵树。
    let quiet = 0;
    const onResize = () => {
      document.documentElement.dataset.resizing = "";
      window.clearTimeout(quiet);
      quiet = window.setTimeout(() => {
        delete document.documentElement.dataset.resizing;
      }, 120);
      fit();
    };
    fit();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.clearTimeout(quiet);
      delete document.documentElement.dataset.resizing;
    };
  }, [sidebarOpen, sidebarW]);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((v) => {
      // 窄屏上的开合是临时的（抽屉），不写进偏好 —— 否则手机上开过一次
      // 侧栏，回到桌面宽度时它就一直开着。
      if (!isMobileNow()) localStorage.setItem(LS.sidebarOpen, v ? "0" : "1");
      return !v;
    });
  }, []);

  /** 拖抽屉推左栏、松手时露出不到一半就收起左栏。已经收着、或窄屏浮层上是空操作。 */
  const collapseSidebar = useCallback(() => {
    if (isMobileNow()) return;
    setSidebarOpen((open) => {
      if (!open) return open;
      localStorage.setItem(LS.sidebarOpen, "0");
      return false;
    });
  }, []);

  return {
    isMobile,
    sidebarOpen,
    setSidebarOpen,
    sidebarVisual,
    setSidebarVisual,
    closeSidebarIfMobile,
    toggleSidebar,
    collapseSidebar,
    sidebarW,
    setSidebarW,
    drawerW,
    setDrawerW,
    termH,
    setTermH,
    schedDetailW,
    setSchedDetailW,
    fullscreen,
    dragFrom,
    dragLive,
  };
}
