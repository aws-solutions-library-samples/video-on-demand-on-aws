/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 *
 * Hover-preview scrub timeline rendered below a player's <video>. The native <video controls> seek bar
 * can't host a preview, so this is a supplementary strip: hover shows the nearest FRAME_CAPTURE thumbnail
 * (from the thumbnails overlay) for that timecode; click seeks the video. Frontend-only — reuses the
 * per-asset JPEGs at `<thumbnailsPrefix>frame.<7-digit>.jpg` (one every INTERVAL_SECONDS).
 */
import { type MouseEvent as ReactMouseEvent, type RefObject, useEffect, useRef, useState } from 'react';
import { formatTimecode } from '../lib/adMarkers';

/** Capture cadence — MUST match the pipeline FRAME_CAPTURE_DEFAULTS.framerateDenominator (source/core/lib/asl.ts). */
const INTERVAL_SECONDS = 5;
/** MediaConvert FRAME_CAPTURE MaxCaptures — the last frame index is MAX_CAPTURES - 1. */
const MAX_CAPTURES = 500;

const frameUrl = (prefix: string, index: number): string => `${prefix}frame.${String(index).padStart(7, '0')}.jpg`;

interface Props {
  videoRef: RefObject<HTMLVideoElement>;
  prefix: string;
  intervalSeconds?: number;
}

export default function ScrubThumbnails({ videoRef, prefix, intervalSeconds = INTERVAL_SECONDS }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [duration, setDuration] = useState(0);
  const [hover, setHover] = useState<{ x: number; t: number; url: string } | null>(null);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const update = () => setDuration(Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0);
    update();
    v.addEventListener('loadedmetadata', update);
    v.addEventListener('durationchange', update);
    return () => {
      v.removeEventListener('loadedmetadata', update);
      v.removeEventListener('durationchange', update);
    };
  }, [videoRef]);

  if (duration <= 0) return null; // no scrub until the video's duration is known

  const maxIndex = Math.min(Math.floor(duration / intervalSeconds), MAX_CAPTURES - 1);

  const onMove = (e: ReactMouseEvent<HTMLDivElement>) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const t = rect.width ? (x / rect.width) * duration : 0;
    const index = Math.max(0, Math.min(maxIndex, Math.round(t / intervalSeconds)));
    setHover({ x, t, url: frameUrl(prefix, index) });
  };

  const seek = () => {
    const v = videoRef.current;
    if (v && hover) v.currentTime = hover.t;
  };

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <div
        ref={trackRef}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        onClick={seek}
        role="slider"
        aria-label="Scrub thumbnails"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={hover ? Math.round(hover.t) : 0}
        tabIndex={0}
        style={{ height: 10, borderRadius: 4, background: '#2b3a4a', cursor: 'pointer' }}
      />
      {hover && (
        <div
          style={{
            position: 'absolute',
            bottom: 18,
            left: Math.max(0, hover.x - 80),
            width: 160,
            pointerEvents: 'none',
            background: '#0f1b2d',
            border: '1px solid #3a4a5a',
            borderRadius: 4,
            padding: 2,
            zIndex: 10,
          }}
        >
          <img
            src={hover.url}
            alt=""
            style={{ width: '100%', height: 90, objectFit: 'cover', display: 'block', borderRadius: 2, background: '#000' }}
            onError={() => setHover(null)}
          />
          <div style={{ textAlign: 'center', fontSize: 12, color: '#d5dbdb' }}>{formatTimecode(hover.t)}</div>
        </div>
      )}
    </div>
  );
}
