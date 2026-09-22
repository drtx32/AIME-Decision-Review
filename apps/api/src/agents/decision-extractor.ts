import type { ModelProvider } from "../providers/index.ts";

export type DecisionCandidate = {
  symbol: string;
  name: string | null;
  action: "buy" | "sell";
  market: "CN" | "HK" | "US" | null;
  executedAt: string | null;
  executedAtText: string;
  timePrecision: "exact" | "approximate" | "unknown";
  price: number | null;
  quantityShares: number | null;
  quantityText: string | null;
  rationale: string;
  notes: string;
  confidence: number;
  needsConfirmation: string[];
};

const schema = `Return JSON only: {"decisions":[{"symbol":"string","name":"string|null","action":"buy|sell","market":"CN|HK|US|null","executedAt":"ISO|null","executedAtText":"original time phrase","timePrecision":"exact|approximate|unknown","price":"number|null","quantityShares":"number|null","quantityText":"string|null","rationale":"string","notes":"string","confidence":"0..1","needsConfirmation":["string"]}]}`;

export class DecisionExtractorAgent {
  constructor(private readonly provider: ModelProvider, private readonly modelName: string) {}

  async extract(message: string, context: { clientNow: string; timezone: string }): Promise<DecisionCandidate[]> {
    const completion = await this.provider.complete({
      modelName: this.modelName,
      schemaHint: "DecisionExtractionResult",
      temperature: 0.1,
      maxOutputTokens: 1800,
      system: "你是 AIME Decision Extractor。只做历史投资决策结构化抽取，不做复盘。必须识别 1..N 笔 decision，解决中文指代。绝不能把数量词（如 2手、全仓）或语气词（如了）当成标的。订单挂单时间不是成交 T0。无法确定分钟就用 approximate/unknown，executedAt 保持 null 或只给有依据的 ISO，不得用当前时刻或 index 假造时间。保留原始时间描述。" + schema,
      user: JSON.stringify({ message, clientNow: context.clientNow, timezone: context.timezone }),
    });
    const value = completion.structured ?? parseJson(completion.text);
    const raw = value && typeof value === "object" && Array.isArray((value as any).decisions) ? (value as any).decisions : null;
    if (!raw) throw new Error("DECISION_EXTRACTION_INVALID");
    const decisions = raw.map(normalizeCandidate).filter(Boolean) as DecisionCandidate[];
    if (!decisions.length) throw new Error("DECISION_EXTRACTION_INVALID");
    return decisions;
  }
}

function parseJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(cleaned); } catch { const start = cleaned.indexOf("{"); const end = cleaned.lastIndexOf("}"); return start >= 0 && end > start ? JSON.parse(cleaned.slice(start, end + 1)) : null; }
}

function normalizeCandidate(input: any): DecisionCandidate | null {
  if (!input || typeof input.symbol !== "string" || !["buy", "sell"].includes(input.action)) return null;
  const precision = ["exact", "approximate", "unknown"].includes(input.timePrecision) ? input.timePrecision : "unknown";
  const iso = typeof input.executedAt === "string" && !Number.isNaN(Date.parse(input.executedAt)) ? input.executedAt : null;
  return {
    symbol: input.symbol.trim(), name: typeof input.name === "string" ? input.name : null, action: input.action,
    market: ["CN", "HK", "US"].includes(input.market) ? input.market : null, executedAt: iso,
    executedAtText: typeof input.executedAtText === "string" ? input.executedAtText : "",
    timePrecision: precision, price: typeof input.price === "number" ? input.price : null,
    quantityShares: typeof input.quantityShares === "number" ? input.quantityShares : null,
    quantityText: typeof input.quantityText === "string" ? input.quantityText : null,
    rationale: typeof input.rationale === "string" ? input.rationale : "",
    notes: typeof input.notes === "string" ? input.notes : "",
    confidence: Math.max(0, Math.min(1, typeof input.confidence === "number" ? input.confidence : 0)),
    needsConfirmation: Array.isArray(input.needsConfirmation) ? input.needsConfirmation.filter((x: unknown): x is string => typeof x === "string") : [],
  };
}
