/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 *
 * Multi-format inline player for the asset detail page. Derives per-format URLs from the asset record
 * and renders a Cloudscape tab per available format (players under ../players).
 * GA layout: DASH + HLS (CMAF). Packaging overlay: DASH + CMAF-HLS + HLS/TS. A UI extension may replace
 * this player (see ../lib/extensions.ts).
 */
import { useMemo } from 'react';
import { Alert, SpaceBetween, StatusIndicator, Tabs, type TabsProps } from '@cloudscape-design/components';
import DashPlayer from '../players/DashPlayer';
import HlsPlayer from '../players/HlsPlayer';
import type { AssetPlayerProps } from '../lib/extensions';
import { useExtensions } from '../context/ExtensionsContext';
import { deriveStreamUrls } from '../lib/streams';

export default function AssetPlayer(props: AssetPlayerProps) {
  // An enabled extension may replace the player (the first one that provides one wins).
  const ExtensionPlayer = useExtensions().find((ext) => ext.AssetPlayer)?.AssetPlayer;
  return ExtensionPlayer ? <ExtensionPlayer {...props} /> : <ClearAssetPlayer {...props} />;
}

function ClearAssetPlayer({ asset, startAt }: AssetPlayerProps) {
  const streams = useMemo(() => deriveStreamUrls(asset), [asset]);
  // Prefer the server-recorded CMAF-HLS URL; fall back to the derived /cmaf sibling for older assets.
  const cmafUrl = asset.cmafUrl ?? streams.cmafUrl;
  // Poster (first FRAME_CAPTURE JPEG) from the thumbnails overlay; undefined when not generated.
  const poster = asset.posterUrl ?? undefined;
  // CloudFront prefix of the FRAME_CAPTURE JPEGs, for the hover-scrub thumbnails; undefined when absent.
  const thumbnailsPrefix = asset.thumbnailsPrefix ?? undefined;

  if (!streams.hlsUrl && !streams.dashUrl) {
    return (
      <Alert type="info" header="No playback URLs yet">
        Playback URLs are written after the Process/encode stage. Current status: {asset.workflowStatus ?? 'unknown'}.
      </Alert>
    );
  }

  // One tab per format. Labels are mode-aware: the GA core (PACKAGING_PROFILE=OFF) emits a single CMAF
  // output group, so both tabs are CMAF; the packaging overlay (streams.overlay) delivers distinct
  // HLS/TS, DASH and CMAF-HLS formats.
  const tabs: TabsProps.Tab[] = [];
  if (streams.hlsUrl) {
    tabs.push({
      id: 'hls',
      label: streams.overlay ? 'HLS/TS' : 'HLS (CMAF)',
      content: (
        <HlsPlayer url={streams.hlsUrl} ssaiUrl={asset.ssaiHlsUrl ?? undefined} poster={poster} thumbnailsPrefix={thumbnailsPrefix} startAt={startAt} />
      ),
    });
  }
  if (streams.dashUrl) {
    tabs.push({
      id: 'dash',
      label: streams.overlay ? 'DASH' : 'DASH (CMAF)',
      content: <DashPlayer url={streams.dashUrl} poster={poster} thumbnailsPrefix={thumbnailsPrefix} startAt={startAt} />,
    });
  }
  if (cmafUrl) {
    tabs.push({
      id: 'cmaf',
      label: 'CMAF-HLS',
      content: <HlsPlayer url={cmafUrl} poster={poster} thumbnailsPrefix={thumbnailsPrefix} startAt={startAt} />,
    });
  }

  return (
    <SpaceBetween size="s">
      <StatusIndicator type="success">{streams.overlay ? 'Packaged streams' : 'CMAF streams'}</StatusIndicator>
      <Tabs tabs={tabs} />
    </SpaceBetween>
  );
}
