# AIME Decision Review — SPEC v0.1

## 0. Document contract

This file is the canonical project specification. All agents and contributors should read it before implementation and re-check it whenever context is uncertain.

Precedence:
1. Newer explicit Issue instruction
2. This SPEC
3. Local implementation choices

Do not silently diverge from this document. If a change is necessary, document the reason in the Issue/PR and update this SPEC when the change becomes canonical.

## 1. Product goal

Help a user review one historical investment decision by reconstructing what was knowable at the decision time, separating ex-ante from ex-post information, evaluating decision quality independently from final P&L, and turning the review into reusable lessons/checklists for future decisions.

Core loop:

Historical Decision
→ Reconstruct Evidence at T0
→ Separate Ex-Ante / Ex-Post
→ Agent Review
→ Decision Quality + Outcome Quality
→ Bias / Missed Evidence / Uncertainty
→ Lesson + Checklist
→ Next Decision Context

Key principle: profit does not automatically mean a good decision, and loss does not automatically mean a bad decision.

## 2. MVP scope

One vertical slice only:

Input one historical trade
→ identify symbol/action/time/price/reason
→ agent creates data plan
→ retrieve financial/market/event evidence
→ classify evidence around T0
→ produce structured review
→ generate lessons/checklist
→ persist result

Not in v0.1:
- multi-agent orchestration
- heavy sandbox platform
- account/auth system
- trading execution
- real-time monitoring
- multi-provider routing
- vector database/RAG platform
- full GBrain integration

## 3. Tech stack

Frontend:
- React
- TypeScript
- Vite
- Bun

Backend:
- Bun
- Hono
- TypeScript

Agent:
- OpenAI Agents SDK for TypeScript

LLM:
- thin provider abstraction
- v0.1: one MiniMax/OpenAI-compatible provider only

Persistence:
- SQLite

Data:
- Fuyao MCP
- iFinD MCP

Optional later:
- GBrain LessonStore

## 4. Architecture

Browser
→ React Web App
→ HTTPS/SSE
→ Hono Review API
→ OpenAI Agents SDK
→ selected MCP servers/tools
→ Evidence normalization
→ Structured Review
→ SQLite

Secrets remain server-side only.

### 4.1 Local/prod-like orchestration

The root `docker-compose.yml` is the authoritative container orchestration
path. It runs the static frontend and Bun/Hono API as separate services, routes
frontend `/api` requests to the API service, and persists the API SQLite file in
the named `api-data` volume. Runtime configuration is documented in the root
`.env.example`; Compose maps `API_PORT` to the API process port and does not
pass backend secrets to the frontend image.

## 5. DecisionReviewAgent

Single agent in v0.1.

Responsibilities:
- understand user decision
- plan evidence retrieval
- select relevant MCP servers/tools
- verify timestamps
- align evidence to T0
- distinguish fact / inference / uncertainty
- evaluate decision process
- run one bounded reflection/self-check
- return structured output

The runtime controls available tools, limits, stop conditions and persistence. The agent decides how to complete the review inside those bounds.

## 6. Agent hard rules

1. Identify exact decision timestamp T0.
2. Information published after T0 MUST NOT be used to judge whether the original decision was reasonable.
3. Separate evidence into ex_ante and ex_post.
4. Distinguish fact, inference and uncertain judgment.
5. Important financial/event claims must be traceable to evidence with source and timestamp.
6. Do not infer causality only from correlation.
7. Evaluate thesis quality, evidence quality, ignored counter-evidence, decision process and outcome separately.
8. Do not let outcome/P&L determine decision quality.
9. Produce reusable lessons and a next-decision checklist.
10. Do not output deterministic return predictions, guaranteed profits, or direct buy/sell instructions.

## 7. Review lifecycle

Statuses:
- created
- planning
- retrieving
- analyzing
- reflecting
- completed
- partial
- failed
- waiting_for_approval

A normal review should finish in minutes, not remain as a continuously running LLM session.

## 8. Input schema

```ts
interface DecisionInput {
  symbol: string;
  market?: "CN" | "HK" | "US";
  action: "buy" | "sell";
  executedAt: string;
  price?: number;
  quantity?: number;
  userReason?: string;
  notes?: string;
}
```

MVP form minimum:
- symbol
- action
- executedAt
- price optional
- reason

## 9. Evidence model

```ts
interface Evidence {
  id: string;
  type:
    | "price"
    | "financial"
    | "news"
    | "announcement"
    | "industry"
    | "macro"
    | "market"
    | "fund"
    | "futures"
    | "options"
    | "legal"
    | "enterprise";
  title: string;
  content: string;
  source: string;
  sourceUrl?: string;
  publishedAt: string;
  retrievedAt: string;
  relationToDecision: "ex_ante" | "ex_post";
  confidence?: number;
  metadata?: Record<string, unknown>;
}
```

