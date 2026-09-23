/**
 * DOCX text + table extraction.
 *
 * DOCX is a ZIP archive containing word/document.xml. We extract that
 * single XML entry, strip control tags, and emit one fragment per
 * paragraph + one fragment per table. No macros, no remote references.
 */

import AdmZip from "adm-zip";
import type { AttachmentFragment } from "../types.ts";
import type { AttachmentLimits } from "../limits.ts";

export interface DocxParseOk {
  status: "ok";
  fragments: AttachmentFragment[];
  truncated: boolean;
  parserWarnings: string[];
}

export interface DocxParseError {
  status: "error";
  parserWarnings: string[];
  reason: string;
}

export type DocxParseResult = DocxParseOk | DocxParseError;

const DOCX_MAGIC_PK = 0x50; // 'P'
const DOCX_MAGIC_K = 0x4b; // 'K'

export function looksLikeZip(bytes: Uint8Array): boolean {
  // ZIP local file header signature is "PK\x03\x04". Empty archives use
  // "PK\x05\x06", and spanned archives use "PK\x07\x08".
  return (
    bytes.length >= 4 &&
    bytes[0] === DOCX_MAGIC_PK &&
    bytes[1] === DOCX_MAGIC_K &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) &&
    (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08)
  );
}

/**
 * Parse a DOCX byte stream into paragraph + table fragments. The extraction
 * strategy intentionally uses regex on the well-known DOCX XML — we don't
 * need a full XML parser because document.xml is structured and the only
 * tokens we care about are <w:p>, <w:tbl>, and the run text inside them.
 */
export function parseDocx(
  bytes: Uint8Array,
  context: { filename: string; mime: string; uploadedAt: string; limits: AttachmentLimits }
): DocxParseResult {
  const { filename, mime, uploadedAt, limits } = context;
  const retrievedAt = new Date().toISOString();
  const warnings: string[] = [];

  if (!looksLikeZip(bytes)) {
    return {
      status: "error",
      parserWarnings: ["DOCX magic bytes missing; file does not look like a ZIP / OOXML container."],
      reason: "not_docx",
    };
  }

  let zip: AdmZip;
  try {
    zip = new AdmZip(Buffer.from(bytes));
  } catch (e) {
    return {
      status: "error",
      parserWarnings: [`adm-zip failed to open DOCX: ${e instanceof Error ? e.message : String(e)}`],
      reason: "zip_failure",
    };
  }

  const entry = zip.getEntry("word/document.xml");
  if (!entry) {
    return {
      status: "error",
      parserWarnings: ["word/document.xml missing — file is not a valid DOCX."],
      reason: "missing_document_xml",
    };
  }

  // Defensive: refuse to load any document that pulls external resources.
  // Real attack surface is small (DOCX has rels for external images) but
  // we don't render media, so the presence of externalTarget entries is a
  // strong "this file is doing something extra" signal.
  const relsEntry = zip.getEntry("word/_rels/document.xml.rels");
  if (relsEntry) {
    const rels = relsEntry.getData().toString("utf8");
    if (/TargetMode\s*=\s*"External"/.test(rels)) {
      warnings.push(
        "Document declares external relationships; external references are ignored, not fetched."
      );
    }
  }

  const xml = entry.getData().toString("utf8");

  // Walk top-level <w:p> and <w:tbl> blocks in source order. A simple
  // state machine (rather than a regex scan) avoids matching nested tags
  // inside the wrong block.
  const blocks = splitTopLevel(xml, ["w:p", "w:tbl"]);

  const fragments: AttachmentFragment[] = [];
  let totalChars = 0;
  let truncated = false;
  let tableIdx = 0;
  let paragraphIdx = 0;

  for (const block of blocks) {
    if (block.tag === "w:p") {
      const text = extractParagraphText(block.body);
      if (!text) continue;
      paragraphIdx += 1;
      const capped = capFragment(text, limits, (st) => {
        truncated = st;
      });
      if (totalChars + capped.text.length > limits.maxParsedTextBytesPerAttachment) {
        truncated = true;
        break;
      }
      totalChars += capped.text.length;
      fragments.push({
        kind: "text",
        text: capped.text,
        locator: `paragraph:${paragraphIdx}`,
        filename,
        mime,
        extractionStatus: capped.extractionStatus,
        uploadedAt,
        retrievedAt,
        source: "user_upload",
        relationToDecision: "user_provided_context",
      });
    } else if (block.tag === "w:tbl") {
      const tableText = extractTableText(block.body);
      if (!tableText) continue;
      tableIdx += 1;
      const capped = capFragment(tableText, limits, (st) => {
        truncated = st;
      });
      if (totalChars + capped.text.length > limits.maxParsedTextBytesPerAttachment) {
        truncated = true;
        break;
      }
      totalChars += capped.text.length;
      fragments.push({
        kind: "text",
        text: capped.text,
        locator: `table:${tableIdx}`,
        filename,
        mime,
        extractionStatus: capped.extractionStatus,
        uploadedAt,
        retrievedAt,
        source: "user_upload",
        relationToDecision: "user_provided_context",
      });
    }
  }

  if (fragments.length === 0) {
    return {
      status: "ok",
      fragments: [],
      truncated,
      parserWarnings: [...warnings, "DOCX contained no extractable paragraph or table content."],
    };
  }

  return { status: "ok", fragments, truncated, parserWarnings: warnings };
}

