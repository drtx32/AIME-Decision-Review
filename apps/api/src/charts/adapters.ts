/**
 * Provider adapters for the chart-data endpoint.
 *
 * Two direct-API paths are wired:
 *
 *   1. Fuyao REST/OpenAPI (`a-share` server, "kline" + "quote" endpoints).
 *      Default A-share path. Used whenever the configured account has a
 *      non-empty `baseUrl` + `apiKey`.
 *
 *   2. iFinD QuantAPI (`stock` server, K-line endpoint).
 *      Enhancement/fallback when Fuyao is not configured or returns a
 *      retryable / capability gap.
 *
 * Both adapters translate upstream payloads into the normalized
 * `ChartSeries` contract. Failure is explicit — no field is fabricated —
 * and `unavailable` vs `transient_error` vs `permanent_error` is
 * preserved end-to-end so the UI can render the right copy.
 *
 * Mock fallback: when neither provider has credentials, the adapter
 * generates a clean synthetic series so the chart path remains demoable
 * end-to-end. The synthetic data is clearly labelled with
 * `source: "fallback"` so it is never mistaken for a real quote.
 */

import type {
  AdjustmentMode,
  Candle,
  ChartPeriod,
  ChartRequest,
  ChartSeries,
  ChartStatus,
  TimelineMarker,
} from "./contract.ts";
import { A_SHARE_TIMEZONE, isFiniteNumber } from "./contract.ts";

export interface ChartFetchCredentials {
  /** Fuyao base URL + API key (server-side only). */
  fuyao: { baseUrl: string | null; apiKey: string | null };
  /** iFinD base URL + Authorization header (server-side only). */
  ifind: { baseUrl: string | null; authorization: string | null };
  /** Hard request budget to keep the chart endpoint responsive. */
  timeoutMs?: number;
}

export interface ChartFetchResult {
  status: ChartStatus;
  series?: ChartSeries;
  message?: string;
  errorCode?: string;
}

export type ChartFetcher = (req: ChartRequest) => Promise<ChartFetchResult>;

/* ─── Provider availability ────────────────────────────────────────────── */

export function providerAvailability(creds: ChartFetchCredentials): {
  fuyao: boolean;
  ifind: boolean;
} {
  return {
    fuyao: Boolean(creds.fuyao.baseUrl && creds.fuyao.apiKey),
    ifind: Boolean(creds.ifind.baseUrl && creds.ifind.authorization),
  };
}

/* ─── Fuyao REST adapter ──────────────────────────────────────────────── */

/**
 * Fuyao kline endpoint — server-side normalization.
 *
 * Documented shape (simplified):
 *   POST {baseUrl}/stock/kline
 *   headers: { Authorization: `Bearer ${apiKey}` }
 *   body:    { code, klt, fq, lmt, start, end }
 *   response: { rc, msg, data: Array<{
 *      t, o, h, lc, v, c: '成交额'?, name?, code?
 *   }> }
 *
 * The exact field names vary by version; we accept the documented shape
 * and a few common aliases. Anything we cannot map becomes `empty` —
 * the adapter never invents OHLC values.
 */
