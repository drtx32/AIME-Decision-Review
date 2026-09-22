/**
 * Test helpers — build a server with a fresh in-memory SQLite and the
 * default mock registry. Each test gets a clean state.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../src/config.ts";
import { buildServer } from "../src/server.ts";

export function makeTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 0,
    sqlitePath: join(tmpdir(), `decision-review-${randomUUID()}.db`),
    logLevel: "error",
    llm: {
      provider: "mock",
      model: "mvp-mock",
      baseUrl: null,
      apiKey: null,
    },
    fuyao: {
      baseUrl: null,
      apiKey: null,
      servers: ["a-share", "a-share-index", "fund", "futures", "options", "meta"],
    },
    ifind: {
      baseUrl: null,
      authorization: null,
      servers: ["ds", "enterprise", "law", "stock", "fund", "edb", "news", "bond", "global-stock", "index", "futures"],
    },
    ...overrides,
  } as AppConfig;
}

export function makeTestServer(): TestServer {
  const cfg = makeTestConfig();
  const { app, deps, repo } = buildServer(cfg);
  return {
    app,
    deps,
    repo,
    cfg,
    cleanup: () => {
      repo.close();
      try {
        rmSync(cfg.sqlitePath, { force: true });
      } catch {
        // ignore
      }
    },
  };
}

export interface TestServer {
  app: ReturnType<typeof buildServer>["app"];
  deps: ReturnType<typeof buildServer>["deps"];
  repo: ReturnType<typeof buildServer>["repo"];
  cfg: AppConfig;
  cleanup: () => void;
}