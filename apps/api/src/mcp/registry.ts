/**
 * MCP registry — broad configuration, narrow resolution.
 *
 * The registry holds configuration for the full Fuyao (6) + iFinD (11)
 * server set, but never enumerates every tool schema at startup. Server
 * adapters are only constructed when a review plan asks for them, and each
 * adapter exposes a tiny intent-based surface instead of dumping its entire
 * tool catalogue to the model.
 *
 * Behaviour:
 *   - No credentials configured          → MockFuyaoAdapter / MockIFindAdapter
 *     (deterministic, used for the vertical slice and CI).
 *   - Credentials configured but no
 *     intent→tool map                    → no live adapter for that server
 *     (we refuse to fabricate tool names).
 *   - Credentials + operator-supplied
 *     `HITHINK_FINANCE_TOOL_MAP` /
 *     `IFIND_MCP_TOOL_MAP`              → LiveMcpAdapter drives real MCP
 *     JSON-RPC 2.0 (initialize → tools/list → tools/call) on each call.
 */

import type { AppConfig } from "../config.ts";
import type {
  FuyaoServerKey,
  IFindServerKey,
  McpServerKey,
} from "../types/index.ts";
import { MockFuyaoAdapter, FUYAO_INTENT_MAP } from "./adapters/fuyao-mock.ts";
import { MockIFindAdapter, IFIND_INTENT_MAP } from "./adapters/ifind-mock.ts";
import { LiveMcpAdapter } from "./adapters/live-mcp.ts";
import type {
  AdapterIntent,
  EvidenceAdapter,
} from "./adapters/types.ts";

export interface McpRegistry {
  /** List the server keys configured for this run. */
  configuredKeys(): McpServerKey[];
  /** Resolve (and lazily construct) an adapter for a single server key. */
  resolve(key: McpServerKey): EvidenceAdapter | null;
  /** List all adapters whose `canHandle(intent)` matches. */
  resolveFor(intent: AdapterRequest["intent"]): EvidenceAdapter[];
}

type AdapterRequest = { intent: AdapterIntent };

export function buildMcpRegistry(cfg: AppConfig): McpRegistry {
  const constructed = new Map<McpServerKey, EvidenceAdapter>();

  const configuredFuyao = new Set(cfg.fuyao.servers);
  const configuredIFind = new Set(cfg.ifind.servers);
  const fuyaoHasCreds = Boolean(cfg.fuyao.baseUrl && cfg.fuyao.apiKey);
  const ifindHasCreds = Boolean(cfg.ifind.baseUrl && cfg.ifind.authorization);

  function fuyaoToolFor(intent: AdapterIntent): string | null {
    return cfg.fuyao.toolMap[intent] ?? null;
  }
  function ifindToolFor(intent: AdapterIntent): string | null {
    return cfg.ifind.toolMap[intent] ?? null;
  }

  function buildAdapter(key: McpServerKey): EvidenceAdapter | null {
    if ((configuredFuyao as Set<string>).has(key)) {
      if (fuyaoHasCreds && cfg.fuyao.baseUrl) {
        return new LiveMcpAdapter({
          provider: "fuyao",
          serverKey: key,
          endpoint: joinMcpEndpoint(cfg.fuyao.baseUrl, String(key), "fuyao", cfg.fuyao.remoteSuffixMap as Partial<Record<string, string>>),
          credentials: {
            baseUrl: cfg.fuyao.baseUrl,
            apiKey: cfg.fuyao.apiKey,
          },
          toolForIntent: fuyaoToolFor,
        });
      }
      return new MockFuyaoAdapter(key as FuyaoServerKey, {
        baseUrl: cfg.fuyao.baseUrl,
        apiKey: cfg.fuyao.apiKey,
      });
    }
    if ((configuredIFind as Set<string>).has(key)) {
      if (ifindHasCreds && cfg.ifind.baseUrl) {
        return new LiveMcpAdapter({
          provider: "ifind",
          serverKey: key,
          endpoint: joinMcpEndpoint(cfg.ifind.baseUrl, String(key), "ifind", cfg.ifind.remoteSuffixMap as Partial<Record<string, string>>),
          credentials: {
            baseUrl: cfg.ifind.baseUrl,
            authorization: cfg.ifind.authorization,
          },
          toolForIntent: ifindToolFor,
        });
      }
      return new MockIFindAdapter(key as IFindServerKey, {
        baseUrl: cfg.ifind.baseUrl,
        authorization: cfg.ifind.authorization,
      });
    }
    return null;
  }

  function resolve(key: McpServerKey): EvidenceAdapter | null {
    const existing = constructed.get(key);
    if (existing) return existing;
    const adapter = buildAdapter(key);
    if (adapter) constructed.set(key, adapter);
    return adapter;
  }

  function resolveFor(intent: AdapterIntent): EvidenceAdapter[] {
    const keys: McpServerKey[] = [
      ...(configuredFuyao as Set<FuyaoServerKey>),
      ...(configuredIFind as Set<IFindServerKey>),
    ];
    const out: EvidenceAdapter[] = [];
    for (const key of keys) {
      const adapter = resolve(key);
      if (!adapter) continue;
      if (adapter.canHandle(intent)) out.push(adapter);
    }
    return out;
  }

  function configuredKeys(): McpServerKey[] {
    return [
      ...(configuredFuyao as Set<FuyaoServerKey>),
      ...(configuredIFind as Set<IFindServerKey>),
    ];
  }

  return { configuredKeys, resolve, resolveFor };
}

/** Build the per-server MCP endpoint URL.
 *
 * Fuyao:    `<baseUrl>/<serverKey>`  (e.g. https://fuyao.aicubes.cn/mcp/a-share)
 * iFinD:    `<baseUrl>/<serverKey>`  (e.g. https://api-mcp.51ifind.com:8643/ds-mcp-servers/stock)
 *
 * If `baseUrl` already ends with the server key, we use it as-is.
 */
function joinMcpEndpoint(base: string, serverKey: string, provider: "fuyao" | "ifind", remoteSuffixMap: Partial<Record<string, string>> = {}): string {
  const trimmed = base.replace(/\/$/, "");
  const suffix = remoteSuffixMap[serverKey] ?? (provider === "ifind" ? `hexin-ifind-ds-${serverKey}-mcp` : serverKey);
  if (trimmed.endsWith(`/${suffix}`)) return trimmed;
  return `${trimmed}/${suffix}`;
}
