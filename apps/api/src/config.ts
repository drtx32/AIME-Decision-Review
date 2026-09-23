/**
 * Centralised env parsing. Real values come from server env / GitHub Secrets —
 * we never log them and never persist them.
 */

import type { AdapterIntent } from "./mcp/adapters/types.ts";

export interface AppConfig {
  port: number;
  sqlitePath: string;
  logLevel: "debug" | "info" | "warn" | "error";
  runtime: "development" | "production";
  /** Production-ish flag toggles Secure cookies and stricter auth headers. */
  isProduction: boolean;

  initialAdmin: {
    username: string;
    password: string | null;
  };

  llm: {
    provider: "openai-compatible" | "mock";
    model: string;
    extractorModel: string;
    baseUrl: string | null;
    apiKey: string | null;
  };

  fuyao: {
    baseUrl: string | null;
    apiKey: string | null;
    servers: FuyaoServerKey[];
    /** Operator-supplied intent → MCP tool name map (e.g. "price:get_security_price"). */
    toolMap: Partial<Record<AdapterIntent, string>>;
    /** Optional server:intent:toolName mappings that narrow dispatch per server. */
    toolMapByServer: Partial<Record<FuyaoServerKey, Partial<Record<AdapterIntent, string>>>>;
    /**
     * Operator-supplied canonical → remote-name suffix map. iFinD's gateway
     * uses the full server name (e.g. `hexin-ifind-ds-stock-mcp`); Fuyao
     * uses the short key. When the operator overrides, the value is appended
     * to `baseUrl` instead of the short key. Format:
     * `HITHINK_FINANCE_REMOTE_SUFFIX_MAP=stock:hexin-ifind-ds-stock-mcp,...`
     */
    remoteSuffixMap: Partial<Record<FuyaoServerKey, string>>;
  };

  ifind: {
    baseUrl: string | null;
    authorization: string | null;
    servers: IFindServerKey[];
    toolMap: Partial<Record<AdapterIntent, string>>;
    /** Optional server:intent:toolName mappings that narrow dispatch per server. */
    toolMapByServer: Partial<Record<IFindServerKey, Partial<Record<AdapterIntent, string>>>>;
    /**
     * See `fuyao.remoteSuffixMap`. The default map uses
     * `hexin-ifind-ds-<key>-mcp` for every configured iFinD server key.
     */
    remoteSuffixMap: Partial<Record<IFindServerKey, string>>;
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

/** Parse "server:intent:toolName,server2:intent2:toolName2". */
function parseToolMapByServer<K extends string>(
  raw: string | undefined,
  allowed: readonly K[]
): Partial<Record<K, Partial<Record<AdapterIntent, string>>>> {
  const out: Partial<Record<K, Partial<Record<AdapterIntent, string>>>> = {};
  if (!raw) return out;
  for (const pair of raw.split(",")) {
    const [server, intent, ...toolParts] = pair.split(":").map((s) => s.trim());
    const toolName = toolParts.join(":").trim();
    if (!server || !intent || !toolName) continue;
    if (!(allowed as readonly string[]).includes(server)) continue;
    const serverMap = out[server as K] ?? {};
    serverMap[intent as AdapterIntent] = toolName;
    out[server as K] = serverMap;
  }
  return out;
}

/** Parse "key:suffix,key:suffix" into a Partial<Record>. Used for the
 *  canonical → remote-name suffix map (iFinD / Fuyao). */
function parseSuffixMap<K extends string>(
  raw: string | undefined,
  allowed: readonly K[]
): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  if (!raw) return out;
  for (const pair of raw.split(",")) {
    const [key, suffix] = pair.split(":").map((s) => s.trim());
    if (!key || !suffix) continue;
    if (!(allowed as readonly string[]).includes(key)) continue;
    out[key as K] = suffix;
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
  // The password must come from server env / GitHub Secrets; there is no
  // repository fallback, so an unconfigured fresh deployment fails fast.
  const initialAdminUsername = (env.INITIAL_ADMIN_USERNAME ?? "admin").trim() || "admin";
  const initialAdminPassword = env.INITIAL_ADMIN_PASSWORD?.length
    ? env.INITIAL_ADMIN_PASSWORD
    : null;

  const nodeEnv = (env.NODE_ENV ?? "development").toLowerCase();
  const isProduction =
    nodeEnv === "production" ||
    nodeEnv === "prod" ||
    (env.PORT === "3000" && nodeEnv !== "test");

  return {
    runtime: env.NODE_ENV === "production" ? "production" : "development",
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
      extractorModel: env.LLM_EXTRACTOR_MODEL ?? env.LLM_MODEL ?? "mvp-mock-model",
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
      toolMapByServer: parseToolMapByServer(
        env.HITHINK_FINANCE_TOOL_MAP_PER_SERVER,
        ALL_FUYAO_SERVERS
      ),
      remoteSuffixMap: parseSuffixMap(
        env.HITHINK_FINANCE_REMOTE_SUFFIX_MAP,
        ALL_FUYAO_SERVERS
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
      toolMap: parseToolMap(env.IFIND_MCP_TOOL_MAP),
      toolMapByServer: parseToolMapByServer(
        env.IFIND_MCP_TOOL_MAP_PER_SERVER,
        ALL_IFIND_SERVERS
      ),
      remoteSuffixMap: parseSuffixMap(
        env.IFIND_MCP_REMOTE_SUFFIX_MAP,
        ALL_IFIND_SERVERS
      ),
    },
  };
}
