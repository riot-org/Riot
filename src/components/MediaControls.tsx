import { type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { host, setWindowFullscreen, subscribeFullscreen } from "../bridge";
import { useT } from "../i18n";

/**
 * 对话流里音频 / 视频共用的播放控件：播放状态 + 一条控件（播放 / 暂停、
 * 当前时间、进度条、总时长，视频再加静音和全屏）。
 *
 * 不用原生 `controls`：macOS WebKit 的原生媒体控件是它自己用脚本排版的，
 * 元素一被跳过渲染（切走会话时整个对话面板走 content-visibility，离屏的
 * 轮同理）再显示，控件就重新量一遍尺寸、重新排 —— 播放键、"0:00"、进度条
 * 当着用户的面挪位置。原生控件内部碰不到，只能自己画：普通元素、尺寸
 * 固定，第一帧就是最终布局。
 */

/** 正在放的那一段（全局只放一段：开一个，别的停下）。 */
let current: HTMLMediaElement | null = null;

export interface MediaPlayback {
  playing: boolean;
  time: number;
  duration: number;
  muted: boolean;
  toggle: () => void;
  seek: (t: number) => void;
  /** 拖进度条期间不让播放进度把滑块拽回去。 */
  seeking: RefObject<boolean>;
  /** 摊到 <audio> / <video> 上的事件。 */
  handlers: {
    onLoadedMetadata: (e: React.SyntheticEvent<HTMLMediaElement>) => void;
    onDurationChange: (e: React.SyntheticEvent<HTMLMediaElement>) => void;
    onPlay: (e: React.SyntheticEvent<HTMLMediaElement>) => void;
    onPause: (e: React.SyntheticEvent<HTMLMediaElement>) => void;
    onEnded: (e: React.SyntheticEvent<HTMLMediaElement>) => void;
    onTimeUpdate: (e: React.SyntheticEvent<HTMLMediaElement>) => void;
    onVolumeChange: (e: React.SyntheticEvent<HTMLMediaElement>) => void;
  };
}

/** 一个媒体元素的播放状态。`src` 变了（文件读进来）时重新接管。 */
export function useMediaPlayback(
  ref: RefObject<HTMLMediaElement | null>,
  src: string | null,
): MediaPlayback {
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const seeking = useRef(false);

  // 播放中按帧刷新时间和进度：timeupdate 一秒只来四次左右，滑块会一跳一跳。
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const m = ref.current;
      if (m && !seeking.current) setTime(m.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, ref]);

  // 卸载（会话被淘汰、消息被删）或换了文件时停掉，别留一段看不见的声音
  // 在放。跟着 src 走：src 到了媒体元素才挂上，这时取到的才是它。
  useEffect(() => {
    const m = ref.current;
    return () => {
      m?.pause();
      if (current === m) current = null;
    };
  }, [src, ref]);

  const finite = (n: number) => (Number.isFinite(n) ? n : 0);
  return {
    playing,
    time,
    duration,
    muted,
    seeking,
    toggle: () => {
      const m = ref.current;
      if (!m || !src) return;
      if (m.paused) void m.play().catch(() => setPlaying(false));
      else m.pause();
    },
    seek: (t) => {
      setTime(t);
      if (ref.current) ref.current.currentTime = t;
    },
    handlers: {
      onLoadedMetadata: (e) => setDuration(finite(e.currentTarget.duration)),
      onDurationChange: (e) => setDuration(finite(e.currentTarget.duration)),
      onPlay: (e) => {
        if (current && current !== e.currentTarget) current.pause();
        current = e.currentTarget;
        setPlaying(true);
      },
      onPause: (e) => {
        if (current === e.currentTarget) current = null;
        setPlaying(false);
        setTime(e.currentTarget.currentTime);
      },
      onEnded: (e) => {
        setPlaying(false);
        setTime(e.currentTarget.duration);
      },
      onTimeUpdate: (e) => {
        if (!seeking.current) setTime(e.currentTarget.currentTime);
      },
      onVolumeChange: (e) => setMuted(e.currentTarget.muted),
    },
  };
}

/**
 * 视频全屏。
 *
 * `[约束]` 桌面版不用元素全屏（requestFullscreen）。WebKit 的元素全屏是把
 * 整个 WebView 从窗口里摘下来、挪进另一个全屏窗口，退出再挪回去 —— 进、出
 * 各重挂一次、重排一次，视频图层按新几何重建，看着就是跳一下、像重新加载。
 * Electron（Chromium）的元素全屏不挪 WebView：窗口自己进系统全屏，页面里
 * 那个元素铺满视口，所以 Claude 桌面版不跳。这里照它做：窗口 setFullscreen，
 * 播放器以 popover 进顶层铺满窗口（`filled`）。浏览器里照旧用元素全屏。
 *
 * 两条路都先把外层的高度钉住、留在对话流里：对话列高度从头到尾不变。
 */
