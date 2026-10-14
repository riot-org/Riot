/**
 * 流式正文的匀速放出。
 *
 * token 是成撮到的：网络一次吐几十上百个字，rAF 合批之后屏幕上就是
 * "停一下、蹦一大段、再停一下"。每次只放出积压的一部分，把一撮摊到
 * 后面一小段时间里，看起来是连续地往外长。
 *
 * - 按**时间**而不是按帧限速：每过 PACE_WINDOW_MS 放完当时的积压。
 *   按帧算的话，rAF 被节流（窗口被挡住、低电量模式、后台面板只给
 *   1 帧/秒）时正文会越落越远；120Hz 屏上又放得太快，等于没摊开；
 * - 一撮刚到（上一次已经放空）按一帧算，不按距上次放出的真实间隔 ——
 *   那段间隔是在等网络，算进去就是一到就全放，摊不开；
 * - 每次至少放 PACE_MIN_CHARS 个字；积压超过 PACE_MAX_BACKLOG（切回
 *   会话、重连补发）直接全放 —— 那是在补账，不是"正在说"；
 * - `[约束]` 只有 rAF 那一路限速。工具开始、整条消息落定、Done 这些
 *   事件同步调 flush()，一次放完 —— 它们要拿完整的流式文本去落定条目，
 *   少一截就是丢字。
 */
export const PACE_WINDOW_MS = 120;
export const PACE_FRAME_MS = 16;
export const PACE_MIN_CHARS = 3;
export const PACE_MAX_BACKLOG = 4_000;

/** 这一次从积压里放出多少个 UTF-16 单元。`dt` 是距上次放出的毫秒数。不在代理对中间切开。 */
export function paceTake(pending: string, dt: number): number {
  const n = pending.length;
  if (n <= PACE_MIN_CHARS || n > PACE_MAX_BACKLOG || dt >= PACE_WINDOW_MS) return n;
  let k = Math.max(PACE_MIN_CHARS, Math.ceil((n * dt) / PACE_WINDOW_MS));
  if (k < n) {
    const c = pending.charCodeAt(k - 1);
    if (c >= 0xd800 && c <= 0xdbff) k++;
  }
  return Math.min(k, n);
}

