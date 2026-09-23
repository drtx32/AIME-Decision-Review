import type { AppConfig } from "./config.ts";
import { buildMcpRegistry } from "./mcp/registry.ts";
import { ReviewRepository } from "./db/sqlite.ts";
import { UserRepository } from "./auth/repository.ts";
import { buildApi, type RouteDeps } from "./routes/api.ts";
import { getModelProvider } from "./providers/index.ts";
import { AttachmentRepository } from "./attachments/repository.ts";
import { AttachmentService } from "./attachments/service.ts";
import { SettingsRepository } from "./settings/repository.ts";

export function buildServer(
  config: AppConfig,
  overrides: Partial<RouteDeps> & {
    attachmentRepo?: AttachmentRepository;
    attachmentService?: AttachmentService;
    settingsRepo?: SettingsRepository;
  } = {}
): {
  app: ReturnType<typeof buildApi>;
  deps: RouteDeps;
  repo: ReviewRepository;
  userRepo: UserRepository;
  attachmentRepo: AttachmentRepository;
  settingsRepo: SettingsRepository;
} {
  const repo = overrides.repo ?? new ReviewRepository(config.sqlitePath);
  const userRepo = overrides.userRepo ?? new UserRepository(config.sqlitePath);
  const registry = overrides.registry ?? buildMcpRegistry(config);
  const provider = overrides.provider ?? getModelProvider(config);
  const attachmentRepo = overrides.attachmentRepo ?? new AttachmentRepository(config.sqlitePath);
  const attachments =
    overrides.attachments ??
    overrides.attachmentService ??
    new AttachmentService({ repo: attachmentRepo, provider });
  const settingsRepo = overrides.settingsRepo ?? new SettingsRepository(config.sqlitePath);

  const deps: RouteDeps = {
    config,
    repo,
    userRepo,
    registry,
    provider,
    attachments,
    settingsRepo,
    runSync: overrides.runSync ?? true,
  };
  const app = buildApi(deps);
  return { app, deps, repo, userRepo, attachmentRepo, settingsRepo };
}