export function useVideoFullscreen(
  wrapRef: RefObject<HTMLElement | null>,
  stageRef: RefObject<HTMLElement | null>,
  videoRef: RefObject<HTMLVideoElement | null>,
): { fullscreen: boolean; filled: boolean; toggle: () => void } {
  /** 桌面版：播放器铺满窗口中。 */
  const [filled, setFilled] = useState(false);
  /** 浏览器：播放器在元素全屏里。 */
  const [native, setNative] = useState(false);
  /** 进全屏前窗口是不是已经全屏（切的那一下返回）。是的话退出时不动窗口。 */
  const windowWas = useRef<Promise<boolean | null> | null>(null);
  /** 浏览器的元素全屏退出后，对话流可能被滚过（把元素滚进视野），按它还原。 */
  const scrollBefore = useRef<{ box: HTMLElement; top: number } | null>(null);

  const pin = () => {
    const wrap = wrapRef.current;
    if (wrap) wrap.style.height = `${wrap.getBoundingClientRect().height}px`;
  };
  const unpin = useCallback(() => {
    if (wrapRef.current) wrapRef.current.style.height = "";
  }, [wrapRef]);

  const exitFill = useCallback(() => {
    setFilled(false);
    const was = windowWas.current;
    windowWas.current = null;
    void was?.then((w) => {
      if (w === false) void setWindowFullscreen(false);
    });
  }, []);

  // 铺满：进顶层（popover），躲开对话流里各层的裁剪、层叠和 content-visibility。
  // 老 WebKit 没有 popover，退到 position: fixed（样式里 .is-filled 两种都盖）。
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!filled || !stage) return;
    const pop = typeof stage.showPopover === "function";
    if (pop) {
      stage.setAttribute("popover", "manual");
      stage.showPopover();
    }
    return () => {
      if (pop) {
        if (stage.matches(":popover-open")) stage.hidePopover();
        stage.removeAttribute("popover");
      }
      unpin();
    };
  }, [filled, stageRef, unpin]);

  // 铺满期间：Esc 退出（系统全屏里 Esc 不管窗口）；用户从绿灯 / ⌃⌘F 把窗口
  // 退出全屏了，播放器也跟着收回。
  useEffect(() => {
    if (!filled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      exitFill();
    };
    window.addEventListener("keydown", onKey, true);
    // 只认"全屏过之后又不是了"：切换动画途中先问到的可能还是 false。
    let seen = false;
    const stop = subscribeFullscreen((full) => {
      if (full) seen = true;
      else if (seen) exitFill();
    });
    return () => {
      window.removeEventListener("keydown", onKey, true);
      stop();
    };
  }, [filled, exitFill]);

  // 卸载时还铺着（会话被淘汰、消息被删）：窗口也还原。
  const filledNow = useRef(false);
  filledNow.current = filled;
  useEffect(
    () => () => {
      if (filledNow.current) exitFill();
    },
    [exitFill],
  );

  // 浏览器的元素全屏：退出时松开占位、还原滚动、重建视频图层。
  useEffect(() => {
    const onChange = () => {
      const on = !!stageRef.current && document.fullscreenElement === stageRef.current;
      setNative(on);
      if (on) return;
      unpin();
      const saved = scrollBefore.current;
      scrollBefore.current = null;
      if (saved) {
        const restore = () => {
          if (Math.abs(saved.box.scrollTop - saved.top) > 1) saved.box.scrollTop = saved.top;
        };
        // 浏览器退出全屏时可能在接下来一两帧里再滚一下，两帧都核一次。
        requestAnimationFrame(() => {
          restore();
          requestAnimationFrame(restore);
        });
      }
      // Safari 把视频从顶层挪回原处后，合成图层有时还停在全屏时的几何上。
      if (videoRef.current) rebuildVideoLayer(videoRef.current);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [stageRef, videoRef, unpin]);

  const toggle = () => {
    if (filled) {
      exitFill();
      return;
    }
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
      return;
    }
    const wrap = wrapRef.current;
    const stage = stageRef.current;
    if (!wrap || !stage) return;
    if (host.nativeWindow) {
      pin();
      setFilled(true);
      windowWas.current = setWindowFullscreen(true);
      return;
    }
    const video = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    // 没开元素全屏的浏览器退到视频自己的系统全屏（那里是系统播放器的控件）。
    if (!stage.requestFullscreen || !document.fullscreenEnabled) {
      video?.webkitEnterFullscreen?.();
      return;
    }
    const box = wrap.closest<HTMLElement>(".transcript");
    scrollBefore.current = box ? { box, top: box.scrollTop } : null;
    pin();
    void stage.requestFullscreen().catch(() => {
      unpin();
      scrollBefore.current = null;
      video?.webkitEnterFullscreen?.();
    });
  };

  return { fullscreen: filled || native, filled, toggle };
}

