/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 */
import { describe, expect, it } from 'vitest';
import { mergeActualBitrates, parseHlsMaster, type LadderRung } from './abrLadder';

const rung = (peakBps: number, avgBps: number): LadderRung => ({
  resolution: `${peakBps}x0`,
  width: peakBps,
  height: 0,
  peakBps,
  avgBps,
  codecs: 'H.264',
});

describe('mergeActualBitrates', () => {
  it('zips measured bitrates onto rungs by position (both descending)', () => {
    const rungs = [rung(7000000, 4000000), rung(3000000, 2000000)];
    const actual = [
      { index: 0, actualVideoBps: 3941668 },
      { index: 1, actualVideoBps: 2909455 },
    ];
    const merged = mergeActualBitrates(rungs, actual);
    expect(merged.map((r) => r.actualVideoBps)).toEqual([3941668, 2909455]);
    // pure / non-mutating
    expect(rungs[0].actualVideoBps).toBeUndefined();
  });

  it('sorts measured rungs by index before zipping (backend order-independence)', () => {
    const rungs = [rung(7000000, 4000000), rung(3000000, 2000000)];
    const actual = [
      { index: 1, actualVideoBps: 2909455 },
      { index: 0, actualVideoBps: 3941668 },
    ];
    expect(mergeActualBitrates(rungs, actual).map((r) => r.actualVideoBps)).toEqual([3941668, 2909455]);
  });

  it('leaves rungs unchanged when counts mismatch (graceful skip, no mis-join)', () => {
    const rungs = [rung(7000000, 4000000), rung(3000000, 2000000)];
    expect(mergeActualBitrates(rungs, [{ index: 0, actualVideoBps: 3941668 }])).toBe(rungs);
    expect(mergeActualBitrates(rungs, [])).toBe(rungs);
  });
});

describe('parseHlsMaster', () => {
  it('parses rungs sorted by peak bitrate desc, skipping audio-only variants', () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=3880856,AVERAGE-BANDWIDTH=2232416,CODECS="avc1.640020,mp4a.40.2",RESOLUTION=1280x720,FRAME-RATE=50.000,AUDIO="a"',
      'index_cmaf_video_2.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=7292365,AVERAGE-BANDWIDTH=4135930,CODECS="avc1.64002a,mp4a.40.2",RESOLUTION=1920x1080,FRAME-RATE=50.000,AUDIO="a"',
      'index_cmaf_video_0.m3u8',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="index_cmaf_audio.m3u8"',
    ].join('\n');
    const rungs = parseHlsMaster(master);
    expect(rungs.map((r) => r.resolution)).toEqual(['1920x1080', '1280x720']);
    expect(rungs[0]).toMatchObject({ peakBps: 7292365, avgBps: 4135930, codecs: 'H.264, AAC', frameRate: 50 });
  });
});