`publishedAt` is mandatory for time-bound reasoning. `retrievedAt` is not a substitute.

## 10. Review result

Return structured output, not an unstructured Markdown blob.

Minimum fields:
- decision
- exAnteEvidence
- exPostEvidence
- decisionQuality
- outcome
- attribution
- biases
- missedEvidence
- lessons
- nextChecklist
- uncertainties
- citations

Decision Quality and Outcome must be displayed separately.

## 11. MCP registry

### Fuyao — configure all six, load by intent

- meta
- a-share
- a-share-index
- fund
- futures
- options

Do not enumerate/load all schemas at startup if avoidable. Select relevant servers after the review plan.

Typical roles:
- meta: resolve instruments/capabilities
- a-share: stock market/financial data
- a-share-index: market/sector benchmark
- fund: ETF/fund context
- futures: commodity/cross-asset context
- options: derivatives/implied market context where supported

### iFinD — configure all eleven, load by intent

- ds
- enterprise
- law
- stock
- fund
- edb
- news
- bond
- global-stock
- index
- futures

Typical routing:
- stock/index/news/edb: common stock review context
- futures/fund/global-stock/bond: conditional cross-asset context
- enterprise/law: special corporate/legal cases
- ds: inspect actual exposed capabilities and use when relevant

Do not infer capability from server name alone when tool discovery can verify it.

## 12. Provider

Keep a thin abstraction only.

Environment variables:
- LLM_PROVIDER
- LLM_MODEL
- LLM_API_KEY
- LLM_BASE_URL

v0.1 implements one provider. No dynamic routing/fallback work unless required later.

## 13. Human-in-the-loop

Read-only market/data retrieval runs automatically.

Future state-changing operations such as saving long-term memory, changing reusable user rules, or creating persistent monitoring tasks may require approval.

No trading execution exists in this product.

## 14. Reflection

One bounded self-check before finalization:

- Did ex-post evidence leak into ex-ante evaluation?
- Are important numeric claims grounded?
- Did the review turn correlation into causality?
- Was counter-evidence ignored?
- Did final outcome contaminate decision-quality evaluation?

No infinite reflection loop.

## 15. Product trace

Do NOT expose hidden chain-of-thought.

Expose product-level events only, e.g.:
- review created
- market data retrieved
- index/sector context retrieved
- news/events retrieved
- evidence time-aligned
- fact consistency checked
- final review generated

## 16. Persistence

SQLite tables/objects may include:
- review_runs
- decisions
- evidence
- review_results
- lessons

No vector DB required for MVP.

Keep LessonStore as a replaceable interface so GBrain can be added later.

## 17. API contract

- POST /api/reviews
- GET /api/reviews/:id
- GET /api/reviews/:id/events
- GET /api/reviews/:id/result
- GET /health

SSE preferred for progress; polling fallback is acceptable.

## 18. Frontend product states

### Home
Input historical decision.

### Running
Show product-level progress only.

### Result
Must prominently show:
- Decision Summary
- T0
- Ex-Ante vs Ex-Post evidence
- Decision Quality
- Outcome
- supported / uncertain / unsupported attribution
- biases / missed evidence
- lessons
- next checklist
- citations/evidence references

The T0 split is the main visual/product concept.

## 19. Tool error semantics

Tool adapters must distinguish:
- success
- empty
- transient_error
- permanent_error

Never translate tool failure into “no data”.

Partial data must lead to an explicit partial/uncertain review.

## 20. Security

Never commit or print:
- API keys
- Authorization headers
- MCP credentials
- cookies
- tokens
- secret-bearing trace payloads

Use server environment variables / GitHub Secrets.

Required placeholders may include:
- HITHINK_FINANCE_API_KEY
- IFIND_MCP_AUTHORIZATION
- LLM_API_KEY
- LLM_BASE_URL
- LLM_MODEL

Frontend must not receive these secrets.

## 21. Deployment target

Frontend:
- static/Web deployment such as Vercel/Cloudflare Pages/GitHub-based deployment

Backend:
- Tencent Cloud 2C4G server is sufficient for API + lightweight agent runtime

No local LLM required.

## 22. MVP acceptance criteria

A user can:
1. enter one historical trade
2. start a review
3. see progress
4. receive ex-ante and ex-post evidence separated around T0
5. see decision quality independently from outcome
6. see lessons/checklist
7. trace important claims back to evidence

At least cover:
- normal review
- empty result
- transient tool failure
- timestamp/T0 boundary
- partial evidence
- non-compliant request boundary

## 23. Delivery artifacts

Repository must ultimately contain:
- accessible working Web URL
- source code
- README
- docs/SPEC.md
- docs/AI_VALIDATION.md
- docs/TEST_PLAN.md

Optional:
- 60–180 second demo video

Keep AI validation and test evidence updated during development, not only at the end.
