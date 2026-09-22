/**
 * Mock Fuyao adapter. Produces deterministic evidence keyed off the symbol and
 * T0 so the vertical slice and tests are repeatable. When real Fuyao
 * credentials are configured we still go through the mock path in this MVP;
 * the live HTTP branch is intentionally a follow-up.
 */

import type { Evidence, ToolResult, FuyaoServerKey } from "../../types/index.ts";
import type {
  AdapterCredentials,
  AdapterIntent,
  AdapterRequest,
  EvidenceAdapter,
} from "./types.ts";
import {
  wrapSuccess,
  wrapEmpty,
  wrapPermanentError,
} from "./types.ts";

const FUYAO_INTENT_MAP: Record<FuyaoServerKey, AdapterIntent[]> = {
  meta: [],
  "a-share": ["price", "financial", "announcement"],
  "a-share-index": ["index", "industry"],
  fund: ["fund"],
  futures: ["futures"],
  options: ["options"],
};

export { FUYAO_INTENT_MAP };

const SYMBOL_PREFIX_LABEL: Record<string, string> = {
  "6": "SH",
  "0": "SZ",
  "3": "SZ",
};

function pseudoMarket(symbol: string): "CN" | "HK" | "US" {
  const c = symbol[0];
  if (c === "6" || c === "0" || c === "3") return "CN";
  return "CN";
}

function daysOffsetIso(T0: string, days: number): string {
  const ms = Date.parse(T0);
  if (Number.isNaN(ms)) return T0;
  return new Date(ms + days * 86_400_000).toISOString();
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h >>> 0;
}

function stablePriceBase(symbol: string, T0: string): number {
  return 10 + (hashString(symbol + "|" + T0) % 990);
}

export class MockFuyaoAdapter implements EvidenceAdapter {
  readonly serverKey: FuyaoServerKey;
  readonly provider = "fuyao" as const;
  private readonly credentials: AdapterCredentials;

  constructor(key: FuyaoServerKey, credentials: AdapterCredentials) {
    this.serverKey = key;
    this.credentials = credentials;
  }

  canHandle(intent: AdapterIntent): boolean {
    return FUYAO_INTENT_MAP[this.serverKey].includes(intent);
  }

  async fetch(req: AdapterRequest): Promise<ToolResult<Evidence[]>> {
    const start = Date.now();
    const retrievedAt = new Date().toISOString();

    // Fail-fast: real credentials but live HTTP branch not implemented in v0.1
    // is treated as a permanent_error rather than silently degraded.
    if (this.credentials.baseUrl && this.credentials.apiKey) {
      return wrapPermanentError(
        "FUYAO_LIVE_NOT_WIRED",
        "Live Fuyao MCP transport is not yet wired in v0.1; use mock or wait for follow-up.",
        retrievedAt,
        Date.now() - start
      );
    }

    const intentMap = FUYAO_INTENT_MAP[this.serverKey];
    if (!intentMap.includes(req.intent)) {
      return wrapEmpty(retrievedAt, Date.now() - start);
    }

    const evidence = this.buildEvidence(req);
    if (evidence.length === 0) {
      return wrapEmpty(retrievedAt, Date.now() - start);
    }
    return wrapSuccess(evidence, retrievedAt, Date.now() - start);
  }

