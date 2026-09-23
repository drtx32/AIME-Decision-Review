/**
 * PDF text extraction — basic text only.
 *
 * No OCR. Image-only / scanned PDFs return an explicit "no_text" outcome.
 * Uses pdf-parse (small CommonJS library; safe inside Bun).
 */

import type { AttachmentFragment } from "../types.ts";
import type { AttachmentLimits } from "../limits.ts";

export interface PdfParseOk {
  status: "ok";
  fragments: AttachmentFragment[];
  truncated: boolean;
  parserWarnings: string[];
}

export interface PdfParseNoText {
  status: "no_text";
  fragments: [];
  parserWarnings: string[];
  /** True when the PDF looks structurally valid but contains no text streams. */
  reason: "no_text" | "image_only";
}

export interface PdfParseError {
  status: "error";
  parserWarnings: string[];
  reason: string;
}

export type PdfParseResult = PdfParseOk | PdfParseNoText | PdfParseError;

interface PdfParseFn {
  (data: Buffer, options?: Record<string, unknown>): Promise<{ text: string; numpages?: number; info?: unknown }>;
}

interface PdfParseModule {
  default?: PdfParseFn;
  PdfReader?: unknown;
}

// Lazy require: keeps module init cheap and lets us stub the entrypoint in
// deterministic test runs.
let cachedPdfParse: PdfParseFn | null = null;
async function loadPdfParse(): Promise<PdfParseFn> {
  if (cachedPdfParse) return cachedPdfParse;
  // pdf-parse exports a function as its module.exports. In Bun we receive
  // the module via require and the function lives on `.default` or on the
  // module itself depending on how it was imported.
  const mod = (await import("pdf-parse")) as unknown as PdfParseModule;
  const fn = mod.default ?? (mod as unknown as PdfParseFn);
  if (typeof fn !== "function") {
    throw new Error("pdf-parse did not export a callable function");
  }
  cachedPdfParse = fn;
  return fn;
}

/** Test hook — reset cached parser so tests can re-mock pdf-parse. */
export function _resetPdfParseForTest(): void {
  cachedPdfParse = null;
}

const PDF_MAGIC = Buffer.from("%PDF-", "ascii");

export function looksLikePdfMagic(bytes: Uint8Array): boolean {
  if (bytes.length < 5) return false;
  return (
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}

export async function parsePdf(
  bytes: Uint8Array,
  context: { filename: string; mime: string; uploadedAt: string; limits: AttachmentLimits }
): Promise<PdfParseResult> {
  const { filename, mime, uploadedAt, limits } = context;
  const retrievedAt = new Date().toISOString();

  if (!looksLikePdfMagic(bytes)) {
    return {
      status: "error",
      parserWarnings: ["PDF magic bytes missing; file does not look like a PDF."],
      reason: "not_pdf",
    };
  }

  let pdfParse: PdfParseFn;
  try {
    pdfParse = await loadPdfParse();
  } catch (e) {
    return {
      status: "error",
      parserWarnings: [`Failed to load pdf-parse: ${e instanceof Error ? e.message : String(e)}`],
      reason: "parser_unavailable",
    };
  }

  const buffer = Buffer.from(bytes);
  let parsed: { text: string; numpages?: number };
  try {
    parsed = await pdfParse(buffer, { max: limits.maxPdfPages });
  } catch (e) {
    return {
      status: "error",
      parserWarnings: [`pdf-parse threw: ${e instanceof Error ? e.message : String(e)}`],
      reason: "parser_failure",
    };
  }

  const rawText = parsed.text ?? "";
  // Collapse runs of whitespace but preserve paragraph / page breaks.
  const normalised = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const pages = splitByFormFeed(normalised);

  // Drop empties but keep "no text" decision.
  const nonEmpty = pages.filter((p) => p.trim().length > 0);
  if (nonEmpty.length === 0) {
    return {
      status: "no_text",
      fragments: [],
      parserWarnings: ["PDF contains no extractable text (image-only or empty)."],
      reason: "no_text",
    };
  }

  const fragments: AttachmentFragment[] = [];
  let totalChars = 0;
  let truncated = false;
  const cap = limits.maxFragmentChars;
  for (let i = 0; i < nonEmpty.length; i++) {
    let text = nonEmpty[i]!;
    let extractionStatus: AttachmentFragment["extractionStatus"] = "success";
    if (text.length > cap) {
      text = text.slice(0, cap);
      truncated = true;
      extractionStatus = "truncated";
    }
    if (totalChars + text.length > limits.maxParsedTextBytesPerAttachment) {
      truncated = true;
      break;
    }
    totalChars += text.length;
    fragments.push({
      kind: "text",
      text,
      page: i + 1,
      locator: `p:${i + 1}`,
      filename,
      mime,
      extractionStatus,
      uploadedAt,
      retrievedAt,
      source: "user_upload",
      relationToDecision: "user_provided_context",
    });
  }

  return { status: "ok", fragments, truncated, parserWarnings: [] };
}

function splitByFormFeed(text: string): string[] {
  // pdf-parse uses \f between pages.
  if (text.includes("\f")) {
    return text.split("\f");
  }
  // Fall back to splitting by form-feed replacement characters used by some
  // libraries, or treat the whole text as a single page.
  if (text.includes("")) {
    return text.split("");
  }
  return [text];
}

void PDF_MAGIC; // exported for tests via looksLikePdfMagic above