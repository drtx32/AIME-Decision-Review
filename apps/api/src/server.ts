import type { AppConfig } from "./config.ts";
import { buildMcpRegistry } from "./mcp/registry.ts";
import { ReviewRepository } from "./db/sqlite.ts";
import { buildApi, type RouteDeps } from "./routes/api.ts";
import { getModelProvider } from "./providers/index.ts";

export function buildServer(
  config: AppConfig,
  overrides: Partial<RouteDeps> = {}
): { app: ReturnType<typeof buildApi>; deps: RouteDeps; repo: ReviewRepository } {
  const repo = overrides.repo ?? new ReviewRepository(config.sqlitePath);
  const registry = overrides.registry ?? buildMcpRegistry(config);
  const provider = overrides.provider ?? getModelProvider(config);
  const deps: RouteDeps = {
    config,
    repo,
    registry,
    provider,
    runSync: overrides.runSync ?? true,
  };
  const app = buildApi(deps);
  return { app, deps, repo };
}