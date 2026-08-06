import { useEffect, useRef, useState } from 'react';

export interface RevealVideoProps {
  src: string;
  startMs: number;
  volume: number;
  hidden: boolean;
  onHiddenChange: (hidden: boolean) => void;
}

export function RevealVideo({ src, startMs, volume, hidden, onHiddenChange }: RevealVideoProps) {
  const ref = useRef<HTMLVideoElement>(null);
  const [needsUnmute, setNeedsUnmute] = useState(false);
  const [failed, setFailed] = useState(false);

  const volumeRef = useRef(volume);
  volumeRef.current = volume;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setNeedsUnmute(false);
    setFailed(false);

    const start = (): void => {
      const target = startMs / 1000;
      if (target > 0 && Number.isFinite(el.duration) && el.duration > 0) {
        try {
          el.currentTime = Math.min(target, Math.max(0, el.duration - 1));
        } catch {
        }
      }

      el.volume = volumeRef.current;
      if (volumeRef.current === 0) {
        el.muted = true;
        void el.play().catch(() => setFailed(true));
        return;
      }

      el.muted = false;
      void el.play().catch(() => {
        el.muted = true;
        setNeedsUnmute(true);
        void el.play().catch(() => setFailed(true));
      });
    };

    if (el.readyState >= 1) start();
    else el.addEventListener('loadedmetadata', start, { once: true });
    return () => el.removeEventListener('loadedmetadata', start);
  }, [src, startMs]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.volume = volume;
    if (volume > 0 && !needsUnmute) el.muted = false;
    if (volume === 0) el.muted = true;
  }, [volume, needsUnmute]);

  if (failed) {
    return (
      <div className="reveal-video is-waiting">
        <span className="shield-hint">Video unavailable</span>
      </div>
    );
  }

  return (
    <div className="reveal-video">
      <video
        ref={ref}
        src={src}
        playsInline
        preload="metadata"
        onError={() => setFailed(true)}
      />

      <button
        type="button"
        className="spoiler-shield"
        data-on={hidden}
        onClick={() => onHiddenChange(!hidden)}
      >
        <span className="shield-label">{hidden ? 'Video hidden' : 'Hide video'}</span>
        {hidden && <span className="shield-hint">Click to show · the song keeps playing</span>}
      </button>

      {needsUnmute && (
        <button
          className="btn"
          data-variant="primary"
          onClick={() => {
            const el = ref.current;
            if (!el) return;
            el.muted = false;
            el.volume = volumeRef.current;
            setNeedsUnmute(false);
            void el.play().catch(() => setNeedsUnmute(true));
          }}
        >
          Unmute
        </button>
      )}
    </div>
  );
}
