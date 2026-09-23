/**
 * OpenAI-compatible provider — talks to any chat-completions endpoint that
 * follows the OpenAI schema, including MiniMax gateways that expose an
 * OpenAI-compatible base URL.
 *
 * We avoid leaking the API key into traces or logs. The provider only returns
 * text / structured fields back to the agent harness.
 *
 * Vision capability is probed at construction time via a tiny PNG payload.
 * The probe result is cached for the lifetime of the provider instance and
 * exposed through `capabilities.images`.
 */

import OpenAI from "openai";
import type {
  LLMCompletion,
  LLMCompletionRequest,
  ModelProvider,
  ProviderCapabilities,
} from "./index.ts";

export interface OpenAICompatibleOptions {
  modelName: string;
  baseUrl: string;
  apiKey: string;
  /**
   * Disable the live vision probe (e.g. in tests or air-gapped CI). When
   * false the provider assumes images are unavailable without making any
   * network call.
   */
  probeImages?: boolean;
  /** Override the probe to a fixed outcome (test hook). */
  probeOverride?: { available: boolean; reason?: string };
}

/**
 * 1x1 transparent PNG. Decoded at runtime from base64 so we don't ship a
 * binary blob inside the source. The probe asks the model to caption it.
 */
const PROBE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";

const PROBE_PROMPT =
  "Reply with the single word OK if you can see this image. No other text.";

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id = "openai-compatible";
  readonly modelName: string;
  capabilities: ProviderCapabilities;
  private client: OpenAI;
  private probeOverride?: { available: boolean; reason?: string };

  constructor(opts: OpenAICompatibleOptions) {
    this.modelName = opts.modelName;
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseUrl,
    });
    this.probeOverride = opts.probeOverride;
    // Default: text always supported; images unknown until probed. We
    // resolve the promise eagerly but keep the failure path non-fatal.
    this.capabilities = { text: true, images: false };
    if (this.probeOverride) {
      this.capabilities = { text: true, images: this.probeOverride.available };
    } else if (opts.probeImages !== false) {
      // Fire-and-forget probe. Callers that need the authoritative answer
      // should await `probeImages()` explicitly.
      void this.probeImages().then((r) => {
        this.capabilities = { text: true, images: r.available };
      });
    }
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

  /**
   * Probe the configured endpoint with a 1×1 PNG. The probe uses
   * `chat.completions.create` with a multimodal `image_url` content part —
   * the same shape the composer will use in ELI-336 — so the test reflects
   * what the composer will actually do.
   */
  async probeImages(): Promise<{ available: boolean; reason?: string }> {
    if (this.probeOverride) {
      return this.probeOverride;
    }
    try {
      const response = await this.client.chat.completions.create({
        model: this.modelName,
        max_tokens: 8,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: PROBE_PROMPT },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/png;base64,${PROBE_PNG_BASE64}`,
                },
              },
            ],
          },
        ],
      });
      const text = (response.choices[0]?.message?.content ?? "").trim();
      if (!text) {
        return { available: false, reason: "empty_response" };
      }
      // The probe is success iff the model produced any non-empty text.
      return { available: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { available: false, reason: msg };
    }
  }
}