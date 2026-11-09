/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 *
 * Adaptive bitrate ladder parser: derives the delivered rungs (resolution / bitrate / codec / frame
 * rate) from an HLS master manifest. The HLS master's #EXT-X-STREAM-INF lines are the only single
 * source that carries all three together (MediaConvert's job-complete metadata reports resolution
 * only), and CloudFront serves the manifest CORS-open, so the CMS reads it client-side.
 */
export interface LadderRung {
  resolution: string; // "1280x720"
  width: number;
  height: number;
  peakBps: number; // BANDWIDTH
  avgBps: number; // AVERAGE-BANDWIDTH (falls back to peak when absent)
  codecs: string; // friendly, e.g. "H.264, AAC"
  frameRate?: number;
  /** Measured video-only bitrate (bps) from the delivered CMAF `.cmfv` size / duration; set by
   * mergeActualBitrates. Undefined when the backend didn't return a matching value. */
  actualVideoBps?: number;
}

/** Split an EXT-X-STREAM-INF attribute list on commas that are NOT inside quotes (CODECS="a,b"). */
function splitAttributes(line: string): string[] {
  const attrs: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === ',' && !inQuotes) {
      attrs.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) attrs.push(current);
  return attrs;
}

/** Parse `KEY=VALUE[,KEY=VALUE...]` into a map, stripping surrounding quotes from values. */
function parseAttributes(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const attr of splitAttributes(line)) {
    const eq = attr.indexOf('=');
    if (eq < 0) continue;
    const key = attr.slice(0, eq).trim();
    const value = attr.slice(eq + 1).trim().replace(/^"|"$/g, '');
    out[key] = value;
  }
  return out;
}

/** RFC-6381 codec tag -> friendly label. */
function friendlyCodec(tag: string): string {
  const t = tag.trim().toLowerCase();
  if (t.startsWith('avc1') || t.startsWith('avc3')) return 'H.264';
  if (t.startsWith('hvc1') || t.startsWith('hev1')) return 'HEVC';
  if (t.startsWith('av01')) return 'AV1';
  if (t.startsWith('vp09')) return 'VP9';
  if (t.startsWith('mp4a')) return 'AAC';
  if (t === 'ac-3') return 'AC-3';
  if (t === 'ec-3') return 'E-AC-3';
  return tag.trim();
}

/** Map a CODECS="a,b" list to unique friendly labels joined with ", " (e.g. "H.264, AAC"). */
export function friendlyCodecs(codecs: string): string {
  if (!codecs) return '-';
  const labels = codecs
    .split(',')
    .map(friendlyCodec)
    .filter(Boolean);
  return [...new Set(labels)].join(', ') || '-';
}

/** "2.50 Mbps" from bits-per-second. */
export function formatBitrate(bps: number): string {
  return `${(bps / 1_000_000).toFixed(2)} Mbps`;
}

/**
 * Parse an HLS master manifest into the video ABR ladder, sorted by peak bitrate desc. Variant streams
 * without a RESOLUTION (audio-only groups / #EXT-X-MEDIA renditions) are skipped.
 */
export function parseHlsMaster(text: string): LadderRung[] {
  const rungs: LadderRung[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    const attrs = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
    const resolution = attrs['RESOLUTION'];
    if (!resolution) continue; // audio-only / no video dimensions
    const [width, height] = resolution.split('x').map((n) => parseInt(n, 10));
    const peakBps = parseInt(attrs['BANDWIDTH'] ?? '0', 10) || 0;
    const avgBps = parseInt(attrs['AVERAGE-BANDWIDTH'] ?? '', 10) || peakBps;
    const frameRate = attrs['FRAME-RATE'] ? parseFloat(attrs['FRAME-RATE']) : undefined;
    rungs.push({
      resolution,
      width: width || 0,
      height: height || 0,
      peakBps,
      avgBps,
      codecs: friendlyCodecs(attrs['CODECS'] ?? ''),
      frameRate,
    });
  }
  return rungs.sort((a, b) => b.peakBps - a.peakBps);
}

/**
 * Attach the backend's measured video-only bitrates to the manifest-parsed rungs, by position. Both
 * lists are in descending-bitrate order — the HLS master lists renditions highest-first, and the
 * backend returns them by `index` (N) ascending, N=0 highest (the same rendition-order invariant the
 * pipeline preserves across output groups). They only line up when the counts match, so a length
 * mismatch (or empty `actual`) is treated as "no measured data" and the rungs are returned unchanged
 * rather than mis-joined. Pure + non-mutating (returns new rung objects).
 */
export function mergeActualBitrates(rungs: LadderRung[], actual: { index: number; actualVideoBps: number }[]): LadderRung[] {
  if (actual.length !== rungs.length) return rungs;
  const byIndex = [...actual].sort((a, b) => a.index - b.index);
  return rungs.map((r, i) => ({ ...r, actualVideoBps: byIndex[i].actualVideoBps }));
}
