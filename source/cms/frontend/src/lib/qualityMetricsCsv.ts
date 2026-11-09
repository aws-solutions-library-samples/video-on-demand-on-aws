/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 *
 * parser for MediaConvert per-frame quality-metric CSVs (VMAF/QVBR/SHOT_CHANGE etc.). Format
 * (confirmed against AWS's MediaConvert docs): a `Display_ID,Value` header, one row per frame, then
 * three trailing summary lines that are NOT CSV rows:
 *
 *   Display_ID,Value
 *   0,100.00
 *   1,55.36
 *   ...
 *   Average: 43.15
 *   Min: 34.19
 *   Max: 100.00
 *
 * Only used for native GA-mode `.csv` files (the manifest's `format: "csv"` entries) — packaging-mode
 * assets get pre-parsed `.json` from the quality-metrics rescue Lambda and skip this entirely. Runs client-side
 * against the full file (no downsampling) — this feature's expected usage is low enough that slower
 * parsing/charting on a very long asset is an acceptable trade-off for full fidelity.
 */
export interface QualityMetricPoint {
  frame: number;
  value: number;
}

export interface ParsedQualityMetricCsv {
  series: QualityMetricPoint[];
  average: number | null;
  min: number | null;
  max: number | null;
}

const SUMMARY_LINE = /^(Average|Min|Max):\s*([\d.eE+-]+)/i;
const FRAME_ROW = /^(-?\d+)\s*,\s*(-?[\d.eE+-]+)\s*$/;

export function parseQualityMetricsCsv(text: string): ParsedQualityMetricCsv {
  const series: QualityMetricPoint[] = [];
  let average: number | null = null;
  let min: number | null = null;
  let max: number | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const summary = line.match(SUMMARY_LINE);
    if (summary) {
      const value = Number(summary[2]);
      const label = summary[1].toLowerCase();
      if (label === 'average') average = value;
      else if (label === 'min') min = value;
      else if (label === 'max') max = value;
      continue;
    }

    const row = line.match(FRAME_ROW);
    if (row) series.push({ frame: Number(row[1]), value: Number(row[2]) });
    // Anything else (the "Display_ID,Value" header, blank lines) is silently skipped.
  }

  return { series, average, min, max };
}

/**
 * Harmonic mean of a set of per-frame quality-metric values, using the offset convention that
 * Netflix's libvmaf applies for its `harmonic_mean` pooling: HM = n / Σ(1/(vᵢ+1)) − 1.
 *
 * The +1 / −1 offset is deliberate, not a fudge: a plain harmonic mean n / Σ(1/vᵢ) divides by
 * zero the moment any single frame scores 0 (common for VMAF's hardest frames, and the norm for
 * SHOT_CHANGE which is 0/1), and it is undefined for negative values. Shifting every value up by 1
 * before taking the reciprocal and shifting the result back down by 1 keeps the denominator finite
 * for the [0, ∞) range these metrics live in, and reproduces exactly the harmonic-mean figure the
 * VMAF tool itself reports. Returns null for an empty series.
 */
export function harmonicMean(values: number[]): number | null {
  if (values.length === 0) return null;
  let reciprocalSum = 0;
  for (const v of values) reciprocalSum += 1 / (v + 1);
  return values.length / reciprocalSum - 1;
}
