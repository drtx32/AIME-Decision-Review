/**
 * Hono routes — /api/reviews/* + /health.
 */

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { DecisionInputSchema } from "../types/index.ts";
import type { AppConfig } from "../config.ts";
import type { ReviewRepository } from "../db/sqlite.ts";
import type { McpRegistry } from "../mcp/registry.ts";
import { DecisionReviewAgent } from "../agents/decision-review.ts";
import type { ModelProvider } from "../providers/index.ts";

export interface RouteDeps {
  config: AppConfig;
  repo: ReviewRepository;
  registry: McpRegistry;
  provider: ModelProvider;
  /** Test hook — bypass background execution so specs stay deterministic. */
  runSync?: boolean;
}

export function buildApi(deps: RouteDeps): Hono {
  const app = new Hono();

  app.get("/health", (c) => {
    return c.json({
      status: "ok",
      provider: deps.provider.id,
      configuredServers: deps.registry.configuredKeys(),
      time: new Date().toISOString(),
    });
  });

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

  return app;
}