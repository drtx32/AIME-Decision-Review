/**
 * Hono routes — /api/reviews/* + /api/auth/* + /api/admin/* + /health.
 *
 * All non-auth, non-health endpoints require an authenticated session.
 * mustChangePassword users are blocked from review endpoints and admin
 * endpoints — they may only hit /api/auth/*.
 */

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { DecisionInputSchema } from "../types/index.ts";
import type { AppConfig } from "../config.ts";
import type { ReviewRepository } from "../db/sqlite.ts";
import type { UserRepository } from "../auth/repository.ts";
import type { McpRegistry } from "../mcp/registry.ts";
import { DecisionReviewAgent } from "../agents/decision-review.ts";
import type { ModelProvider } from "../providers/index.ts";
import { attachUser, requireAuth, gateMustChangePassword, rejectClientUserIdHeader, type AuthEnv } from "../auth/middleware.ts";
import { buildAuthRoutes } from "../auth/routes.ts";
import { buildAdminRoutes } from "../auth/admin.ts";
import { ChartRequestSchema, type ChartResponse, type ChartSeries } from "../charts/contract.ts";
import {
  fetchFuyaoKline,
  fetchIFindKline,
  fallbackKlineSeries,
  providerAvailability,
  withMarkers,
  type ChartFetchCredentials,
  type ChartFetchResult,
} from "../charts/adapters.ts";

export interface RouteDeps {
  config: AppConfig;
  repo: ReviewRepository;
  userRepo: UserRepository;
  registry: McpRegistry;
  provider: ModelProvider;
  /** Test hook — bypass background execution so specs stay deterministic. */
  runSync?: boolean;
}

type AppEnv = { Variables: AuthEnv["Variables"] };

