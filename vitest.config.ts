import { defineConfig } from "vitest/config";

/**
 * 前端单测。只测纯逻辑（事件 → 条目的翻译、快照对账、增量解析这类），
 * 不起宿主、不渲染整棵树。jsdom 只是为了让 bridge / i18n 在导入时能找到
 * window 和 localStorage —— 没有令牌时网页传输什么都不连。
 */
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
  },
});
