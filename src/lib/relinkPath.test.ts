import { describe, expect, it } from "vitest";

import { findAbsPathFor } from "./relinkPath";

const ABS = "/Users/caiwu/Documents/AI导航对接需求评审报告.html";

describe("findAbsPathFor", () => {
  it("同段行内代码里的绝对路径", () => {
    expect(
      findAbsPathFor("AI导航对接需求评审报告.html", [
        "报告已生成并在内置浏览器打开：",
        "打开 AI导航对接需求评审报告.html",
        "（",
        ABS,
        "，单文件、1MB）。",
      ]),
    ).toBe(ABS);
  });

  it("绝对路径嵌在正文里，前后是中文标点", () => {
    expect(findAbsPathFor("报告.html", ["已写到 /tmp/out/报告.html。"])).toBe("/tmp/out/报告.html");
  });

  it("相对路径带子目录也认", () => {
    expect(findAbsPathFor("docs/a.md", ["见 `/repo/docs/a.md`"])).toBe("/repo/docs/a.md");
  });

  it("Windows 路径", () => {
    expect(findAbsPathFor("a.docx", ["C:\\Users\\me\\a.docx"])).toBe("C:\\Users\\me\\a.docx");
  });

  it("只是文件名后缀相同不算", () => {
    expect(findAbsPathFor("报告.html", ["/tmp/旧报告.html"])).toBeNull();
  });

  it("两个不同的候选就不猜", () => {
    expect(findAbsPathFor("a.md", ["/x/a.md 和 /y/a.md"])).toBeNull();
  });

  it("同一个路径出现两次不算冲突", () => {
    expect(findAbsPathFor("a.md", ["/x/a.md", "/x/a.md"])).toBe("/x/a.md");
  });

  it("没有候选、或链接本身已是绝对路径", () => {
    expect(findAbsPathFor("a.md", ["没提路径"])).toBeNull();
    expect(findAbsPathFor("/x/a.md", ["/x/a.md"])).toBeNull();
  });
});
