import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { describe, expect, it } from "vitest";

import { REMARK_PLUGINS } from "./Markdown";

/** 用对话里同一份 remark 插件把一段 markdown 渲染成 HTML。 */
const html = (md: string) =>
  renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: REMARK_PLUGINS }, md));

describe("中文强调（remark-cjk-friendly）", () => {
  it("句号包在加粗里、后面紧跟汉字，照样加粗", () => {
    const out = html("**第一，修复情绪，防止踩踏。**昨天是缩量阴跌");
    expect(out).toContain("<strong>第一，修复情绪，防止踩踏。</strong>昨天");
    expect(out).not.toContain("**");
  });

  it("开头一侧同理：汉字后面紧跟以标点开头的加粗", () => {
    expect(html("这是**「重点」**内容")).toContain("<strong>「重点」</strong>");
  });

  it("删除线也一样", () => {
    expect(html("~~旧的说法。~~新的说法")).toContain("<del>旧的说法。</del>新的说法");
  });

  it("英文照旧按 CommonMark", () => {
    expect(html("**bold.**text")).not.toContain("<strong>");
    expect(html("a **bold** word")).toContain("<strong>bold</strong>");
  });

  it("代码里的星号不受影响", () => {
    const out = html("`**不是加粗。**原样`");
    expect(out).toContain("<code>**不是加粗。**原样</code>");
    expect(out).not.toContain("<strong>");
  });
});

describe("没闭合的围栏（remarkOpenFences）", () => {
  it("写到一半的代码块挂 data-open", () => {
    expect(html("看这条：\n\n```bash\nrm -rf ./")).toContain("data-open");
  });

  it("闭合了就不挂", () => {
    expect(html("```bash\nls\n```")).not.toContain("data-open");
    expect(html("~~~~bash\nls\n~~~~\n\n后文")).not.toContain("data-open");
  });

  it("里面出现更短的围栏不算闭合", () => {
    expect(html("````md\n```\nx")).toContain("data-open");
  });
});

describe("组件围栏（remarkWidgetFences）", () => {
  it("```widget 换成 html 语言并打上 data-widget", () => {
    const out = html("```widget\n<p>hi</p>\n```");
    expect(out).toContain("data-widget");
    expect(out).toContain("language-html");
  });

  it("```html 不动：那是要抄进文件的代码", () => {
    expect(html("```html\n<p>hi</p>\n```")).not.toContain("data-widget");
  });
});

describe("本地网址变链接（remarkLocalUrls）", () => {
  it("行内代码里的本地网址套上链接，保留代码样子", () => {
    const out = html("服务起好了：`http://localhost:5173`");
    expect(out).toContain('<a href="http://localhost:5173"><code>http://localhost:5173</code></a>');
  });

  it("不带协议的也认", () => {
    expect(html("打开 localhost:3000/admin。")).toContain('<a href="http://localhost:3000/admin">localhost:3000/admin</a>');
  });

  it("代码块、别的行内代码、已有链接不动", () => {
    expect(html("```\nhttp://localhost:5173\n```")).not.toContain("<a");
    expect(html("`npm run dev`")).not.toContain("<a");
    expect(html("[后台](http://localhost:3000)")).toContain('<a href="http://localhost:3000">后台</a>');
  });
});

describe("行内代码小装饰（remarkInlineCodeHints）", () => {
  it("颜色值挂色块", () => {
    const out = html("主色 `#3b82f6`，辅色 `rgb(16, 185, 129)`");
    expect(out).toContain('data-swatch=""');
    expect(out).toContain("--md-swatch:#3b82f6");
    expect(out).toContain("--md-swatch:rgb(16, 185, 129)");
  });

  it("带分号的不当颜色（不能把别的声明带进 style）", () => {
    expect(html("`rgb(1,2,3);color:red`")).not.toContain("data-swatch");
  });

  it("快捷键画成键帽，普通代码不动", () => {
    expect(html("按 `⌘K` 或 `Ctrl+Shift+P`")).toContain('data-kbd=""');
    expect(html("`Esc` 和 `npm run dev`")).not.toContain("data-kbd");
    expect(html("`#define`")).not.toContain("data-swatch");
  });
});
