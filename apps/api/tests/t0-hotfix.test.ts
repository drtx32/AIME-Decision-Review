/**
 * ELI-362 P0 regression — T0 datetime picker sync + confirm preflight.
 *
 * Background:
 *
 * The decision-confirm card renders `<input type="datetime-local">` whose
 * `value` is `decision.executedAt.slice(0, 16)`. The browser interprets a
 * `YYYY-MM-DDTHH:mm` string as local wall-clock time, so for the visible
 * field and the picker selection to agree with the storage round-trip we
 * need:
 *
 *   1. Storage to keep the local wall-clock — naive ISO
 *      (`YYYY-MM-DDTHH:mm:ss`, no Z, no offset) so the slice yields the
 *      same value the user picked.
 *   2. Server validation to no longer block a confirm just because the
 *      extraction left a `needsConfirmation` prompt in place — the user
 *      can clear it via the picker or the explicit "确认时间" button.
 *
 * These tests pin both behaviours at the wire + repo level so future
 * refactors of `DecisionConfirm` cannot reintroduce either bug.
 *
 * The frontend runtime fix (App.tsx) lives in the same PR; we don't need
 * a DOM test here because the storage format is decided by the React
 * component, and these tests assert the backend contract the component
 * relies on (string executedAt survives round-trip; needsConfirmation
 * can be cleared; confirm preflight only blocks when the row is
 * genuinely under-specified).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loginAndCookie, makeTestServer, type TestServer } from "./helpers.ts";
import type { ModelProvider } from "../src/providers/index.ts";

// Two decisions matching the screenshot reproduction. The first arrives
// extracted with timePrecision="exact" and an empty needsConfirmation;
// the second arrives extracted with needsConfirmation prompts that the
// LLM flagged but the user can clear via the UI.
const liveExtraction = {
  decisions: [
    { symbol: "万科A", name: "万科A", action: "buy", market: "CN", executedAt: "2026-09-22T13:37:00+08:00", executedAtText: "昨天下午1:37", timePrecision: "exact", price: 13.7, quantityShares: 2000, quantityText: "20手", rationale: "", notes: "", confidence: .98, needsConfirmation: [] },
    { symbol: "一鸣食品", name: "一鸣食品", action: "sell", market: "CN", executedAt: "2026-09-23T09:30:00+08:00", executedAtText: "今天早上，跌破当日均价线后", timePrecision: "approximate", price: null, quantityShares: 800, quantityText: "8手", rationale: "跌破当日均价线", notes: "确切时间与价格待核对", confidence: .76, needsConfirmation: ["确认今天上午的成交时间", "精确到分钟"] },
  ],
};

describe("ELI-362 T0 hotfix — picker sync + confirm preflight", () => {
  let ctx: TestServer;
  beforeEach(() => { ctx = makeTestServer(); });
  afterEach(() => ctx.cleanup());

  // ---------------------------------------------------------------------------
  // Storage contract: executedAt round-trip preserves local wall-clock.
  // ---------------------------------------------------------------------------

  test("PATCH with naive local ISO executedAt is stored verbatim (no UTC shift)", async () => {
    const cookie = await loginAndCookie(ctx.app, ctx.userRepo, "picker", "picker-pass");
    ctx.deps.provider = { id: "test", modelName: "test", configured: true, complete: async () => ({ text: JSON.stringify({ decisions: [{ ...liveExtraction.decisions[0], executedAt: "2026-09-22T13:37:00+08:00", needsConfirmation: [] }] }) }) } satisfies ModelProvider;
    const created = await ctx.app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ message: "昨天下午1:37买万科A", clientNow: "2026-09-22T22:00:00+08:00", timezone: "Asia/Shanghai" }) });
    expect(created.status).toBe(201);
    const body = await created.json() as { sessionId: string; decisions: Array<{ id: string; executedAt: string | null }> };
    const decisionId = body.decisions[0].id;
    // Simulate the picker emitting a `YYYY-MM-DDTHH:mm` value wrapped as
    // naive local ISO; the backend must NOT shift it to UTC.
    const userPicked = "2026-09-22T13:37:00";
    const patched = await ctx.app.request(`/api/sessions/${body.sessionId}/decisions/${decisionId}`, {
      method: "PATCH", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ executedAt: userPicked, timePrecision: "exact", needsConfirmation: [] }),
    });
    expect(patched.status).toBe(200);
    const restored = await ctx.app.request(`/api/sessions/${body.sessionId}`, { headers: { cookie } });
    const restoredBody = await restored.json() as { decisions: Array<{ executedAt: string | null }> };
    // The exact same string survives round-trip — the picker will therefore
    // show "2026-09-22T13:37" again, agreeing with the text field.
    expect(restoredBody.decisions[0].executedAt).toBe(userPicked);
    expect(restoredBody.decisions[0].executedAt?.slice(0, 16)).toBe("2026-09-22T13:37");
  });

  test("PATCH with timezone offset executedAt ALSO round-trips unchanged", async () => {
    const cookie = await loginAndCookie(ctx.app, ctx.userRepo, "offset", "offset-pass");
    ctx.deps.provider = { id: "test", modelName: "test", configured: true, complete: async () => ({ text: JSON.stringify({ decisions: [{ ...liveExtraction.decisions[0], executedAt: "2026-09-22T13:37:00+08:00" }] }) }) } satisfies ModelProvider;
    const created = await ctx.app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ message: "买万科A", clientNow: "2026-09-22T22:00:00+08:00", timezone: "Asia/Shanghai" }) });
    const body = await created.json() as { sessionId: string; decisions: Array<{ id: string; executedAt: string | null }> };
    const patched = await ctx.app.request(`/api/sessions/${body.sessionId}/decisions/${body.decisions[0].id}`, {
      method: "PATCH", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ executedAt: "2026-09-23T10:00:00+08:00", timePrecision: "exact" }),
    });
    expect(patched.status).toBe(200);
    const restored = await ctx.app.request(`/api/sessions/${body.sessionId}`, { headers: { cookie } });
    const restoredBody = await restored.json() as { decisions: Array<{ executedAt: string | null }> };
    expect(restoredBody.decisions[0].executedAt).toBe("2026-09-23T10:00:00+08:00");
  });

  // ---------------------------------------------------------------------------
  // Confirm preflight: a row that the user has settled (cleared
  // needsConfirmation) must NOT block /confirm, even if extraction
  // originally flagged a follow-up question.
  // ---------------------------------------------------------------------------

  test("two filled decisions — clearing needsConfirmation unblocks /confirm", async () => {
    const cookie = await loginAndCookie(ctx.app, ctx.userRepo, "t0-fix", "t0-fix-pass");
    ctx.deps.provider = { id: "test", modelName: "test", configured: true, complete: async () => ({ text: JSON.stringify(liveExtraction) }) } satisfies ModelProvider;
    const created = await ctx.app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ message: "万科A 昨天13:37买20手; 一鸣食品 今天上午出8手", clientNow: "2026-09-23T10:00:00+08:00", timezone: "Asia/Shanghai" }) });
    expect(created.status).toBe(201);
    const body = await created.json() as { sessionId: string; decisions: Array<{ id: string; executedAt: string | null; needsConfirmation: string[] }> };
    expect(body.decisions).toHaveLength(2);
    // First decision has no needsConfirmation, but the second is extracted
    // with two follow-up prompts — confirm must block without an explicit
    // PATCH that clears them.
    const blocked = await ctx.app.request(`/api/sessions/${body.sessionId}/confirm`, { method: "POST", headers: { cookie } });
    expect(blocked.status).toBe(422);
    const blockedBody = await blocked.json() as { decisionIds: string[]; message: string };
    expect(blockedBody.decisionIds).toEqual([body.decisions[1].id]);
    expect(blockedBody.message).toMatch(/成交时间/);
    // User picks the time in the picker (or clicks 确认时间). Server treats
    // clearing needsConfirmation + setting executedAt+timePrecision=exact
    // as a single confirmation gesture.
    const cleared = await ctx.app.request(`/api/sessions/${body.sessionId}/decisions/${body.decisions[1].id}`, {
      method: "PATCH", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ executedAt: "2026-09-23T09:30:00", timePrecision: "exact", needsConfirmation: [] }),
    });
    expect(cleared.status).toBe(200);
    const confirmed = await ctx.app.request(`/api/sessions/${body.sessionId}/confirm`, { method: "POST", headers: { cookie } });
    expect(confirmed.status).toBe(202);
  });

  test("exact-time extracted decisions confirm without any user PATCH", async () => {
    // The first decision in the live extraction already arrives as
    // timePrecision=exact and needsConfirmation=[]. An isolated session
    // must therefore confirm with zero PATCHes.
    const cookie = await loginAndCookie(ctx.app, ctx.userRepo, "ready", "ready-pass");
    ctx.deps.provider = { id: "test", modelName: "test", configured: true, complete: async () => ({ text: JSON.stringify({ decisions: [liveExtraction.decisions[0]] }) }) } satisfies ModelProvider;
    const created = await ctx.app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ message: "买万科A", clientNow: "2026-09-22T22:00:00+08:00", timezone: "Asia/Shanghai" }) });
    const body = await created.json() as { sessionId: string };
    const confirmed = await ctx.app.request(`/api/sessions/${body.sessionId}/confirm`, { method: "POST", headers: { cookie } });
    expect(confirmed.status).toBe(202);
  });

  // ---------------------------------------------------------------------------
  // Approximate-time confirmation path: the user can keep an extracted
  // approximate T0 by clearing needsConfirmation while keeping
  // timePrecision='approximate'.
  // ---------------------------------------------------------------------------

  test("approximate confirmation path still blocks /confirm if needsConfirmation is untouched", async () => {
    const cookie = await loginAndCookie(ctx.app, ctx.userRepo, "approx", "approx-pass");
    ctx.deps.provider = { id: "test", modelName: "test", configured: true, complete: async () => ({ text: JSON.stringify({ decisions: [{ ...liveExtraction.decisions[1], needsConfirmation: ["still pending"] }] }) }) } satisfies ModelProvider;
    const created = await ctx.app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ message: "今天上午卖出", clientNow: "2026-09-23T10:00:00+08:00", timezone: "Asia/Shanghai" }) });
    const body = await created.json() as { sessionId: string; decisions: Array<{ id: string }> };
    const blocked = await ctx.app.request(`/api/sessions/${body.sessionId}/confirm`, { method: "POST", headers: { cookie } });
    expect(blocked.status).toBe(422);
    // User clicks 保留为近似 (PATCH with timePrecision=approximate,
    // needsConfirmation=[]) — the same wall-clock string is kept, no UTC
    // re-shift happens because we used a naive ISO already.
    const kept = await ctx.app.request(`/api/sessions/${body.sessionId}/decisions/${body.decisions[0].id}`, {
      method: "PATCH", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ executedAt: "2026-09-23T09:30:00", timePrecision: "approximate", needsConfirmation: [] }),
    });
    expect(kept.status).toBe(200);
    const confirmed = await ctx.app.request(`/api/sessions/${body.sessionId}/confirm`, { method: "POST", headers: { cookie } });
    expect(confirmed.status).toBe(202);
  });

  // ---------------------------------------------------------------------------
  // Confirm preflight identifies only the truly under-specified row.
  // ---------------------------------------------------------------------------

  test("a session with one settled and one under-specified row reports only the failing row", async () => {
    const cookie = await loginAndCookie(ctx.app, ctx.userRepo, "half", "half-pass");
    ctx.deps.provider = { id: "test", modelName: "test", configured: true, complete: async () => ({ text: JSON.stringify({
      decisions: [
        { ...liveExtraction.decisions[0], needsConfirmation: [], timePrecision: "exact" },
        { ...liveExtraction.decisions[1], executedAt: null, timePrecision: "unknown", needsConfirmation: ["确认今天上午的成交时间"] },
      ],
    }) }) } satisfies ModelProvider;
    const created = await ctx.app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ message: "两笔", clientNow: "2026-09-23T10:00:00+08:00", timezone: "Asia/Shanghai" }) });
    const body = await created.json() as { sessionId: string; decisions: Array<{ id: string; needsConfirmation: string[] }> };
    const blocked = await ctx.app.request(`/api/sessions/${body.sessionId}/confirm`, { method: "POST", headers: { cookie } });
    expect(blocked.status).toBe(422);
    const blockedBody = await blocked.json() as { decisionIds: string[] };
    // The first row is fully settled; the second is missing executedAt.
    // Only the failing row must appear in `decisionIds`.
    expect(blockedBody.decisionIds).toEqual([body.decisions[1].id]);
  });
});
