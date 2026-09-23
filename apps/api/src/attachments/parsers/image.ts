/**
 * Image attachment — pass-through with provenance only.
 *
 * Per ELI-337: images are stored/forwarded as image attachments. No local
 * OCR. Actual vision handling is delegated to the configured LLM *only if*
 * its image capability has been verified. The composer (ELI-336) is
 * responsible for deciding whether to invoke the multimodal LLM call; this
 * module only records the necessary metadata.
 */

import type { ImageAttachmentFragment } from "../types.ts";

export interface ImageProcessOk {
  status: "ok";
  fragments: [ImageAttachmentFragment];
}

export interface ImageProcessError {
  status: "error";
  parserWarnings: string[];
  reason: string;
}

export type ImageProcessResult = ImageProcessOk | ImageProcessError;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const RIFF_MAGIC = [0x52, 0x49, 0x46, 0x46]; // 'RIFF'
const WEBP_MAGIC = [0x57, 0x45, 0x42, 0x50]; // 'WEBP' at offset 8

export function looksLikeImage(bytes: Uint8Array, mime: string): boolean {
  const lower = mime.toLowerCase();
  if (lower === "image/png") return matchesAt(bytes, 0, PNG_MAGIC);
  if (lower === "image/jpeg") return matchesAt(bytes, 0, JPEG_MAGIC);
  if (lower === "image/webp") {
    return matchesAt(bytes, 0, RIFF_MAGIC) && matchesAt(bytes, 8, WEBP_MAGIC);
  }
  return false;
}

function matchesAt(bytes: Uint8Array, offset: number, magic: number[]): boolean {
  if (bytes.length < offset + magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[offset + i] !== magic[i]) return false;
  }
  return true;
}

export function sha256Hex(bytes: Uint8Array): string {
  // Bun ships crypto.subtle on the global scope; Hash object is sync.
  // We use Bun.password.hash for argon2id elsewhere, but for SHA-256 the
  // Bun native digest is the simplest.
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

export function buildImageFragment(
  bytes: Uint8Array,
  context: { filename: string; mime: string; uploadedAt: string }
): ImageAttachmentFragment {
  const retrievedAt = new Date().toISOString();
  return {
    kind: "image",
    mime: context.mime,
    sha256: sha256Hex(bytes),
    byteLength: bytes.byteLength,
    locator: "image",
    filename: context.filename,
    uploadedAt: context.uploadedAt,
    retrievedAt,
    source: "user_upload",
    relationToDecision: "user_provided_context",
  };
}

export function processImage(
  bytes: Uint8Array,
  context: { filename: string; mime: string; uploadedAt: string }
): ImageProcessResult {
  if (!looksLikeImage(bytes, context.mime)) {
    return {
      status: "error",
      parserWarnings: [`Image magic bytes do not match declared MIME ${context.mime}.`],
      reason: "mime_mismatch",
    };
  }
  return { status: "ok", fragments: [buildImageFragment(bytes, context)] };
}