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
 *   - No credentials configured → MockFuyaoAdapter / MockIFindAdapter
 *     (deterministic, used for the vertical slice and CI).
 *   - Credentials configured     → LiveHttpAdapter wraps a real HTTP call,
 *     normalizes the upstream payload into Evidence, and surfaces
 *     success / empty / transient_error / permanent_error honestly.
 */

import type { AppConfig } from "../config.ts";
import type {
  FuyaoServerKey,
  IFindServerKey,
  McpServerKey,
} from "../types/index.ts";
import { MockFuyaoAdapter, FUYAO_INTENT_MAP } from "./adapters/fuyao-mock.ts";
import { MockIFindAdapter, IFIND_INTENT_MAP } from "./adapters/ifind-mock.ts";
import { LiveHttpAdapter } from "./adapters/live-http.ts";
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

  function buildAdapter(key: McpServerKey): EvidenceAdapter | null {
    if ((configuredFuyao as Set<string>).has(key)) {
      if (fuyaoHasCreds) {
        return new LiveHttpAdapter({
          provider: "fuyao",
          serverKey: key,
          credentials: {
            baseUrl: cfg.fuyao.baseUrl,
            apiKey: cfg.fuyao.apiKey,
          },
          pathFor: (k, intent) => `/${k}/${intent}`,
          // Fuyao gateway uses x-api-key; we still send Authorization as a
          // belt-and-braces header so the same code path works for endpoints
          // that key off `authorization`.
          buildAuthHeader: () => cfg.fuyao.apiKey ?? undefined,
          supportedIntents: FUYAO_INTENT_MAP[key as FuyaoServerKey],
        });
      }
      return new MockFuyaoAdapter(key as FuyaoServerKey, {
        baseUrl: cfg.fuyao.baseUrl,
        apiKey: cfg.fuyao.apiKey,
      });
    }
    if ((configuredIFind as Set<string>).has(key)) {
      if (ifindHasCreds) {
        return new LiveHttpAdapter({
          provider: "ifind",
          serverKey: key,
          credentials: {
            baseUrl: cfg.ifind.baseUrl,
            authorization: cfg.ifind.authorization,
          },
          pathFor: (k, intent) => `/${k}/${intent}`,
          buildAuthHeader: () => cfg.ifind.authorization ?? undefined,
          supportedIntents: IFIND_INTENT_MAP[key as IFindServerKey],
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