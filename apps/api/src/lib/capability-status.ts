/**
 * Capability / runtime status — truthful, secret-free answers for
 * "MCP 能不能用 / Fuyao 能用吗 / iFinD 能用吗" style questions.
 *
 * These questions must never be routed to the generic chat LLM, and the
 * answer must never expose base URLs, auth material, tool maps, or claim a
 * capability the operator has not actually provisioned. The chat turn itself
 * never calls MCP — MCP is invoked only inside a review run after the user
 * confirms decisions + T0. An answer that cannot prove a live connection
 * states "configured but not verified" instead of hallucinating success.
 */

import type { AppConfig } from "../config.ts";
import type { ModelProvider } from "../providers/index.ts";

const CAPABILITY_TOKENS = [
  /\bMCP\b/i,
  /Fuyao/i,
  /\biFinD\b/i,
  /数据源/,
  /外部工具/,
  /外部调用/,
  /插件/,
  /工具/,
];

const STATUS_INTENT = [
  /能不能/,
  /能\s*用/,
  /可用/,
  /能\s*调\s*用/,
  /能\s*接/,
  /可\s*以\s*用/,
  /是否\s*(?:配置|可用|能)/,
  /连\s*得?\s*上/,
  /配置\s*了\s*吗/,
];

/** Conservative detector — only fires when a capability token AND status intent co-occur. */
export function detectCapabilityQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const hasCapability = CAPABILITY_TOKENS.some((re) => re.test(t));
  if (!hasCapability) return false;
  return STATUS_INTENT.some((re) => re.test(t));
}

export interface ProviderCapabilityStatus {
  provider: "fuyao" | "ifind";
  state: "ready" | "configured-unverified" | "not-configured" | "degraded";
  serverCount: number;
  credentialLoaded: boolean;
  toolMapReady: boolean;
}

export interface RuntimeStatus {
  llm:
    | { state: string; model: string; degraded: boolean; configured: boolean }
    | null;
  fuyao: ProviderCapabilityStatus | null;
  ifind: ProviderCapabilityStatus | null;
}

interface CapabilityOpts {
  config: AppConfig;
  provider: ModelProvider | null;
}

function dataProviderStatus(
  cfg: AppConfig,
  which: "fuyao" | "ifind",
): ProviderCapabilityStatus {
  const fuyao = which === "fuyao" ? cfg.fuyao : cfg.ifind;
  const credentialLoaded =
    which === "fuyao"
      ? Boolean(cfg.fuyao.baseUrl && cfg.fuyao.apiKey)
      : Boolean(cfg.ifind.baseUrl && cfg.ifind.authorization);
  const toolMapReady =
    Object.keys(fuyao.toolMap ?? {}).length > 0 ||
    Object.keys(fuyao.toolMapByServer ?? {}).length > 0;
  const serverCount = fuyao.servers.length;
  if (!credentialLoaded) {
    return {
      provider: which,
      state: serverCount > 0 ? "not-configured" : "not-configured",
      serverCount,
      credentialLoaded: false,
      toolMapReady,
    };
  }
  if (!toolMapReady || serverCount === 0) {
    return {
      provider: which,
      // Credentials alone do not make a debugger into a data source: without
      // an operator-supplied intent→tool map we refuse to fabricate tool names.
      state: "degraded",
      serverCount,
      credentialLoaded: true,
      toolMapReady: false,
    };
  }
  // Provisioned (creds + tool map + servers). Whether the endpoint actually
  // answers can only be proven by a live call during a review run.
  return {
    provider: which,
    state: "configured-unverified",
    serverCount,
    credentialLoaded: true,
    toolMapReady: true,
  };
}

/**
 * Surface runtime state from config + provider availability only. No secrets,
 * no URLs, no auth material, no tool names. `provider` comes from the session
 * owner's model config when present, else the server default.
 */
export function buildRuntimeStatus(opts: CapabilityOpts): RuntimeStatus {
  const avail = opts.provider?.availability?.() ?? null;
  const llm = opts.provider
    ? {
        state: avail?.state ?? (opts.provider.configured ? "ready" : "unconfigured"),
        model: avail?.model ?? opts.provider.modelName,
        degraded: Boolean(avail?.degraded) || !opts.provider.configured,
        configured: Boolean(opts.provider.configured) && avail?.state !== "unconfigured",
      }
    : null;
  return {
    llm,
    fuyao: dataProviderStatus(opts.config, "fuyao"),
    ifind: dataProviderStatus(opts.config, "ifind"),
  };
}

function hasCjk(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text);
}

/**
 * Render a safe, answer-shaped message. Never includes URLs, keys, auth
 * headers, tool names, or raw config values. `lang` is detected from the
 * user's question (Chinese if any CJK present, else English).
 */
export function formatRuntimeStatusMessage(
  status: RuntimeStatus,
  question: string,
): string {
  const zh = hasCjk(question);

  const llmLine = (() => {
    if (!status.llm) return zh ? "模型服务：未就绪。" : "Model service: not ready.";
    if (status.llm.state === "ready") {
      return zh
        ? `模型服务：已就绪（${status.llm.model}）。`
        : `Model service: ready (${status.llm.model}).`;
    }
    return zh
      ? "模型服务：未配置可用的大模型，追问与分析暂不可用。"
      : "Model service: no configured model — follow-up analysis unavailable.";
  })();

  const sourceLines = (s: ProviderCapabilityStatus | null, label: string) => {
    if (!s) {
      return zh ? `${label}：未配置。` : `${label}: not configured.`;
    }
    const sc = zh
      ? `已登记 ${s.serverCount} 个服务`
      : `registered ${s.serverCount} servers`;
    switch (s.state) {
      case "configured-unverified":
        return zh
          ? `${label}：已配置（凭据与工具映射就绪，${sc}），复盘时按需调用；本轮未进行实际连接验证。`
          : `${label}: configured (credentials + tool map ready, ${sc}); used on demand during a review; not verified live in this turn.`;
      case "degraded":
        return zh
          ? `${label}：已配置凭据但缺少工具映射，复盘不会调用远程数据源（防止伪造工具名）。`
          : `${label}: credentials present but no tool map — remote data source will not be called (no fabricated tool names).`;
      default:
        return zh
          ? `${label}：未配置。`
          : `${label}: not configured.`;
    }
  };

  return zh
    ? [
        "以下是当前运行状态（不含任何密钥或内部配置）：",
        llmLine,
        sourceLines(status.fuyao, "Fuyao（金融数据）"),
        sourceLines(status.ifind, "iFinD（金融数据）"),
        "注意：聊天消息本身不会调用数据源；只有确认决策并进入复盘后，复盘进程才会按需检索证据。",
        "如果你想把真实交易纳入复盘，直接描述交易（标的、方向、时间、理由）即可，我会先解析成可确认的决策结构。",
      ].join("\n")
    : [
        "Current runtime status (no secrets or internal config):",
        llmLine,
        sourceLines(status.fuyao, "Fuyao (finance data)"),
        sourceLines(status.ifind, "iFinD (finance data)"),
        "Note: chat messages never call data sources directly; only the review run fetches evidence after you confirm a decision.",
        "To review a real trade, describe it (symbol, direction, time, rationale) and I will first parse it into a confirmable decision.",
      ].join("\n");
}