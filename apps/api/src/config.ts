/**
 * Centralised env parsing. Real values come from server env / GitHub Secrets —
 * we never log them and never persist them.
 */

export interface AppConfig {
  port: number;
  sqlitePath: string;
  logLevel: "debug" | "info" | "warn" | "error";

  llm: {
    provider: "openai-compatible" | "mock";
    model: string;
    baseUrl: string | null;
    apiKey: string | null;
  };

  fuyao: {
    baseUrl: string | null;
    apiKey: string | null;
    servers: FuyaoServerKey[];
  };

  ifind: {
    baseUrl: string | null;
    authorization: string | null;
    servers: IFindServerKey[];
  };
}

import type { FuyaoServerKey, IFindServerKey } from "./types/index.ts";

function parseEnumList<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T[]
): T[] {
  if (raw === undefined || raw === "") return fallback;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is T => (allowed as readonly string[]).includes(s));
}

const ALL_FUYAO_SERVERS: readonly FuyaoServerKey[] = [
  "meta",
  "a-share",
  "a-share-index",
  "fund",
  "futures",
  "options",
] as const;

const ALL_IFIND_SERVERS: readonly IFindServerKey[] = [
  "ds",
  "enterprise",
  "law",
  "stock",
  "fund",
  "edb",
  "news",
  "bond",
  "global-stock",
  "index",
  "futures",
] as const;

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const providerRaw = (env.LLM_PROVIDER ?? "mock").toLowerCase();
  const provider: AppConfig["llm"]["provider"] =
    providerRaw === "mock" || providerRaw === "" ? "mock" : "openai-compatible";

  return {
    port: Number(env.PORT ?? 3000),
    sqlitePath: env.SQLITE_PATH ?? "./data/decision-review.db",
    logLevel: (env.LOG_LEVEL as AppConfig["logLevel"]) ?? "info",
    llm: {
      provider,
      model: env.LLM_MODEL ?? "mvp-mock-model",
      baseUrl: env.LLM_BASE_URL?.trim() || null,
      apiKey: env.LLM_API_KEY?.trim() || null,
    },
    fuyao: {
      baseUrl: env.HITHINK_FINANCE_BASE_URL?.trim() || null,
      apiKey: env.HITHINK_FINANCE_API_KEY?.trim() || null,
      servers: parseEnumList(
        env.HITHINK_FINANCE_SERVERS,
        ALL_FUYAO_SERVERS,
        [...ALL_FUYAO_SERVERS]
      ),
    },
    ifind: {
      baseUrl: env.IFIND_MCP_BASE_URL?.trim() || null,
      authorization: env.IFIND_MCP_AUTHORIZATION?.trim() || null,
      servers: parseEnumList(
        env.IFIND_MCP_SERVERS,
        ALL_IFIND_SERVERS,
        [...ALL_IFIND_SERVERS]
      ),
    },
  };
}