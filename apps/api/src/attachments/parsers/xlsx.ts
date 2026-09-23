/**
 * XLSX spreadsheet extraction — sheet names + bounded cell ranges.
 *
 * XLSX is a ZIP archive of XML files:
 *   - xl/workbook.xml          — workbook structure (sheet list)
 *   - xl/_rels/workbook.xml.rels — relationship IDs → sheet files
 *   - xl/sharedStrings.xml    — global string table
 *   - xl/worksheets/sheetN.xml — per-sheet cell data
 *
 * We deliberately do NOT execute formulas / macros / external links.
 */

import AdmZip from "adm-zip";
import type { AttachmentFragment } from "../types.ts";
import type { AttachmentLimits } from "../limits.ts";
import { looksLikeZip } from "./docx.ts";

export interface XlsxParseOk {
  status: "ok";
  fragments: AttachmentFragment[];
  truncated: boolean;
  parserWarnings: string[];
}

export interface XlsxParseError {
  status: "error";
  parserWarnings: string[];
  reason: string;
}

export type XlsxParseResult = XlsxParseOk | XlsxParseError;

export function parseXlsx(
  bytes: Uint8Array,
  context: { filename: string; mime: string; uploadedAt: string; limits: AttachmentLimits }
): XlsxParseResult {
  const { filename, mime, uploadedAt, limits } = context;
  const retrievedAt = new Date().toISOString();
  const warnings: string[] = [];

  if (!looksLikeZip(bytes)) {
    return {
      status: "error",
      parserWarnings: ["XLSX magic bytes missing; file does not look like a ZIP / OOXML container."],
      reason: "not_xlsx",
    };
  }

  let zip: AdmZip;
  try {
    zip = new AdmZip(Buffer.from(bytes));
  } catch (e) {
    return {
      status: "error",
      parserWarnings: [`adm-zip failed to open XLSX: ${e instanceof Error ? e.message : String(e)}`],
      reason: "zip_failure",
    };
  }

  const workbookEntry = zip.getEntry("xl/workbook.xml");
  const relsEntry = zip.getEntry("xl/_rels/workbook.xml.rels");
  const sharedStringsEntry = zip.getEntry("xl/sharedStrings.xml");
  if (!workbookEntry || !relsEntry) {
    return {
      status: "error",
      parserWarnings: ["XLSX workbook.xml or workbook.xml.rels missing."],
      reason: "missing_workbook_xml",
    };
  }

  // Parse workbook.xml for sheet definitions.
  const workbookXml = workbookEntry.getData().toString("utf8");
  const sheets = parseSheetList(workbookXml);

  // Parse _rels to map rId → sheet file path.
  const relsXml = relsEntry.getData().toString("utf8");
  const ridMap = parseRelsToMap(relsXml);

  // Refuse external links / DDE connections — those are an attack surface
  // even though we don't execute formulas.
  if (/externalLink/i.test(workbookXml) || /externalLink/i.test(relsXml)) {
    warnings.push("XLSX declares external links; external references are ignored, not fetched.");
  }

  // Parse sharedStrings.xml once.
  let sharedStrings: string[] = [];
  if (sharedStringsEntry) {
    sharedStrings = parseSharedStrings(sharedStringsEntry.getData().toString("utf8"));
  }

  const fragments: AttachmentFragment[] = [];
  let totalChars = 0;
  let truncated = false;
  let sheetsProcessed = 0;

  for (const sheet of sheets) {
    if (sheetsProcessed >= limits.maxSheetsPerWorkbook) {
      warnings.push(`Workbook contains more than ${limits.maxSheetsPerWorkbook} sheets; remaining sheets skipped.`);
      truncated = true;
      break;
    }
    const sheetPath = ridMap[sheet.rId];
    if (!sheetPath) {
      warnings.push(`Sheet "${sheet.name}" has no resolvable rId (${sheet.rId}); skipped.`);
      continue;
    }
    const sheetEntry = zip.getEntry(sheetPath);
    if (!sheetEntry) {
      warnings.push(`Sheet "${sheet.name}" file missing at ${sheetPath}; skipped.`);
      continue;
    }
    const sheetXml = sheetEntry.getData().toString("utf8");
    const rows = parseSheetCells(sheetXml, sharedStrings, limits);
    if (rows.length === 0) {
      // Empty sheet — emit no fragment. The composer still sees the sheet
      // name via the metadata if it needs to.
      continue;
    }

    const cellRange = computeCellRange(rows);
    const text = rows
      .map((row: CellRow) =>
        row.cells
          .map((cell: { column: string; value: string }) =>
            cell.value.length === 0 ? "" : escapeTsvCell(cell.value)
          )
          .join("\t")
      )
      .join("\n");

    const capped = capFragment(text, limits, (v) => {
      truncated = v;
    });
    if (totalChars + capped.text.length > limits.maxParsedTextBytesPerAttachment) {
      truncated = true;
      break;
    }
    totalChars += capped.text.length;
    fragments.push({
      kind: "text",
      text: capped.text,
      sheet: sheet.name,
      rowRange: { from: rows[0]!.rowNumber, to: rows[rows.length - 1]!.rowNumber },
      cellRange,
      locator: `sheet:${sheet.name}:${cellRange.from}:${cellRange.to}`,
      filename,
      mime,
      extractionStatus: capped.extractionStatus,
      uploadedAt,
      retrievedAt,
      source: "user_upload",
      relationToDecision: "user_provided_context",
    });
    sheetsProcessed += 1;
  }

  if (fragments.length === 0) {
    return {
      status: "ok",
      fragments: [],
      truncated,
      parserWarnings: [...warnings, "XLSX contained no rows in any sheet."],
    };
  }

  return { status: "ok", fragments, truncated, parserWarnings: warnings };
}

