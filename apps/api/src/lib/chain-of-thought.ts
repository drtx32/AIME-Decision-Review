/**
 * Chain-of-thought hygiene.
 *
 * Raw CoT from a provider (either `<think>…</think>` XML-style tokens or
 * ` ```think …``` ` fences) is never persisted to `conversation_messages`
 * nor rendered to the user. Only product-level progress/trace may surface.
 * This module is the single place the backend strips it before storage.
 */

const THINK_XML = /<(?:think|thinking)\b[^>]*>[\s\S]*?<\/(?:think|thinking)>/gi;
const THINK_FENCE = /```\s*think[\s\S]*?```/gi;
const THINK_MULTILINE_FENCE = /~~~\s*think[\s\S]*?~~~/gi;

export function stripChainOfThought(text: string): string {
  if (!text) return text;
  return text
    .replace(THINK_FENCE, "")
    .replace(THINK_MULTILINE_FENCE, "")
    .replace(THINK_XML, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function containsCoT(text: string): boolean {
  return THINK_XML.test(text) || THINK_FENCE.test(text) || THINK_MULTILINE_FENCE.test(text);
}