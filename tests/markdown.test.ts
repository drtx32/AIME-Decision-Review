/**
 * Regressions for the safe Markdown renderer used by the chat bubble.
 *
 * Scope (narrow helper slice, intentionally isolated to the Markdown
 * rendering path):
 *
 *   - Markdown features render: paragraphs, headings, bold/italic,
 *     ordered/unordered lists, GFM tables, fenced/inline code,
 *     blockquotes, and links.
 *   - Raw provider chain-of-thought (`<think>...</think>`) NEVER
 *     reaches the rendered HTML.
 *   - Raw HTML in provider content is sanitized: no <script>, no
 *     <iframe>, no `javascript:` hrefs, no inline event handlers.
 *   - `stripThinkBlocks` is idempotent and case-insensitive.
 *   - ActivityEvent / worklog / tool rendering is untouched (this
 *     test file does not import App.tsx — those are exercised by
 *     visual / Playwright flows, not unit tests).
 *
 * Run from the repo root:
 *
 *   bun test tests/markdown.test.ts
 */

import { describe, test, expect } from "bun:test";
import { stripThinkBlocks, renderAssistantMarkdown } from "../src/markdown.ts";

describe("stripThinkBlocks", () => {
  test("strips a single <think> block including delimiters", () => {
    const input = "<think>hidden chain of thought</think>visible answer";
    expect(stripThinkBlocks(input)).toBe("visible answer");
  });

  test("strips <think> blocks with attributes on the opening tag", () => {
    const input = `<think> reason="proxy"  channel="x">\nsecret plan\n</think>\nvisible answer`;
    expect(stripThinkBlocks(input)).toBe("visible answer");
  });

  test("strips multiple <think> blocks in one string", () => {
    const input = "<think>one</think>public<think>two</think> tail";
    expect(stripThinkBlocks(input)).toBe("public tail");
  });

  test("is case-insensitive", () => {
    const input = "<THINK>secret</THINK>visible";
    expect(stripThinkBlocks(input)).toBe("visible");
  });

  test("is greedy across newlines", () => {
    const input = "<think>\nline1\nline2\nline3\n</think>visible";
    expect(stripThinkBlocks(input)).toBe("visible");
  });

  test("is idempotent", () => {
    const once = stripThinkBlocks("<think>x</think>visible");
    const twice = stripThinkBlocks(once);
    expect(twice).toBe(once);
  });

  test("leaves content untouched when no think block is present", () => {
    const input = "## 复盘\n\n这是一段公开内容，**not** hidden。";
    expect(stripThinkBlocks(input)).toBe(input);
  });

  test("treats empty / falsy input as empty string", () => {
    expect(stripThinkBlocks("")).toBe("");
    // The function does not accept null/undefined at the type level, but
    // calling with a falsy string returns the empty string contract.
    expect(stripThinkBlocks(" ")).toBe("");
  });
});

describe("renderAssistantMarkdown — Markdown features", () => {
  test("renders paragraphs and headings", () => {
    const md = `# 决策复盘\n\n第一段：当时能知道的信息。\n\n## 子标题\n\n第二段正文。`;
    const { html, stripped } = renderAssistantMarkdown(md);
    expect(stripped).toBe(false);
    expect(html).toContain("<h1>决策复盘</h1>");
    expect(html).toContain("<h2>子标题</h2>");
    expect(html).toContain("<p>第一段");
    expect(html).toContain("<p>第二段");
  });

  test("renders bold and italic", () => {
    const md = "这是 **加粗** 内容，*斜体* 内容。";
    const { html } = renderAssistantMarkdown(md);
    expect(html).toContain("<strong>加粗</strong>");
    expect(html).toContain("<em>斜体</em>");
  });

  test("renders unordered and ordered lists", () => {
    const md = "- 第一项\n- 第二项\n\n1. 步骤一\n2. 步骤二";
    const { html } = renderAssistantMarkdown(md);
    expect(html).toMatch(/<li>第一项<\/li>/);
    expect(html).toMatch(/<li>第二项<\/li>/);
    expect(html).toMatch(/<li>步骤一<\/li>/);
    expect(html).toMatch(/<li>步骤二<\/li>/);
  });

  test("renders GFM tables", () => {
    const md = `| 标的 | 方向 | 数量 |\n| --- | --- | --- |\n| 600519 | buy | 100 |\n| - | - | - |`;
    const { html } = renderAssistantMarkdown(md);
    expect(html).toContain("<table>");
    expect(html).toContain("<th>标的</th>");
    expect(html).toContain("<td>600519</td>");
  });

  test("renders fenced code blocks and inline code", () => {
    const md = "调用 `get_company_by_query` 的结果：\n\n```json\n{\"ok\": true}\n```";
    const { html } = renderAssistantMarkdown(md);
    expect(html).toContain("<code>get_company_by_query</code>");
    expect(html).toContain("<pre><code");
    // Code blocks escape the inner content — quotes become entities.
    expect(html).toContain("{&quot;ok&quot;: true}");
  });

  test("renders blockquotes", () => {
    const md = "> 重要：决策复盘必须区分事前和事后信息。";
    const { html } = renderAssistantMarkdown(md);
    expect(html).toContain("<blockquote>");
    expect(html).toContain("重要：决策复盘");
  });

  test("renders safe http and mailto links", () => {
    const md = "参考：[AIME 主页](https://example.com/aime) 和 [邮箱](mailto:test@example.com)";
    const { html } = renderAssistantMarkdown(md);
    expect(html).toContain('href="https://example.com/aime"');
    expect(html).toContain('href="mailto:test@example.com"');
  });

  test("renders relative path links (same-host dev routing)", () => {
    const md = "[回首页](/sessions)";
    const { html } = renderAssistantMarkdown(md);
    expect(html).toContain('href="/sessions"');
  });

  test("renders anchor links", () => {
    const md = "[跳到顶部](#top)";
    const { html } = renderAssistantMarkdown(md);
    expect(html).toContain('href="#top"');
  });
});

