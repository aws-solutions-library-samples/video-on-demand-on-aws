/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 *
 * per-frame quality-metrics dashboard. Fetches a manifest of CloudFront URLs from the CMS API
 * (list-only server-side — see index.mjs's getQualityMetricsManifest), then fetches each file directly
 * from the browser (same cross-origin-open pattern AbrLadder.tsx uses for the HLS manifest). `format:
 * "json"` files (rescued packaging-mode data) parse with a plain `res.json()`; `format: "csv"`
 * files (native GA-mode data) go through `parseQualityMetricsCsv`. Charts the full, un-downsampled
 * series either way. Lazily loaded: nothing is fetched until the section is expanded.
 *
 * Aggregated by METRIC (not rendition): one chart per metric type (VMAF/QVBR/SHOT_CHANGE) with every
 * rendition plotted as its own series on that same chart, so quality can be compared across renditions
 * at a glance.
 */
import { lazy, Suspense, useState } from 'react';
import { Box, ExpandableSection, SpaceBetween, Spinner, StatusIndicator, Table } from '@cloudscape-design/components';
import { fetchQualityMetricsManifest } from '../lib/api';

// Code-split ECharts: it only loads once this panel is expanded, keeping it out of the initial bundle.
const MetricLineChart = lazy(() => import('./MetricLineChart'));
import { harmonicMean, parseQualityMetricsCsv, type ParsedQualityMetricCsv } from '../lib/qualityMetricsCsv';

interface RenditionMetric extends ParsedQualityMetricCsv {
  rendition: string;
}

interface MetricGroup {
  metric: string;
  renditions: RenditionMetric[];
}

// Preferred display order for the metric sections; VMAF is the headline quality metric, so it leads.
// Anything not listed sorts after these, in first-seen order.
const METRIC_ORDER = ['VMAF', 'QVBR', 'SHOT_CHANGE'];
const metricRank = (metric: string) => {
  const i = METRIC_ORDER.indexOf(metric.toUpperCase());
  return i === -1 ? METRIC_ORDER.length : i;
};

const fmt = (n: number | null) => (n === null || Number.isNaN(n) ? '-' : n.toFixed(2));

export default function QualityMetricsPanel({ guid }: { guid: string }) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [metricGroups, setMetricGroups] = useState<MetricGroup[] | null>(null);

  async function load() {
    setLoading(true);
    setError(undefined);
    try {
      const manifest = await fetchQualityMetricsManifest(guid);
      const byMetric = new Map<string, RenditionMetric[]>();
      await Promise.all(
        manifest.renditions.map((r) =>
          Promise.all(
            r.files.map(async (f) => {
              const res = await fetch(f.url);
              if (!res.ok) throw new Error(`${f.url} -> HTTP ${res.status}`);
              const parsed: ParsedQualityMetricCsv = f.format === 'json' ? await res.json() : parseQualityMetricsCsv(await res.text());
              const entry: RenditionMetric = { rendition: r.resolution ?? r.name, ...parsed };
              const existing = byMetric.get(f.metric);
              if (existing) existing.push(entry);
              else byMetric.set(f.metric, [entry]);
            }),
          ),
        ),
      );
      setMetricGroups(
        [...byMetric.entries()]
          .map(([metric, renditions]) => ({ metric, renditions }))
          .sort((a, b) => metricRank(a.metric) - metricRank(b.metric)),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <ExpandableSection
      headerText="Per-frame quality metrics (fetched and parsed in full in the browser - may be slow for very long assets)"
      expanded={expanded}
      onChange={({ detail }) => {
        setExpanded(detail.expanded);
        if (detail.expanded && !metricGroups && !loading) load();
      }}
    >
      {loading ? (
        <Spinner />
      ) : error ? (
        <StatusIndicator type="warning">Couldn&apos;t load quality metrics ({error}).</StatusIndicator>
      ) : metricGroups && metricGroups.length > 0 ? (
        <SpaceBetween size="l">
          {metricGroups.map((g) => (
            <SpaceBetween key={g.metric} size="s">
              <Box variant="h4">{g.metric}</Box>
              <Table
                variant="embedded"
                items={g.renditions}
                columnDefinitions={[
                  { id: 'rendition', header: 'Rendition', cell: (r) => r.rendition },
                  { id: 'harmonicMean', header: 'Harmonic mean', cell: (r) => fmt(harmonicMean(r.series.map((p) => p.value))) },
                  { id: 'average', header: 'Average', cell: (r) => r.average ?? '-' },
                  { id: 'min', header: 'Min', cell: (r) => r.min ?? '-' },
                  { id: 'max', header: 'Max', cell: (r) => r.max ?? '-' },
                ]}
              />
              <Suspense fallback={<Spinner />}>
                <MetricLineChart
                  metric={g.metric}
                  series={g.renditions.map((r) => ({
                    title: r.rendition,
                    data: r.series.map((p) => ({ x: p.frame, y: p.value })),
                  }))}
                />
              </Suspense>
            </SpaceBetween>
          ))}
        </SpaceBetween>
      ) : metricGroups ? (
        <StatusIndicator type="info">
          No quality-metrics data available yet - packaging-mode assets are rescued asynchronously after
          MediaConvert completes and may take a few minutes to appear.
        </StatusIndicator>
      ) : null}
    </ExpandableSection>
  );
}
