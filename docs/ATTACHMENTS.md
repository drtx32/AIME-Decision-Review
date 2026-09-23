# Attachments — ELI-337

Controlled PDF / DOCX / XLSX / CSV / image ingestion as conversation context.

User uploads are **not** historical evidence. They are labeled
`source = "user_upload"` and `relationToDecision = "user_provided_context"`
on every parsed fragment, and never auto-promoted to `ex_ante` / `ex_post`.

## Goals

- Accept a bounded set of common document formats without turning uploads
  into trusted evidence.
- Reject anything that is not on the allowlist (archives, executables,
  macro-enabled Office, HTML/JS, legacy binary `.doc`, unknown binary).
- Bound the resource cost of every upload (size, count, parsed text, rows,
  sheets, pages).
- Surface a *honest* parse outcome: `ready`, `no_text`, `failed`,
  `unsupported`. A malformed upload returns `failed`, not `ready`.
- Enforce per-user access on read paths. A bare attachment id is never
  enough.

## Allowlist

Server-side allowlist (`apps/api/src/attachments/limits.ts`):

| Category | MIME                                                  | Extensions      |
| -------- | ----------------------------------------------------- | --------------- |
| image    | `image/png`, `image/jpeg`, `image/webp`               | `png`, `jpg`, `jpeg`, `webp` |
| pdf      | `application/pdf`                                     | `pdf`           |
| docx     | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | `docx` |
| xlsx     | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`       | `xlsx` |
| csv      | `text/csv`                                            | `csv`           |

Explicit rejection list (returns `400 rejected`): `.doc`, `.docm`,
`.xls`, `.xlsm`, `.ppt`, `.pptx`, `.pptm`, `.html`, `.htm`, `.js`,
`.mjs`, `.ts`, `.jsx`, `.tsx`, `.exe`, `.bat`, `.sh`, `.zip`, `.tar`,
`.gz`, `.tgz`, `.rar`, `.7z`, `.iso`, `.dmg`, `.jar`, `.war`, `.so`,
`.dll`.

A declared MIME and the filename extension must agree on the same
category, otherwise the upload is rejected (`400 rejected`,
`MIME … does not match extension .…`). This catches "looks-like-pdf.png"
attempts at the boundary.

## Limits

`DEFAULT_ATTACHMENT_LIMITS` in `apps/api/src/attachments/limits.ts`:

- `maxFileBytes`: 25 MiB per upload
- `maxFilesPerUser`: 50 attachments kept per user
- `maxParsedTextBytesPerAttachment`: 1 MiB of structured text per file
- `maxFragmentChars`: 32 768 chars per individual text fragment
- `maxRowsPerSheet`: 5 000 (CSV / XLSX)
- `maxColsPerRow`: 64 (XLSX)
- `maxSheetsPerWorkbook`: 32 (XLSX)
- `maxPdfPages`: 200 (best effort)

Truncation markers are emitted explicitly: `extractionStatus = "truncated"`
on the affected fragment, and the row-level `parsedTruncated = true` flag
plus a parser warning.

## Provenance contract

Every parsed text fragment carries:

- `filename`, `mime`
- `uploadedAt`, `retrievedAt`
- `locator`: `paragraph:<n>`, `table:<n>`, `p:<page>`, or
  `sheet:<name>:<cellFrom>:<cellTo>`
- `page` for PDFs, `sheet` / `cellRange` / `rowRange` for spreadsheets
- `source = "user_upload"`
- `relationToDecision = "user_provided_context"` — **never** `ex_ante`
  or `ex_post`

This is enforced in three places:

1. The fragment constructors in `parsers/{pdf,docx,xlsx,csv}.ts`.
2. The repository schema (`attachments` table CHECK constraints on
   `category` / `status`).
3. The route layer's read filter (`/api/attachments/:id` returns 404 to
   any non-owner).

## API

All routes require an authenticated, non-`mustChangePassword` user.

| Verb     | Path                              | Body / Response                                      |
| -------- | --------------------------------- | ---------------------------------------------------- |
| `POST`   | `/api/attachments`                | `multipart/form-data` with `file` field; returns `201` with metadata, or `400/413/415` |
| `GET`    | `/api/attachments`                | List caller's attachments, newest first              |
| `GET`    | `/api/attachments/:id`            | Get one metadata record                              |
| `GET`    | `/api/attachments/:id/raw`        | Raw bytes — images only (`400 raw_only_for_images` for text formats) |
| `DELETE` | `/api/attachments/:id`            | `204` on success, `404` if not owned                 |

Error codes returned by the service:

- `unsupported` → `415`
- `oversized` / `quota_exceeded` → `413`
- `rejected` / `invalid_multipart` / `missing_file` / `missing_id` /
  `raw_only_for_images` → `400`
- `not_found` → `404`
- `unauthenticated` → `401`

## Vision capability contract

`providers/{index,mock-provider,openai-compatible}.ts` carry a
`ProviderCapabilities { text: true; images: boolean }` snapshot. The
capability is recorded on every uploaded attachment as
`providerVisionCapability`:

- `"available"` — provider accepts `image_url` multimodal content.
- `"unavailable"` — provider has no vision endpoint.
- `"unknown"` — not an image upload, or capability not probed.

The OpenAI-compatible provider probes vision lazily on first image
upload with a 1×1 PNG (recorded as `probe`); a `probeOverride` option
lets tests bypass real network. The mock provider reports `unavailable`
without any network call.

Image bytes are only sent to the LLM when the capability is
`"available"`. The composer in `ELI-336` is responsible for checking
the recorded capability before attaching image content.

## Storage

`AttachmentRepository` (`apps/api/src/attachments/repository.ts`):

- SQLite row per attachment in the `attachments` table, with CHECK
  constraints on `category` / `status`.
- Raw bytes written to `<sqliteDir>/attachments/<id>.bin` (sync
  `writeFileSync` so the blob is on disk before the route returns).
- Per-user access enforced in `findOwned(id, ownerUserId)` and
  `openOwnedBytes(id, ownerUserId)` — every read takes the caller id.
- `deleteOwned` removes both the row and the blob file (best-effort).

## Safety notes

- Server-side MIME + extension + magic-byte checks (PNG / JPEG / WebP /
  `%PDF-` / ZIP `PK\x03\x04`).
- Sanitised filename: drops path separators, leading dots/spaces, caps
  length, falls back to `unnamed`.
- No remote fetch — DOCX `externalTarget` and XLSX `externalLink`
  entries are warnings, never followed.
- No formula / macro / DDE execution. Cell type `s` resolves through
  sharedStrings, never as an executable expression.
- CSV cells starting with `=+-@` are quoted to prevent formula execution
  in downstream tools.
- No remote fetch from PDF (we use local `pdf-parse` only).

## Integration with ELI-336

ELI-336 (chat composer) consumes attachment metadata via:

```ts
const attachments = deps.attachments.listOwned(userId);
// or for a specific upload:
const meta = deps.attachments.readOwned(id, userId);
```

For vision-capable providers the composer fetches raw bytes via
`readOwnedBytes(id, userId)` and only when `meta.providerVisionCapability
=== "available"`.

For text formats, the composer iterates `meta.fragments` (already
parsed + bounded) and uses the locator / sheet / rowRange / cellRange /
page fields to cite the upload as `user_provided_context` in the
prompt, never as an `ex_ante` evidence entry.

## Tests

`apps/api/tests/attachments.test.ts` (26 cases):

- allowlist + MIME / extension validation
- oversized / empty / macro-enabled / path-traversal sanitisation
- PNG / JPEG image metadata, magic-byte mismatch surfaces `failed`
- PDF text + image-only PDF no-text + non-PDF magic bytes surfaces
  `failed`
- DOCX paragraphs + tables with provenance
- XLSX rows with sheet + cell range provenance, sheet limit truncation
- CSV with bounded rows + cell range
- per-fragment truncation marker
- old-dated uploaded material stays `user_provided_context` (never
  `ex_ante`)
- cross-user GET / DELETE / RAW return `404`
- auth gate (`401`) and `mustChangePassword` gate (`403`)
- vision capability snapshot reflects the configured provider
- secret safety: no `sk-…` / `Bearer …` / `Authorization: …` literal in
  any response body

Local test run: `bun test ./apps/api/tests/attachments.test.ts`.