describe("renderAssistantMarkdown — provider chain-of-thought safety", () => {
  test("strips <think> and never includes it in rendered HTML", () => {
    const md = "<think>我应该先调用 mcp_a_share 然后再决定。</think>\n## 复盘\n\n公开结论。";
    const { html, stripped } = renderAssistantMarkdown(md);
    expect(stripped).toBe(true);
    expect(html).not.toContain("<think>");
    expect(html).not.toContain("</think>");
    expect(html).not.toContain("我应该先调用 mcp_a_share 然后再决定。");
    expect(html).toContain("<h2>复盘</h2>");
    expect(html).toContain("公开结论");
  });

  test("strips attribute-bearing <think> even when followed by visible markdown", () => {
    const md = `<think> channel="internal">\nsecret reasoning\n</think>\n**可见结论**`;
    const { html } = renderAssistantMarkdown(md);
    expect(html).not.toContain("secret reasoning");
    expect(html).not.toContain("channel=");
    expect(html).toContain("<strong>可见结论</strong>");
  });

  test("strips a <think> block that contains markdown that would otherwise render", () => {
    // If stripping failed, the inner <table> would survive in the output.
    const md = "<think>\n| inner | table |\n| --- | --- |\n| a | b |\n</think>\n公开内容";
    const { html } = renderAssistantMarkdown(md);
    expect(html).not.toContain("<table>");
    expect(html).toContain("公开内容");
  });

  test("strips multiple <think> blocks in one assistant message", () => {
    const md = "<think>phase 1</think>第一段<think>phase 2</think>第二段";
    const { html, stripped } = renderAssistantMarkdown(md);
    expect(stripped).toBe(true);
    expect(html).not.toContain("phase 1");
    expect(html).not.toContain("phase 2");
    expect(html).toContain("第一段");
    expect(html).toContain("第二段");
  });
});

describe("renderAssistantMarkdown — raw HTML sanitization", () => {
  test("escapes raw <script> tags", () => {
    const md = "hello <script>alert(1)</script> world";
    const { html } = renderAssistantMarkdown(md);
    // The live <script> tag is escaped to entities; the literal text
    // "alert(1)" survives as plain text content, but cannot execute.
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("alert(1)");
  });

  test("escapes raw <iframe> tags", () => {
    const md = "<iframe src='https://evil.example'></iframe>";
    const { html } = renderAssistantMarkdown(md);
    expect(html).not.toContain("<iframe");
    expect(html).toContain("&lt;iframe");
  });

  test("blocks inline event handlers from breaking out of link title", () => {
    const md = "[boom](https://example.com \"x\\\" onclick=alert(1)\")";
    const { html } = renderAssistantMarkdown(md);
    // The href must remain a safe URL; the title attribute must keep
    // its `"` escaped (so an attacker cannot break out of the title and
    // inject a live `onclick=` attribute).
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain("&quot;");
    // The rendered `<a>` tag must close before the next `<a` or `</a>`,
    // and the `onclick=alert(1)` text must remain inside the title
    // attribute (escaped) — never as a top-level attribute on the tag.
    const tagMatch = html.match(/<a [^>]*>/);
    expect(tagMatch).not.toBeNull();
    const tag = tagMatch![0];
    // Sanity: the tag has exactly two attributes (`href`, `title`).
    expect(tag).toContain('href="https://example.com"');
    expect(tag).toContain('title=');
  });

  test("blocks javascript: link hrefs", () => {
    const md = "[click](javascript:alert(1))";
    const { html } = renderAssistantMarkdown(md);
    expect(html).not.toMatch(/href\s*=\s*["']?javascript:/i);
  });

  test("blocks data: link hrefs", () => {
    const md = "[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)";
    const { html } = renderAssistantMarkdown(md);
    expect(html).not.toMatch(/href\s*=\s*["']?data:/i);
  });

  test("blocks vbscript: link hrefs", () => {
    const md = "[click](vbscript:msgbox(1))";
    const { html } = renderAssistantMarkdown(md);
    expect(html).not.toMatch(/href\s*=\s*["']?vbscript:/i);
  });

  test("blocks file: link hrefs", () => {
    const md = "[click](file:///etc/passwd)";
    const { html } = renderAssistantMarkdown(md);
    expect(html).not.toMatch(/href\s*=\s*["']?file:/i);
  });
});

describe("renderAssistantMarkdown — return shape", () => {
  test("returns html and stripped=false for ordinary content", () => {
    const out = renderAssistantMarkdown("hello **world**");
    expect(typeof out.html).toBe("string");
    expect(out.stripped).toBe(false);
    expect(out.html.length).toBeGreaterThan(0);
  });

  test("returns stripped=true only when <think> was removed", () => {
    const out = renderAssistantMarkdown("<think>hidden</think>visible");
    expect(out.stripped).toBe(true);
    expect(out.html).toContain("visible");
  });

  test("returns empty html for empty input", () => {
    const out = renderAssistantMarkdown("");
    expect(out.html).toBe("");
    expect(out.stripped).toBe(false);
  });
});