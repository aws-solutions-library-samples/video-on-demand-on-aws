/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 *
 * Per-format stream URL derivation for the operator app's players. URLs are derived from the ASSET
 * record (hlsUrl/dashUrl).
 */
import type { Asset } from '../types';

export interface StreamUrls {
  hlsUrl?: string;
  dashUrl?: string;
  cmafUrl?: string;
  /** true = REMUX_ALL packaging layout (per-format under /hls,/cmaf,/dash); false = GA single-CMAF. */
  overlay: boolean;
}

/**
 * Resolve per-format URLs from the asset's stored playback URLs. When the HLS URL sits under
 * `/hls/index.m3u8` the sibling CMAF-HLS URL is synthesized so all three format tabs are offered
 * (DASH, CMAF-HLS, HLS/TS).
 */
export function deriveStreamUrls(asset: Pick<Asset, 'hlsUrl' | 'dashUrl'>): StreamUrls {
  const hlsUrl = asset.hlsUrl ?? undefined;
  const dashUrl = asset.dashUrl ?? undefined;
  const overlay = !!hlsUrl && /\/hls\/index\.m3u8$/.test(hlsUrl);
  const cmafUrl = overlay && hlsUrl ? hlsUrl.replace(/\/hls\/index\.m3u8$/, '/cmaf/index.m3u8') : undefined;
  return { hlsUrl, dashUrl, cmafUrl, overlay };
}