/**
 * 让 WebKit 重建视频的合成图层：外层高度先钉住（不然拆掉那一帧对话会塌
 * 一下、跟着跳），视频 display:none 一帧再放回来。播放状态和进度都在
 * 元素上，不受影响。
 */
function rebuildVideoLayer(v: HTMLVideoElement) {
  const wrap = v.parentElement;
  if (!wrap) return;
  const h = wrap.getBoundingClientRect().height;
  wrap.style.height = `${h}px`;
  v.style.display = "none";
  requestAnimationFrame(() => {
    v.style.display = "";
    requestAnimationFrame(() => {
      wrap.style.height = "";
    });
  });
}

/** 控件条。`extra` 排在最右（视频的静音、全屏）。 */
export function MediaBar({
  media,
  enabled,
  label,
  extra,
}: {
  media: MediaPlayback;
  /** 文件读进来了。没读进来时整条禁用，但尺寸照旧 —— 读完换上不跳。 */
  enabled: boolean;
  label: string;
  extra?: ReactNode;
}) {
  const { t } = useT();
  const { playing, time, duration, seeking } = media;
  const ready = enabled && duration > 0;
  const max = duration || 1;
  const at = Math.min(time, max);
  return (
    <span className="media-bar">
      <button
        type="button"
        className="media-btn media-toggle"
        onClick={media.toggle}
        disabled={!enabled}
        aria-label={playing ? t("transcript.md.audioPause") : t("transcript.md.audioPlay")}
        title={playing ? t("transcript.md.audioPause") : t("transcript.md.audioPlay")}
      >
        {playing ? <PauseGlyph /> : <PlayGlyph />}
      </button>
      <span className="media-time">{clock(time)}</span>
      <input
        type="range"
        className="media-seek"
        min={0}
        max={max}
        step={0.01}
        value={at}
        disabled={!ready}
        aria-label={t("transcript.md.audioSeek")}
        aria-valuetext={`${clock(time)} / ${clock(duration)}`}
        title={label}
        // 已播比例给样式画填充（WebKit 的 range 没有原生的"已走过"那一段）。
        style={{ ["--pct" as string]: `${(at / max) * 100}%` }}
        onPointerDown={() => {
          seeking.current = true;
        }}
        onPointerUp={() => {
          seeking.current = false;
        }}
        onChange={(e) => media.seek(Number(e.currentTarget.value))}
      />
      <span className="media-time">{ready ? clock(duration) : "--:--"}</span>
      {extra}
    </span>
  );
}

/** 秒 → m:ss（过一小时 h:mm:ss）。 */
function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

function PlayGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <path d="M3 1.8v8.4c0 .5.5.8.9.55l6.3-4.2a.65.65 0 0 0 0-1.1L3.9 1.25A.6.6 0 0 0 3 1.8z" fill="currentColor" />
    </svg>
  );
}

function PauseGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <rect x="2.5" y="1.5" width="2.6" height="9" rx="0.8" fill="currentColor" />
      <rect x="6.9" y="1.5" width="2.6" height="9" rx="0.8" fill="currentColor" />
    </svg>
  );
}

export function VolumeGlyph({ muted }: { muted: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M2.5 6h2.2L8 3.2v9.6L4.7 10H2.5z" fill="currentColor" />
      {muted ? (
        <path d="M11 6.2l3.3 3.6M14.3 6.2L11 9.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      ) : (
        <path
          d="M10.6 5.6a3.4 3.4 0 0 1 0 4.8M12.4 3.9a5.8 5.8 0 0 1 0 8.2"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

export function FullscreenGlyph({ exit }: { exit: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d={
          exit
            ? "M6 2.5v3.5H2.5M10 2.5v3.5h3.5M6 13.5V10H2.5M10 13.5V10h3.5"
            : "M2.5 6V2.5H6M13.5 6V2.5H10M2.5 10v3.5H6M13.5 10v3.5H10"
        }
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
