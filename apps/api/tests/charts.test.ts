/**
 * Chart-data contract tests.
 *
 * These tests do NOT exercise real network calls. They cover:
 *   - the contract surface (schemas, types, marker relation rules)
 *   - the fallback K-line generator (deterministic, weekend-skipping)
 *   - the Fuyao + iFinD adapter envelope when credentials are absent
 *     (returns `unavailable`, never `ok` with invented data)
 *   - the response envelope never echoes credentials
 *
 * Live provider behaviour is exercised via the dedicated
 * `live-http.test.ts` and `live-mcp.test.ts` files that gate on real
 * env credentials. Keeping these tests hermetic means the chart
 * path is always demoable in CI.
 */

import { describe, test, expect } from "bun:test";
import {
  ChartRequestSchema,
  ChartResponseSchema,
  A_SHARE_TIMEZONE,
} from "../src/charts/contract.ts";
import {
  fetchFuyaoKline,
  fetchIFindKline,
  fallbackKlineSeries,
  withMarkers,
  buildCompareSeries,
  providerAvailability,
} from "../src/charts/adapters.ts";
import type { ChartSeries } from "../src/charts/contract.ts";

describe("Chart contract", () => {
  test("schema rejects missing required fields", () => {
    const bad = ChartRequestSchema.safeParse({ symbol: "" });
    expect(bad.success).toBe(false);
  });

  test("schema accepts a minimal kline request", () => {
    const ok = ChartRequestSchema.safeParse({
      symbol: "600519",
      type: "kline",
      period: "day",
    });
    expect(ok.success).toBe(true);
  });

  test("schema accepts a compare request including a baseline", () => {
    const ok = ChartRequestSchema.safeParse({
      symbol: "600519",
      type: "compare",
      period: "day",
      compareSymbol: "000300.SH",
    });
    expect(ok.success).toBe(true);
  });

  test("response schema carries every provenance field", () => {
    const sample = {
      status: "ok" as const,
      type: "kline" as const,
      retrievedAt: "2026-09-23T00:00:00Z",
      series: {
        source: "fuyao" as const,
        symbol: "600519",
        market: "CN" as const,
        timezone: A_SHARE_TIMEZONE,
        unit: "CNY",
        adjustment: "qfq" as const,
        retrievedAt: "2026-09-23T00:00:00Z",
        candles: [
          { t: "2026-09-22T00:00:00+08:00", open: 1, high: 2, low: 0.5, close: 1.5, volume: 1000 },
        ],
        markers: [
          {
            t: "2026-09-22T00:00:00+08:00",
            label: "T0 决策点",
            relationToDecision: "ex_ante" as const,
          },
        ],
      },
    };
    expect(ChartResponseSchema.safeParse(sample).success).toBe(true);
  });

  test("response schema marks ex_post markers distinctly", () => {
    const sample = {
      status: "ok" as const,
      type: "timeline" as const,
      retrievedAt: "2026-09-23T00:00:00Z",
      series: {
        source: "ifind" as const,
        symbol: "600519",
        market: "CN" as const,
        timezone: A_SHARE_TIMEZONE,
        unit: "CNY",
        retrievedAt: "2026-09-23T00:00:00Z",
        line: [],
        markers: [
          {
            t: "2026-09-23T00:00:00+08:00",
            label: "已发布年报",
            relationToDecision: "ex_post" as const,
          },
        ],
      },
    };
    const parsed = ChartResponseSchema.safeParse(sample);
    expect(parsed.success).toBe(true);
  });
});