  private buildEvidence(req: AdapterRequest): Evidence[] {
    const symbolLabel = `${SYMBOL_PREFIX_LABEL[req.symbol[0] as keyof typeof SYMBOL_PREFIX_LABEL] ?? "EX"}-${req.symbol}`;
    const market = req.market ?? pseudoMarket(req.symbol);
    const basePrice = stablePriceBase(req.symbol, req.T0);

    switch (this.serverKey) {
      case "a-share": {
        if (req.intent === "price") {
          return [
            {
              id: `fuyao-${req.symbol}-price-pre30`,
              type: "price",
              title: `${symbolLabel} close, 30 days pre-T0`,
              content: `Closing price 30 days before T0: ${(basePrice + 1.2).toFixed(2)} (${market}).`,
              source: "fuyao:a-share:price",
              publishedAt: daysOffsetIso(req.T0, -30),
              retrievedAt: new Date().toISOString(),
              relationToDecision: "ex_ante",
              confidence: 0.85,
              metadata: { field: "close", lookbackDays: 30 },
            },
            {
              id: `fuyao-${req.symbol}-price-pre1`,
              type: "price",
              title: `${symbolLabel} close, 1 day pre-T0`,
              content: `Closing price 1 day before T0: ${(basePrice + 0.4).toFixed(2)} (${market}).`,
              source: "fuyao:a-share:price",
              publishedAt: daysOffsetIso(req.T0, -1),
              retrievedAt: new Date().toISOString(),
              relationToDecision: "ex_ante",
              confidence: 0.9,
              metadata: { field: "close", lookbackDays: 1 },
            },
            {
              id: `fuyao-${req.symbol}-price-post30`,
              type: "price",
              title: `${symbolLabel} close, 30 days post-T0`,
              content: `Closing price 30 days after T0: ${(basePrice - 0.6).toFixed(2)} (${market}). Outcome context only.`,
              source: "fuyao:a-share:price",
              publishedAt: daysOffsetIso(req.T0, 30),
              retrievedAt: new Date().toISOString(),
              relationToDecision: "ex_post",
              confidence: 0.85,
              metadata: { field: "close", lookforwardDays: 30 },
            },
          ];
        }
        if (req.intent === "financial") {
          return [
            {
              id: `fuyao-${req.symbol}-fin-q-prev`,
              type: "financial",
              title: `${symbolLabel} — most recent annual filing pre-T0`,
              content: `Most recent annual filing pre-T0 disclosed revenue growth of ~${(2 + (hashString(req.symbol) % 6)).toFixed(1)}% YoY.`,
              source: "fuyao:a-share:financial",
              publishedAt: daysOffsetIso(req.T0, -45),
              retrievedAt: new Date().toISOString(),
              relationToDecision: "ex_ante",
              confidence: 0.7,
              metadata: { filing: "annual", periodOffsetDays: -45 },
            },
          ];
        }
        if (req.intent === "announcement") {
          return [
            {
              id: `fuyao-${req.symbol}-ann-pre`,
              type: "announcement",
              title: `${symbolLabel} — pre-T0 corporate announcement`,
              content: `Pre-T0 announcement: routine business update without material change to investment thesis.`,
              source: "fuyao:a-share:announcement",
              publishedAt: daysOffsetIso(req.T0, -7),
              retrievedAt: new Date().toISOString(),
              relationToDecision: "ex_ante",
              confidence: 0.6,
              metadata: { kind: "business_update" },
            },
          ];
        }
        return [];
      }
      case "a-share-index": {
        if (req.intent === "index" || req.intent === "industry") {
          return [
            {
              id: "fuyao-idx-sector-pre",
              type: "market",
              title: "Sector index level, 30 days pre-T0",
              content: "Sector index was up 1.8% over the 30 trading days preceding T0.",
              source: "fuyao:a-share-index:index",
              publishedAt: daysOffsetIso(req.T0, -30),
              retrievedAt: new Date().toISOString(),
              relationToDecision: "ex_ante",
              confidence: 0.8,
              metadata: { scope: "sector", lookbackDays: 30 },
            },
          ];
        }
        return [];
      }
      case "fund": {
        if (req.intent === "fund") {
          return [
            {
              id: "fuyao-fund-flow-pre",
              type: "fund",
              title: "Aggregate fund inflow, 30 days pre-T0",
              content: "Net fund inflow into sector ETFs over the 30 days preceding T0 was modestly positive.",
              source: "fuyao:fund:flow",
              publishedAt: daysOffsetIso(req.T0, -30),
              retrievedAt: new Date().toISOString(),
              relationToDecision: "ex_ante",
              confidence: 0.6,
              metadata: { scope: "sector_etf" },
            },
          ];
        }
        return [];
      }
      case "futures": {
        if (req.intent === "futures") {
          return [
            {
              id: "fuyao-futures-basis-pre",
              type: "futures",
              title: "Cross-asset futures context, pre-T0",
              content: "Cross-asset futures basis pre-T0 suggested neutral risk appetite.",
              source: "fuyao:futures:basis",
              publishedAt: daysOffsetIso(req.T0, -2),
              retrievedAt: new Date().toISOString(),
              relationToDecision: "ex_ante",
              confidence: 0.5,
              metadata: { scope: "cross_asset" },
            },
          ];
        }
        return [];
      }
      case "options": {
        if (req.intent === "options") {
          return [
            {
              id: "fuyao-options-iv-pre",
              type: "options",
              title: "Implied volatility, pre-T0",
              content: "Options-implied volatility pre-T0 was within normal band.",
              source: "fuyao:options:iv",
              publishedAt: daysOffsetIso(req.T0, -3),
              retrievedAt: new Date().toISOString(),
              relationToDecision: "ex_ante",
              confidence: 0.5,
              metadata: { scope: "iv_30d" },
            },
          ];
        }
        return [];
      }
      case "meta":
      default:
        return [];
    }
  }
}