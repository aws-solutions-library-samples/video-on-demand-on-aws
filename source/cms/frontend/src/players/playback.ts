/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 */
import { type RefObject, useEffect } from 'react';

/**
 * Mark the player ready WITHOUT autostarting playback. The operator presses play (every <video> is
 * rendered with `controls`). Kept as a shared helper so all three players behave identically.
 */
export function markReady(setStatus: (s: string) => void): void {
  setStatus('Ready — press play');
}

/**
 * Seek the player to `startAt` seconds once the media's metadata is known (deep links such as
 * `/portal/:guid?t=<seconds>`). No-op when undefined. Applied once per `startAt` value, so the viewer can
 * then scrub freely; a re-attached source (quality/SSAI switch) is not re-seeked.
 */
export function useStartAt(videoRef: RefObject<HTMLVideoElement | null>, startAt?: number): void {
  useEffect(() => {
    const video = videoRef.current;
    if (!video || startAt === undefined || !Number.isFinite(startAt) || startAt <= 0) return;
    const seek = () => {
      video.currentTime = startAt;
    };
    if (video.readyState >= 1) {
      seek();
      return;
    }
    video.addEventListener('loadedmetadata', seek, { once: true });
    return () => video.removeEventListener('loadedmetadata', seek);
  }, [videoRef, startAt]);
}
