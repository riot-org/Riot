import { describe, expect, it } from "vitest";

import {
  PartialJsonObject,
  extractTopLevelStringField,
  extractTopLevelStringFields,
  firstStringField,
} from "./partialJson";

const INPUTS = [
  JSON.stringify({ path: "/tmp/a.rs", content: 'fn main() {\n  println!("hi \\ "q"");\n}\n' }),
  JSON.stringify({ plan: "# Plan\n\n- [ ] step one\n- [ ] 第二步 😀\u0007", name: "x" }),
  String.raw`{ "command" : "ls -la\u00e9\u4E2D\ud83d\ude00" , "timeout": 30, "after": "never seen" }`,
  JSON.stringify({ a: "", b: "tab\tnew\nline/slash", c: "\u2028" }),
  '  {"nested": {"x": "y"}, "z": "w"}',
  '{"k":"v""k2":"v2"}',
  "[1, 2]",
];

/** 改写前的整段解析（作参照）。分段增量解析在每个前缀上都必须和它一致。 */
function legacyField(
  partial: string,
  field: string,
): string | null {
  const t = partial.trimStart();
  if (!t.startsWith("{")) return null;
  let i = 1;
  i = skipWs(t, i);
  const key = `"${field}"`;
  if (!t.startsWith(key, i)) return null;
  i += key.length;
  i = skipWs(t, i);
  if (i >= t.length) return "";
  if (t[i] !== ":") return null;
  i += 1;
  i = skipWs(t, i);
  if (i >= t.length) return "";
  if (t[i] !== '"') return null;
  return unescapeJsonStringPrefix(t.slice(i + 1));
}

/**
 * 从尚未闭合的 JSON 对象里抽出已出现的顶层字符串字段。
 *
 * Write 的参数是 `{"path":"...","content":"..."}`，正文在第二个键里，
 * 而且会流很久。只看第一个键的话，用户对着三个点干等整份文件写完。
 * 值还在写的那个字段带上已写出的前缀。
 */
function legacyFields(partial: string): Record<string, string> {
  const t = partial.trimStart();
  if (!t.startsWith("{")) return {};
  const out: Record<string, string> = {};
  let i = 1;
  while (i < t.length) {
    i = skipWs(t, i);
    if (i >= t.length) break;
    if (t[i] === "}") break;
    if (t[i] === ",") {
      i += 1;
      continue;
    }
    if (t[i] !== '"') break;
    const key = readClosedJsonString(t, i);
    if (!key) break;
    i = key.end;
    i = skipWs(t, i);
    if (i >= t.length) break;
    if (t[i] !== ":") break;
    i += 1;
    i = skipWs(t, i);
    if (i >= t.length) {
      out[key.value] = "";
      break;
    }
    if (t[i] !== '"') break;
    const val = unescapeJsonStringPrefix(t.slice(i + 1));
    out[key.value] = val;
    const closed = jsonStringClosed(t, i + 1);
    if (!closed) break;
    i = closed;
  }
  return out;
}

/** 读一个已经闭合的 JSON 字符串（含开头引号）。没闭合就当键还没写完。 */
function readClosedJsonString(s: string, start: number): { value: string; end: number } | null {
  if (s[start] !== '"') return null;
  const value = unescapeJsonStringPrefix(s.slice(start + 1));
  const end = jsonStringClosed(s, start + 1);
  if (end === null) return null;
  return { value, end };
}

/** 从字符串内容起点找到闭合引号之后的下标；还没闭合返回 null。 */
function jsonStringClosed(s: string, from: number): number | null {
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === '"') return i + 1;
    if (c !== "\\") continue;
    if (i + 1 >= s.length) return null;
    const n = s[++i]!;
    if (n === "u") {
      if (i + 4 >= s.length) return null;
      i += 4;
    }
  }
  return null;
}

function skipWs(s: string, i: number): number {
  while (i < s.length) {
    const c = s[i];
    if (c !== " " && c !== "\n" && c !== "\r" && c !== "\t") break;
    i += 1;
  }
  return i;
}

const ESC: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/** 解开一段可能尚未闭合的 JSON 字符串（不含开头的引号）。 */
function unescapeJsonStringPrefix(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') break;
    if (c !== "\\") {
      out += c;
      continue;
    }
    if (i + 1 >= s.length) break;
    const n = s[++i]!;
    if (n === "u") {
      if (i + 4 >= s.length) break;
      const hex = s.slice(i + 1, i + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
      out += String.fromCharCode(Number.parseInt(hex, 16));
      i += 4;
      continue;
    }
    out += ESC[n] ?? n;
  }
  return out;
}

/** 确定性的伪随机切段。 */
function chunks(s: string, seed: number): string[] {
  const out: string[] = [];
  let x = seed;
  let i = 0;
  while (i < s.length) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const n = 1 + (x % 7);
    out.push(s.slice(i, i + n));
    i += n;
  }
  return out;
}

describe("PartialJsonObject", () => {
  it.each(INPUTS)("matches the whole-text parser on every prefix, any chunking (%#)", (input) => {
    for (const seed of [1, 7, 42]) {
      const p = new PartialJsonObject();
      let seen = "";
      for (const c of chunks(input, seed)) {
        p.push(c);
        seen += c;
        expect(p.snapshot(), JSON.stringify(seen)).toEqual(legacyFields(seen));
        expect(firstStringField(p, "plan"), JSON.stringify(seen)).toBe(legacyField(seen, "plan"));
      }
    }
    for (let n = 0; n <= input.length; n++) {
      const prefix = input.slice(0, n);
      expect(extractTopLevelStringFields(prefix)).toEqual(legacyFields(prefix));
      expect(extractTopLevelStringField(prefix, "command")).toBe(legacyField(prefix, "command"));
    }
  });

  it("returns the same object until something changes, and never mutates one it handed out", () => {
    const p = new PartialJsonObject();
    p.push('{"a":"x');
    const first = p.snapshot();
    expect(p.snapshot()).toBe(first);
    p.push("y");
    const second = p.snapshot();
    expect(second).not.toBe(first);
    expect(first).toEqual({ a: "x" });
    expect(second).toEqual({ a: "xy" });
    p.push("   ");
    expect(p.snapshot()).not.toBe(second); // 空白也落进了值
  });

  it("only scans new input — a long value grows in linear total time", () => {
    const p = new PartialJsonObject();
    p.push('{"content":"');
    const piece = "x".repeat(64);
    const t0 = performance.now();
    for (let i = 0; i < 20_000; i++) {
      p.push(piece);
      p.snapshot();
    }
    expect(p.snapshot()["content"]?.length).toBe(64 * 20_000);
    // 1.28 MB 累积：整段重扫要几十秒，增量是毫秒级。给足余量防机器抖。
    expect(performance.now() - t0).toBeLessThan(2_000);
  });
});
