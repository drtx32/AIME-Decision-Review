/**
 * OpenAI-compatible provider — talks to any chat-completions endpoint that
 * follows the OpenAI schema, including MiniMax gateways that expose an
 * OpenAI-compatible base URL.
 *
 * We avoid leaking the API key into traces or logs. The provider only returns
 * text / structured fields back to the agent harness.
 */

import OpenAI from "openai";
import type {
  LLMCompletion,
  LLMCompletionRequest,
  ModelProvider,
  ProviderCapabilities,
  ProviderAvailability,
} from "./index.ts";

export interface OpenAICompatibleOptions {
  modelName: string;
  baseUrl: string;
  apiKey: string;
  probeImages?: boolean;
  probeOverride?: { available: boolean; reason?: string };
}

const PROBE_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";
const PROBE_PROMPT = "Reply with the single word OK if you can see this image. No other text.";

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id = "openai-compatible";
  readonly modelName: string;
  capabilities: ProviderCapabilities = { text: true, images: false };
  private client: OpenAI;
  private probeOverride?: { available: boolean; reason?: string };

  constructor(opts: OpenAICompatibleOptions) {
    this.modelName = opts.modelName;
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseUrl,
    });
    this.probeOverride = opts.probeOverride;
    if (this.probeOverride) this.capabilities = { text: true, images: this.probeOverride.available };
    // Capability probing is opt-in: construction must never trigger an
    // unexpected network call or consume a completion before the caller asks
    // for it. Credentialed deployments can pass `probeImages: true`.
    else if (opts.probeImages === true) void this.probeImages().then((r) => { this.capabilities = { text: true, images: r.available }; });
  }

  async complete(req: LLMCompletionRequest): Promise<LLMCompletion> {
    const response = await this.client.chat.completions.create({
      model: this.modelName,
      temperature: req.temperature ?? 0.2,
      max_tokens: req.maxOutputTokens ?? 1024,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
    });

    const choice = response.choices[0];
    const text = choice?.message?.content ?? "";
    return {
      text,
      usage: response.usage
        ? {
            input: response.usage.prompt_tokens ?? 0,
            output: response.usage.completion_tokens ?? 0,
          }
        : undefined,
    };
  }

  availability(): ProviderAvailability {
    // The provider is constructed only when both `apiKey` and `baseUrl`
    // were supplied, so the wrapper can declare a `ready` baseline. Any
    // transient failure is captured by `LazyResilientProvider` on top and
    // surfaced through its own `availability()`.
    return {
      state: "ready",
      providerId: this.id,
      model: this.modelName,
      lastError: null,
      requestedMode: "openai-compatible",
      degraded: false,
    };
  }

  async probeImages(): Promise<{ available: boolean; reason?: string }> {
    if (this.probeOverride) return this.probeOverride;
    try {
      const response = await this.client.chat.completions.create({
        model: this.modelName,
        max_tokens: 8,
        temperature: 0,
        messages: [{ role: "user", content: [
          { type: "text", text: PROBE_PROMPT },
          { type: "image_url", image_url: { url: `data:image/png;base64,${PROBE_PNG_BASE64}` } },
        ] }],
      });
      return (response.choices[0]?.message?.content ?? "").trim()
        ? { available: true }
        : { available: false, reason: "empty_response" };
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
}
