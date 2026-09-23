/**
 * CSV parser — safe RFC 4180-style tabular extraction.
 *
 * Conservative: quote-aware, line-aware, character-aware. We refuse to
 * evaluate formula prefixes (no `=` execution) and we don't follow up on
 * embedded URIs. The output is one fragment per file (single sheet) with a
 * cell-range derived from the parsed rectangle.
 */

import type { AttachmentFragment } from "../types.ts";
import type { AttachmentLimits } from "../limits.ts";

export interface CsvParseOk {
  status: "ok";
  fragments: AttachmentFragment[];
  truncated: boolean;
  parserWarnings: string[];
}

export interface CsvParseError {
  status: "error";
  parserWarnings: string[];
  reason: string;
}

export type CsvParseResult = CsvParseOk | CsvParseError;

const FORMULA_PREFIX = /^[=+\-@]/;

export function parseCsv(
  text: string,
  context: { filename: string; mime: string; uploadedAt: string; limits: AttachmentLimits }
): CsvParseResult {
  const { filename, mime, uploadedAt, limits } = context;
  const retrievedAt = new Date().toISOString();
  const warnings: string[] = [];

  const lines = splitCsvLines(text);
  const rows: string[][] = [];
  let maxCols = 0;

  for (let i = 0; i < lines.length; i++) {
    if (rows.length >= limits.maxRowsPerSheet) {
      warnings.push(`CSV contains more than ${limits.maxRowsPerSheet} rows; remaining rows skipped.`);
      break;
    }
    const fields = parseCsvLine(lines[i]!);
    if (fields.length > limits.maxColsPerRow) {
      fields.length = limits.maxColsPerRow;
    }
    rows.push(fields.map((f) => (FORMULA_PREFIX.test(f) ? `'${f}` : f)));
    if (fields.length > maxCols) maxCols = fields.length;
  }

  if (rows.length === 0 || maxCols === 0) {
    return {
      status: "ok",
      fragments: [],
      truncated: false,
      parserWarnings: [...warnings, "CSV contained no rows."],
    };
  }

  const text_out = rows
    .map((row) =>
      row
        .map((cell) => escapeTsvCell(cell))
        .join("\t")
    )
    .join("\n");

  const capped = capFragment(text_out, limits, (v) => {
    warnings.push("CSV text exceeded per-fragment cap; truncated.");
    void v;
  });
  const fragment: AttachmentFragment = {
    kind: "text",
    text: capped.text,
    sheet: "csv",
    rowRange: { from: 1, to: rows.length },
    cellRange: { from: `A1`, to: `${columnLabel(maxCols - 1)}${rows.length}` },
    locator: `csv:A1:${columnLabel(maxCols - 1)}${rows.length}`,
    filename,
    mime,
    extractionStatus: capped.extractionStatus,
    uploadedAt,
    retrievedAt,
    source: "user_upload",
    relationToDecision: "user_provided_context",
  };

  return {
    status: "ok",
    fragments: [fragment],
    truncated: capped.extractionStatus === "truncated",
    parserWarnings: warnings,
  };
}

/**
 * Split into logical CSV lines while honouring quoted newlines. Returns an
 * empty trailing line is dropped so we don't emit phantom rows.
 */
export function splitCsvLines(text: string): string[] {
  const lines: string[] = [];
  let buf = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') {
        buf += '"';
        if (inQuotes && text[i + 1] === '"') {
          buf += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }
    if ((ch === "\n" || ch === "\r") && !inQuotes) {
      lines.push(buf);
      buf = "";
      if (ch === "\r" && text[i + 1] === "\n") i++;
      continue;
    }
    buf += ch;
  }
  if (buf.length > 0) lines.push(buf);
  // Drop purely whitespace-only trailing lines so a final newline doesn't
  // count as a phantom row.
  while (lines.length > 0 && lines[lines.length - 1]!.trim().length === 0) {
    lines.pop();
  }
  return lines;
}

export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        buf += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out;
}

function columnLabel(idx: number): string {
  let n = idx + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function escapeTsvCell(value: string): string {
  return value
    .replace(/[\t\r\n]+/g, " ")
    .replace(/  +/g, " ")
    .trim();
}

function capFragment(
  text: string,
  limits: AttachmentLimits,
  setTruncated: (v: boolean) => void
): { text: string; extractionStatus: AttachmentFragment["extractionStatus"] } {
  if (text.length <= limits.maxFragmentChars) {
    return { text, extractionStatus: "success" };
  }
  setTruncated(true);
  return { text: text.slice(0, limits.maxFragmentChars), extractionStatus: "truncated" };
}