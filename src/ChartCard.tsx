/**
 * Inline ECharts renderer for the chart-data endpoint.
 *
 * Mounted inside the assistant turn of a review conversation. The
 * composer below stays put because the chart is part of the
 * scroll-conversation surface, not a floating overlay.
 *
 * Behaviors:
 *   - requests /api/chart-data server-side (credentials never reach the
 *     frontend)
 *   - renders OHLC + MA5/10/20/60 + volume by default
 *   - draws decision T0 as a vertical marker line, with a star on the
 *     day of execution
 *   - shows ex_post evidence markers (post-T0) with a distinct color so
 *     they can never visually justify the original decision
 *   - explicit `unavailable` / `transient_error` / `permanent_error`
 *     card when the server returns a degraded status — never a fake
 *     empty chart
 *
 * No second chart framework is introduced; only `echarts/core` plus the
 * required chart and component imports keep the bundle small.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import type { EChartsCoreOption } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { CandlestickChart, LineChart, BarChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  TitleComponent,
  MarkLineComponent,
  MarkPointComponent,
  LegendComponent,
  DataZoomComponent,
} from 'echarts/components';
import { ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';

echarts.use([
  CanvasRenderer,
  CandlestickChart,
  LineChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  TitleComponent,
  MarkLineComponent,
  MarkPointComponent,
  LegendComponent,
  DataZoomComponent,
]);

export type ChartType = 'kline' | 'timeline' | 'compare';
export type ChartPeriod = 'day' | 'week' | 'month';

export interface ChartMarker {
  t: string;
  label: string;
  relationToDecision: 'ex_ante' | 'ex_post';
  source?: string;
}

export interface ChartSeries {
  source: 'fuyao' | 'ifind' | 'mixed' | 'fallback';
  symbol: string;
  market: 'CN' | 'HK' | 'US';
  timezone: string;
  unit: string;
  adjustment?: 'none' | 'qfq' | 'hfq';
  retrievedAt: string;
  candles?: Array<{
    t: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>;
  line?: Array<{ t: string; value: number }>;
  baseline?: Array<{ t: string; value: number }>;
  markers?: ChartMarker[];
}

export interface ChartResponse {
  status: 'ok' | 'empty' | 'unavailable' | 'transient_error' | 'permanent_error';
  type: ChartType | string;
  series?: ChartSeries;
  error?: { code: string; message: string; retryable: boolean };
  retrievedAt: string;
  message?: string;
}

export interface ChartCardProps {
  symbol: string;
  market?: 'CN' | 'HK' | 'US';
  type?: ChartType;
  period?: ChartPeriod;
  /** T0 decision timestamp used to color-code ex_ante vs ex_post. */
  T0?: string;
  /** Optional review id so the server can pull session events. */
  reviewId?: string;
  /** Comparison baseline symbol for `compare` type. */
  compareSymbol?: string;
  /** When this changes the chart refetches. */
  refreshKey?: string | number;
}

const apiBase = ((import.meta.env.VITE_API_BASE_URL as string | undefined) || '/api').replace(/\/$/, '');

