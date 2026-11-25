import { describe, expect, it } from "vitest";

import { normalizeMath } from "./mathText";

describe("normalizeMath", () => {
  it("没有公式的文本原样返回", () => {
    expect(normalizeMath("普通的一段话。")).toBe("普通的一段话。");
  });

  it("单 $ 的行内公式转成 $$", () => {
    expect(normalizeMath("面积是 $\\pi r^2$，周长")).toBe("面积是 $$\\pi r^2$$，周长");
    expect(normalizeMath("$x$ 和 $y$")).toBe("$$x$$ 和 $$y$$");
  });

  it("钱数不算公式", () => {
    expect(normalizeMath("从 $5 涨到 $10")).toBe("从 $5 涨到 $10");
    expect(normalizeMath("price: $5 and $ 10")).toBe("price: $5 and $ 10");
    expect(normalizeMath("花了 $20，又花了 $30。")).toBe("花了 $20，又花了 $30。");
  });

  it("下一个 $ 不合格时这个开头就作废，不往后接着找", () => {
    expect(normalizeMath("$5 和 $x$")).toBe("$5 和 $$x$$");
  });

  it("转义的 \\$ 不当开关", () => {
    expect(normalizeMath("价格 \\$5 和 \\$6")).toBe("价格 \\$5 和 \\$6");
  });

  it("\\( \\) 转成行内，\\[ \\] 转成块级", () => {
    expect(normalizeMath("设 \\(a+b\\) 为")).toBe("设 $$a+b$$ 为");
    expect(normalizeMath("如下：\\[ E = mc^2 \\]")).toBe("如下：\n$$\nE = mc^2\n$$\n");
    expect(normalizeMath("\\[\n\\int_0^1 x\\,dx\n\\]")).toBe("\n$$\n\\int_0^1 x\\,dx\n$$\n");
  });

  it("已经是 $$ 的不动", () => {
    expect(normalizeMath("$$a$$ 与 $b$")).toBe("$$a$$ 与 $$b$$");
    const block = "$$\n\\sum_i x_i\n$$";
    expect(normalizeMath(block)).toBe(block);
  });

  it("代码里的不动", () => {
    expect(normalizeMath("`echo $HOME $PATH`")).toBe("`echo $HOME $PATH`");
    expect(normalizeMath("```bash\necho $a$\n```\n$x$")).toBe("```bash\necho $a$\n```\n$$x$$");
    expect(normalizeMath("``a ` $b$ ``")).toBe("``a ` $b$ ``");
  });

  it("没收尾的（还在流式）先原样", () => {
    expect(normalizeMath("公式 $x + ")).toBe("公式 $x + ");
    expect(normalizeMath("\\[ x +")).toBe("\\[ x +");
  });

  it("行内不跨行", () => {
    expect(normalizeMath("$a\nb$")).toBe("$a\nb$");
  });
});
