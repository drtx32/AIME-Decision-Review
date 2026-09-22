import type { AppConfig } from "./config.ts";
import { buildMcpRegistry } from "./mcp/registry.ts";
import { ReviewRepository } from "./db/sqlite.ts";
import { UserRepository } from "./auth/repository.ts";
import { buildApi, type RouteDeps } from "./routes/api.ts";
import { getModelProvider } from "./providers/index.ts";
import { QuotaRepository, QuotaService } from "./quota/repository.ts";

export function buildServer(
  config: AppConfig,
  overrides: Partial<RouteDeps> = {}
): { app: ReturnType<typeof buildApi>; deps: RouteDeps; repo: ReviewRepository; userRepo: UserRepository } {
  const repo = overrides.repo ?? new ReviewRepository(config.sqlitePath);
  const userRepo = overrides.userRepo ?? new UserRepository(config.sqlitePath);
  const registry = overrides.registry ?? buildMcpRegistry(config);
  const provider = overrides.provider ?? getModelProvider(config);
  const quotaRepo = overrides.quotaRepo ?? new QuotaRepository(config.sqlitePath);
  const quota = overrides.quota ?? new QuotaService({
    repo: quotaRepo,
    quota: config.platformDailyTokenQuota,
  });
  const deps: RouteDeps = {
    config,
    repo,
    userRepo,
    registry,
    provider,
    quota,
    quotaRepo,
    runSync: overrides.runSync ?? true,
  };
  const app = buildApi(deps);
  return { app, deps, repo, userRepo };
}