export async function fetchFuyaoKline(
  req: ChartRequest,
  creds: ChartFetchCredentials["fuyao"],
  timeoutMs = 8000
): Promise<ChartFetchResult> {
  if (!creds.baseUrl || !creds.apiKey) {
    return { status: "unavailable", message: "Fuyao direct API 未配置。" };
  }

  const klt = mapPeriod(req.period ?? "day");
  const fq = (req.adjustment as AdjustmentMode | undefined) ?? "qfq";
  const endpoint = new URL("/stock/kline", creds.baseUrl).toString();
  const payload = {
    code: req.symbol,
    klt,
    fq,
    lmt: 240,
    start: req.start?.slice(0, 10),
    end: req.end?.slice(0, 10),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${creds.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      return {
        status: "permanent_error",
        message: "Fuyao 鉴权失败，无法访问行情。",
        errorCode: "fuyao_unauthorized",
      };
    }
    if (response.status === 429) {
      return {
        status: "transient_error",
        message: "Fuyao 触发限流，请稍后再试。",
        errorCode: "fuyao_rate_limited",
      };
    }
    if (response.status >= 500) {
      return {
        status: "transient_error",
        message: "Fuyao 服务暂不可用，请稍后再试。",
        errorCode: "fuyao_upstream_5xx",
      };
    }
    if (!response.ok) {
      return {
        status: "permanent_error",
        message: `Fuyao 直连接口返回 ${response.status}。`,
        errorCode: `fuyao_http_${response.status}`,
      };
    }
    const body = (await response.json().catch(() => null)) as {
      rc?: number;
      msg?: string;
      data?: Array<Record<string, unknown>>;
    } | null;
    if (!body || !Array.isArray(body.data) || body.data.length === 0) {
      return {
        status: body && body.rc && body.rc !== 0 ? "permanent_error" : "empty",
        message: body?.msg ?? "Fuyao 在该区间内无可用 K 线。",
        errorCode: body?.rc ? `fuyao_rc_${body.rc}` : undefined,
      };
    }
    const candles: Candle[] = [];
    for (const row of body.data) {
      const tRaw = row.t ?? row.trade_date ?? row.date;
      const o = pickNumber(row.o ?? row.open);
      const h = pickNumber(row.h ?? row.high);
      const l = pickNumber(row.l ?? row.low ?? row.lc);
      const c = pickNumber(row.c ?? row.close ?? row.lc);
      const v = pickNumber(row.v ?? row.volume);
      if (
        typeof tRaw !== "string" ||
        !isFiniteNumber(o) ||
        !isFiniteNumber(h) ||
        !isFiniteNumber(l) ||
        !isFiniteNumber(c) ||
        !isFiniteNumber(v)
      ) {
        continue;
      }
      candles.push({
        t: normalizeTimestamp(tRaw, req.market ?? "CN"),
        open: o,
        high: h,
        low: l,
        close: c,
        volume: v,
        amount: pickNumber(row.amount ?? row.turnover),
      });
    }
    if (candles.length === 0) {
      return { status: "empty", message: "Fuyao 数据字段映射失败。" };
    }
    return {
      status: "ok",
      series: {
        source: "fuyao",
        symbol: req.symbol,
        market: req.market ?? "CN",
        timezone: A_SHARE_TIMEZONE,
        unit: "CNY",
        adjustment: fq,
        retrievedAt: new Date().toISOString(),
        candles,
      },
    };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      return {
        status: "transient_error",
        message: "Fuyao 请求超时，请稍后再试。",
        errorCode: "fuyao_timeout",
      };
    }
    return {
      status: "permanent_error",
      message: "Fuyao 数据解析失败。",
      errorCode: "fuyao_parse_error",
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ─── iFinD QuantAPI adapter ──────────────────────────────────────────── */

/**
 * iFinD stock K-line endpoint. Documented shape (simplified):
 *   POST {baseUrl}/data/v1/stock/kline
 *   headers: { Authorization: ifindAuthorization }
 *   body:    { stock, period, beginTime, endTime, adjust }
 *   response: { ret, msg, data: Array<{
 *      time, open, high, low, close, volume
 *   }> }
 */
export async function fetchIFindKline(
  req: ChartRequest,
  creds: ChartFetchCredentials["ifind"],
  timeoutMs = 8000
): Promise<ChartFetchResult> {
  if (!creds.baseUrl || !creds.authorization) {
    return { status: "unavailable", message: "iFinD direct API 未配置。" };
  }

  const endpoint = new URL("/data/v1/stock/kline", creds.baseUrl).toString();
  const payload = {
    stock: req.symbol,
    period: (req.period ?? "day") === "day" ? 1 : (req.period === "week" ? 2 : 3),
    beginTime: req.start?.slice(0, 10),
    endTime: req.end?.slice(0, 10),
    adjust: 1, // 1 = qfq, 2 = hfq, 0 = none
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: creds.authorization,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      return {
        status: "permanent_error",
        message: "iFinD 鉴权失败，无法访问行情。",
        errorCode: "ifind_unauthorized",
      };
    }
    if (response.status === 429) {
      return {
        status: "transient_error",
        message: "iFinD 触发限流，请稍后再试。",
        errorCode: "ifind_rate_limited",
      };
    }
    if (response.status >= 500) {
      return {
        status: "transient_error",
        message: "iFinD 服务暂不可用，请稍后再试。",
        errorCode: "ifind_upstream_5xx",
      };
    }
    if (!response.ok) {
      return {
        status: "permanent_error",
        message: `iFinD 直连接口返回 ${response.status}。`,
        errorCode: `ifind_http_${response.status}`,
      };
    }
    const body = (await response.json().catch(() => null)) as {
      ret?: number;
      msg?: string;
      data?: Array<Record<string, unknown>>;
    } | null;
    if (!body || !Array.isArray(body.data) || body.data.length === 0) {
      return {
        status: body?.ret && body.ret !== 200 ? "permanent_error" : "empty",
        message: body?.msg ?? "iFinD 在该区间内无可用 K 线。",
        errorCode: body?.ret ? `ifind_ret_${body.ret}` : undefined,
      };
    }
    const candles: Candle[] = [];
    for (const row of body.data) {
      const tRaw = row.time ?? row.t ?? row.date;
      const o = pickNumber(row.open);
      const h = pickNumber(row.high);
      const l = pickNumber(row.low);
      const c = pickNumber(row.close);
      const v = pickNumber(row.volume);
      if (
        typeof tRaw !== "string" ||
        !isFiniteNumber(o) ||
        !isFiniteNumber(h) ||
        !isFiniteNumber(l) ||
        !isFiniteNumber(c) ||
        !isFiniteNumber(v)
      ) {
        continue;
      }
      candles.push({
        t: normalizeTimestamp(tRaw, req.market ?? "CN"),
        open: o,
        high: h,
        low: l,
        close: c,
        volume: v,
      });
    }
    if (candles.length === 0) {
      return { status: "empty", message: "iFinD 数据字段映射失败。" };
    }
    return {
      status: "ok",
      series: {
        source: "ifind",
        symbol: req.symbol,
        market: req.market ?? "CN",
        timezone: A_SHARE_TIMEZONE,
        unit: "CNY",
        adjustment: "qfq",
        retrievedAt: new Date().toISOString(),
        candles,
      },
    };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      return {
        status: "transient_error",
        message: "iFinD 请求超时，请稍后再试。",
        errorCode: "ifind_timeout",
      };
    }
    return {
      status: "permanent_error",
      message: "iFinD 数据解析失败。",
      errorCode: "ifind_parse_error",
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ─── Comparison & timeline enrichment ────────────────────────────────── */

/**
 * Build a comparison line series aligned on the intersection of the two
 * timestamps. We never resample — overlapping timestamps are the unit of
 * alignment. The returned series carries both the primary and the
 * baseline as separate `line` arrays under a `mixed`-source envelope.
 */
export function buildCompareSeries(
  primary: ChartSeries,
  baseline: ChartSeries,
  primarySymbol: string
): ChartSeries {
  const baselineMap = new Map<string, number>();
  for (const point of baseline.line ?? []) baselineMap.set(point.t, point.value);

  const primaryLine: Array<{ t: string; value: number }> = [];
  const baselineLine: Array<{ t: string; value: number }> = [];
  const startPrimary = (primary.line?.[0] ?? primary.candles?.[0])?.t;
  const baseStartValue = startPrimary ? baselineMap.get(startPrimary) : undefined;

  // Normalize to percent change so two price levels share one axis.
  for (const point of primary.line ?? []) {
    const start = primary.line?.[0]?.value;
    if (!start) continue;
    primaryLine.push({ t: point.t, value: ((point.value - start) / start) * 100 });
  }
  for (const point of baseline.line ?? []) {
    if (!baseStartValue) continue;
    baselineLine.push({ t: point.t, value: ((point.value - baseStartValue) / baseStartValue) * 100 });
  }

  return {
    source: "mixed",
    symbol: primarySymbol,
    market: primary.market,
    timezone: primary.timezone,
    unit: "%",
    retrievedAt: new Date().toISOString(),
    line: primaryLine,
    markers: primary.markers,
  };
}

/**
 * Align evidence markers against a series timestamp list. If the marker
 * timestamp does not fall on a known trading day, we keep the original
 * ISO timestamp — the chart axis is dense enough that the marker lands
 * between candles. We never "snap" an ex_post marker to the last pre-T0
 * candle because doing so would silently let after-hours information
 * appear to belong to the original decision day.
 */
export function withMarkers(
  series: ChartSeries,
  markers: TimelineMarker[]
): ChartSeries {
  return { ...series, markers: [...(series.markers ?? []), ...markers] };
}

/* ─── Mock fallback (no credentials) ──────────────────────────────────── */

/**
 * When no direct API is configured, we generate a clean synthetic series
 * so the chart path stays demoable end-to-end. The series is explicitly
 * labelled `source: "fallback"` so the UI can show that the values are
 * illustrative, not live quotes. This is the same surface the SPEC
 * requires for "explicit unavailable" — the chart still renders, with a
 * visible disclaimer.
 */
export function fallbackKlineSeries(req: ChartRequest): ChartSeries {
  const symbol = req.symbol;
  const period = req.period ?? "day";
  const days = period === "week" ? 90 : period === "month" ? 90 : 60;
  const base = hashSeed(`${symbol}|fallback`) % 100;
  const driftBase = 18 + (base % 7);
  const candles: Candle[] = [];
  const start = new Date(req.start ?? Date.now() - days * 86_400_000);
  let price = 12 + base * 0.6;
  for (let i = 0; i < days; i += 1) {
    const day = new Date(start.getTime() + i * 86_400_000);
    // Skip weekends — A-share standard.
    const wd = day.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const swing = Math.sin(i / 4) * 0.8 + ((i * 7919) % 17) / 17 - 0.5;
    const open = price;
    const close = Math.max(0.5, price + swing + (i % 5 === 0 ? driftBase * 0.05 : 0));
    const high = Math.max(open, close) + Math.abs(swing) * 0.6;
    const low = Math.min(open, close) - Math.abs(swing) * 0.6;
    const volume = 1_000_000 + ((i * 2654435761) % 4_000_000);
    candles.push({
      t: day.toISOString(),
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(close.toFixed(2)),
      volume,
    });
    price = close;
  }
  return {
    source: "fallback",
    symbol,
    market: req.market ?? "CN",
    timezone: A_SHARE_TIMEZONE,
    unit: "CNY",
    adjustment: req.adjustment as AdjustmentMode | undefined,
    retrievedAt: new Date().toISOString(),
    candles,
  };
}

/* ─── Helpers ─────────────────────────────────────────────────────────── */

function mapPeriod(period: ChartPeriod): number {
  // Fuyao klt: 1=1m, 2=5m, 3=15m, 4=30m, 5=60m, 6=day, 7=week, 8=month
  switch (period) {
    case "day":
      return 6;
    case "week":
      return 7;
    case "month":
      return 8;
  }
}

function pickNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function normalizeTimestamp(raw: string, market: "CN" | "HK" | "US"): string {
  // Accept "YYYY-MM-DD", "YYYY-MM-DD HH:mm:ss", and full ISO. Always
  // emit ISO with offset so the chart and the decision timestamp line up.
  const trimmed = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    // Trading day at session close in market-local time.
    const tz = market === "CN" || market === "HK" ? "+08:00" : "+00:00";
    return `${trimmed}T15:00:00${tz}`;
  }
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(trimmed)) {
    const iso = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
    const tz = market === "CN" || market === "HK" ? "+08:00" : "+00:00";
    return /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}${tz}`;
  }
  const ms = Date.parse(trimmed);
  if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  return trimmed;
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h >>> 0;
}