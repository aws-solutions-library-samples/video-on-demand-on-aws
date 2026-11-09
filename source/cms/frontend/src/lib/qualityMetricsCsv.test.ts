/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 */
import { describe, expect, it } from 'vitest';
import { harmonicMean, parseQualityMetricsCsv } from './qualityMetricsCsv';

// Fixture matches the real MediaConvert per-frame-metrics CSV format documented at
// https://docs.aws.amazon.com/mediaconvert/latest/ug/per-frame-metrics-enable.html
const SAMPLE_CSV = `Display_ID,Value
0,100.00
1,55.36
2,54.88
3,55.05
4,53.39
Average: 43.15
Min: 34.19
Max: 100.00
`;

describe('parseQualityMetricsCsv', () => {
  it('parses the per-frame series, skipping the header row', () => {
    const { series } = parseQualityMetricsCsv(SAMPLE_CSV);
    expect(series).toEqual([
      { frame: 0, value: 100.0 },
      { frame: 1, value: 55.36 },
      { frame: 2, value: 54.88 },
      { frame: 3, value: 55.05 },
      { frame: 4, value: 53.39 },
    ]);
  });

  it('parses the trailing Average/Min/Max summary lines', () => {
    const { average, min, max } = parseQualityMetricsCsv(SAMPLE_CSV);
    expect(average).toBe(43.15);
    expect(min).toBe(34.19);
    expect(max).toBe(100.0);
  });

  it('tolerates CRLF line endings and out-of-order summary lines', () => {
    const crlf = 'Display_ID,Value\r\nMax: 9\r\n0,1\r\n1,2\r\nMin: 0\r\nAverage: 1.5\r\n';
    const parsed = parseQualityMetricsCsv(crlf);
    expect(parsed.series).toEqual([
      { frame: 0, value: 1 },
      { frame: 1, value: 2 },
    ]);
    expect(parsed).toMatchObject({ average: 1.5, min: 0, max: 9 });
  });

  it('returns nulls and an empty series for an empty file', () => {
    expect(parseQualityMetricsCsv('')).toEqual({ series: [], average: null, min: null, max: null });
  });
});

describe('harmonicMean', () => {
  it('returns null for an empty series', () => {
    expect(harmonicMean([])).toBeNull();
  });

  it('equals the value itself when every frame is identical', () => {
    // n / Σ(1/(100+1)) − 1 = 4 / (4/101) − 1 = 101 − 1 = 100
    expect(harmonicMean([100, 100, 100, 100])).toBeCloseTo(100, 10);
  });

  it('matches the offset harmonic mean for mixed values', () => {
    // n / Σ(1/(vᵢ+1)) − 1 = 2 / (1/2 + 1/4) − 1 = 2/0.75 − 1 = 1.6666…
    expect(harmonicMean([1, 3])).toBeCloseTo(1.6666666667, 9);
  });

  it('stays finite when a frame scores 0 (the reason for the +1/−1 offset)', () => {
    // 2 / (1/1 + 1/101) − 1 ≈ 0.980392 — a plain harmonic mean would collapse to 0 here
    expect(harmonicMean([0, 100])).toBeCloseTo(0.9803921569, 9);
  });
});
