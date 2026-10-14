/**
 * 流式 tool_input 的顶层字符串字段，边到边解。
 *
 * Write 的参数是 `{"path":"...","content":"..."}`，正文在第二个键里，
 * 而且会流很久；CreatePlan 的整份计划在 `{"plan":"..."}` 里。完整 JSON
 * 到齐之前用户就该看见正文在长，而不是对着三个点干等。
 *
 * 只认顶层**字符串**字段：遇到别的值（数字、布尔、嵌套对象）就停在那里，
 * 后面的键等完整的 tool_use 再补 —— 跟踪嵌套结构是为了几个很少流得
 * 很长的参数多写一个完整解析器，不值。
 *
 * `[约束]` 增量的：每来一段只看这一段。早先每帧把整段累积的 JSON 从头
 * 再扫一遍（还要先复制两份），一个几十 KB 的 Write 流上几十秒，每帧的
 * 开销随已写出的长度线性涨 —— 越写越卡。状态（在键里 / 在值里 / 转义
 * 写了一半）跨段保留，分段方式不影响结果。
 */
export class PartialJsonObject {
  /** 已出现的顶层字符串字段；正在写的那个是已写出的前缀。 */
  private fields: Record<string, string> = {};
  private first: string | null = null;
  private state:
    | "start"
    | "key_or_end"
    | "key"
    | "colon"
    | "value"
    | "string"
    | "comma_or_end"
    | "stop" = "start";
  /** 正在读的键 / 值。值写进 fields 是在每段末尾，不是逐字。 */
  private buf = "";
  private key = "";
  /** 跨段的半截转义（`\`、`\u12`）。 */
  private esc = "";
  /**
   * 字段表已经交出去了（snapshot）。之后再改要先复制一份 —— 交出去的那份
   * 进了 React state，原地改它等于偷改上一帧的数据。
   */
  private shared = false;

  /** 第一个顶层键（读完整之后）。 */
  get firstKey(): string | null {
    return this.first;
  }

  /** 遇到了不归这里管的东西（非字符串值、对象已闭合、坏 JSON），不再往下读。 */
  get stopped(): boolean {
    return this.state === "stop";
  }

  push(chunk: string): void {
    let i = 0;
    const n = chunk.length;
    while (i < n && this.state !== "stop") {
      switch (this.state) {
        case "start": {
          i = skipWs(chunk, i);
          if (i >= n) return;
          if (chunk[i] !== "{") {
            this.state = "stop";
            return;
          }
          i++;
          this.state = "key_or_end";
          break;
        }
        case "key_or_end":
        case "comma_or_end": {
          i = skipWs(chunk, i);
          if (i >= n) return;
          const c = chunk[i];
          if (c === "}") {
            this.state = "stop";
            return;
          }
          if (c === ",") {
            i++;
            this.state = "key_or_end";
            break;
          }
          // 值后面直接跟引号（少了逗号）也当下一个键读，和整段解析时一样宽容。
          if (c !== '"') {
            this.state = "stop";
            return;
          }
          i++;
          this.buf = "";
          this.state = "key";
          break;
        }
        case "key":
        case "string": {
          i = this.readString(chunk, i);
          if (this.state === "string") this.flushValue();
          break;
        }
        case "colon": {
          i = skipWs(chunk, i);
          if (i >= n) return;
          if (chunk[i] !== ":") {
            this.state = "stop";
            return;
          }
          i++;
          // 冒号到了、值还没开始：先占一个空串（界面能先画出这个字段）。
          this.setField(this.key, "");
          this.state = "value";
          break;
        }
        case "value": {
          i = skipWs(chunk, i);
          if (i >= n) return;
          if (chunk[i] !== '"') {
            // 不是字符串：这个字段不归这里管，后面的也不再读。
            this.writable();
            delete this.fields[this.key];
            this.state = "stop";
            return;
          }
          i++;
          this.buf = "";
          this.state = "string";
          break;
        }
        default:
          return;
      }
    }
  }