describe("Fuyao adapter", () => {
  test("returns unavailable when credentials are absent", async () => {
    const result = await fetchFuyaoKline(
      { symbol: "600519", type: "kline" },
      { baseUrl: null, apiKey: null }
    );
    expect(result.status).toBe("unavailable");
    expect(result.series).toBeUndefined();
  });

  test("returns permanent_error on 401", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
    try {
      const result = await fetchFuyaoKline(
        { symbol: "600519", type: "kline" },
        { baseUrl: "https://example.test", apiKey: "test-key" }
      );
      expect(result.status).toBe("permanent_error");
      expect(result.errorCode).toBe("fuyao_unauthorized");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns transient_error on 429", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
    try {
      const result = await fetchFuyaoKline(
        { symbol: "600519", type: "kline" },
        { baseUrl: "https://example.test", apiKey: "test-key" }
      );
      expect(result.status).toBe("transient_error");
      expect(result.errorCode).toBe("fuyao_rate_limited");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns transient_error on 5xx", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("upstream boom", { status: 503 })) as unknown as typeof fetch;
    try {
      const result = await fetchFuyaoKline(
        { symbol: "600519", type: "kline" },
        { baseUrl: "https://example.test", apiKey: "test-key" }
      );
      expect(result.status).toBe("transient_error");
      expect(result.errorCode).toBe("fuyao_upstream_5xx");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns transient_error on timeout", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            const err = new DOMException("aborted", "AbortError");
            reject(err);
          });
        }
      });
    }) as unknown as typeof fetch;
    try {
      const result = await fetchFuyaoKline(
        { symbol: "600519", type: "kline" },
        { baseUrl: "https://example.test", apiKey: "test-key" },
        1
      );
      expect(result.status).toBe("transient_error");
      expect(result.errorCode).toBe("fuyao_timeout");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("parses a successful upstream payload into candles", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          rc: 0,
          data: [
            { t: "2026-09-22", o: 10, h: 12, l: 9, c: 11, v: 1000 },
            { t: "2026-09-23", o: 11, h: 13, l: 10, c: 12, v: 1500 },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as unknown as typeof fetch;
    try {
      const result = await fetchFuyaoKline(
        { symbol: "600519", type: "kline", period: "day" },
        { baseUrl: "https://example.test", apiKey: "test-key" }
      );
      expect(result.status).toBe("ok");
      expect(result.series?.source).toBe("fuyao");
      expect(result.series?.candles?.length).toBe(2);
      expect(result.series?.candles?.[0]?.open).toBe(10);
      expect(result.series?.candles?.[0]?.close).toBe(11);
      expect(result.series?.candles?.[0]?.low).toBe(9);
      expect(result.series?.timezone).toBe(A_SHARE_TIMEZONE);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns empty when upstream payload has no data", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ rc: 0, data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    try {
      const result = await fetchFuyaoKline(
        { symbol: "600519", type: "kline" },
        { baseUrl: "https://example.test", apiKey: "test-key" }
      );
      expect(result.status).toBe("empty");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("iFinD adapter", () => {
  test("returns unavailable when credentials are absent", async () => {
    const result = await fetchIFindKline(
      { symbol: "600519", type: "kline" },
      { baseUrl: null, authorization: null }
    );
    expect(result.status).toBe("unavailable");
  });

  test("returns permanent_error on 403", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("forbidden", { status: 403 })) as unknown as typeof fetch;
    try {
      const result = await fetchIFindKline(
        { symbol: "600519", type: "kline" },
        { baseUrl: "https://example.test", authorization: "test-token" }
      );
      expect(result.status).toBe("permanent_error");
      expect(result.errorCode).toBe("ifind_unauthorized");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns transient_error on 5xx", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("boom", { status: 502 })) as unknown as typeof fetch;
    try {
      const result = await fetchIFindKline(
        { symbol: "600519", type: "kline" },
        { baseUrl: "https://example.test", authorization: "test-token" }
      );
      expect(result.status).toBe("transient_error");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Fallback K-line generator", () => {
  test("produces a labelled fallback series when no provider is wired", () => {
    const series = fallbackKlineSeries({
      symbol: "600519",
      type: "kline",
      period: "day",
      start: "2026-08-01T00:00:00Z",
      end: "2026-09-23T00:00:00Z",
    });
    expect(series.source).toBe("fallback");
    expect(series.symbol).toBe("600519");
    expect(series.candles?.length).toBeGreaterThan(20);
    // Each candle should land on a weekday.
    for (const candle of series.candles!) {
      const day = new Date(candle.t);
      const wd = day.getUTCDay();
      expect(wd).not.toBe(0);
      expect(wd).not.toBe(6);
    }
  });

  test("is deterministic for the same symbol + window", () => {
    const req = {
      symbol: "600519",
      type: "kline" as const,
      period: "day" as const,
      start: "2026-08-01T00:00:00Z",
      end: "2026-09-23T00:00:00Z",
    };
    const a = fallbackKlineSeries(req);
    const b = fallbackKlineSeries(req);
    expect(a.candles?.length).toBe(b.candles?.length);
    expect(a.candles?.[0]?.close).toBe(b.candles?.[0]?.close);
  });
});

describe("Marker alignment and provenance", () => {
  test("withMarkers preserves ex_ante vs ex_post distinction", () => {
    const series: ChartSeries = {
      source: "fuyao",
      symbol: "600519",
      market: "CN",
      timezone: A_SHARE_TIMEZONE,
      unit: "CNY",
      retrievedAt: new Date().toISOString(),
      candles: [],
    };
    const enriched = withMarkers(series, [
      {
        t: "2024-03-18T10:24:00+08:00",
        label: "T0 决策点",
        relationToDecision: "ex_ante",
      },
      {
        t: "2024-04-08T00:00:00+08:00",
        label: "批价继续下探",
        relationToDecision: "ex_post",
      },
    ]);
    expect(enriched.markers?.length).toBe(2);
    expect(enriched.markers?.[1]?.relationToDecision).toBe("ex_post");
  });
});

describe("Compare series alignment", () => {
  test("produces percent-change line for both legs", () => {
    const primary: ChartSeries = {
      source: "fuyao",
      symbol: "600519",
      market: "CN",
      timezone: A_SHARE_TIMEZONE,
      unit: "CNY",
      retrievedAt: new Date().toISOString(),
      line: [
        { t: "2026-09-22", value: 100 },
        { t: "2026-09-23", value: 110 },
      ],
    };
    const baseline: ChartSeries = {
      source: "ifind",
      symbol: "000300.SH",
      market: "CN",
      timezone: A_SHARE_TIMEZONE,
      unit: "CNY",
      retrievedAt: new Date().toISOString(),
      line: [
        { t: "2026-09-22", value: 3000 },
        { t: "2026-09-23", value: 3030 },
      ],
    };
    const merged = buildCompareSeries(primary, baseline, "600519");
    expect(merged.line?.[0]?.value).toBe(0);
    expect(merged.line?.[1]?.value).toBeCloseTo(10);
  });
});

describe("Provider availability", () => {
  test("reports both providers disabled when credentials are absent", () => {
    const status = providerAvailability({
      fuyao: { baseUrl: null, apiKey: null },
      ifind: { baseUrl: null, authorization: null },
    });
    expect(status.fuyao).toBe(false);
    expect(status.ifind).toBe(false);
  });

  test("reports fuyao enabled when both baseUrl and apiKey are set", () => {
    const status = providerAvailability({
      fuyao: { baseUrl: "https://example.test", apiKey: "k" },
      ifind: { baseUrl: null, authorization: null },
    });
    expect(status.fuyao).toBe(true);
    expect(status.ifind).toBe(false);
  });
});
