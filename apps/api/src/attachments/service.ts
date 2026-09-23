/**
 * AttachmentService — orchestrates validation + parsing + storage.
 *
 * The service is the only entry point callers (routes, tests) should use.
 * It owns:
 *
 *   - allowlist / MIME / extension checks
 *   - size + per-user quota enforcement
 *   - sha256 hashing
 *   - parser dispatch
 *   - repository persistence (with the user as the row owner)
 *   - capability-state snapshot for the configured provider
 */

import { createHash } from "node:crypto";
import {
  ALLOWED_KINDS,
  DEFAULT_ATTACHMENT_LIMITS,
  allowlistForExtension,
  allowlistForMime,
  extensionOf,
  isExtensionRejected,
  sanitiseFilename,
  type AttachmentLimits,
} from "./limits.ts";
import {
  attachmentRowToMetadata,
  AttachmentRepository,
  type AttachmentRow,
} from "./repository.ts";
import { parseAttachment, type ParseOutcome } from "./parsers/index.ts";
import type { ModelProvider } from "../providers/index.ts";
import type {
  AttachmentMetadata,
  ProviderVisionCapability,
} from "./types.ts";

export interface AttachmentDeps {
  repo: AttachmentRepository;
  provider: ModelProvider;
  limits?: AttachmentLimits;
  now?: () => Date;
}

export interface UploadInput {
  /** Raw filename from the client. Sanitised before storage. */
  rawFilename: string;
  /** Declared MIME type from the client. Re-validated against magic bytes. */
  mime: string;
  bytes: Uint8Array;
  ownerUserId: string;
}

export interface UploadOutcome {
  metadata: AttachmentMetadata;
}

export class AttachmentService {
  private repo: AttachmentRepository;
  private provider: ModelProvider;
  private limits: AttachmentLimits;
  private now: () => Date;

