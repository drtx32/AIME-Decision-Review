/**
 * Mock iFinD adapter. Same determinism contract as the Fuyao mock adapter.
 *
 * iFinD coverage in this slice:
 *   - stock    → price + announcement + financial
 *   - news     → news
 *   - index    → index context
 *   - edb      → macro context
 *   - fund     → fund flow
 *   - bond     → bond context
 *   - global-stock → global peer context
 *   - futures  → futures context
 *   - ds       → capability inspection (always returns empty evidence)
 *   - enterprise → corporate filings
 *   - law      → legal/regulatory
 */

import type { Evidence, ToolResult, IFindServerKey } from "../../types/index.ts";
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

const IFIND_INTENT_MAP: Record<IFindServerKey, AdapterIntent[]> = {
  ds: [],
  enterprise: ["enterprise"],
  law: ["legal"],
  stock: ["price", "financial", "announcement"],
  fund: ["fund"],
  edb: ["macro"],
  news: ["news"],
  bond: ["macro"],
  "global-stock": ["price", "financial"],
  index: ["index"],
  futures: ["futures"],
};

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

export class MockIFindAdapter implements EvidenceAdapter {
  readonly serverKey: IFindServerKey;
  readonly provider = "ifind" as const;
  private readonly credentials: AdapterCredentials;

  constructor(key: IFindServerKey, credentials: AdapterCredentials) {
    this.serverKey = key;
    this.credentials = credentials;
  }

  canHandle(intent: AdapterIntent): boolean {
    return IFIND_INTENT_MAP[this.serverKey].includes(intent);
  }

