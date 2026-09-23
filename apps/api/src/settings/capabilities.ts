/**
 * Model / provider capability metadata.
 *
 * The Settings UI uses this to populate the model picker and to decide
 * whether to enable image-attachment affordances. Per the ELI-341 brief,
 * vision metadata is only marked `verified` when we have actually
 * confirmed it against the provider's published capability matrix;
 * everything else stays `static`/`unknown` so the UI never assumes a
 * capability we have not validated.
 *
 * Adding more verified entries is safe and is the documented extension
 * path; flipping `verified: false` -> `verified: true` without checking
 * the source is the kind of silent capability drift we are guarding
 * against.
 */

import type { ModelCapabilitiesPayload, ModelProviderCapabilities } from "./types.ts";

const OPENAI_COMPATIBLE: ModelProviderCapabilities = {
  id: "openai-compatible",
  displayName: "OpenAI-compatible",
  configurable: true,
  models: [
    {
      id: "gpt-4o",
      displayName: "GPT-4o",
      vision: true,
      visionSource: "verified",
      notes: "OpenAI's published capability matrix lists GPT-4o as multimodal.",
    },
    {
      id: "gpt-4o-mini",
      displayName: "GPT-4o mini",
      vision: true,
      visionSource: "verified",
      notes: "OpenAI's published capability matrix lists GPT-4o mini as multimodal.",
    },
    {
      id: "gpt-4-turbo",
      displayName: "GPT-4 Turbo",
      vision: true,
      visionSource: "verified",
      notes: "OpenAI's published capability matrix lists GPT-4 Turbo (gpt-4-turbo-2024-04-09+) as multimodal.",
    },
    {
      id: "gpt-3.5-turbo",
      displayName: "GPT-3.5 Turbo",
      vision: false,
      visionSource: "verified",
      notes: "Text-only model. Vision is not part of the public capability matrix.",
    },
    {
      id: "o1",
      displayName: "o1",
      vision: true,
      visionSource: "verified",
      notes: "OpenAI's published capability matrix lists o1 as multimodal.",
    },
    {
      id: "o1-mini",
      displayName: "o1 mini",
      vision: false,
      visionSource: "verified",
      notes: "o1 mini is text-only in OpenAI's published capability matrix.",
    },
    {
      id: "claude-3-5-sonnet",
      displayName: "Claude 3.5 Sonnet",
      vision: true,
      visionSource: "verified",
      notes: "Anthropic's published capability matrix lists Claude 3.5 Sonnet as multimodal.",
    },
    {
      id: "claude-3-opus",
      displayName: "Claude 3 Opus",
      vision: true,
      visionSource: "verified",
      notes: "Anthropic's published capability matrix lists Claude 3 Opus as multimodal.",
    },
  ],
};

const MOCK: ModelProviderCapabilities = {
  id: "mock",
  displayName: "Mock (no credentials)",
  configurable: false,
  models: [
    {
      id: "mvp-mock-model",
      displayName: "MVP mock",
      vision: false,
      visionSource: "static",
      notes:
        "The MVP mock provider does not exercise any vision capability. The Settings UI must not enable attachments against this provider.",
    },
  ],
};

export function getModelCapabilities(): ModelCapabilitiesPayload {
  return {
    providers: [OPENAI_COMPATIBLE, MOCK],
    notes:
      "Vision is only flagged `verified` when the provider's published capability matrix has been checked. " +
      "`static` means we assume false because no verification has been run. " +
      "`unknown` is reserved for entries that need operator follow-up. " +
      "Settings UI must not enable image attachments against models that are not vision-verified.",
  };
}
