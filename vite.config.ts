import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { type Plugin, defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileViewerRenderers } from "@file-viewer/vite-plugin";

const req = createRequire(import.meta.url);
/**
 * micromark 的实体解码依赖有两个实现：browser 条件是 DOM 版（模块顶层
 * 就 document.createElement），default 是纯查表版。Vite 按 browser 条件
 * 预构建后，markdown.worker 一加载就 "document is not defined"。经
 * micromark 的位置用 node 条件解析出查表版的绝对路径（pnpm 严格隔离，
 * 从 Riot root 直接解析不到这个传递依赖），主线程用它也毫无损失。
 */
const decodePlain = createRequire(req.resolve("micromark")).resolve(
  "decode-named-character-reference",
);

/**
 * 回答里 HTML/SVG 组件的沙箱页（src-tauri/assets/widget-frame.html）。
 *
 * 桌面版由 riot-widget:// 协议、网页版由远程服务的 /__riot_widget 端出，
 * 两处都在 Rust 里（src-tauri/src/widget_frame.rs）。直接开 Vite 做网页版
 * 开发时请求打到这里，按同一条 CSP 端出 —— 改 CSP 要两边一起改。
 */
const WIDGET_CSP =
  "default-src 'none'; " +
  "script-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com; " +
  "style-src 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; " +
  "font-src data: https://fonts.gstatic.com https://cdn.jsdelivr.net; " +
  "img-src data: blob:; media-src data: blob:; " +
  "connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

function widgetFrame(): Plugin {
  return {
    name: "riot-widget-frame",
    configureServer(server) {
      server.middlewares.use("/__riot_widget", (_req, res) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Content-Security-Policy", WIDGET_CSP);
        res.setHeader("Cache-Control", "no-cache");
        res.end(readFileSync(new URL("./src-tauri/assets/widget-frame.html", import.meta.url)));
      });
    },
  };
}

export default defineConfig({
  resolve: {
    alias: {
      "decode-named-character-reference": decodePlain,
    },
  },
  plugins: [
    react(),
    widgetFrame(),
    // 文件预览（@file-viewer）：formats 精确装配，只注入白名单要的
    // 渲染模块和资产（对照 FilePreview.tsx 的 PREVIEWABLE_EXTS）。
    // 'pptx' 命中 presentation 的 OpenXML 子入口 —— 二进制 .ppt 的
    // WASM + 字体（18MB）不会进产物。copyAssets 把命中管线的
    // Worker / WASM 拷进构建产物，dev 与打包都从本地 origin 提供，
    // 预览不出网。
    fileViewerRenderers({
      formats: ["pdf", "docx", "xlsx", "csv", "pptx", "md"],
      copyAssets: true,
    }),
  ],
  clearScreen: false,
  server: {
    // 必须听 127.0.0.1：Tailscale Serve 会把目标规范成 127.0.0.1，而 Node
    // 默认只绑 [::1] 时 Serve 连不上 → 502 空响应，iOS Safari 会把它存成
    // 「document.txt」下载。tauri.conf.json 的devUrl 也改成 127.0.0.1。
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    // Tailscale Serve / 反代进来时 Host 是 `macbook-….ts.net`，Vite 默认只
    // 放行 localhost，会直接 403。前导点 = 该后缀下所有子域。
    allowedHosts: [".ts.net", "localhost", "127.0.0.1"],
    // 网页版开发：打开 http://127.0.0.1:1420，/ws 反代到宿主远程服务。
    // 端口改了用 RIOT_REMOTE_PORT。
    proxy: {
      "/ws": {
        target: `ws://127.0.0.1:${process.env.RIOT_REMOTE_PORT ?? "7823"}`,
        ws: true,
        // 保留浏览器给的 Host（127.0.0.1:1420 或 *.ts.net），宿主按
        // Origin == Host / RIOT_REMOTE_ALLOWED_ORIGINS 做来源校验。
        changeOrigin: false,
      },
    },
    fs: {
      // @file-viewer 链接到本地 fork（见 pnpm-workspace.yaml 的 overrides），
      // 它的 Worker / WASM 用 import.meta.url 相对定位，真实路径在工作区
      // 外 —— 不放行的话 pptx 等靠 Worker 的管线直接黑屏。
      // 注意：显式设置 allow 会取代默认值，"." 必须带上。
      allow: [".", "../file-viewer"],
    },
    watch: {
      // 不看 Rust 侧 —— target/ 目录会把 watcher 拖垮
      ignored: ["**/src-tauri/**", "**/target/**", "**/crates/**"],
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
  optimizeDeps: {
    // `[约束]` @file-viewer 是 link 到本地 fork 的，Vite 不会预先爬它的
    // 第三方依赖 —— 运行中首次打开某格式触发按需预构建 + 强制整页
    // reload，正在 pending 的动态 import 永远不会 resolve，表现为
    // "先开 pptx/docx 再开 csv 卡死在解析中"。这里用嵌套语法把各渲染
    // 管线的深层依赖在启动时就预构建掉。新格式首开如果终端再出现
    // "new dependencies optimized: X"，把 X 按同样写法补进来。
    include: [
      "@file-viewer/renderer-spreadsheet > styled-exceljs",
      "@file-viewer/renderer-spreadsheet > jszip",
      "@file-viewer/renderer-spreadsheet > e-virt-table",
      "@file-viewer/renderer-spreadsheet > utif",
      "@file-viewer/renderer-spreadsheet > tinycolor2",
      "@file-viewer/renderer-text > marked",
      "@file-viewer/renderer-text > dompurify",
      "@file-viewer/renderer-word > jszip",
      "@file-viewer/renderer-presentation > @file-viewer/pptx > billboard.js",
      "@file-viewer/renderer-presentation > @file-viewer/pptx > d3-format",
      "@file-viewer/renderer-presentation > @file-viewer/pptx > dompurify",
      "@file-viewer/renderer-presentation > @file-viewer/pptx > jszip",
      "@file-viewer/renderer-presentation > @file-viewer/pptx > tinycolor2",
      "@file-viewer/renderer-presentation > @file-viewer/pptx > utif",
      "@file-viewer/renderer-presentation > @file-viewer/pptx > dingbat-to-unicode",
      "@file-viewer/renderer-pdf > pdfjs-dist/legacy/build/pdf.mjs",
      "@file-viewer/renderer-pdf > pdfjs-dist/legacy/web/pdf_viewer.mjs",
      "@file-viewer/renderer-pdf > pdfjs-dist/legacy/build/pdf.worker.mjs",
    ],
  },
});