interface ParsedBlock {
  tag: "w:p" | "w:tbl";
  body: string;
}

function splitTopLevel(xml: string, tags: string[]): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  let i = 0;
  while (i < xml.length) {
    let nextIdx = -1;
    let nextTag: "w:p" | "w:tbl" | null = null;
    for (const tag of tags) {
      const open = `<${tag}`;
      let j = i;
      while (j < xml.length) {
        const idx = xml.indexOf(open, j);
        if (idx === -1) break;
        const after = xml.charAt(idx + open.length);
        // Accept `<w:p>`, `<w:p `, `<w:p/>`, `<w:p />` — reject `<w:pPr…`
        // and `<w:pStyle…` so paragraph / table cells aren't mistaken for
        // paragraphs.
        if (
          after === ">" ||
          after === " " ||
          after === "/" ||
          after === "\t" ||
          after === "\n"
        ) {
          if (nextIdx === -1 || idx < nextIdx) {
            nextIdx = idx;
            nextTag = tag as "w:p" | "w:tbl";
          }
          break;
        }
        j = idx + 1;
      }
    }
    if (nextIdx === -1 || nextTag === null) break;
    const end = xml.indexOf(`</${nextTag}>`, nextIdx);
    if (end === -1) break;
    const closeEnd = end + `</${nextTag}>`.length;
    blocks.push({ tag: nextTag, body: xml.slice(nextIdx, closeEnd) });
    i = closeEnd;
  }
  return blocks;
}

function extractParagraphText(pXml: string): string {
  // Collect every <w:t...>...</w:t> text node, joined with no separator.
  // The XML allows w:t to nest inside w:r > w:p. We deliberately do NOT
  // unescape entities other than the ones the XML guarantees.
  const out: string[] = [];
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pXml)) !== null) {
    out.push(decodeEntities(m[1] ?? ""));
  }
  return out.join("").replace(/[ \t]+/g, " ").trim();
}

function extractTableText(tblXml: string): string {
  // For each row, join its cells with a tab; rows separated by newlines.
  const rowRe = /<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/g;
  const rows: string[] = [];
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(tblXml)) !== null) {
    const rowXml = rm[1] ?? "";
    const cellRe = /<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g;
    const cells: string[] = [];
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(rowXml)) !== null) {
      cells.push(extractParagraphText(cm[1] ?? ""));
    }
    rows.push(cells.filter((c) => c.length > 0).join("\t"));
  }
  return rows.filter((r) => r.length > 0).join("\n").trim();
}

function decodeEntities(s: string): string {
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