interface SheetDef {
  name: string;
  rId: string;
}

interface CellRow {
  rowNumber: number;
  cells: Array<{ column: string; value: string }>;
}

function parseSheetList(xml: string): SheetDef[] {
  const out: SheetDef[] = [];
  const re = /<sheet\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1] ?? "";
    const name = /name\s*=\s*"([^"]*)"/.exec(attrs)?.[1] ?? "";
    const rId = /(?:r:id|id)\s*=\s*"([^"]*)"/.exec(attrs)?.[1] ?? "";
    if (name) out.push({ name: decodeXmlEntities(name), rId });
  }
  return out;
}

function parseRelsToMap(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Note: the attribute capture MUST allow "/" because Type="http://..." URLs
  // contain slashes. A `[^/>]*` capture (the previous version) truncated at
  // the first slash in the Type URL and lost the Target attribute.
  const re = /<Relationship\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1] ?? "";
    const id = /Id\s*=\s*"([^"]*)"/.exec(attrs)?.[1] ?? "";
    const target = /Target\s*=\s*"([^"]*)"/.exec(attrs)?.[1] ?? "";
    if (id && target) {
      if (target.startsWith("/")) {
        out[id] = target.slice(1);
      } else if (target.startsWith("./")) {
        out[id] = `xl/${target.slice(2)}`;
      } else {
        out[id] = `xl/${target}`;
      }
    }
  }
  return out;
}

function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  // Each <si> may contain one <t> directly or a rich-text sequence of <r><t>…</t></r>.
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml)) !== null) {
    const body = m[1] ?? "";
    const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let parts = "";
    let tm: RegExpExecArray | null;
    while ((tm = tRe.exec(body)) !== null) {
      parts += decodeXmlEntities(tm[1] ?? "");
    }
    out.push(parts);
  }
  return out;
}

interface RawCell {
  ref: string;
  type: "n" | "s" | "str" | "b" | "e" | "inlineStr" | "unknown";
  value: string;
}

