import { useRef } from "react";

import { MediaBar, useMediaPlayback } from "./MediaControls";

/**
 * 对话流里的音频播放条。控件自己画（为什么不用原生 controls 见
 * MediaControls）。`src` 还没读进来（null）时画同尺寸的禁用态，读完换上，不跳。
 */
export function AudioPlayer({ src, label }: { src: string | null; label: string }) {
  const ref = useRef<HTMLAudioElement>(null);
  const media = useMediaPlayback(ref, src);
  return (
    <span className="audio-player">
      {src ? <audio ref={ref} src={src} preload="metadata" {...media.handlers} /> : null}
      <MediaBar media={media} enabled={!!src} label={label} />
    </span>
  );
}
