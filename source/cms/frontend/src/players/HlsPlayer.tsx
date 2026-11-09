/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 *
 * HLS player (CMAF-HLS and HLS/TS) via hls.js, with a Safari native fallback.
 */
import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { Box, Button, SpaceBetween, Toggle } from '@cloudscape-design/components';
import { markReady, useStartAt } from './playback';
import PlayerStatus from './PlayerStatus';
import ScrubThumbnails from './ScrubThumbnails';
import QualitySelector, { type QualityLevel } from './QualitySelector';

interface Props {
  url: string;
  /** MediaTailor SSAI playback URL for this rendition; undefined = SSAI not available for this asset. */
  ssaiUrl?: string;
  poster?: string;
  thumbnailsPrefix?: string;
  /** Seek here (seconds) once metadata loads, e.g. a `?t=` deep link. */
  startAt?: number;
}

export default function HlsPlayer({ url, ssaiUrl, poster, thumbnailsPrefix, startAt }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useStartAt(videoRef, startAt);
  const hlsRef = useRef<Hls | null>(null);
  const [status, setStatus] = useState('Idle');
  const [levels, setLevels] = useState<QualityLevel[]>([]);
  const [quality, setQuality] = useState(-1); // -1 = Auto (ABR)
  const [activeAuto, setActiveAuto] = useState(-1);
  const [ssaiOn, setSsaiOn] = useState(false);
  // MediaTailor SSAI only stitches ads into the HLS/TS rendition (the only one with real
  // avail markers) and today's ADS is a static example VAST, not real ad decisioning.
  const effectiveUrl = ssaiOn && ssaiUrl ? ssaiUrl : url;

  function load() {
    const video = videoRef.current;
    if (!video) return;
    if (!effectiveUrl) {
      setStatus('No stream URL');
      return;
    }
    hlsRef.current?.destroy();
    hlsRef.current = null;
    setLevels([]);
    setQuality(-1);

    if (!Hls.isSupported()) {
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = effectiveUrl;
        markReady(setStatus);
      } else {
        setStatus('This browser supports neither hls.js MSE nor native HLS.');
      }
      return;
    }
    setStatus('Loading…');

    const hls = new Hls();
    hlsRef.current = hls;
    // hls.js raises many non-fatal errors (e.g. bufferAppendNoProgress, bufferStalledError) that it
    // recovers from on its own; only surface an error once playback genuinely cannot continue.
    let mediaRecoveryTried = false;
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) {
        console.debug('hls.js non-fatal error', data.details);
        return;
      }
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !mediaRecoveryTried) {
        mediaRecoveryTried = true;
        hls.recoverMediaError();
        return;
      }
      setStatus(`Error: ${data.details}`);
    });
    hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
      setLevels(data.levels.map((l) => ({ height: l.height, bitrate: l.bitrate })));
      markReady(setStatus);
    });
    hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => setActiveAuto(data.level));
    hls.loadSource(effectiveUrl);
    hls.attachMedia(video);
  }

  /** Pin a rendition (-1 restores ABR auto). */
  function selectQuality(index: number) {
    setQuality(index);
    if (hlsRef.current) hlsRef.current.currentLevel = index;
  }

  useEffect(() => {
    load();
    return () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveUrl]);

  return (
    <SpaceBetween size="s">
      <video ref={videoRef} controls playsInline poster={poster} style={{ width: '100%', maxHeight: '70vh', background: '#000' }} />
      {thumbnailsPrefix && <ScrubThumbnails videoRef={videoRef} prefix={thumbnailsPrefix} />}
      <QualitySelector levels={levels} value={quality} activeAuto={activeAuto} onChange={selectQuality} />
      <Toggle checked={ssaiOn} onChange={({ detail }) => setSsaiOn(detail.checked)} disabled={!ssaiUrl}>
        SSAI Ads (MediaTailor){!ssaiUrl && ' — not available for this asset'}
      </Toggle>
      {ssaiOn && ssaiUrl && (
        <Box variant="small" color="text-status-inactive">
          Playing the MediaTailor-stitched manifest. The ad decision server returns a static example ad,
          not real ad decisioning.
        </Box>
      )}
      <Box>
        <Button iconName="refresh" onClick={load}>
          Reload
        </Button>
      </Box>
      <PlayerStatus status={status} />
    </SpaceBetween>
  );
}
