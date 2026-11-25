/**
 * 回答里的命令代码块「一键运行」：哪些块能跑、跑的到底是哪段文本、
 * 跑之前要不要先确认。纯函数，界面在 Markdown.tsx 的 CodeBlock，
 * 运行和状态在 lib/terminalRuns.ts。
 *
 * 跑是用户自己点的，所以默认**直接跑**，不加一道确认 —— 每条都问一次
 * 的按钮没人想点。只有三种情况先在代码块里确认（见 {@link runRisks}）：
 * 高风险命令、看不见的字符、很长的脚本。
 */

/** 各平台能直接交给面板里那个 shell 的语言。面板的 shell 在 macOS/Linux
 *  是用户的登录 shell，在 Windows 是 PowerShell（见宿主 term.rs）。 */
const UNIX_LANGS = new Set(["bash", "sh", "zsh", "shell", "console", "shellsession"]);
const WIN_LANGS = new Set(["powershell", "pwsh", "ps1", "ps", "console"]);

export type ShellPlatform = "unix" | "windows";

export function shellPlatform(): ShellPlatform {
  return typeof navigator !== "undefined" && /Win/i.test(navigator.platform || navigator.userAgent)
    ? "windows"
    : "unix";
}

/** 这种语言的代码块在这个平台上给不给「运行」。 */
export function isRunnableLang(lang: string, platform: ShellPlatform = shellPlatform()): boolean {
  const l = lang.toLowerCase();
  return platform === "windows" ? WIN_LANGS.has(l) : UNIX_LANGS.has(l);
}

/**
 * `console` 一类的块是「提示符 + 命令 + 输出」的抄录：只取提示符后面的
 * 命令（以 `\` 结尾的续行跟着带上），输出行跳过。一行提示符都没有时
 * 整块当命令 —— 模型常把纯命令也标成 console。
 */
const PROMPT = /^\s*(?:\$|%|>|PS [^>]*>)\s/;

export function extractCommand(lang: string, source: string): string {
  const text = source.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  const l = lang.toLowerCase();
  if (l !== "console" && l !== "shellsession") return text.trim() ? text : "";
  const lines = text.split("\n");
  if (!lines.some((x) => PROMPT.test(x))) return text.trim() ? text : "";
  const out: string[] = [];
  let cont = false;
  for (const line of lines) {
    if (cont) {
      out.push(line);
      cont = /\\$/.test(line);
      continue;
    }
    const m = PROMPT.exec(line);
    if (!m) continue;
    const cmd = line.slice(m[0].length);
    out.push(cmd);
    cont = /\\$/.test(cmd);
  }
  return out.join("\n");
}

/**
 * 命令里有要用户先改的占位符（`<your-token>`、`YOUR_API_KEY`）。
 * 这种命令只填进终端、不按回车 —— 原样跑出去要么报错，要么把占位符
 * 当真值写进了配置。
 */
const PLACEHOLDERS = [
  /<[A-Za-z][\w.-]*(?:[ _-][\w.-]+)*>/, // <your-token>、<project name>
  /\b(?:YOUR|MY)_[A-Z0-9_]+\b/, // YOUR_API_KEY
  /\byour[-_][a-z0-9][a-z0-9_-]*/i, // your-repo
  /\bx{3,}\b/i, // xxx
];

