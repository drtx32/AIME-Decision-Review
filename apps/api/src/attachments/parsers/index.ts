/**
 * Parser dispatcher — selects a parser based on the allowlist entry.
 */

import { parsePdf } from "./pdf.ts";
import type { AttachmentFragment, ImageAttachmentFragment } from "../types.ts";
import type { AttachmentLimits, AllowedKind } from "../limits.ts";
import { parseDocx } from "./docx.ts";
import { parseXlsx } from "./xlsx.ts";
import { parseCsv } from "./csv.ts";
import { processImage } from "./image.ts";

export interface ParseSuccess {
  status: "ready" | "no_text";
  fragments: Array<AttachmentFragment | ImageAttachmentFragment>;
  truncated: boolean;
  parserWarnings: string[];
  parsedTextBytes: number;
}

export interface ParseFailure {
  status: "failed" | "unsupported";
  fragments: [];
  truncated: boolean;
  parserWarnings: string[];
  parsedTextBytes: 0;
  reason: string;
}

export type ParseOutcome = ParseSuccess | ParseFailure;

export async function parseAttachment(
  kind: AllowedKind,
  bytes: Uint8Array,
  context: { filename: string; mime: string; uploadedAt: string; limits: AttachmentLimits }
): Promise<ParseOutcome> {
  switch (kind.category) {
    case "image": {
      const r = processImage(bytes, context);
      if (r.status === "error") {
        return {
          status: "failed",
          fragments: [],
          truncated: false,
          parserWarnings: r.parserWarnings,
          parsedTextBytes: 0,
          reason: r.reason,
        };
      }
      return {
        status: "ready",
        fragments: r.fragments,
        truncated: false,
        parserWarnings: [],
        parsedTextBytes: 0,
      };
    }
    case "pdf": {
      const r = await parsePdf(bytes, context);
      if (r.status === "error") {
        return {
          status: "failed",
          fragments: [],
          truncated: false,
          parserWarnings: r.parserWarnings,
          parsedTextBytes: 0,
          reason: r.reason,
        };
      }
      if (r.status === "no_text") {
        return {
          status: "no_text",
          fragments: [],
          truncated: false,
          parserWarnings: r.parserWarnings,
          parsedTextBytes: 0,
        };
      }
      return {
        status: "ready",
        fragments: r.fragments,
        truncated: r.truncated,
        parserWarnings: r.parserWarnings,
        parsedTextBytes: sumTextBytes(r.fragments),
      };
    }
    case "docx": {
      const r = parseDocx(bytes, context);
      if (r.status === "error") {
        return {
          status: "failed",
          fragments: [],
          truncated: false,
          parserWarnings: r.parserWarnings,
          parsedTextBytes: 0,
          reason: r.reason,
        };
      }
      const hasText = r.fragments.length > 0;
      return {
        status: hasText ? "ready" : "no_text",
        fragments: r.fragments,
        truncated: r.truncated,
        parserWarnings: r.parserWarnings,
        parsedTextBytes: sumTextBytes(r.fragments),
      };
    }
    case "xlsx": {
      const r = parseXlsx(bytes, context);
      if (r.status === "error") {
        return {
          status: "failed",
          fragments: [],
          truncated: false,
          parserWarnings: r.parserWarnings,
          parsedTextBytes: 0,
          reason: r.reason,
        };
      }
      const hasText = r.fragments.length > 0;
      return {
        status: hasText ? "ready" : "no_text",
        fragments: r.fragments,
        truncated: r.truncated,
        parserWarnings: r.parserWarnings,
        parsedTextBytes: sumTextBytes(r.fragments),
      };
    }
    case "csv": {
      const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      const r = parseCsv(decoded, context);
      if (r.status === "error") {
        return {
          status: "failed",
          fragments: [],
          truncated: false,
          parserWarnings: r.parserWarnings,
          parsedTextBytes: 0,
          reason: r.reason,
        };
      }
      const hasText = r.fragments.length > 0;
      return {
        status: hasText ? "ready" : "no_text",
        fragments: r.fragments,
        truncated: r.truncated,
        parserWarnings: r.parserWarnings,
        parsedTextBytes: sumTextBytes(r.fragments),
      };
    }
  }
}

function sumTextBytes(fragments: Array<AttachmentFragment | ImageAttachmentFragment>): number {
  let total = 0;
  for (const f of fragments) {
    if (f.kind === "text") total += f.text.length;
  }
  return total;
}