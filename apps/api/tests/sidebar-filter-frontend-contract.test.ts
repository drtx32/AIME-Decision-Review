/**
 * ELI-358 P0 regression — frontend filter-toggle wire contract.
 *
 * The sidebar has two filter chips: "进行中" (active) and "已归档" (archived).
 * Clicking each chip must send a strictly-scoped query to /api/sessions so
 * the two tabs can never render the same list. This test pins the URL
 * construction that the React wrapper delegates to, so a regression in the
 * wrapper can't reintroduce the duplicate-list bug at the wire layer.
 */

import { describe, expect, test } from "bun:test";
import { buildSessionsQueryString } from "../../../src/sessions-query.ts";

describe("Sidebar filter-toggle wire contract (frontend)", () => {
  test("active chip sends no `archived` parameter", () => {
    // The active view passes `archived: false` (or undefined). The wrapper
    // must NOT serialize `archived=0` — the server interprets an omitted
    // parameter as the active scope, and that contract is what the regression
    // depends on.
    expect(buildSessionsQueryString({ archived: false })).toBe("");
    expect(buildSessionsQueryString({})).toBe("");
    expect(buildSessionsQueryString()).toBe("");
  });

  test("archived chip sends `archived=1` and nothing else", () => {
    expect(buildSessionsQueryString({ archived: true })).toBe("?archived=1");
  });

  test("search term is encoded and combined with the current scope", () => {
    expect(buildSessionsQueryString({ archived: false, q: "300750 宁德" })).toBe("?q=300750+%E5%AE%81%E5%BE%B7");
    expect(buildSessionsQueryString({ archived: true, q: "300750 宁德" })).toBe("?q=300750+%E5%AE%81%E5%BE%B7&archived=1");
  });

  test("blank search term is dropped, scope still honored", () => {
    expect(buildSessionsQueryString({ archived: false, q: "   " })).toBe("");
    expect(buildSessionsQueryString({ archived: true, q: "" })).toBe("?archived=1");
  });

  test("the wrapper never leaks the active flag into the archived URL and vice versa", () => {
    // Mutually exclusive: there must be no path that produces both `archived`
    // AND something that could be misinterpreted as the active scope. The
    // server only knows `archived=1` vs omitted, so this regression check
    // simply ensures the two URLs differ whenever the user toggles scope.
    const active = buildSessionsQueryString({ archived: false });
    const archived = buildSessionsQueryString({ archived: true });
    expect(active).not.toBe(archived);
    expect(active.includes("archived")).toBe(false);
    expect(archived.includes("archived=1")).toBe(true);
  });
});
