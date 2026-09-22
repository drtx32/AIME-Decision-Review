import { loadConfig } from "./config.ts";
import { buildServer } from "./server.ts";
import { UserRepository } from "./auth/repository.ts";

const config = loadConfig();

// Construct the user repo separately so we can run the idempotent bootstrap
// before wiring up routes. If a fresh DB exists and INITIAL_ADMIN_USERNAME /
// INITIAL_ADMIN_PASSWORD are set, the bootstrap admin is created with
// mustChangePassword=1 so the public default cannot linger.
const userRepo = new UserRepository(config.sqlitePath);
userRepo
  .ensureBootstrapAdmin({
    initialAdminUsername: config.initialAdmin.username,
    initialAdminPassword: config.initialAdmin.password,
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