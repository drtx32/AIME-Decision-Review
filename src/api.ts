/**
 * Frontend API adapter.
 *
 * Behaviour:
 *   - When `import.meta.env.VITE_API_BASE_URL` is set, the adapter routes
 *     to the real backend (POST /api/reviews, then poll /api/reviews/:id,
 *     /events, /result).
 *   - Otherwise it falls back to the static mock so the UI stays demoable
 *     before the backend is reachable.
 *
 * The frontend NEVER receives LLM keys, MCP credentials, or Authorization
 * headers — those stay server-side.
 */

export type Input = {
  symbol: string;
  market: string;
  side: "buy" | "sell";
  executedAt: string;
  price: string;
  quantity: string;
  reason: string;
  notes: string;
};

export type ReviewResult = {
  id: string;
  status: string;
  result: {
    decision: { symbol: string; action: string; executedAt: string; T0: string; userReason?: string };
    exAnteEvidence: Array<{ id: string; title: string; source: string; publishedAt: string; relationToDecision: string; type: string }>;
    exPostEvidence: Array<{ id: string; title: string; source: string; publishedAt: string; relationToDecision: string; type: string }>;
    decisionQuality: { rating: string; reasoning: string; processFactors?: string[] };
    outcome: { summary: string; pnlRealized: boolean; note: string };
    attribution: Array<{ claim: string; status: string; evidenceIds: string[] }>;
    biases: Array<{ label: string; description: string; severity: string }>;
    missedEvidence: string[];
    lessons: string[];
    nextChecklist: string[];
    uncertainties: string[];
    citations: Array<{ evidenceId: string; claim: string }>;
    toolStatuses: Array<{ tool: string; server: string; status: string; message?: string }>;
  };
};

const apiBase = (import.meta.env.VITE_API_BASE_URL ?? "").trim().replace(/\/$/, "");
const useReal = apiBase.length > 0;

function marketToEnum(market: string): "CN" | "HK" | "US" {
  if (market.includes("港")) return "HK";
  if (market.includes("美")) return "US";
  return "CN";
}

function toIso(executedAt: string): string {
  // The HTML datetime-local input produces "YYYY-MM-DDTHH:mm" without seconds
  // or timezone. The backend requires RFC3339; we treat the value as UTC.
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(executedAt)) return executedAt;
  if (/T/.test(executedAt)) return `${executedAt}:00.000Z`;
  return `${executedAt}T00:00:00.000Z`;
}

