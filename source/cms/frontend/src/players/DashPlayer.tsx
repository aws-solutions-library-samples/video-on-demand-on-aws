/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 *
 * DASH panel via dash.js. Plays clear DASH; an optional `protection` (supplied by a UI extension) can
 * hold playback back and configure the player (e.g. license servers) once it is created.
 */
import { useEffect, useRef, useState } from 'react';
import dashjs from 'dashjs';
import { Box, Button, SpaceBetween } from '@cloudscape-design/components';
import { markReady, useStartAt } from './playback';
import PlayerStatus from './PlayerStatus';
import ScrubThumbnails from './ScrubThumbnails';
import QualitySelector, { type QualityLevel } from './QualitySelector';

/** Protected-playback wiring for {@link DashPlayer}. */
export interface DashProtection {
  /** The player re-initializes when this changes (e.g. when a session credential arrives). */
  key: string;
  /** Why playback cannot start yet; shown instead of loading. Undefined = ready. */
  blockedReason?: string;
  /** Configure the dash.js player right after `initialize()`. */
  configure?: (player: dashjs.MediaPlayerClass) => void;
}

interface Props {
  url: string;
  protection?: DashProtection;
  poster?: string;
  thumbnailsPrefix?: string;
  /** Seek here (seconds) once metadata loads, e.g. a `?t=` deep link. */
  startAt?: number;
}

export default function DashPlayer({ url, protection, poster, thumbnailsPrefix, startAt }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useStartAt(videoRef, startAt);
  const playerRef = useRef<dashjs.MediaPlayerClass | null>(null);
  const [status, setStatus] = useState('Idle');
  const [levels, setLevels] = useState<QualityLevel[]>([]);
  const [quality, setQuality] = useState(-1); // -1 = Auto (ABR)
  const [activeAuto, setActiveAuto] = useState(-1);

  function load() {
    const video = videoRef.current;
    if (!video) return;
    if (!url) {
      setStatus('No stream URL');
      return;
    }
    if (protection?.blockedReason) {
      setStatus(protection.blockedReason);
      return;
    }
    playerRef.current?.destroy();
    setStatus('Loading…');
    setLevels([]);
    setQuality(-1);

    const player = dashjs.MediaPlayer().create();
    playerRef.current = player;
    player.on('error', (event: { error?: { message?: string } | string }) => {
      const err = event?.error;
      setStatus(`Error: ${typeof err === 'string' ? err : (err?.message ?? 'unknown error')}`);
    });
    player.on('playbackStarted', () => setStatus('Playing'));
    // Populate the quality menu once the video representations are known.
    player.on('streamInitialized', () => {
      const list = player.getBitrateInfoListFor('video') ?? [];
      setLevels(list.map((b) => ({ height: b.height, bitrate: b.bitrate })));
    });
    // Reflect the ABR-chosen rendition while on Auto.
    player.on('qualityChangeRendered', (e: { mediaType?: string; newQuality?: number }) => {
      if (e?.mediaType === 'video' && typeof e.newQuality === 'number') setActiveAuto(e.newQuality);
    });
    player.initialize(video, url, false);

    protection?.configure?.(player);
    markReady(setStatus);
  }

  /** Pin a rendition (-1 restores ABR auto). */
  function selectQuality(index: number) {
    setQuality(index);
    const player = playerRef.current;
    if (!player) return;
    player.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: index < 0 } } } });
    if (index >= 0) player.setQualityFor('video', index);
  }

  useEffect(() => {
    load();
    return () => {
      playerRef.current?.destroy();
      playerRef.current = null;
    };
    // Re-init when the URL or the protection key changes (a protection may become ready asynchronously).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, protection?.key]);

  return (
    <SpaceBetween size="s">
      <video ref={videoRef} controls playsInline poster={poster} style={{ width: '100%', maxHeight: '70vh', background: '#000' }} />
      {thumbnailsPrefix && <ScrubThumbnails videoRef={videoRef} prefix={thumbnailsPrefix} />}
      <QualitySelector levels={levels} value={quality} activeAuto={activeAuto} onChange={selectQuality} />
      <Box>
        <Button iconName="refresh" onClick={load}>
          Reload
        </Button>
      </Box>
      <PlayerStatus status={status} />
    </SpaceBetween>
  );
}