function parseSheetCells(
  xml: string,
  sharedStrings: string[],
  limits: AttachmentLimits
): CellRow[] {
  const cellsByRow = new Map<number, RawCell[]>();

  // <row r="N">…</row>
  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(xml)) !== null) {
    const rowAttrs = rm[1] ?? "";
    const rowNum = Number(/r\s*=\s*"(\d+)"/.exec(rowAttrs)?.[1] ?? "0");
    if (!rowNum) continue;
    const rowXml = rm[2] ?? "";
    const cellRe = /<c\b([^/>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(rowXml)) !== null) {
      const attrs = cm[1] ?? "";
      const inner = cm[2] ?? "";
      const ref = /r\s*=\s*"([A-Z]+\d+)"/.exec(attrs)?.[1] ?? "";
      if (!ref) continue;
      const typeMatch = /t\s*=\s*"([^"]*)"/.exec(attrs)?.[1];
      const type: RawCell["type"] = (
        ["n", "s", "str", "b", "e", "inlineStr"].includes(typeMatch ?? "") ? typeMatch : "n"
      ) as RawCell["type"];
      const value = extractCellValue(inner, sharedStrings);
      const list = cellsByRow.get(rowNum) ?? [];
      if (list.length >= limits.maxColsPerRow) break;
      list.push({ ref, type, value });
      cellsByRow.set(rowNum, list);
    }
  }

  const sortedRowNumbers = Array.from(cellsByRow.keys()).sort((a, b) => a - b);
  const rowLimit = Math.min(sortedRowNumbers.length, limits.maxRowsPerSheet);
  const rows: CellRow[] = [];
  for (let i = 0; i < rowLimit; i++) {
    const rowNumber = sortedRowNumbers[i]!;
    const cells = (cellsByRow.get(rowNumber) ?? []).slice(0, limits.maxColsPerRow);
    rows.push({
      rowNumber,
      cells: cells.map((c) => ({
        column: columnLabel(c.ref),
        value: resolveRawCell(c, sharedStrings),
      })),
    });
  }
  return rows;
}

function extractCellValue(inner: string, sharedStrings: string[]): string {
  // <v> numeric or shared-string index </v>  OR  <is><t>…</t></is>  OR  <t>…</t> direct
  const vMatch = /<v>([\s\S]*?)<\/v>/.exec(inner);
  if (vMatch) {
    const raw = decodeXmlEntities(vMatch[1] ?? "");
    // Shared-string type ("s") index, otherwise the literal value.
    // We can't know the type from the inner alone — the caller tags the type
    // and resolves shared strings. Here we just return the raw text.
    return raw;
  }
  const inlineMatch = /<is>([\s\S]*?)<\/is>|<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/.exec(inner);
  if (inlineMatch) {
    return decodeXmlEntities(inlineMatch[1] ?? inlineMatch[2] ?? "");
  }
  return "";
}

function columnLabel(ref: string): string {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? "";
  return letters;
}

/**
 * Resolve raw <v> contents based on cell type. Public so the dispatcher can
 * resolve shared-strings without exposing the cell-walker internals.
 */
export function resolveRawCell(cell: RawCell, sharedStrings: string[]): string {
  if (cell.type === "s") {
    const idx = Number(cell.value);
    if (Number.isInteger(idx) && idx >= 0 && idx < sharedStrings.length) {
      return sharedStrings[idx] ?? "";
    }
    return "";
  }
  if (cell.type === "inlineStr") {
    return cell.value;
  }
  if (cell.type === "b") {
    return cell.value === "1" || cell.value.toLowerCase() === "true" ? "TRUE" : "FALSE";
  }
  if (cell.type === "e") {
    return `#ERR:${cell.value}`;
  }
  return cell.value;
}

function computeCellRange(rows: CellRow[]): { from: string; to: string } {
  if (rows.length === 0) return { from: "", to: "" };
  let minCol = "Z".repeat(8);
  let maxCol = "";
  let minRow = Number.POSITIVE_INFINITY;
  let maxRow = 0;
  for (const row of rows) {
    minRow = Math.min(minRow, row.rowNumber);
    maxRow = Math.max(maxRow, row.rowNumber);
    for (const cell of row.cells) {
      if (cell.column.localeCompare(minCol) < 0) minCol = cell.column;
      if (cell.column.localeCompare(maxCol) > 0) maxCol = cell.column;
    }
  }
  return {
    from: `${minCol}${Number.isFinite(minRow) ? minRow : 1}`,
    to: `${maxCol}${maxRow || 1}`,
  };
}

function escapeTsvCell(value: string): string {
  // XLSX cells cannot contain tabs or newlines natively — but our extraction
  // surface (text fragment for the LLM) shouldn't lose data, so collapse.
  return value
    .replace(/[\t\r\n]+/g, " ")
    .replace(/  +/g, " ")
    .trim();
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
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