export async function createReview(input: Input): Promise<{ id: string; input: Input }> {
  if (!useReal) {
    await new Promise((r) => setTimeout(r, 350));
    return { id: `demo-${input.symbol || "x"}`, input };
  }
  const body = {
    symbol: input.symbol,
    market: marketToEnum(input.market),
    action: input.side,
    executedAt: toIso(input.executedAt),
    price: input.price ? Number(input.price) : undefined,
    quantity: input.quantity ? Number(input.quantity) : undefined,
    userReason: input.reason,
    notes: input.notes,
  };
  const res = await fetch(`${apiBase}/api/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 422) {
    const err = (await res.json().catch(() => ({}))) as { reason?: string };
    throw new Error(err.reason ?? "non_compliant_request");
  }
  if (!res.ok) {
    throw new Error(`createReview failed: HTTP ${res.status}`);
  }
  const json = (await res.json()) as { id: string };
  return { id: json.id, input };
}

export async function pollResult(id: string, input: Input): Promise<ReviewResult> {
  if (!useReal) {
    await new Promise((r) => setTimeout(r, 400));
    return mockResult(id, input);
  }
  // Poll status until terminal.
  for (let i = 0; i < 120; i++) {
    const statusRes = await fetch(`${apiBase}/api/reviews/${id}`);
    if (!statusRes.ok) throw new Error(`poll status failed: HTTP ${statusRes.status}`);
    const statusBody = (await statusRes.json()) as { status: string };
    if (
      statusBody.status === "completed" ||
      statusBody.status === "partial" ||
      statusBody.status === "failed"
    ) {
      const resultRes = await fetch(`${apiBase}/api/reviews/${id}/result`);
      if (!resultRes.ok) throw new Error(`fetch result failed: HTTP ${resultRes.status}`);
      const resultBody = (await resultRes.json()) as { status: string; result: ReviewResult["result"] };
      return { id, status: resultBody.status, result: resultBody.result };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("review timed out after 60s");
}

export const adapterKind = useReal ? "API" : "Mock";

// ── Mock fallback ─────────────────────────────────────────────────────────
function mockResult(id: string, input: Input): ReviewResult {
  return {
    id,
    status: "completed",
    result: {
      decision: {
        symbol: input.symbol,
        action: input.side,
        executedAt: input.executedAt,
        T0: toIso(input.executedAt),
        userReason: input.reason,
      },
      exAnteEvidence: [
        {
          id: "mock-ante-1",
          title: "公司披露经营数据，渠道库存处于可控区间",
          source: "demo:announcement",
          publishedAt: "2024-03-15T00:00:00Z",
          relationToDecision: "ex_ante",
          type: "announcement",
        },
        {
          id: "mock-ante-2",
          title: "股价低于 60 日均线，估值处于近三年 42% 分位",
          source: "demo:price",
          publishedAt: "2024-03-17T00:00:00Z",
          relationToDecision: "ex_ante",
          type: "price",
        },
        {
          id: "mock-ante-3",
          title: "北向资金连续 3 日净流出",
          source: "demo:fund",
          publishedAt: "2024-03-17T00:00:00Z",
          relationToDecision: "ex_ante",
          type: "fund",
        },
      ],
      exPostEvidence: [
        {
          id: "mock-post-1",
          title: "批价继续下探，渠道反馈弱于预期",
          source: "demo:news",
          publishedAt: "2024-04-08T00:00:00Z",
          relationToDecision: "ex_post",
          type: "news",
        },
        {
          id: "mock-post-2",
          title: "一季报收入同比下降，市场预期进一步下修",
          source: "demo:financial",
          publishedAt: "2024-05-10T00:00:00Z",
          relationToDecision: "ex_post",
          type: "financial",
        },
      ],
      decisionQuality: {
        rating: "fair",
        reasoning: "核心判断方向部分成立，但仓位与失效条件未被明确写入决策。",
        processFactors: ["3 条 ex-ante 证据被纳入", "用户理由已记录"],
      },
      outcome: {
        summary: "持有期结果 -18.4%，结果差但部分事前证据成立。",
        pnlRealized: true,
        note: "Outcome described separately from decision quality.",
      },
      attribution: [
        { claim: "渠道库存改善", status: "supported", evidenceIds: ["mock-ante-1"] },
        { claim: "批价企稳时间未定义", status: "uncertain", evidenceIds: [] },
        { claim: "市场快速修复", status: "unsupported", evidenceIds: [] },
      ],
      biases: [
        {
          label: "overconfidence-language",
          description: "User reason contained assertive language.",
          severity: "low",
        },
      ],
      missedEvidence: ["没有明确写入失效条件"],
      lessons: ["把'企稳'写成可验证条件", "在下单前记录反向证据", "预先写下失效条件"],
      nextChecklist: [
        "Re-read pre-T0 evidence before judging decision quality.",
        "Compare user reason vs ex-ante facts, item by item.",
        "Hold final outcome out of decision-quality evaluation.",
        "Note counter-evidence visible at T0 but unused.",
      ],
      uncertainties: ["Demo data — not derived from a live review."],
      citations: [
        { evidenceId: "mock-ante-1", claim: "渠道库存处于可控区间" },
        { evidenceId: "mock-ante-2", claim: "估值分位 42%" },
        { evidenceId: "mock-ante-3", claim: "北向资金净流出" },
      ],
      toolStatuses: [{ tool: "demo", server: "mock", status: "success" }],
    },
  };
}