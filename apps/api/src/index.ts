import { loadConfig } from "./config.ts";
import { buildServer } from "./server.ts";

const config = loadConfig();

const { app } = buildServer(config);

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