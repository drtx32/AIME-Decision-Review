import { loadConfig } from "./config.ts";
import { buildServer } from "./server.ts";
import { UserRepository } from "./auth/repository.ts";

const config = loadConfig();

// The bootstrap admin password MUST come from server env / GitHub Secrets.
// If it is missing, fail fast here so a misconfigured deployment cannot
// silently run with no admin (and cannot default to a public credential).
// This check only matters on a fresh DB — once any admin exists, the
// ensureBootstrapAdmin() call below is a no-op.
const bootstrapPassword = config.initialAdmin.password;
const userRepo = new UserRepository(config.sqlitePath);
const needsBootstrap = !userRepo.hasAnyAdmin();

if (needsBootstrap && (!bootstrapPassword || !bootstrapPassword.length)) {
  console.error(
    "[decision-review-api] INITIAL_ADMIN_PASSWORD is required for a fresh database. " +
      "Set it via the deployment secret store / GitHub Secret; the API refuses " +
      "to fall back to a repository-resident default."
  );
  process.exit(1);
}

userRepo
  .ensureBootstrapAdmin({
    initialAdminUsername: config.initialAdmin.username,
    // The non-null assertion is safe here because of the process.exit above;
    // tests stub the repo via buildServer overrides and never hit this path.
    initialAdminPassword: bootstrapPassword!,
  })
  .then((result) => {
    if (result.created) {
      // Do NOT log the password; just acknowledge the username was created.
      console.log(
        `[decision-review-api] bootstrap admin created: ${result.user.username} (mustChangePassword=1)`
      );
    } else {
      console.log("[decision-review-api] bootstrap admin already present, leaving credentials untouched");
    }
  })
  .catch((e) => {
    console.error(`[decision-review-api] bootstrap admin failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });

const { app } = buildServer(config, { userRepo });

const server = Bun.serve({
  port: config.port,
  fetch: app.fetch,
});

console.log(
  `[decision-review-api] listening on http://localhost:${server.port} (provider=${config.llm.provider})`
);

const shutdown = () => {
  console.log("[decision-review-api] shutting down");
  server.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

export type { AppConfig } from "./config.ts";