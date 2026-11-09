/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 *
 * SDK-free shared contracts between the API Lambda and the browser (mirrors the shapes the API
 * returns).
 */
export interface CmsConfig {
  region: string | null;
  cloudFrontDomain: string | null;
  sourceBucket: string | null;
  tableConfigured: boolean;
  /** The VOD core stack this CMS reads (its `/<stackName>/` SSM namespace). */
  stackName: string | null;
  /** The enabled CMS extensions (from `.env` VOD_EXTENSIONS); the UI loads only these. */
  extensions?: string[];
}

export interface Asset {
  guid: string | null;
  workflowStatus: string | null;
  srcVideo: string | null;
  encodingProfile: string | null;
  srcHeight: number | null;
  startTime: string | null;
  endTime: string | null;
  archiveSource: string | null;
  hasAdBreaks: boolean;
  qualityMetrics: string[];
  errorStage?: string | null;
  /** Poster image URL (first FRAME_CAPTURE JPEG) from the thumbnails overlay; null when not generated. Returned in the list + detail shapes. */
  posterUrl?: string | null;
  // detail-only
  hlsUrl?: string | null;
  dashUrl?: string | null;
  cmafUrl?: string | null;
  /** MediaTailor SSAI playback URL for the HLS/TS rendition; null when the SSAI overlay isn't deployed. */
  ssaiHlsUrl?: string | null;
  orchestratorExecutionArn?: string | null;
  qualityMetricsPrefix?: string | null;
  /** CloudFront URL prefix of the FRAME_CAPTURE thumbnail JPEGs (`<guid>/thumbnails/`); null when absent. */
  thumbnailsPrefix?: string | null;
  adMarkersEsamXml?: string | null;
  errorMessage?: string | null;
  probeRaw?: unknown;
}

/** one quality-metrics file the browser should fetch+parse itself, already resolved to a
 * direct CloudFront URL. `format` is "json" for rescued packaging-mode data (plain fetch+parse,
 * no CSV parsing needed) or "csv" for native GA-mode data (needs `parseQualityMetricsCsv`). */
export interface QualityMetricsFile {
  metric: string; // e.g. "VMAF", "QVBR", "SHOT_CHANGE"
  format: 'json' | 'csv';
  url: string;
}

export interface QualityMetricsRendition {
  name: string; // MediaConvert output name (rendition), e.g. "stream_video_1"
  /** Real resolution (e.g. "1920x1080"), resolved from the delivered HLS master; null if unavailable. */
  resolution: string | null;
  files: QualityMetricsFile[];
}

/** Response shape of GET /assets/{guid}/quality-metrics — a manifest only, no file bodies. */
export interface QualityMetricsManifest {
  renditions: QualityMetricsRendition[];
}

/** One scrub-bar thumbnail JPEG from the thumbnailsProfile overlay's FRAME_CAPTURE output, already
 * resolved to a direct CloudFront URL. `key` is the bare filename (e.g. "frame.0000012.jpg"), sent
 * back verbatim to POST /assets/{guid}/poster to select it. */
export interface ThumbnailFrame {
  key: string;
  url: string;
}

/** Response shape of GET /assets/{guid}/thumbnails — a manifest only, no image bodies. */
export interface ThumbnailsManifest {
  frames: ThumbnailFrame[];
}

/** One rung's measured (actual) video-only bitrate, computed server-side from the delivered CMAF
 * `.cmfv` byte size / source duration. `index` is the MediaConvert rendition number (N in
 * `index_cmaf_video_N.cmfv`), N=0 highest — the same descending order the HLS master lists rungs in. */
export interface AbrActualBitrate {
  index: number;
  actualVideoBps: number;
}

/** Response shape of GET /assets/{guid}/abr-bitrates. */
export interface AbrBitratesResponse {
  rungs: AbrActualBitrate[];
}
