#!/usr/bin/env node
// AIME Decision Review — submission preflight
//
// Verifies the working tree is ready to be packaged into a deterministic
// submission ZIP, and (optionally) produces that ZIP. Self-contained: no
// third-party dependencies, runs on Node ≥ 18 or Bun ≥ 1.1.
//
// Usage:
//   node scripts/preflight.mjs                 # verify only
//   node scripts/preflight.mjs --zip <path>     # verify + build deterministic ZIP
//   node scripts/preflight.mjs --tar <path>    # verify + build deterministic tar.gz (uses system tar)
//   node scripts/preflight.mjs --strict        # dirty tree fails the build
//   node scripts/preflight.mjs --json          # machine-readable summary on stdout
//
// Exit codes:
//   0  all checks passed (and optional archive written)
//   1  one or more checks failed
//   2  usage error
//
// See `submission/MANIFEST.md` for the contract this script enforces.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve, sep, posix } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const SUBMISSION_DIR = "submission";
const MANIFEST_PATH = join(REPO_ROOT, SUBMISSION_DIR, "MANIFEST.md");

// ----------------------------------------------------------------------------
// Entry-point guard
//
// This file is also imported by `tests/preflight/preflight.test.ts` for the
// bun:test unit coverage. When that happens, we MUST NOT run the CLI flow
// (which calls process.exit and scans the working tree). The guard below
// gates every side-effecting statement — only the top-level constants,
// helper functions, and exports run on import.
// ----------------------------------------------------------------------------

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

// ----------------------------------------------------------------------------
// Required artefacts (§1 of MANIFEST.md)
// ----------------------------------------------------------------------------

const REQUIRED_ARTEFACTS = [
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "package.json",
  "package-lock.json",
  "docker-compose.yml",
  ".env.example",
  ".gitignore",
  "index.html",
  "tsconfig.json",
  "vite.config.ts",
  "src",
  "apps/api",
  "apps/web",
  "docs/SPEC.md",
  "docs/AI_VALIDATION.md",
  "docs/TEST_PLAN.md",
  "docs/AUTOMATION.md",
  "docs/DEPLOYMENT.md",
  "submission/MANIFEST.md",
  "submission/README.md",
  "submission/DEPLOYMENT_EVIDENCE.template.md",
  "submission/LICENSE_INVENTORY.md",
  "submission/TEST_NOTES.md",
  "submission/AI_VALIDATION_RECORD.md",
  "scripts/preflight.mjs",
  "scripts/preflight.sh",
  "tests/preflight",
  ".github/workflows/ci.yml",
  ".github/workflows/multica-supervisor.yml",
];

// Forbidden paths (§2.1 of MANIFEST.md). Matched as a path-prefix or full
// filename against the project-relative path with forward slashes.
const FORBIDDEN_PATHS = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.test",
  "secrets.json",
  "secrets.yaml",
  "secrets.yml",
  "id_rsa",
  "id_ed25519",
];

const FORBIDDEN_DIRS = [
  ".multica",
  ".claude",
  "node_modules",
  "dist",
  ".vscode",
  ".idea",
  "coverage",
];

const FORBIDDEN_GLOBS = [
  /\.pem$/i,
  /\.key$/i,
  /\.crt$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.rsa$/i,
  /credentials?\.json$/i,
  /service-account.*\.json$/i,
  /\.db$/i,
  /\.db-journal$/i,
  /\.db-wal$/i,
  /\.db-shm$/i,
  /\.tsbuildinfo$/i,
  /\.log$/i,
  /^npm-debug\.log/i,
  /^yarn-error\.log/i,
  /^bun-error\.log/i,
  /^\.DS_Store$/,
  /^Thumbs\.db$/,
];

