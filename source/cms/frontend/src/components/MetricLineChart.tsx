/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 *
 * dense per-frame quality-metrics line chart (one metric, one series per rendition).
 * Uses ECharts (canvas) instead of Cloudscape LineChart so long assets stay interactive: native
 * drag/wheel/pinch zoom + a slider brush via `dataZoom`, and `sampling: 'lttb'` decimates each
 * series to the pixel budget so a multi-hour clip (100k+ frames/rendition) renders smoothly. The
 * rest of the CMS stays Cloudscape; this one chart is the deliberate exception (dense scientific
 * time-series). Themed from the Cloudscape color mode so it matches light/dark.
 */
import { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import { useColorScheme } from '../hooks/useColorScheme';

export interface MetricSeries {
  title: string;
  data: { x: number; y: number }[];
}

/** Cloudscape categorical chart palette (matches the app's other charts). */
const PALETTE = ['#688ae8', '#c33d69', '#2ea597', '#8456ce', '#e07941', '#3759ce', '#962249', '#096f64', '#6237a7', '#a2531d'];

export default function MetricLineChart({ metric, series }: { metric: string; series: MetricSeries[] }) {
  const { dark } = useColorScheme();

  const option = useMemo<EChartsOption>(() => {
    const fg = dark ? '#d1d5db' : '#000716';
    const grid = dark ? '#414d5c' : '#e9ebed';
    // VMAF is a bounded 0-100 perceptual score: pin the axis max to 100 so charts read on an
    // absolute quality scale. Min auto-scales ('dataMin') so the populated band fills the height.
    const isVmaf = metric.toUpperCase().includes('VMAF');
    return {
      textStyle: { color: fg },
      color: PALETTE,
      grid: { top: 16, right: 16, bottom: 64, left: 48 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'line' },
        backgroundColor: dark ? '#232f3e' : '#ffffff',
        borderColor: grid,
        textStyle: { color: fg },
      },
      legend: { type: 'scroll', bottom: 0, textStyle: { color: fg } },
      xAxis: {
        type: 'value',
        name: 'Frame',
        nameLocation: 'middle',
        nameGap: 28,
        min: 'dataMin',
        max: 'dataMax',
        axisLine: { lineStyle: { color: grid } },
        axisLabel: { color: fg },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        name: metric,
        max: isVmaf ? 100 : undefined,
        min: isVmaf ? 'dataMin' : undefined,
        axisLine: { lineStyle: { color: grid } },
        axisLabel: { color: fg },
        splitLine: { lineStyle: { color: grid } },
      },
      // Slider brush + inside (wheel / pinch / drag) zoom over the frame axis.
      dataZoom: [
        { type: 'inside', xAxisIndex: 0, filterMode: 'none' },
        { type: 'slider', xAxisIndex: 0, height: 20, bottom: 28, borderColor: grid, filterMode: 'none' },
      ],
      series: series.map((s) => ({
        name: s.title,
        type: 'line' as const,
        showSymbol: false,
        sampling: 'lttb' as const, // decimate to the pixel budget — the key long-clip fix
        lineStyle: { width: 1 },
        emphasis: { focus: 'series' as const },
        data: s.data.map((p) => [p.x, p.y]),
      })),
    };
  }, [metric, series, dark]);

  return (
    <ReactECharts
      option={option}
      style={{ height: 320, width: '100%' }}
      opts={{ renderer: 'canvas' }}
      notMerge
    />
  );
}