  constructor(deps: AttachmentDeps) {
    this.repo = deps.repo;
    this.provider = deps.provider;
    this.limits = deps.limits ?? DEFAULT_ATTACHMENT_LIMITS;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Run the full validation + parse + store pipeline. Errors are surfaced
   * as typed reasons so the route layer can return an appropriate status.
   */
  async upload(input: UploadInput): Promise<
    | { ok: true; metadata: AttachmentMetadata }
    | {
        ok: false;
        reason: "unsupported" | "oversized" | "rejected" | "quota_exceeded";
        message: string;
      }
  > {
    const sanitisedName = sanitiseFilename(input.rawFilename);
    const ext = extensionOf(sanitisedName);

    if (!ext) {
      return {
        ok: false,
        reason: "unsupported",
        message: "File has no extension; refusing to guess category.",
      };
    }
    if (isExtensionRejected(ext)) {
      return {
        ok: false,
        reason: "rejected",
        message: `Extension .${ext} is on the rejection list (legacy / macro-enabled / executable).`,
      };
    }

    const fromExt = allowlistForExtension(ext);
    const fromMime = allowlistForMime(input.mime);
    if (!fromExt && !fromMime) {
      return {
        ok: false,
        reason: "unsupported",
        message: `MIME ${input.mime} and extension .${ext} are not on the allowlist.`,
      };
    }
    if (fromExt && fromMime && fromExt.category !== fromMime.category) {
      return {
        ok: false,
        reason: "rejected",
        message: `MIME ${input.mime} does not match extension .${ext}.`,
      };
    }

    const kind = fromExt ?? fromMime!;

    if (input.bytes.byteLength === 0) {
      return {
        ok: false,
        reason: "rejected",
        message: "Empty file.",
      };
    }
    if (input.bytes.byteLength > this.limits.maxFileBytes) {
      return {
        ok: false,
        reason: "oversized",
        message: `File size ${input.bytes.byteLength} exceeds limit ${this.limits.maxFileBytes}.`,
      };
    }

    const owned = this.repo.countOwnedBy(input.ownerUserId);
    if (owned >= this.limits.maxFilesPerUser) {
      return {
        ok: false,
        reason: "quota_exceeded",
        message: `User has ${owned} attachments; max ${this.limits.maxFilesPerUser}.`,
      };
    }

    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const uploadedAt = this.now().toISOString();

    const parseOutcome = await parseAttachment(kind, input.bytes, {
      filename: sanitisedName,
      mime: input.mime,
      uploadedAt,
      limits: this.limits,
    });

    const { status, metadata } = await this.persist({
      parseOutcome,
      ownerUserId: input.ownerUserId,
      filename: sanitisedName,
      mime: input.mime,
      sizeBytes: input.bytes.byteLength,
      sha256,
      rawBytes: input.bytes,
      category: kind.category,
    });

    return { ok: true, metadata };
  }

  /** Read an attachment metadata by id and owner; null if missing / other-user. */
  readOwned(id: string, ownerUserId: string): AttachmentMetadata | null {
    const row = this.repo.findOwned(id, ownerUserId);
    return row ? attachmentRowToMetadata(row) : null;
  }

  /** List metadata for the caller's attachments, newest first. */
  listOwned(ownerUserId: string): AttachmentMetadata[] {
    return this.repo.listOwned(ownerUserId).map(attachmentRowToMetadata);
  }

  /** Delete an attachment owned by the caller. */
  deleteOwned(id: string, ownerUserId: string): boolean {
    return this.repo.deleteOwned(id, ownerUserId);
  }

  /** Read the raw upload bytes for the caller. Used by vision-capable composers. */
  readOwnedBytes(id: string, ownerUserId: string): {
    bytes: Uint8Array;
    mime: string;
    filename: string;
  } | null {
    const row = this.repo.findOwned(id, ownerUserId);
    if (!row) return null;
    const bytes = this.repo.openOwnedBytes(id, ownerUserId);
    if (!bytes) return null;
    return { bytes, mime: row.mime, filename: row.filename };
  }

  private async persist(args: {
    parseOutcome: ParseOutcome;
    ownerUserId: string;
    filename: string;
    mime: string;
    sizeBytes: number;
    sha256: string;
    rawBytes: Uint8Array;
    category: AttachmentMetadata["category"];
  }): Promise<{ status: AttachmentMetadata["status"]; metadata: AttachmentMetadata }> {
    const { parseOutcome } = args;
    const visionCapability = readVisionCapability(this.provider, args.mime);

    const status: AttachmentMetadata["status"] = (() => {
      switch (parseOutcome.status) {
        case "ready":
          return "ready";
        case "no_text":
          return "no_text";
        case "failed":
          return "failed";
        case "unsupported":
          return "unsupported";
      }
    })();

    const row: AttachmentRow = this.repo.create({
      ownerUserId: args.ownerUserId,
      filename: args.filename,
      mime: args.mime,
      sizeBytes: args.sizeBytes,
      category: args.category,
      status,
      fragments: parseOutcome.fragments,
      parsedTextBytes: parseOutcome.parsedTextBytes,
      parsedTruncated: parseOutcome.truncated,
      parserWarnings: parseOutcome.parserWarnings,
      sha256: args.sha256,
      providerVisionCapability: visionCapability,
      rawBytes: args.rawBytes,
    });
    return { status, metadata: attachmentRowToMetadata(row) };
  }
}

/**
 * Read the provider's vision capability snapshot. The snapshot is recorded
 * on every upload so the composer can later decide without re-querying.
 */
export function readVisionCapability(
  provider: ModelProvider,
  mime: string
): ProviderVisionCapability {
  if (!mime.toLowerCase().startsWith("image/")) return "unknown";
  if (provider.id === "mock") return "unavailable";
  const cap = provider.capabilities?.images;
  if (cap === true) return "available";
  if (cap === false) return "unavailable";
  return "unknown";
}

// Re-export so route handlers can `import { AttachmentService } from "./service.ts"`.
export { ALLOWED_KINDS };
