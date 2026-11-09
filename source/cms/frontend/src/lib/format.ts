/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 *
 * Presentation helpers for the Portal experience: derive a human title from the source key, a relative
 * "added" label from the workflow start time, and a short quality badge from the probed source height.
 * Pure functions (no React) so the grid, the watch-page rail, and the watch header can share them.
 */

/** Last path segment of an S3 key (e.g. `uploads/<id>/big_buck-bunny.mp4` -> `big_buck-bunny.mp4`). */
const baseName = (key: string): string => key.split('/').pop() || key;

/**
 * Human-friendly title from a source video key: strip the path and extension, turn `-`/`_`/`.`
 * separators into spaces, collapse whitespace, and title-case each word. Falls back to the guid (or a
 * generic label) when there is no source key.
 */
export function formatTitle(srcVideo?: string | null, guid?: string | null): string {
  if (!srcVideo) return guid ?? 'Untitled video';
  const stem = baseName(srcVideo).replace(/\.[^.]+$/, '');
  const words = stem
    .replace(/[-_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!words) return guid ?? 'Untitled video';
  return words
    .split(' ')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** Relative "Added N <unit> ago" from an ISO-ish start time; falls back to the raw string on parse failure. */
export function timeAgo(iso?: string | null): string {
  if (!iso) return 'Recently added';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return `Added ${iso}`;
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  const units: [number, string][] = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [30, 'day'],
    [12, 'month'],
    [Number.POSITIVE_INFINITY, 'year'],
  ];
  let value = secs;
  let unit = 'second';
  for (const [size, label] of units) {
    if (value < size) {
      unit = label;
      break;
    }
    value = Math.floor(value / size);
    unit = label;
  }
  if (unit === 'second' && value < 45) return 'Added just now';
  return `Added ${value} ${unit}${value === 1 ? '' : 's'} ago`;
}

/** Short quality badge from the probed source height (4K / 2K / HD / SD). */
export function qualityLabel(srcHeight?: number | null): string {
  if (!srcHeight) return 'SD';
  if (srcHeight >= 2160) return '4K';
  if (srcHeight >= 1440) return '2K';
  if (srcHeight >= 720) return 'HD';
  return 'SD';
}