export function buildApi(deps: RouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const config = deps.config;
  const auth = buildAuthRoutes(deps.userRepo, config.isProduction);
  const admin = buildAdminRoutes(deps.userRepo);

  app.use("*", attachUser(deps.userRepo));

  // Identity-contract guard — must run BEFORE requireAuth so a forged
  // x-user-id header is rejected even if a future route forgets the auth
  // gate. Runs after attachUser so it doesn't interfere with /health or
  // /api/auth/login response paths.
  app.use("/api/*", rejectClientUserIdHeader());

  app.get("/health", (c) => {
    return c.json({
      status: "ok",
      provider: deps.provider.id,
      configuredServers: deps.registry.configuredKeys(),
      time: new Date().toISOString(),
    });
  });

  // Public auth endpoints (login + change-password self-service) live here.
  app.route("/api/auth", auth);

  // Review endpoints — require an authenticated, non-mustChangePassword user.
  app.use("/api/reviews/*", requireAuth(deps.userRepo), gateMustChangePassword());

  app.post("/api/reviews", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = DecisionInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid_input", issues: parsed.error.issues },
        400
      );
    }
    const decision = parsed.data;
    // TEST_PLAN T11 — reject requests asking for deterministic predictions or
    // guaranteed-return / direct trade-instruction language. The product
    // reviews historical decisions; it does not produce forward signals.
    const nonCompliantReason = nonCompliantReasonFor(decision);
    if (nonCompliantReason) {
      return c.json(
        {
          error: "non_compliant_request",
          reason: nonCompliantReason,
          message:
            "This product reviews historical decisions; it does not produce deterministic buy/sell signals or guaranteed-return claims.",
        },
        422
      );
    }
    const id = `rev_${randomUUID()}`;
    const T0 = decision.executedAt;
    deps.repo.createRun(id, decision, T0);

    const agent = new DecisionReviewAgent({
      repo: deps.repo,
      registry: deps.registry,
      provider: deps.provider,
      config: deps.config,
    });

    if (deps.runSync) {
      try {
        await agent.run(id, decision);
      } catch (e) {
        deps.repo.updateStatus(id, "failed", {
          errorMessage: e instanceof Error ? e.message : String(e),
          finishedAt: new Date().toISOString(),
        });
      }
    } else {
      // Fire-and-forget; clients poll /api/reviews/:id for progress.
      agent.run(id, decision).catch((e) => {
        deps.repo.updateStatus(id, "failed", {
          errorMessage: e instanceof Error ? e.message : String(e),
          finishedAt: new Date().toISOString(),
        });
      });
    }

    const run = deps.repo.getRun(id);
    return c.json(
      {
        id,
        status: run?.status ?? "created",
        decision,
        T0,
        poll: `/api/reviews/${id}`,
        events: `/api/reviews/${id}/events`,
        result: `/api/reviews/${id}/result`,
      },
      202
    );
  });

  app.get("/api/reviews/:id", (c) => {
    const id = c.req.param("id");
    const run = deps.repo.getRun(id);
    if (!run) return c.json({ error: "not_found" }, 404);
    const decision = deps.repo.getDecision(id);
    return c.json({
      id: run.id,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      finishedAt: run.finishedAt,
      errorMessage: run.errorMessage,
      decision: decision?.decision,
      T0: decision?.T0,
    });
  });

  app.get("/api/reviews/:id/events", (c) => {
    const id = c.req.param("id");
    const run = deps.repo.getRun(id);
    if (!run) return c.json({ error: "not_found" }, 404);
    const events = deps.repo.getEvents(id);
    return c.json({ id, events });
  });

  app.get("/api/reviews/:id/result", (c) => {
    const id = c.req.param("id");
    const run = deps.repo.getRun(id);
    if (!run) return c.json({ error: "not_found" }, 404);
    const result = deps.repo.getResult(id);
    if (!result) {
      return c.json(
        {
          error: "result_not_ready",
          status: run.status,
          message:
            run.status === "completed" || run.status === "partial" || run.status === "failed"
              ? "Run finished but no result was persisted."
              : "Run is still in progress.",
        },
        425
      );
    }
    return c.json({ id, status: run.status, result });
  });

  // Chart endpoint — direct structured data path for inline ECharts.
  // Requires an authenticated, non-mustChangePassword user, same gate as
  // the review surface. Server-side only: provider credentials never
  // leave this process and the response never echoes them.
  app.use(
    "/api/chart-data",
    requireAuth(deps.userRepo),
    gateMustChangePassword()
  );

  app.get("/api/chart-data", async (c) => {
    const parsed = ChartRequestSchema.safeParse({
      symbol: c.req.query("symbol"),
      market: c.req.query("market") ?? undefined,
      type: c.req.query("type"),
      period: c.req.query("period") ?? undefined,
      start: c.req.query("start") ?? undefined,
      end: c.req.query("end") ?? undefined,
      compareSymbol: c.req.query("compareSymbol") ?? undefined,
    });
    if (!parsed.success) {
      return c.json(
        { error: "invalid_input", issues: parsed.error.issues },
        400
      );
    }
    const req = parsed.data;
    const credentials: ChartFetchCredentials = {
      fuyao: {
        baseUrl: config.fuyao.baseUrl,
        apiKey: config.fuyao.apiKey,
      },
      ifind: {
        baseUrl: config.ifind.baseUrl,
        authorization: config.ifind.authorization,
      },
      timeoutMs: 8000,
    };

    const availability = providerAvailability(credentials);
    let primary: ChartFetchResult | null = null;

    // Default path: Fuyao direct API. Only fall through to iFinD on a
    // retryable / capability gap, never on a synthetic blank chart.
    if (req.type === "kline" || req.type === "timeline") {
      primary = await fetchFuyaoKline(req, credentials.fuyao);
      if (
        primary.status === "unavailable" ||
        primary.status === "transient_error"
      ) {
        const fallback = await fetchIFindKline(req, credentials.ifind);
        if (fallback.status === "ok") primary = fallback;
        // If iFinD also fails, keep the Fuyao envelope — it carries the
        // more useful diagnostic copy.
      }
      if (!availability.fuyao && !availability.ifind && primary?.status !== "ok") {
        // Real credentials are required to ever return `status: "ok"`.
        // Mock-mode (NODE_ENV !== production) keeps the demo path alive
        // with a clearly labelled `source: "fallback"` synthetic series;
        // production must NEVER silently invent data and must surface
        // the explicit `unavailable` envelope so the UI shows the
        // degraded card. The trigger explicitly forbids mock faking
        // success under real credentials.
        if (config.isProduction) {
          primary = {
            status: "unavailable",
            message:
              "未配置 Fuyao / iFinD 直连凭据，K 线图表暂不可用。复盘结论仍可继续生成。",
          };
        } else {
          const synthetic = fallbackKlineSeries(req);
          primary = { status: "ok", series: synthetic };
        }
      }
    } else if (req.type === "compare") {
      // Comparison series: fetch the primary and the baseline, then
      // combine them into a `mixed`-source envelope. We only enable
      // this path when the primary is a kline request with a baseline.
      const primaryReq = { ...req, type: "kline" as const };
      const fetched = await fetchFuyaoKline(primaryReq, credentials.fuyao);
      if (fetched.status === "ok" && req.compareSymbol) {
        const baselineReq = { ...primaryReq, symbol: req.compareSymbol };
        const baseline = await fetchFuyaoKline(baselineReq, credentials.fuyao);
        if (baseline.status === "ok") {
          const pctPrimary = toPercentLine(fetched.series!);
          const pctBaseline = toPercentLine(baseline.series!);
          primary = {
            status: "ok",
            series: {
              source: "mixed",
              symbol: req.symbol,
              market: req.market ?? "CN",
              timezone: fetched.series!.timezone,
              unit: "%",
              retrievedAt: new Date().toISOString(),
              line: pctPrimary,
              baseline: pctBaseline,
              markers: fetched.series!.markers,
            },
          };
        } else {
          primary = fetched;
        }
      } else {
        primary = fetched;
      }
    } else if (req.type === "valuation" || req.type === "financial") {
      // Provider-field gap: we deliberately do NOT fabricate values
      // here. SPEC §6.6 — analyst/consensus targets must come from a
      // real provider or remain absent.
      primary = {
        status: "unavailable",
        message:
          "估值/财务时序字段未在直连接口中暴露，请改用 K 线 + 财务事件的组合。",
      };
    }

    // Decision / event markers: derive from the review's stored evidence
    // if the user asked for `timeline`. We never surface a marker
    // without its `relationToDecision` label, and ex_post markers cannot
    // justify the original decision.
    const reviewId = c.req.query("reviewId");
    if (reviewId && primary?.series) {
      const events = deps.repo.getEvents(reviewId);
      const decision = deps.repo.getDecision(reviewId);
      const T0 = decision?.T0;
      const markers = events
        .filter((e) => e.at)
        .slice(0, 12)
        .map((e) => ({
          t: e.at,
          label: e.message.slice(0, 40),
          relationToDecision:
            T0 && Date.parse(e.at) > Date.parse(T0)
              ? ("ex_post" as const)
              : ("ex_ante" as const),
        }));
      primary = {
        status: primary.status,
        series: withMarkers(primary.series, markers),
        message: primary.message,
        errorCode: primary.errorCode,
      };
    }

    const response: ChartResponse = {
      status: primary?.status ?? "permanent_error",
      type: req.type,
      series: primary?.series,
      retrievedAt: new Date().toISOString(),
      message: primary?.message,
      error:
        primary?.status && primary.status !== "ok" && primary.errorCode
          ? {
              code: primary.errorCode,
              message: primary.message ?? "图表数据获取失败。",
              retryable: primary.status === "transient_error",
            }
          : undefined,
    };
    return c.json(response);
  });

  // Admin endpoints — guarded inside buildAdminRoutes.
  app.route("/api/admin", admin);

  return app;
}