export function ChartCard({
  symbol,
  market = 'CN',
  type = 'kline',
  period = 'day',
  T0,
  reviewId,
  compareSymbol,
  refreshKey,
}: ChartCardProps) {
  const [response, setResponse] = useState<ChartResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams({
      symbol,
      market,
      type,
      period,
    });
    if (compareSymbol) params.set('compareSymbol', compareSymbol);
    if (reviewId) params.set('reviewId', reviewId);
    return params.toString();
  }, [symbol, market, type, period, compareSymbol, reviewId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`${apiBase}/chart-data?${query}`, { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`图表请求失败 (${res.status})`);
        const body = (await res.json()) as ChartResponse;
        if (!cancelled) {
          setResponse(body);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : '图表加载失败');
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [query, refreshKey, type]);

  useEffect(() => {
    if (!containerRef.current) return;
    if (!response?.series) return;
    const option = buildOption(response.series, { T0, type });
    if (!chartRef.current) {
      chartRef.current = echarts.init(containerRef.current);
    }
    chartRef.current.setOption(option, true);
    const resize = () => chartRef.current?.resize();
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, [response, T0, type]);

  if (loading) {
    return (
      <div className="chart-card chart-loading" aria-busy="true">
        <div className="chart-loading-spinner" />
        <span>正在从直连接口拉取 {symbol} 的行情…</span>
      </div>
    );
  }

  if (!response) {
    return (
      <div className="chart-card chart-error">
        <strong>图表加载失败</strong>
        <small>{error ?? '请稍后重试。'}</small>
      </div>
    );
  }

  if (response.status !== 'ok' || !response.series) {
    return (
      <div className={`chart-card chart-${response.status}`}>
        <div className="chart-head">
          <span className="chart-title">{symbol} · {labelFor(type)}</span>
          <span className={`chart-pill chart-pill-${response.status}`}>
            {labelFor(response.status)}
          </span>
        </div>
        <p className="chart-message">
          {response.message ??
            (response.status === 'unavailable'
              ? '当前账号未配置该图表所需字段。'
              : '图表数据暂不可用，复盘结论仍可继续生成。')}
        </p>
        {response.error?.code && (
          <small className="chart-meta">
            source code: <code>{response.error.code}</code>
            {response.error.retryable ? '（可重试）' : ''}
          </small>
        )}
      </div>
    );
  }

  const sourceLabel =
    response.series.source === 'fuyao'
      ? '同花顺 Fuyao 直连'
      : response.series.source === 'ifind'
        ? 'iFinD 直连'
        : response.series.source === 'mixed'
          ? 'Fuyao + iFinD'
          : '演示数据';

  return (
    <div className={`chart-card chart-ok ${expanded ? 'expanded' : ''}`}>
      <div className="chart-head">
        <span className="chart-title">
          {symbol} · {labelFor(type)} · {labelFor(period)}
        </span>
        <div className="chart-head-meta">
          <span className={`chart-pill chart-pill-source chart-pill-${response.series.source}`}>
            {sourceLabel}
          </span>
          {response.series.adjustment && (
            <span className="chart-pill chart-pill-adjust">
              {response.series.adjustment === 'qfq'
                ? '前复权'
                : response.series.adjustment === 'hfq'
                  ? '后复权'
                  : '不复权'}
            </span>
          )}
          <button
            type="button"
            className="chart-toggle"
            aria-label={expanded ? '收起图表' : '放大图表'}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            {expanded ? '收起' : '放大'}
          </button>
        </div>
      </div>
      <div ref={containerRef} className="chart-canvas" />
      <div className="chart-foot">
        <small>
          时区 {response.series.timezone} · 单位 {response.series.unit} · 拉取于{' '}
          {new Date(response.series.retrievedAt).toLocaleString()}
        </small>
        {T0 && (
          <small className="chart-foot-t0">
            T0 {new Date(T0).toLocaleString()} · 紫色为决策时刻线，红色事件为事后信息
          </small>
        )}
      </div>
      {response.series.markers && response.series.markers.length > 0 && (
        <details className="chart-markers">
          <summary>
            <RefreshCw size={12} />
            事件标记 ({response.series.markers.length})
          </summary>
          <ul>
            {response.series.markers.slice(0, 10).map((marker, idx) => (
              <li
                key={`${marker.t}-${idx}`}
                className={`marker-${marker.relationToDecision}`}
              >
                <b>{marker.relationToDecision === 'ex_ante' ? '事前' : '事后'}</b>
                <span>{new Date(marker.t).toLocaleDateString()}</span>
                <em>{marker.label}</em>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function labelFor(value: string): string {
  switch (value) {
    case 'kline':
      return 'K 线';
    case 'timeline':
      return '决策时间线';
    case 'compare':
      return '对比';
    case 'day':
      return '日';
    case 'week':
      return '周';
    case 'month':
      return '月';
    case 'ok':
      return '可用';
    case 'empty':
      return '空';
    case 'unavailable':
      return '不可用';
    case 'transient_error':
      return '暂时不可用';
    case 'permanent_error':
      return '不可恢复';
    default:
      return value;
  }
}

function buildOption(
  series: ChartSeries,
  ctx: { T0?: string; type: string }
): EChartsCoreOption {
  const t0 = ctx.T0 ? new Date(ctx.T0).getTime() : null;

  // K-line path
  if (series.candles?.length && ctx.type !== 'compare') {
    const dates = series.candles.map((c) => c.t.slice(0, 10));
    const ohlc = series.candles.map((c) => [c.open, c.close, c.low, c.high]);
    const volumes = series.candles.map((c, i) => ({
      value: c.volume,
      itemStyle: {
        color: c.close >= c.open ? '#83b885' : '#d89988',
      },
      _date: dates[i],
    }));
    const ma = (window: number) =>
      series.candles!.map((_, i) => {
        if (i + 1 < window) return '-';
        const slice = series.candles!.slice(i + 1 - window, i + 1);
        const avg = slice.reduce((sum, c) => sum + c.close, 0) / window;
        return Number(avg.toFixed(2));
      });

    return {
      animation: false,
      grid: [
        { left: 50, right: 16, top: 24, height: '60%' },
        { left: 50, right: 16, top: '74%', height: '20%' },
      ],
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
      },
      legend: { data: ['K 线', 'MA5', 'MA10', 'MA20', 'MA60'], top: 0, textStyle: { fontSize: 10 } },
      xAxis: [
        {
          type: 'category',
          data: dates,
          boundaryGap: true,
          axisLabel: { fontSize: 10 },
        },
        {
          type: 'category',
          gridIndex: 1,
          data: dates,
          axisLabel: { show: false },
        },
      ],
      yAxis: [
        { scale: true, axisLabel: { fontSize: 10 } },
        {
          gridIndex: 1,
          axisLabel: { fontSize: 10 },
          splitNumber: 2,
        },
      ],
      dataZoom: [
        { type: 'inside', xAxisIndex: [0, 1], start: 60, end: 100 },
        { type: 'slider', xAxisIndex: [0, 1], height: 18, bottom: 8 },
      ],
      series: [
        {
          type: 'candlestick',
          name: 'K 线',
          data: ohlc,
          itemStyle: {
            color: '#83b885',
            color0: '#d89988',
            borderColor: '#5b9b5f',
            borderColor0: '#b86d61',
          },
          markLine: t0
            ? {
                silent: true,
                symbol: 'none',
                lineStyle: { color: '#7a4ec4', width: 1.2, type: 'dashed' },
                data: [
                  {
                    xAxis: new Date(t0).toISOString().slice(0, 10),
                    label: { formatter: 'T0', position: 'end', color: '#7a4ec4', fontSize: 10 },
                  },
                ],
              }
            : undefined,
        },
        { type: 'line', name: 'MA5', data: ma(5), smooth: true, showSymbol: false, lineStyle: { width: 1 } },
        { type: 'line', name: 'MA10', data: ma(10), smooth: true, showSymbol: false, lineStyle: { width: 1 } },
        { type: 'line', name: 'MA20', data: ma(20), smooth: true, showSymbol: false, lineStyle: { width: 1 } },
        { type: 'line', name: 'MA60', data: ma(60), smooth: true, showSymbol: false, lineStyle: { width: 1 } },
        {
          type: 'bar',
          name: '成交量',
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: volumes,
        },
      ],
    };
  }

  // Compare / line path
  const line = series.line ?? [];
  const baseline = series.baseline ?? [];
  const dates = line.map((p) => p.t.slice(0, 10));
  return {
    animation: false,
    grid: { left: 50, right: 16, top: 24, bottom: 32 },
    tooltip: { trigger: 'axis' },
    legend: {
      data: [series.symbol, compareLabel(series), 'T0'],
      top: 0,
      textStyle: { fontSize: 10 },
    },
    xAxis: { type: 'category', data: dates, axisLabel: { fontSize: 10 } },
    yAxis: { type: 'value', axisLabel: { formatter: '{value}%', fontSize: 10 } },
    series: [
      {
        name: series.symbol,
        type: 'line',
        data: line.map((p) => Number(p.value.toFixed(2))),
        smooth: true,
        showSymbol: false,
        lineStyle: { color: '#173e2e' },
      },
      ...(baseline.length
        ? [
            {
              name: '对比基准',
              type: 'line',
              data: baseline.map((p) => Number(p.value.toFixed(2))),
              smooth: true,
              showSymbol: false,
              lineStyle: { color: '#719776', type: 'dashed' as const },
            },
          ]
        : []),
      ...(t0
        ? [
            {
              name: 'T0',
              type: 'line',
              data: [],
              markLine: {
                silent: true,
                symbol: 'none',
                lineStyle: { color: '#7a4ec4', type: 'dashed' as const },
                data: [
                  {
                    xAxis: new Date(t0).toISOString().slice(0, 10),
                    label: { formatter: 'T0', color: '#7a4ec4', fontSize: 10 },
                  },
                ],
              },
            },
          ]
        : []),
    ],
  };
}

function compareLabel(series: ChartSeries): string {
  return series.source === 'mixed' ? '对比基准' : series.symbol;
}
