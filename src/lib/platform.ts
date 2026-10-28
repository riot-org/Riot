import { type MessageKey, t } from "../i18n";

/**
 * 用户的操作系统。按 UA 判 —— 网页版在 Mac 的浏览器里也算 mac：这里关心的
 * 是用户手上是什么系统（按什么键、文件管理器叫什么），不是 Riot 跑在哪。
 * 红绿灯让位那种"是不是桌面窗口"的判断见 chrome.tsx 的 IS_MAC。
 */
export type Platform = "mac" | "windows" | "linux";

export const PLATFORM: Platform = (() => {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/Mac|iPhone|iPad|iPod/.test(ua)) return "mac";
  if (/Windows/.test(ua)) return "windows";
  return "linux";
})();

const FILE_MANAGER: Record<Platform, MessageKey> = {
  mac: "common.fileManager.mac",
  windows: "common.fileManager.windows",
  linux: "common.fileManager.linux",
};

/** 「在访达中显示」/「在文件资源管理器中显示」/「在文件管理器中显示」。 */
export function revealInFileManagerLabel(): string {
  return t("common.revealInFileManager", { app: t(FILE_MANAGER[PLATFORM]) });
}