function toPercentLine(series: ChartSeries): Array<{ t: string; value: number }> {
  if (!series.line?.length && !series.candles?.length) return [];
  const points = series.line ?? series.candles!.map((c) => ({ t: c.t, value: c.close }));
  const start = points[0]?.value;
  if (!start) return [];
  return points.map((p) => ({ t: p.t, value: ((p.value - start) / start) * 100 }));
}

const NON_COMPLIANT_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bguaranteed?\s+(return|profit|income|return[s]?)/i, label: "guaranteed return" },
  { re: /\b100\s*%\s*(safe|return|profit)/i, label: "100% return" },
  { re: /\b确定性(涨跌|收益|回报)/, label: "确定性收益" },
  { re: /\b直接(买入|卖出)指令/, label: "直接买卖指令" },
  { re: /\bsure\s+thing\b/i, label: "sure thing" },
  { re: /\b(predict|tell me)\s+(the\s+)?(next\s+)?(price|stock|move)/i, label: "predict next price" },
];

function nonCompliantReasonFor(decision: { userReason?: string | null; notes?: string | null }): string | null {
  const text = `${decision.userReason ?? ""} ${decision.notes ?? ""}`.trim();
  if (!text) return null;
  for (const { re, label } of NON_COMPLIANT_PATTERNS) {
    if (re.test(text)) return label;
  }
  return null;
}