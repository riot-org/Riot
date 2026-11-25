/**
 * 本机开发服务的网址（`http://localhost:5173`、`127.0.0.1:8080/api`……）。
 *
 * 回答里出现它们，十有八九是"服务起好了，你看一眼"：点一下就该开进内置
 * 浏览器，而不是跳到系统浏览器、切走窗口。模型写这种网址又特别随意 ——
 * 常常包在行内代码里，或者干脆不带 `http://` —— 这两种也要认出来变成
 * 链接（见 Markdown.tsx 的 remarkLocalUrls）。
 *
 * 只认回环地址。局域网 IP（Vite 打印的 Network: http://192.168.…）不算：
 * 那多半是给手机看的，而且分不清是不是别人的机器。
 */

const HOST = String.raw`(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.localhost)`;
const PORT = String.raw`:\d{2,5}`;
/** 路径到空白或全角标点为止（中文句子里 URL 后面紧跟的「，」不算 URL）。 */
const PATH = String.raw`(?:[/?#][^\s<>"'\`　-〿＀-￯]*)?`;

/** 整段就是一个本地网址（行内代码里的那种）。不带协议时必须带端口。 */
const WHOLE = new RegExp(String.raw`^(?:(https?:\/\/)${HOST}(?:${PORT})?|${HOST}${PORT})${PATH}$`, "i");

/** 正文里不带协议的 `localhost:5173/…`。带协议的 GFM 自己会链接。 */
const BARE = new RegExp(String.raw`(?<![\w/.:@-])${HOST}${PORT}${PATH}`, "gi");

/** 句末标点不算进网址：「打开 localhost:3000.」 */
function trimTail(url: string): string {
  return url.replace(/[.,;:!?)\]}]+$/, "");
}

/** 补上协议、把 0.0.0.0 换成 localhost（浏览器不让直接访问 0.0.0.0）。 */
export function normalizeLocalUrl(raw: string): string {
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  return withScheme.replace(/^(https?:\/\/)0\.0\.0\.0(?=[:/]|$)/i, "$1localhost");
}

/** 一个 http(s) 网址是不是本机的开发服务。 */
export function isLocalDevUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    return (
      h === "localhost" ||
      h === "127.0.0.1" ||
      h === "0.0.0.0" ||
      h === "[::1]" ||
      h.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

/** 行内代码的内容如果整段是本地网址，给出规范化后的链接地址。 */
export function localUrlOfCode(code: string): string | null {
  const s = code.trim();
  if (!WHOLE.test(s)) return null;
  const url = normalizeLocalUrl(trimTail(s));
  return isLocalDevUrl(url) ? url : null;
}

/** 正文里不带协议的本地网址：每一处的位置、原文和链接地址。 */
export function findBareLocalUrls(text: string): { index: number; text: string; url: string }[] {
  const out: { index: number; text: string; url: string }[] = [];
  for (const m of text.matchAll(BARE)) {
    const raw = trimTail(m[0]);
    if (m.index === undefined || !raw) continue;
    out.push({ index: m.index, text: raw, url: normalizeLocalUrl(raw) });
  }
  return out;
}
