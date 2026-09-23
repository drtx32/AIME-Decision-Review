import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const THINK_XML = /<(?:think|thinking)\b[^>]*>[\s\S]*?<\/(?:think|thinking)>/gi;
const THINK_FENCE = /```\s*think[\s\S]*?```/gi;
const DANGEROUS_BLOCK = /<(script|style|iframe|object|embed|form|link|meta|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const ANY_HTML_TAG = /<\/?[a-zA-Z][\w-]*(?:\s[^<>]*?)?\s*\/?>/g;

function stripChainOfThought(text: string): string {
  return text.replace(THINK_FENCE, '').replace(THINK_XML, '').trim();
}

/**
 * Neutralize raw HTML before Markdown parsing. Dangerous containers are
 * removed whole (content included); all other tags are stripped to their
 * visible text so no unescaped markup ever reaches the DOM and no raw HTML
 * block can swallow adjacent message content.
 */
function sanitizeRawHtml(text: string): string {
  return text
    .replace(DANGEROUS_BLOCK, '')
    .replace(ANY_HTML_TAG, '')
    .replace(/</g, '&lt;');
}

function safeLink(href: string | undefined): string | undefined {
  if (!href) return href;
  try {
    const url = new URL(href, 'https://aime.local');
    if (url.protocol === 'javascript:' || url.protocol === 'vbscript:' || url.protocol === 'data:') return undefined;
    return href;
  } catch {
    return undefined;
  }
}

/**
 * Standard, safe Markdown renderer for assistant/status content. Raw HTML is
 * neutralized, javascript: links are dropped, and any residual CoT block is
 * stripped defensively (the backend already strips before persistence).
 */
export default function MarkdownText({ text, className }: { text: string; className?: string }) {
  const safe = sanitizeRawHtml(stripChainOfThought(text));
  return (
    <div className={className || 'message-md'} dir="auto">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, ...props }) => <a href={safeLink(href)} target="_blank" rel="noopener noreferrer" {...props} />,
        }}
      >
        {safe}
      </ReactMarkdown>
    </div>
  );
}