  /**
   * 此刻的字段表。没变化时是同一个对象 —— 调用方按引用判断要不要重画。
   */
  snapshot(): Record<string, string> {
    this.shared = true;
    return this.fields;
  }

  private writable() {
    if (this.shared) {
      this.fields = { ...this.fields };
      this.shared = false;
    }
  }

  private setField(key: string, value: string) {
    if (this.fields[key] === value && key in this.fields) return;
    this.writable();
    this.fields[key] = value;
  }

  /** 正在读的值落进字段表（每段末尾、以及值读完时）。 */
  private flushValue() {
    this.setField(this.key, this.buf);
  }

  /**
   * 读字符串内容直到闭合引号或这段结束。普通字符成片 slice，不逐字拼。
   * 返回下一个要看的下标。
   */
  private readString(s: string, i: number): number {
    const n = s.length;
    if (this.esc) {
      const r = this.finishEscape(s, i);
      if (r < 0) return n;
      i = r;
    }
    while (i < n) {
      let j = i;
      while (j < n) {
        const c = s.charCodeAt(j);
        if (c === 34 /* " */ || c === 92 /* \ */) break;
        j++;
      }
      if (j > i) this.buf += s.slice(i, j);
      if (j >= n) return n;
      if (s.charCodeAt(j) === 34) {
        this.closeString();
        return j + 1;
      }
      // 反斜杠：转义可能被分段切开，攒进 esc 等下一段。
      this.esc = "\\";
      const r = this.finishEscape(s, j + 1);
      if (r < 0) return n;
      if (this.state === "stop") return n;
      i = r;
    }
    return n;
  }

  /** 接着补完 esc 里那半截转义。返回下一个下标；这段不够用时返回 -1。 */
  private finishEscape(s: string, i: number): number {
    while (i < s.length) {
      this.esc += s[i++];
      const e = this.esc;
      if (e.length === 2 && e[1] !== "u") {
        this.buf += ESC[e[1]!] ?? e[1]!;
        this.esc = "";
        return i;
      }
      if (e.length === 6) {
        const hex = e.slice(2);
        this.esc = "";
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          // 坏转义：值停在这里，不再往下读。
          this.state = "stop";
          return i;
        }
        this.buf += String.fromCharCode(Number.parseInt(hex, 16));
        return i;
      }
    }
    return -1;
  }

  private closeString() {
    if (this.state === "key") {
      this.key = this.buf;
      if (this.first === null) this.first = this.key;
      this.buf = "";
      this.state = "colon";
      return;
    }
    this.flushValue();
    this.buf = "";
    this.state = "comma_or_end";
  }
}

/**
 * 一次性版本：从尚未闭合的 JSON 对象里抽出第一个顶层键的字符串值，
 * 且只在那个键正好是 `field` 时（避免 Bash/Write 的参数值里碰巧出现
 * `"plan"`）。字段还没出现或值还没开始时返回 `null`；键已经对上、值
 * 还是空的，返回 `""`。
 */
export function extractTopLevelStringField(partial: string, field: string): string | null {
  const p = new PartialJsonObject();
  p.push(partial);
  return firstStringField(p, field);
}

/** 一次性版本：抽出已出现的顶层字符串字段。 */
export function extractTopLevelStringFields(partial: string): Record<string, string> {
  const p = new PartialJsonObject();
  p.push(partial);
  return p.snapshot();
}

/** 第一个顶层键是 `field` 且冒号已到时它的值（可能是前缀）；否则 null。 */
export function firstStringField(p: PartialJsonObject, field: string): string | null {
  if (p.firstKey !== field) return null;
  // 键读完、冒号还没到也算"认出来了"（返回空串）；停了（值不是字符串）才是 null。
  return p.snapshot()[field] ?? (p.stopped ? null : "");
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