// Forbidden contents (§2.2 of MANIFEST.md). Each entry: { name, pattern }.
// The "key=value" patterns require the value to look like a real credential
// (≥ 8 chars, not a shell placeholder like `${VAR}` or `<value>`), so they
// don't false-positive on the placeholder defaults in `.env.example` or the
// documentation prose that mentions the variable name. A `(?<![A-Za-z0-9_])`
// lookbehind anchors the match to a non-identifier boundary so the
// regex still fires on inline leaks like
// `export const token = LLM_API_KEY=sk-live-...` while staying quiet on
// `mLLM_API_KEY=...` (substring of a longer identifier).
const FORBIDDEN_CONTENT = [
  {
    name: "Authorization Bearer (real token shape)",
    // Require 16+ alphanumeric/typical token chars after "Bearer ".
    // Excludes `$VAR` shell references and short non-credential tokens.
    pattern: /Authorization:\s*Bearer\s+[A-Za-z0-9_\-]{16,}/,
  },
  {
    name: "OpenAI sk-* key",
    // sk- followed by 16+ alphanumeric chars (real key shape).
    pattern: /\bsk-[A-Za-z0-9]{16,}\b/,
  },
  {
    name: "HITHINK_FINANCE_API_KEY=<value>",
    pattern: /(?<![A-Za-z0-9_])HITHINK_FINANCE_API_KEY=(?!\$\{|<)[A-Za-z0-9_\-./+=]{8,}/,
  },
  {
    name: "IFIND_MCP_AUTHORIZATION=<value>",
    pattern: /(?<![A-Za-z0-9_])IFIND_MCP_AUTHORIZATION=(?!\$\{|<)[A-Za-z0-9_\-./+=]{8,}/,
  },
  {
    name: "LLM_API_KEY=<value>",
    pattern: /(?<![A-Za-z0-9_])LLM_API_KEY=(?!\$\{|<)[A-Za-z0-9_\-./+=]{8,}/,
  },
  {
    name: "MULTICA_AIME_SUPERVISOR_WEBHOOK_URL=<value>",
    pattern: /(?<![A-Za-z0-9_])MULTICA_AIME_SUPERVISOR_WEBHOOK_URL=(?!\$\{|<)[A-Za-z0-9_\-./+=:?&]{16,}/,
  },
  {
    name: "INITIAL_ADMIN_PASSWORD=<value>",
    pattern: /(?<![A-Za-z0-9_])INITIAL_ADMIN_PASSWORD=(?!\$\{|<)[A-Za-z0-9_\-./+=]{8,}/,
  },
];

// Files exempt from the secret-content scan:
//  - `.env.example` is the placeholder template (empty values only).
//  - `scripts/preflight.mjs` and `submission/` contain the rule patterns
//    themselves; scanning them is circular and produces false positives.
//  - `tests/preflight/` deliberately contains credential-shaped fixtures
//    to verify the scanner works; scanning them would cause a circular
//    self-test failure.
//  - `docs/AI_VALIDATION.md` is the canonical human-curated log that
//    documents every secret scan we ran; it legitimately mentions the
//    rule patterns (e.g. "no `sk-*`, no `Bearer …`") and would
//    false-positive on every entry. The file is reviewed in every PR so
//    real-credential leaks would be caught by humans.
const SECRET_SCAN_EXEMPT = new Set([
  ".env.example",
  "scripts/preflight.mjs",
  "tests/preflight/preflight.test.ts",
  "submission/MANIFEST.md",
  "submission/README.md",
  "submission/DEPLOYMENT_EVIDENCE.template.md",
  "submission/LICENSE_INVENTORY.md",
  "submission/TEST_NOTES.md",
  "submission/AI_VALIDATION_RECORD.md",
  "docs/AI_VALIDATION.md",
]);

// ----------------------------------------------------------------------------
// Helper functions (no side effects; safe to evaluate on import)
// ----------------------------------------------------------------------------

function usage() {
  return `Usage: node scripts/preflight.mjs [--zip <path>] [--tar <path>] [--strict] [--json]\n`;
}

function fail(msg) {
  process.stderr.write(`preflight: ${msg}\n`);
  process.exit(2);
}

function git(args) {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch (e) {
    return null;
  }
}

const skippedDirNames = new Set([".git", ".multica", ".claude", "node_modules", "dist", "coverage"]);

function walk(rel) {
  const abs = join(REPO_ROOT, rel);
  const st = statSync(abs);
  if (st.isFile()) return [{ rel, size: st.size }];
  const out = [];
  for (const name of readdirSync(abs)) {
    if (skippedDirNames.has(name)) continue;
    const child = posix.join(rel, name);
    const childAbs = join(abs, name);
    const childSt = statSync(childAbs);
    if (childSt.isDirectory()) {
      for (const f of walk(child)) out.push(f);
    } else if (childSt.isFile()) {
      out.push({ rel: child, size: childSt.size });
    }
  }
  return out;
}

function toPosix(p) {
  return p.split(sep).join("/");
}

function isForbiddenPath(rel) {
  const p = toPosix(rel);
  const segments = p.split("/");
  const basename = segments[segments.length - 1] ?? "";
  // Forbidden directory at any level: match a path segment.
  for (const dir of FORBIDDEN_DIRS) {
    if (segments.includes(dir)) return true;
  }
  // Forbidden filename match: basename match, so `id_rsa` is caught whether
  // it sits at the repo root, inside `.ssh/`, or anywhere else.
  for (const exact of FORBIDDEN_PATHS) {
    if (basename === exact) return true;
  }
  // Glob pattern match: applies to the full relative path.
  for (const re of FORBIDDEN_GLOBS) {
    if (re.test(p)) return true;
  }
  return false;
}

// ----------------------------------------------------------------------------
// Deterministic ZIP encoder (no compression, store mode)
//
// Pure-JS implementation of APPNOTE.TXT §4.3.7 — store mode. Used so the
// output is byte-stable across runs given identical inputs. Files are
// sorted lexicographically by relative POSIX path; mtimes are normalised
// to zero so ZIP readers fall back to the archive mtime; CRCs are computed
// against the actual file bytes.
//
// Implements:
//   - Local file header (signature 0x04034b50)
//   - Central directory entry (signature 0x02014b50)
//   - End of central directory record (signature 0x06054b50)
//   - CRC32 (polynomial 0xEDB88320)
//
// Does NOT implement: Zip64 extensions (sufficient for any submission <
// 4 GiB), encryption, compression, data descriptors.
// ----------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function buildDeterministicZip(outPath, fileList) {
  const out = [];
  const central = [];
  let offset = 0;
  // Sort by relative POSIX path so the local headers, central directory,
  // and CRCs are written in a stable order. Two builds from the same
  // fixture must produce byte-identical archives.
  const sorted = [...fileList].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  for (const f of sorted) {
    if (isForbiddenPath(f.rel)) continue; // safety: skip forbidden paths
    const data = readFileSync(join(REPO_ROOT, f.rel));
    const nameBuf = Buffer.from(toPosix(f.rel), "utf8");
    const crc = crc32(data);
    const dosTime = 0; // normalised; archive mtime is the canonical one
    const dosDate = 0x21; // 1980-01-01
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    out.push(local, nameBuf, data);

    const centralEntry = Buffer.alloc(46);
    centralEntry.writeUInt32LE(0x02014b50, 0);
    centralEntry.writeUInt16LE(20, 4);
    centralEntry.writeUInt16LE(20, 6);
    centralEntry.writeUInt16LE(0, 8);
    centralEntry.writeUInt16LE(0, 10);
    centralEntry.writeUInt16LE(dosTime, 12);
    centralEntry.writeUInt16LE(dosDate, 14);
    centralEntry.writeUInt32LE(crc, 16);
    centralEntry.writeUInt32LE(data.length, 20);
    centralEntry.writeUInt32LE(data.length, 24);
    centralEntry.writeUInt16LE(nameBuf.length, 28);
    centralEntry.writeUInt16LE(0, 30);
    centralEntry.writeUInt16LE(0, 32);
    centralEntry.writeUInt16LE(0, 34);
    centralEntry.writeUInt16LE(0, 36);
    centralEntry.writeUInt32LE(0, 38);
    centralEntry.writeUInt32LE(offset, 42);
    central.push(centralEntry, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const cdOffset = offset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length / 2, 8);
  eocd.writeUInt16LE(central.length / 2, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  mkdirSync(resolve(outPath, ".."), { recursive: true });
  const chunks = [...out, ...central, eocd];
  writeFileSync(outPath, Buffer.concat(chunks));
}

// ----------------------------------------------------------------------------
// Deterministic tar.gz via system tar
//
// We delegate to the system's tar so we don't need to write a tar encoder.
// tar is available on every CI image we use (Ubuntu runners, macOS, Git
// Bash on Windows). Files are passed in sorted order; we set --mtime and
// --owner/--numeric-owner to fixed values so the archive is reproducible.
// ----------------------------------------------------------------------------

function buildDeterministicTar(outPath) {
  mkdirSync(resolve(outPath, ".."), { recursive: true });
  const args = [
    "--create",
    "--gzip",
    "--file",
    outPath,
    "--sort=name",
    "--mtime=@0",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "--exclude=.git",
    "--exclude=.multica",
    "--exclude=.claude",
    "--exclude=node_modules",
    "--exclude=dist",
    "--exclude=coverage",
    "--exclude=*.db",
    "--exclude=*.db-journal",
    "--exclude=*.db-wal",
    "--exclude=*.db-shm",
    "--exclude=*.tsbuildinfo",
    "--exclude=*.log",
    "--exclude=.DS_Store",
    "--exclude=Thumbs.db",
    ".",
  ];
  execFileSync("tar", args, { cwd: REPO_ROOT, stdio: ["ignore", "ignore", "inherit"] });
}

// ----------------------------------------------------------------------------
// Exports for unit tests (bun:test in tests/preflight/). The CLI entry path
// stays a self-contained script; the exported functions are pure checks
// that operate on a (root, fileList, options) tuple so tests can run them
// against a synthetic tmpdir fixture without touching the real repo.
// ----------------------------------------------------------------------------

export function classifyPosix(p) {
  return toPosix(p);
}

export function isForbiddenPathForTests(rel) {
  return isForbiddenPath(rel);
}

export function getRulesForTests() {
  return {
    FORBIDDEN_CONTENT,
    FORBIDDEN_PATHS,
    FORBIDDEN_DIRS,
    FORBIDDEN_GLOBS,
    SECRET_SCAN_EXEMPT,
  };
}

export function buildDeterministicZipForTests(outPath, fileList, rootPath) {
  // Allow callers to specify a fake root path so tests don't need to live
  // in the real repo. The signature mirrors buildDeterministicZip, but
  // resolves `fileList[i].rel` against `rootPath` instead of REPO_ROOT.
  const base = rootPath ?? REPO_ROOT;
  const out = [];
  const central = [];
  let offset = 0;
  // Sort by relative POSIX path so two builds from the same fixture are
  // byte-identical regardless of the caller's input order.
  const sorted = [...fileList].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  for (const f of sorted) {
    if (isForbiddenPath(f.rel)) continue;
    const data = readFileSync(join(base, f.rel));
    const nameBuf = Buffer.from(toPosix(f.rel), "utf8");
    const crc = crc32(data);
    const dosTime = 0;
    const dosDate = 0x21;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    out.push(local, nameBuf, data);
    const centralEntry = Buffer.alloc(46);
    centralEntry.writeUInt32LE(0x02014b50, 0);
    centralEntry.writeUInt16LE(20, 4);
    centralEntry.writeUInt16LE(20, 6);
    centralEntry.writeUInt16LE(0, 8);
    centralEntry.writeUInt16LE(0, 10);
    centralEntry.writeUInt16LE(dosTime, 12);
    centralEntry.writeUInt16LE(dosDate, 14);
    centralEntry.writeUInt32LE(crc, 16);
    centralEntry.writeUInt32LE(data.length, 20);
    centralEntry.writeUInt32LE(data.length, 24);
    centralEntry.writeUInt16LE(nameBuf.length, 28);
    centralEntry.writeUInt16LE(0, 30);
    centralEntry.writeUInt16LE(0, 32);
    centralEntry.writeUInt16LE(0, 34);
    centralEntry.writeUInt16LE(0, 36);
    centralEntry.writeUInt32LE(0, 38);
    centralEntry.writeUInt32LE(offset, 42);
    central.push(centralEntry, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const cdOffset = offset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length / 2, 8);
  eocd.writeUInt16LE(central.length / 2, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);
  mkdirSync(resolve(outPath, ".."), { recursive: true });
  writeFileSync(outPath, Buffer.concat([...out, ...central, eocd]));
}

// ----------------------------------------------------------------------------
// CLI flow — runs only when this file is the main entry point.
//
// Wrapping the entire CLI in a top-level `if (isMain)` block keeps the module
// side-effect-free for importers (`tests/preflight/preflight.test.ts`).
// Every side-effecting statement below — argv parsing with process.exit,
// git/FS walks, secret scan, BUILD_INFO write, stdout/stderr output, the
// optional ZIP/tar build — lives inside this block.
// ----------------------------------------------------------------------------

if (isMain) {
  if (!existsSync(MANIFEST_PATH)) {
    fail(`manifest missing at ${MANIFEST_PATH}`);
  }

  // CLI argv parsing.
  const argv = process.argv.slice(2);
  const opts = {
    zip: null,
    tar: null,
    strict: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--zip") opts.zip = argv[++i];
    else if (a === "--tar") opts.tar = argv[++i];
    else if (a === "--strict") opts.strict = true;
    else if (a === "--json") opts.json = true;
    else if (a === "-h" || a === "--help") {
      process.stdout.write(usage());
      process.exit(0);
    } else {
      process.stderr.write(`Unknown arg: ${a}\n${usage()}`);
      process.exit(2);
    }
  }

  // Side-effecting state — git + FS walk.
  const gitSha = git(["rev-parse", "HEAD"]);
  const gitShort = gitSha ? gitSha.slice(0, 7) : null;
  const gitDirty = (() => {
    const out = git(["status", "--porcelain"]);
    return out == null ? null : out.length > 0;
  })();
  const files = walk("").sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  // Findings buffer + checks.
  const findings = [];

  function note(severity, kind, where, message) {
    findings.push({ severity, kind, where, message });
  }

  function checkRequiredArtefacts() {
    for (const path of REQUIRED_ARTEFACTS) {
      if (!existsSync(join(REPO_ROOT, path))) {
        note("error", "missing-artefact", path, `required artefact missing: ${path}`);
      }
    }
  }

  function scanFileContent(f) {
    const rel = toPosix(f.rel);
    if (SECRET_SCAN_EXEMPT.has(rel)) return;
    // For files larger than 256KB only scan the first 256KB.
    const SCAN_LIMIT = 256 * 1024;
    let content;
    try {
      const buf = readFileSync(join(REPO_ROOT, f.rel));
      if (buf.length > SCAN_LIMIT) {
        content = buf.subarray(0, SCAN_LIMIT).toString("utf8");
      } else {
        content = buf.toString("utf8");
      }
    } catch {
      return; // skip unreadable files
    }
    for (const rule of FORBIDDEN_CONTENT) {
      if (rule.pattern.test(content)) {
        note("error", "forbidden-content", f.rel, `${rule.name} found in ${f.rel}`);
      }
    }
  }

  function checkForbiddenPaths() {
    for (const f of files) {
      if (isForbiddenPath(f.rel)) {
        note("error", "forbidden-path", f.rel, `forbidden path/pattern matched: ${f.rel}`);
      }
    }
  }

  function checkForbiddenContent() {
    for (const f of files) scanFileContent(f);
  }

  function checkEvidenceTemplate() {
    const evidencePath = join(REPO_ROOT, SUBMISSION_DIR, "DEPLOYMENT_EVIDENCE.md");
    if (!existsSync(evidencePath)) return; // template only — allowed
    const txt = readFileSync(evidencePath, "utf8");
    const lines = txt.split(/\r?\n/);
    const blankOrUnknown = (l) => l.trim() === "" || /^\s*UNKNOWN\s+—\s+.+/.test(l);
    if (lines.some((l) => !blankOrUnknown(l))) return; // populated — fine
    note("warn", "evidence-placeholder", "submission/DEPLOYMENT_EVIDENCE.md", "deployment evidence file exists but is all UNKNOWN placeholders");
  }

  function checkWorkingTreeState() {
    if (gitSha == null) {
      note("warn", "no-git", "(repo)", "not a git working tree — git SHA unavailable");
      return;
    }
    if (gitDirty && !opts.strict) {
      note("warn", "dirty-tree", "(repo)", "working tree has uncommitted changes (use --strict to fail)");
    } else if (gitDirty && opts.strict) {
      note("error", "dirty-tree", "(repo)", "working tree is dirty and --strict was passed");
    }
  }

  // Run checks.
  checkRequiredArtefacts();
  checkForbiddenPaths();
  checkForbiddenContent();
  checkEvidenceTemplate();
  checkWorkingTreeState();

  // Write BUILD_INFO.txt BEFORE the optional ZIP build, so the file is
  // present in the working tree when the archive is constructed.
  const buildInfoLines = [
    `commit_sha=${gitSha ?? "UNKNOWN"}`,
    `commit_short=${gitShort ?? "UNKNOWN"}`,
    `branch=${git(["rev-parse", "--abbrev-ref", "HEAD"]) ?? "UNKNOWN"}`,
    `working_tree=${gitDirty == null ? "UNKNOWN" : gitDirty ? "dirty" : "clean"}`,
    `built_at_utc=${new Date().toISOString()}`,
    `node_version=${process.version}`,
  ];
  const buildInfoPath = join(REPO_ROOT, SUBMISSION_DIR, "BUILD_INFO.txt");
  writeFileSync(buildInfoPath, buildInfoLines.join("\n") + "\n", "utf8");
  // Also include BUILD_INFO.txt in the archive list so a deterministic
  // ZIP carries the build metadata it was produced with.
  const buildInfoEntry = { rel: `${SUBMISSION_DIR}/BUILD_INFO.txt`, size: buildInfoLines.join("\n").length + 1 };
  if (!files.some((f) => f.rel === buildInfoEntry.rel)) {
    files.push(buildInfoEntry);
    files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  }

  // Output summary.
  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warn");

  if (opts.json) {
    const summary = {
      ok: errors.length === 0,
      commit: { sha: gitSha, short: gitShort },
      workingTree: gitDirty == null ? "unknown" : gitDirty ? "dirty" : "clean",
      strict: opts.strict,
      counts: { errors: errors.length, warnings: warnings.length },
      findings,
      artefactsChecked: REQUIRED_ARTEFACTS.length,
    };
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  } else {
    process.stdout.write("\nAIME Decision Review — submission preflight\n");
    process.stdout.write(`  commit:        ${gitShort ?? "UNKNOWN"}${gitDirty ? " (dirty)" : ""}\n`);
    process.stdout.write(`  required:      ${REQUIRED_ARTEFACTS.length} artefacts\n`);
    process.stdout.write(`  files scanned: ${files.length}\n`);
    process.stdout.write(`  errors:        ${errors.length}\n`);
    process.stdout.write(`  warnings:      ${warnings.length}\n\n`);

    if (warnings.length > 0) {
      process.stdout.write("Warnings:\n");
      for (const w of warnings) {
        process.stdout.write(`  - [${w.kind}] ${w.where}: ${w.message}\n`);
      }
      process.stdout.write("\n");
    }
    if (errors.length > 0) {
      process.stdout.write("Errors:\n");
      for (const e of errors) {
        process.stdout.write(`  - [${e.kind}] ${e.where}: ${e.message}\n`);
      }
      process.stdout.write("\n");
    }
  }

  if (errors.length > 0) {
    process.stderr.write(`preflight: ${errors.length} error(s), ${warnings.length} warning(s)\n`);
    process.exit(1);
  }

  if (opts.zip) {
    try {
      buildDeterministicZip(opts.zip, files);
      process.stdout.write(`wrote deterministic ZIP: ${opts.zip}\n`);
    } catch (e) {
      process.stderr.write(`zip build failed: ${e.message}\n`);
      process.exit(1);
    }
  }

  if (opts.tar) {
    try {
      buildDeterministicTar(opts.tar);
      process.stdout.write(`wrote deterministic tar.gz: ${opts.tar}\n`);
    } catch (e) {
      process.stderr.write(`tar build failed: ${e.message}\n`);
      process.exit(1);
    }
  }

  process.stdout.write("preflight OK\n");
  process.exit(0);
}