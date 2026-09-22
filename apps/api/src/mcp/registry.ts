/**
 * MCP registry — broad configuration, narrow resolution.
 *
 * The registry holds configuration for the full Fuyao (6) + iFinD (11)
 * server set, but never enumerates every tool schema at startup. Server
 * adapters are only constructed when a review plan asks for them, and each
 * adapter exposes a tiny intent-based surface instead of dumping its entire
 * tool catalogue to the model.
 *
 * In the mock vertical slice, adapters produce deterministic evidence. When
 * real credentials are configured the adapters switch to HTTP — that branch is
 * wired but not exercised in this MVP.
 */

import type { AppConfig } from "../config.ts";
import type {
  FuyaoServerKey,
  IFindServerKey,
  McpServerKey,
} from "../types/index.ts";
import { MockFuyaoAdapter } from "./adapters/fuyao-mock.ts";
import { MockIFindAdapter } from "./adapters/ifind-mock.ts";
import type { EvidenceAdapter, AdapterRequest } from "./adapters/types.ts";

export interface McpRegistry {
  /** List the server keys configured for this run. */
  configuredKeys(): McpServerKey[];
  /** Resolve (and lazily construct) an adapter for a single server key. */
  resolve(key: McpServerKey): EvidenceAdapter | null;
  /** List all adapters whose `canHandle(intent)` matches. */
  resolveFor(intent: AdapterRequest["intent"]): EvidenceAdapter[];
}

export function buildMcpRegistry(cfg: AppConfig): McpRegistry {
  const constructed = new Map<McpServerKey, EvidenceAdapter>();

  const configuredFuyao = new Set(cfg.fuyao.servers);
  const configuredIFind = new Set(cfg.ifind.servers);

  function buildAdapter(key: McpServerKey): EvidenceAdapter | null {
    if ((configuredFuyao as Set<string>).has(key)) {
      return new MockFuyaoAdapter(key as FuyaoServerKey, {
        baseUrl: cfg.fuyao.baseUrl,
        apiKey: cfg.fuyao.apiKey,
      });
    }
    if ((configuredIFind as Set<string>).has(key)) {
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

  function resolveFor(intent: AdapterRequest["intent"]): EvidenceAdapter[] {
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