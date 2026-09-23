/**
 * Attachment route handlers — ELI-337.
 *
 *   POST   /api/attachments              upload a new file
 *   GET    /api/attachments              list the caller's attachments
 *   GET    /api/attachments/:id          get one attachment
 *   GET    /api/attachments/:id/raw      get the raw bytes (image only,
 *                                         vision-capable path; composer-only)
 *   DELETE /api/attachments/:id          remove an attachment
 *
 * Every route requires an authenticated, non-mustChangePassword user.
 * Cross-user access is enforced inside the service / repository — a bare
 * id is never enough.
 */

import { Hono } from "hono";
import { AttachmentService } from "./service.ts";
import type { AuthEnv } from "../auth/middleware.ts";
import { getAuthContext } from "../auth/middleware.ts";

export function buildAttachmentRoutes(service: AttachmentService) {
  const app = new Hono<AuthEnv>();

  app.post("/", async (c) => {
    const ctx = getAuthContext(c);
    if (!ctx) return c.json({ error: "unauthenticated" }, 401);

    let body: Record<string, unknown> | null = null;
    try {
      body = (await c.req.parseBody()) as Record<string, unknown>;
    } catch (e) {
      return c.json(
        { error: "invalid_multipart", message: e instanceof Error ? e.message : String(e) },
        400
      );
    }
    if (!body) return c.json({ error: "invalid_multipart" }, 400);

    const file = body["file"];
    if (!(file instanceof File) && !(file instanceof Blob)) {
      return c.json({ error: "missing_file" }, 400);
    }
    // Convert to Uint8Array.
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const filename = (file instanceof File && file.name) || (body["filename"] as string) || "unnamed";
    // Prefer an explicit `mime` field if the client provided one — Bun's
    // multipart parser derives `file.type` from the filename extension, which
    // is exactly the thing we're trying to validate against. The explicit
    // field is the authoritative declared type.
    const mime =
      (body["mime"] as string | undefined) ||
      (file instanceof File && file.type) ||
      "application/octet-stream";

    const result = await service.upload({
      rawFilename: filename,
      mime,
      bytes,
      ownerUserId: ctx.user.id,
    });

    if (!result.ok) {
      const status =
        result.reason === "oversized" || result.reason === "quota_exceeded"
          ? 413
          : result.reason === "unsupported"
          ? 415
          : 400;
      return c.json(
        { error: result.reason, message: result.message },
        status
      );
    }
    return c.json({ attachment: result.metadata }, 201);
  });

  app.get("/", (c) => {
    const ctx = getAuthContext(c);
    if (!ctx) return c.json({ error: "unauthenticated" }, 401);
    const attachments = service.listOwned(ctx.user.id);
    return c.json({ attachments });
  });

  app.get("/:id", (c) => {
    const ctx = getAuthContext(c);
    if (!ctx) return c.json({ error: "unauthenticated" }, 401);
    const id = c.req.param("id");
    if (!id) return c.json({ error: "missing_id" }, 400);
    const metadata = service.readOwned(id, ctx.user.id);
    if (!metadata) return c.json({ error: "not_found" }, 404);
    return c.json({ attachment: metadata });
  });

  app.get("/:id/raw", (c) => {
    const ctx = getAuthContext(c);
    if (!ctx) return c.json({ error: "unauthenticated" }, 401);
    const id = c.req.param("id");
    if (!id) return c.json({ error: "missing_id" }, 400);
    const data = service.readOwnedBytes(id, ctx.user.id);
    if (!data) return c.json({ error: "not_found" }, 404);
    if (!data.mime.toLowerCase().startsWith("image/")) {
      // Image-only endpoint — non-images use the parsed text fragments.
      return c.json({ error: "raw_only_for_images" }, 400);
    }
    return new Response(data.bytes, {
      headers: {
        "content-type": data.mime,
        "content-disposition": `inline; filename="${data.filename.replace(/"/g, "_")}"`,
      },
    });
  });

  app.delete("/:id", (c) => {
    const ctx = getAuthContext(c);
    if (!ctx) return c.json({ error: "unauthenticated" }, 401);
    const id = c.req.param("id");
    if (!id) return c.json({ error: "missing_id" }, 400);
    const ok = service.deleteOwned(id, ctx.user.id);
    if (!ok) return c.json({ error: "not_found" }, 404);
    return c.body(null, 204);
  });

  return app;
}