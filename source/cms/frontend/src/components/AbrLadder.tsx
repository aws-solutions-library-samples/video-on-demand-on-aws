/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 *
 * Adaptive bitrate ladder table for the asset detail page. Fetches the HLS master manifest (CORS-open
 * via CloudFront) and lists the delivered rungs: resolution, bitrate, codec, frame rate.
 */
import { useEffect, useState } from 'react';
import { BarChart, Box, SpaceBetween, Spinner, StatusIndicator, Table } from '@cloudscape-design/components';
import { parseHlsMaster, formatBitrate, mergeActualBitrates, type LadderRung } from '../lib/abrLadder';
import { fetchAbrBitrates } from '../lib/api';

/** Bits per second -> Mbps rounded to 3 dp (chart axis is in Mbps). */
const mbps = (bps: number): number => Math.round(bps / 1000) / 1000;

export default function AbrLadder({ hlsUrl, guid }: { hlsUrl?: string | null; guid?: string | null }) {
  const [rungs, setRungs] = useState<LadderRung[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!hlsUrl) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    fetch(hlsUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then(async (text) => {
        const parsed = parseHlsMaster(text);
        // Best-effort overlay of measured video-only bitrates; a failure/empty leaves reported-only.
        let measured: { index: number; actualVideoBps: number }[] = [];
        if (guid) {
          try {
            measured = (await fetchAbrBitrates(guid)).rungs;
          } catch {
            measured = [];
          }
        }
        if (!cancelled) setRungs(mergeActualBitrates(parsed, measured));
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hlsUrl, guid]);

  if (loading) return <Spinner />;
  if (error) return <StatusIndicator type="warning">Couldn&apos;t read the ladder from the manifest ({error}).</StatusIndicator>;
  if (!rungs || rungs.length === 0) return <StatusIndicator type="info">No renditions found in the manifest.</StatusIndicator>;

  // Unique per-rung category label (two rungs can share a resolution) mirroring the table's "#" column;
  // suffixed with the video codec (first friendly entry, before the audio codec) to disambiguate rungs.
  const label = (r: LadderRung): string => {
    const videoCodec = r.codecs.split(',')[0]?.trim();
    return `${rungs.indexOf(r) + 1}. ${r.resolution}${videoCodec && videoCodec !== '-' ? ` ${videoCodec}` : ''}`;
  };
  const labels = rungs.map(label);
  const maxPeak = Math.max(...rungs.map((r) => mbps(r.peakBps)));
  // Measured video-only bitrate is best-effort: only show the column/series when the backend returned
  // a value for every rung (mergeActualBitrates sets it all-or-nothing).
  const hasActual = rungs.every((r) => typeof r.actualVideoBps === 'number');

  return (
    <SpaceBetween size="l">
      <Table<LadderRung>
        variant="embedded"
        items={rungs}
        columnDefinitions={[
          { id: 'index', header: '#', cell: (r) => rungs.indexOf(r) + 1, width: 60 },
          { id: 'resolution', header: 'Resolution', cell: (r) => r.resolution },
          {
            id: 'bitrate',
            header: 'Reported bitrate',
            cell: (r) =>
              r.peakBps && r.peakBps !== r.avgBps
                ? `${formatBitrate(r.avgBps)} (peak ${formatBitrate(r.peakBps)})`
                : formatBitrate(r.avgBps),
          },
          {
            id: 'actual',
            header: 'Measured (video)',
            cell: (r) => (typeof r.actualVideoBps === 'number' ? formatBitrate(r.actualVideoBps) : '-'),
          },
          { id: 'codec', header: 'Codec', cell: (r) => r.codecs },
          { id: 'framerate', header: 'Frame rate', cell: (r) => (r.frameRate ? `${r.frameRate} fps` : '-') },
        ]}
        empty={<Box textAlign="center">No renditions</Box>}
      />
      <BarChart
        horizontalBars
        height={260}
        hideFilter
        emphasizeBaselineAxis
        xTitle="Rendition"
        yTitle="Bitrate (Mbps)"
        ariaLabel="Bitrate per rendition"
        xScaleType="categorical"
        xDomain={labels}
        yDomain={[0, Math.max(maxPeak * 1.1, 0.1)]}
        series={[
          { title: 'Reported (avg)', type: 'bar', data: rungs.map((r) => ({ x: label(r), y: mbps(r.avgBps) })) },
          { title: 'Peak', type: 'bar', data: rungs.map((r) => ({ x: label(r), y: mbps(r.peakBps) })) },
          ...(hasActual
            ? [
                {
                  title: 'Actual (video)',
                  type: 'bar' as const,
                  data: rungs.map((r) => ({ x: label(r), y: mbps(r.actualVideoBps ?? 0) })),
                },
              ]
            : []),
        ]}
        i18nStrings={{
          xTickFormatter: (x) => String(x),
          yTickFormatter: (y) => `${y} Mbps`,
        }}
        empty={<StatusIndicator type="info">No renditions to chart.</StatusIndicator>}
      />
    </SpaceBetween>
  );
}
