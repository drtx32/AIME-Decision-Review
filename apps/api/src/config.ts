/**
 * Centralised env parsing. Real values come from server env / GitHub Secrets —
 * we never log them and never persist them.
 */

import type { AdapterIntent } from "./mcp/adapters/types.ts";

export interface AppConfig {
  port: number;
  sqlitePath: string;
  logLevel: "debug" | "info" | "warn" | "error";
  /** Production-ish flag toggles Secure cookies and stricter auth headers. */
  isProduction: boolean;

  initialAdmin: {
    username: string;
    password: string;
  };

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
    /** Operator-supplied intent → MCP tool name map (e.g. "price:get_security_price"). */
    toolMap: Partial<Record<AdapterIntent, string>>;
  };

  ifind: {
    baseUrl: string | null;
    authorization: string | null;
    servers: IFindServerKey[];
    toolMap: Partial<Record<AdapterIntent, string>>;
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

/** Parse "intent:toolName,intent2:toolName2" into a Partial<Record>. */
function parseToolMap(
  raw: string | undefined
): Partial<Record<AdapterIntent, string>> {
  const out: Partial<Record<AdapterIntent, string>> = {};
  if (!raw) return out;
  for (const pair of raw.split(",")) {
    const [intent, toolName] = pair.split(":").map((s) => s.trim());
    if (!intent || !toolName) continue;
    out[intent as AdapterIntent] = toolName;
  }
  return out;
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

  // INITIAL_ADMIN_USERNAME / INITIAL_ADMIN_PASSWORD carry the *bootstrap*
  // admin credentials. They are only used on a fresh DB and never logged.
  // Default username "admin" / password "admin@123" is the documented
  // fallback; Compose passes through real values when present.
  const initialAdminUsername = (env.INITIAL_ADMIN_USERNAME ?? "admin").trim() || "admin";
  const initialAdminPassword = env.INITIAL_ADMIN_PASSWORD?.length
    ? env.INITIAL_ADMIN_PASSWORD
    : "admin@123";

  const nodeEnv = (env.NODE_ENV ?? "development").toLowerCase();
  const isProduction =
    nodeEnv === "production" ||
    nodeEnv === "prod" ||
    (env.PORT === "3000" && nodeEnv !== "test");

  return {
    port: Number(env.PORT ?? 3000),
    sqlitePath: env.SQLITE_PATH ?? "./data/decision-review.db",
    logLevel: (env.LOG_LEVEL as AppConfig["logLevel"]) ?? "info",
    isProduction,
    initialAdmin: {
      username: initialAdminUsername,
      password: initialAdminPassword,
    },
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
      toolMap: parseToolMap(env.HITHINK_FINANCE_TOOL_MAP),
    },
    ifind: {
      baseUrl: env.IFIND_MCP_BASE_URL?.trim() || null,
      authorization: env.IFIND_MCP_AUTHORIZATION?.trim() || null,
      servers: parseEnumList(
        env.IFIND_MCP_SERVERS,
        ALL_IFIND_SERVERS,
        [...ALL_IFIND_SERVERS]
      ),
      toolMap: parseToolMap(env.IFIND_MCP_TOOL_MAP),
    },
  };
}