export function hasPlaceholder(cmd: string): boolean {
  // heredoc 的 `<<EOF` 不算：去掉 `<<` 起头的那段再看。
  const body = cmd.replace(/<<-?\s*['"]?\w+['"]?/g, "");
  return PLACEHOLDERS.some((re) => re.test(body));
}

/** 零宽字符、文字方向控制符、软连字符、BOM 和 C0 控制字符（\t \n 除外）。
 *  双向控制符能让屏幕上看到的命令和实际执行的顺序不一样 —— 提示词
 *  注入最常用的就是这一招。
 *  C0 控制符写在正则字面量里会触发 no-control-regex，它们正是要拦的。 */
// eslint-disable-next-line no-control-regex -- 检测对象就是 C0 控制字符（\t \n 除外）
const HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

export type RunRisk =
  | "delete"
  | "sudo"
  | "pipeToShell"
  | "git"
  | "disk"
  | "perm"
  | "system"
  | "hidden"
  | "long";

/** 每条规则对整条命令测（不拆 `&&`）：`npm test && rm -rf /` 照样命中。 */
const RISKY: [RunRisk, RegExp][] = [
  ["delete", /\brm\s+(?:-[a-zA-Z]*[rRf][a-zA-Z]*|--recursive|--force)\b/],
  ["delete", /\bRemove-Item\b[^\n]*-(?:Recurse|Force)\b/i],
  ["delete", /\b(?:rmdir|rd)\s+\/s\b/i],
  ["delete", /\bfind\b[^\n]*\s-delete\b/],
  ["sudo", /(?:^|[\s;&|(])(?:sudo|doas)\s/m],
  ["pipeToShell", /\b(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z|da|fi)?sh\b/i],
  ["pipeToShell", /\b(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*\|\s*(?:iex|Invoke-Expression|python3?|node|perl|ruby)\b/i],
  ["pipeToShell", /\b(?:ba|z)?sh\s+-c\s+["']?\$\((?:curl|wget)\b/],
  ["git", /\bgit\s+push\b[^\n]*(?:\s--force(?:-with-lease)?\b|\s-f\b)/],
  ["git", /\bgit\s+reset\s+[^\n]*--hard\b/],
  ["git", /\bgit\s+clean\s+-[a-zA-Z]*f/],
  ["git", /\bgit\s+checkout\s+(?:--\s+)?\.(?:\s|$)/],
  ["disk", /(?:^|[\s;&|])(?:dd|mkfs(?:\.\w+)?|fdisk|parted|wipefs)\s/m],
  ["disk", /\bdiskutil\s+(?:erase\w*|partitionDisk|zeroDisk|secureErase)\b/i],
  ["disk", />\s*\/dev\/(?:sd|disk|nvme|hd)/],
  ["perm", /\b(?:chmod|chown|chgrp)\s+(?:-[a-zA-Z]*R|--recursive)\b/],
  ["perm", /\bchmod\s+[^\n]*\b777\b/],
  ["system", /(?:^|[\s;&|])(?:shutdown|reboot|halt|poweroff)\b/m],
  ["system", /\blaunchctl\s+(?:unload|remove|bootout)\b/],
  ["system", /:\(\)\s*\{\s*:\|:&\s*\};:/],
];

/** 多于这么多行的就不是「一条命令」了，是一段脚本：先看一眼再跑。 */
export const LONG_LINES = 10;

/** 这条命令跑之前要先确认的理由。空 = 直接跑。 */
export function runRisks(cmd: string): RunRisk[] {
  const found = new Set<RunRisk>();
  if (HIDDEN.test(cmd)) found.add("hidden");
  for (const [risk, re] of RISKY) if (re.test(cmd)) found.add(risk);
  const lines = cmd.split("\n").filter((x) => x.trim() && !/^\s*#/.test(x));
  if (lines.length > LONG_LINES) found.add("long");
  return [...found];
}

/** 结果尾巴里最多给几行。代码块下面是一句结论，不是第二个终端。 */
export const TAIL_LINES = 6;
/** 「发给 agent」最多带多少字。dev server 刷了几千行时，要的是最后那段。 */
export const SHARE_MAX_CHARS = 12_000;

/** 去掉首尾空行、只留最后 `n` 行。 */
export function tailLines(text: string, n: number): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  while (lines.length && !lines[0]?.trim()) lines.shift();
  return lines.slice(-n).join("\n");
}

/** 截到最后 `max` 个字符，从整行处切，前面标一句省略。 */
export function clipForShare(text: string, max = SHARE_MAX_CHARS): { text: string; clipped: boolean } {
  const t = text.replace(/\s+$/, "");
  if (t.length <= max) return { text: t, clipped: false };
  const cut = t.slice(-max);
  const nl = cut.indexOf("\n");
  return { text: nl >= 0 ? cut.slice(nl + 1) : cut, clipped: true };
}
