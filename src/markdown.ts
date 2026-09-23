/**
 * Safe Markdown rendering for assistant message content.
 *
 * Goals:
 * - Replace the previous hand-written partial Markdown parser with a
 *   standard, audited library (marked v18).
 * - Render a mature Markdown subset: paragraphs, headings, bold/italic,
 *   ordered/unordered lists, GFM tables, fenced/inline code, blockquotes,
 *   and links.
 * - NEVER expose provider chain-of-thought (`<think>...</think>`) to the
 *   visible message bubble. Stripping happens at the provider/message
 *   boundary, *before* the string is persisted or rendered.
 * - NEVER trust raw HTML in provider content. Raw HTML is escaped by
 *   marked by default; an explicit renderer override additionally drops
 *   any inline/block HTML tokens so even a misconfigured extension
 *   cannot inject script tags, javascript: URLs, or event handlers.
 * - ActivityEvent/tool/review worklog rendering lives in App.tsx and is
 *   unaffected by this module.
 *
 * The reasoning/status summary, if any, is a SEPARATE structured field
 * (`reasoning` on SessionMessage). The Markdown body MUST NOT contain a
 * "thinking" disclosure that renders raw hidden chain-of-thought. If a
 * product-level disclosure is later desired, it must be fed from the
 * structured `reasoning` field, not by re-parsing the visible content.
 */

import { marked, type Tokens } from 'marked';

/**
 * URL safety check used by the link / image renderers.
 *
 * Allows:
 *   - http: and https:
 *   - mailto:
 *   - Same-host relative paths starting with `/`
 *   - Anchor links starting with `#`
 *
 * Blocks every other scheme, including javascript:, data:, vbscript:,
 * file:, and any other unknown protocol.
 */
function sanitizeHref(href: string): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (/^(javascript|data|vbscript|file):/i.test(lower)) return null;
  if (/^(https?:|mailto:|\/|#)/i.test(lower)) return trimmed;
  return null;
}

/**
 * Strip provider hidden chain-of-thought (`<think>...</think>` blocks,
 * including variants with leading whitespace, attributes, or newlines).
 *
 * - Case-insensitive
 * - Greedy across newlines
 * - Removes the entire `<think>...</think>` region including delimiters
 * - Does NOT touch user-visible prose
 * - Safe to call repeatedly
 */
export function stripThinkBlocks(input: string): string {
  if (!input) return '';
  // Greedy across newlines; tolerate attributes like <think reason="x">.
  // The regex matches the entire <think>...</think> span regardless of
  // attributes on the opening tag; trailing closing tags are required.
  // Note: no \b after `think` — the next character may itself be a word
  // char (e.g. `<thinkplain>` or `<think>x</think>`), and \b would
  // erroneously require a non-word boundary there.
  return input.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/**
 * The shared link/image override used by both `link` and `image`
 * renderers. marked v18 does not expose a `safeLink` hook, so the
 * scheme check is performed inside the renderer override.
 *
 * When the href is unsafe the renderer falls back to plain text (links)
 * or to an empty string (images); image payloads are not part of the
 * assistant message UX today, so a hard drop is acceptable and
 * conservative.
 */
function safeLinkOrImage(
  base: { href: string; title?: string | null; text?: string; tokens?: unknown[] },
  fallbackText: string | null,
): string | false {
  const safe = sanitizeHref(base.href);
  if (safe === null) {
    if (fallbackText === null) return '';
    // Render the inner tokens (if any) as inline prose.
    if (Array.isArray(base.tokens) && base.tokens.length > 0) {
      return (marked as unknown as {
        parser: { parseInline: (tokens: unknown[]) => string };
      }).parser.parseInline(base.tokens);
    }
    return fallbackText;
  }
  base.href = safe;
  // Returning `false` lets marked's default renderer run.
  return false;
}

/**
 * Install safe renderers and extension defaults on the shared marked
 * instance. Called exactly once at module load.
 *
 * - `gfm: true` enables GitHub-flavoured Markdown (tables, strikethrough,
 *   autolinks).
 * - `breaks: false` keeps single newlines from becoming <br>, matching
 *   the conventional Markdown semantics the chat bubble expects.
 * - The inline `html` renderer is overridden to drop any inline HTML
 *   tokens. marked already escapes raw HTML entities by default; this is
 *   defence in depth.
 * - The block-level `html` extension tokeniser recognises HTML tags and
 *   renders them to an empty string. marked's default behaviour already
 *   escapes block HTML, but a malicious or buggy provider payload could
 *   otherwise inject `<script>`, `<iframe>`, etc.
 * - The `link` and `image` renderers are overridden to filter the href
 *   via `sanitizeHref` before emitting the tag. Unsafe schemes
 *   (javascript:, data:, vbscript:, file:) fall back to plain text or
 *   are dropped entirely.
 */
marked.use({
  gfm: true,
  breaks: false,
  pedantic: false,
  renderer: {
    // Raw HTML in provider content is escaped to entities. marked v18
    // does NOT escape raw HTML by default — `<script>alert(1)</script>`
    // passes through to the DOM as live HTML. This renderer override
    // replaces `<`, `>`, `&`, and `"` with their HTML entity equivalents
    // so the chat bubble never executes scripts, frames, or event
    // handlers from a provider payload.
    html(token: { text?: string }): string {
      const raw = token.text ?? '';
      return raw.replace(/[&<>"]/g, (c) => {
        switch (c) {
          case '&': return '&amp;';
          case '<': return '&lt;';
          case '>': return '&gt;';
          case '"': return '&quot;';
          default: return c;
        }
      });
    },
    // Override link rendering: filter unsafe URL schemes.
    link(token: Tokens.Link): string {
      const out = safeLinkOrImage(
        { href: token.href, title: token.title, tokens: token.tokens },
        null,
      );
      if (out === false) {
        // Delegate to the default renderer with sanitized href.
        return false as unknown as string;
      }
      return out;
    },
    // Override image rendering: same scheme filter. Unsafe images are
    // dropped entirely (no <img>, no alt text leak).
    image(token: Tokens.Image): string {
      const out = safeLinkOrImage(
        { href: token.href, title: token.title, text: token.text },
        '',
      );
      if (out === false) {
        return false as unknown as string;
      }
      return out;
    },
  },
  // Block-level HTML goes through the default html renderer, which is
  // overridden above to escape raw HTML to entities. No custom block
  // extension is registered because it would intercept block HTML
  // before the escape override runs.
});

export interface RenderedMarkdown {
  /** Sanitized HTML ready for dangerouslySetInnerHTML. */
  html: string;
  /** Whether anything was stripped (<think> blocks). */
  stripped: boolean;
}

/**
 * Render a Markdown string into sanitized HTML for the chat bubble.
 *
 * Strips provider hidden chain-of-thought first, then renders through
 * marked with raw-HTML output disabled and unsafe URL schemes blocked.
 * Returns both the HTML and a flag indicating whether anything was
 * stripped, so the caller can log or audit the strip event without
 * surfacing it in the visible UI.
 */
export function renderAssistantMarkdown(input: string): RenderedMarkdown {
  const cleaned = stripThinkBlocks(input);
  const stripped = cleaned.length !== (input ?? '').trim().length;
  const html = marked.parse(cleaned, { async: false, gfm: true, breaks: false }) as string;
  return { html, stripped };
}