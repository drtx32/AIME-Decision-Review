// ELI-358 — pure helper that builds the sidebar list query string. Extracted
// so the frontend/bun regression can assert the wire contract without pulling
// in the Vite `import.meta.env` reference inside `src/api.ts`.

export type SessionsQuery = { q?: string; archived?: boolean };

/**
 * Build the query-string suffix for `/api/sessions`. The contract is:
 *   - no opts / both falsy → empty string (active scope, server defaults apply)
 *   - `archived: true` → `?archived=1` (strict archived scope)
 *   - `q: 'phrase'`     → `?q=<encoded>` (server still scopes to current tab)
 *
 * The frontend never sends `archived=0`. The server interprets an omitted
 * `archived` parameter as "active only" and `archived=1` as "archived only".
 */
export function buildSessionsQueryString(query?: SessionsQuery): string {
  if (!query) return "";
  const params = new URLSearchParams();
  if (query.q && query.q.trim()) params.set("q", query.q.trim());
  if (query.archived) params.set("archived", "1");
  const suffix = params.toString();
  return suffix ? `?${suffix}` : "";
}