  async fetch(req: AdapterRequest): Promise<ToolResult<Evidence[]>> {
    const start = Date.now();
    const retrievedAt = new Date().toISOString();

    if (this.credentials.baseUrl && this.credentials.authorization) {
      return wrapPermanentError(
        "IFIND_LIVE_NOT_WIRED",
        "Live iFinD MCP transport is not yet wired in v0.1; use mock or wait for follow-up.",
        retrievedAt,
        Date.now() - start
      );
    }

    const intentMap = IFIND_INTENT_MAP[this.serverKey];
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
    const sym = req.symbol;
    switch (this.serverKey) {
      case "stock": {
        if (req.intent === "price") {
          return [
            {
              id: `ifind-${sym}-last-close-pre`,
              type: "price",
              title: `Last close pre-T0 (iFinD cross-check)`,
              content: `Independent last-close pre-T0 figure cross-checked vs Fuyao a-share: ${(10 + (hashString(sym) % 700)).toFixed(2)}.`,
              source: "ifind:stock:price",
              publishedAt: daysOffsetIso(req.T0, -1),
              retrievedAt: new Date().toISOString(),
              relationToDecision: "ex_ante",
              confidence: 0.85,
              metadata: { crossCheck: "fuyao:a-share" },
            },
          ];
        }
        if (req.intent === "financial") {
          return [
            {
              id: `ifind-${sym}-fin-yoy`,
              type: "financial",
              title: `Annual revenue YoY (iFinD)`,
              content: `Annual revenue YoY pre-T0 was ${(3 + (hashString(sym + "fin") % 5)).toFixed(1)}%.`,
              source: "ifind:stock:financial",
              publishedAt: daysOffsetIso(req.T0, -60),
              retrievedAt: new Date().toISOString(),
              relationToDecision: "ex_ante",
              confidence: 0.7,
              metadata: { field: "revenue_yoy" },
            },
          ];
        }
        if (req.intent === "announcement") {
          return [
            {
              id: `ifind-${sym}-ann-pre`,
              type: "announcement",
              title: `Pre-T0 announcement index entry`,
              content: "Pre-T0 corporate announcement indexed for cross-reference.",
              source: "ifind:stock:announcement",
              publishedAt: daysOffsetIso(req.T0, -10),
              retrievedAt: new Date().toISOString(),
              relationToDecision: "ex_ante",
              confidence: 0.5,
            },
          ];
        }
        return [];
      }
      case "news":
        return [
          {
            id: `ifind-news-${sym}-pre`,
            type: "news",
            title: `Sector news headline ~30 days pre-T0`,
            content:
              "Sector-wide news pre-T0 was mixed; no idiosyncratic shock in the pre-T0 window.",
            source: "ifind:news:sector",
            publishedAt: daysOffsetIso(req.T0, -28),
            retrievedAt: new Date().toISOString(),
            relationToDecision: "ex_ante",
            confidence: 0.6,
          },
          {
            id: `ifind-news-${sym}-post`,
            type: "news",
            title: `Post-T0 sector news context (outcome window only)`,
            content:
              "Post-T0 sector coverage describes the eventual drawdown but is NOT a basis for judging the original decision.",
            source: "ifind:news:sector",
            publishedAt: daysOffsetIso(req.T0, 14),
            retrievedAt: new Date().toISOString(),
            relationToDecision: "ex_post",
            confidence: 0.6,
          },
        ];
      case "index":
        return [
          {
            id: "ifind-idx-pre",
            type: "market",
            title: "Broad index level, pre-T0",
            content: "Broad-market index level pre-T0 was within historical band.",
            source: "ifind:index:level",
            publishedAt: daysOffsetIso(req.T0, -5),
            retrievedAt: new Date().toISOString(),
            relationToDecision: "ex_ante",
            confidence: 0.7,
          },
        ];
      case "edb":
        return [
          {
            id: "ifind-edb-macro-pre",
            type: "macro",
            title: "Macro context — pre-T0",
            content: "Pre-T0 macro context was neutral; no obvious regime shift.",
            source: "ifind:edb:macro",
            publishedAt: daysOffsetIso(req.T0, -40),
            retrievedAt: new Date().toISOString(),
            relationToDecision: "ex_ante",
            confidence: 0.6,
          },
        ];
      case "fund":
        return [
          {
            id: "ifind-fund-pre",
            type: "fund",
            title: "Fund flow pre-T0",
            content: "Sector fund flows pre-T0 were modestly positive.",
            source: "ifind:fund:flow",
            publishedAt: daysOffsetIso(req.T0, -20),
            retrievedAt: new Date().toISOString(),
            relationToDecision: "ex_ante",
            confidence: 0.6,
          },
        ];
      case "bond":
        return [
          {
            id: "ifind-bond-pre",
            type: "macro",
            title: "Sovereign yield curve context pre-T0",
            content: "Sovereign yield curve pre-T0 was stable; no credit shock.",
            source: "ifind:bond:yield",
            publishedAt: daysOffsetIso(req.T0, -8),
            retrievedAt: new Date().toISOString(),
            relationToDecision: "ex_ante",
            confidence: 0.5,
          },
        ];
      case "global-stock":
        return [
          {
            id: "ifind-global-pre",
            type: "price",
            title: "Global peer pre-T0",
            content: "Global peer index pre-T0 was uneventful.",
            source: "ifind:global-stock:peer",
            publishedAt: daysOffsetIso(req.T0, -2),
            retrievedAt: new Date().toISOString(),
            relationToDecision: "ex_ante",
            confidence: 0.5,
          },
        ];
      case "futures":
        return [
          {
            id: "ifind-fut-pre",
            type: "futures",
            title: "iFinD futures context pre-T0",
            content: "Cross-asset futures context pre-T0 was neutral.",
            source: "ifind:futures:basis",
            publishedAt: daysOffsetIso(req.T0, -2),
            retrievedAt: new Date().toISOString(),
            relationToDecision: "ex_ante",
            confidence: 0.5,
          },
        ];
      case "enterprise":
        return [
          {
            id: `ifind-ent-${sym}-pre`,
            type: "enterprise",
            title: "Enterprise filing pre-T0",
            content: "No material enterprise filing in the pre-T0 window.",
            source: "ifind:enterprise:filings",
            publishedAt: daysOffsetIso(req.T0, -25),
            retrievedAt: new Date().toISOString(),
            relationToDecision: "ex_ante",
            confidence: 0.5,
          },
        ];
      case "law":
        return [
          {
            id: `ifind-law-${sym}-pre`,
            type: "legal",
            title: "Litigation / regulatory pre-T0",
            content: "No material litigation or regulatory action pre-T0.",
            source: "ifind:law:scan",
            publishedAt: daysOffsetIso(req.T0, -15),
            retrievedAt: new Date().toISOString(),
            relationToDecision: "ex_ante",
            confidence: 0.5,
          },
        ];
      case "ds":
      default:
        return [];
    }
  }
}