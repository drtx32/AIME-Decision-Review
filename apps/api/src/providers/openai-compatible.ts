/**
 * OpenAI-compatible provider — talks to any chat-completions endpoint that
 * follows the OpenAI schema, including MiniMax gateways that expose an
 * OpenAI-compatible base URL.
 *
 * We avoid leaking the API key into traces or logs. The provider only returns
 * text / structured fields back to the agent harness.
 */

import OpenAI from "openai";
import type { LLMCompletion, LLMCompletionRequest, ModelProvider } from "./index.ts";

export interface OpenAICompatibleOptions {
  modelName: string;
  baseUrl: string;
  apiKey: string;
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id = "openai-compatible";
  readonly modelName: string;
  private client: OpenAI;

  constructor(opts: OpenAICompatibleOptions) {
    this.modelName = opts.modelName;
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseUrl,
    });
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
}