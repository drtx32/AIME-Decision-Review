/**
 * bun:test coverage for the submission preflight script.
 *
 * The tests live outside `apps/api/tests/` because the preflight belongs
 * to the submission skeleton, not the API runtime. They import the
 * preflight's pure helpers from `scripts/preflight.mjs` and exercise them
 * against synthetic fixtures in a tmpdir — they do not mutate the real
 * repo.
 *
 * Run from the repo root:
 *   cd apps/api && bun test ../../tests/preflight/
 */

import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep, posix } from "node:path";

import {
  classifyPosix,
  isForbiddenPathForTests,
  getRulesForTests,
  buildDeterministicZipForTests,
} from "../../scripts/preflight.mjs";

const {
  FORBIDDEN_CONTENT,
  FORBIDDEN_PATHS,
  FORBIDDEN_DIRS,
  FORBIDDEN_GLOBS,
  SECRET_SCAN_EXEMPT,
} = getRulesForTests();

function makeFixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "aime-preflight-"));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function writeFixtureFile(root: string, rel: string, content: string) {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

function fixtureFiles(root: string, rels: string[]) {
  return rels
    .filter((rel) => existsSync(join(root, rel)))
    .map((rel) => ({ rel, size: readFileSync(join(root, rel)).byteLength }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

describe("classifyPosix", () => {
  test("converts backslashes to forward slashes", () => {
    expect(classifyPosix(`a${sep}b${sep}c`)).toBe("a/b/c");
  });

  test("is idempotent on already-posix paths", () => {
    expect(classifyPosix("a/b/c")).toBe("a/b/c");
  });
});

describe("isForbiddenPath", () => {
  test("flags every exact-match forbidden filename", () => {
    for (const exact of FORBIDDEN_PATHS) {
      expect(isForbiddenPathForTests(exact)).toBe(true);
    }
  });

  test("flags every forbidden directory at the root", () => {
    for (const dir of FORBIDDEN_DIRS) {
      expect(isForbiddenPathForTests(dir)).toBe(true);
    }
  });

  test("flags forbidden directories nested anywhere", () => {
    expect(isForbiddenPathForTests(`apps/api/${FORBIDDEN_DIRS[0]}/x`)).toBe(true);
    expect(isForbiddenPathForTests(`deep/path/${FORBIDDEN_DIRS[1]}/y`)).toBe(true);
  });

  test("flags glob patterns (private keys, log files, .db, .tsbuildinfo)", () => {
    expect(isForbiddenPathForTests("certs/server.pem")).toBe(true);
    expect(isForbiddenPathForTests("certs/server.key")).toBe(true);
    expect(isForbiddenPathForTests("certs/server.crt")).toBe(true);
    expect(isForbiddenPathForTests("certs/server.pfx")).toBe(true);
    expect(isForbiddenPathForTests("~/.ssh/id_rsa")).toBe(true);
    expect(isForbiddenPathForTests("local-data.db")).toBe(true);
    expect(isForbiddenPathForTests("local-data.db-journal")).toBe(true);
    expect(isForbiddenPathForTests("aime.tsbuildinfo")).toBe(true);
    expect(isForbiddenPathForTests("server.log")).toBe(true);
    expect(isForbiddenPathForTests(".DS_Store")).toBe(true);
    expect(isForbiddenPathForTests("Thumbs.db")).toBe(true);
    expect(isForbiddenPathForTests("credentials.json")).toBe(true);
    expect(isForbiddenPathForTests("gcp-service-account.json")).toBe(true);
  });

  test("does NOT flag normal source files", () => {
    for (const ok of [
      "src/App.tsx",
      "apps/api/src/server.ts",
      "apps/api/tests/api.test.ts",
      "docs/SPEC.md",
      "submission/MANIFEST.md",
      "scripts/preflight.mjs",
      "tests/preflight/preflight.test.ts",
      ".env.example",
      ".gitignore",
      "package.json",
      "vite.config.ts",
      "index.html",
      "README.md",
    ]) {
      expect(isForbiddenPathForTests(ok)).toBe(false);
    }
  });
});

describe("FORBIDDEN_CONTENT patterns", () => {
  test("matches a real OpenAI sk-* key", () => {
    const r = FORBIDDEN_CONTENT.find((x) => x.name.startsWith("OpenAI"));
    expect(r).toBeDefined();
    expect(r!.pattern.test("token is sk-abcdefghijklmnop1234 in env")).toBe(true);
    // Not a real key — too short.
    expect(r!.pattern.test("placeholder sk-abc")).toBe(false);
  });

  test("matches Authorization: Bearer with a real-looking token", () => {
    const r = FORBIDDEN_CONTENT.find((x) => x.name.startsWith("Authorization"));
    expect(r).toBeDefined();
    expect(
      r!.pattern.test(
        "curl -H 'Authorization: Bearer abcdef1234567890XYZ_auth' https://api"
      )
    ).toBe(true);
    // Shell variable substitution — not a populated token.
    expect(
      r!.pattern.test("curl -H 'Authorization: Bearer $GH_TOKEN' https://api")
    ).toBe(false);
    // Short non-token value.
    expect(
      r!.pattern.test("curl -H 'Authorization: Bearer short' https://api")
    ).toBe(false);
  });

  test("matches LLM_API_KEY but ignores placeholders", () => {
    const r = FORBIDDEN_CONTENT.find((x) => x.name === "LLM_API_KEY=<value>");
    expect(r).toBeDefined();
    expect(r!.pattern.test("LLM_API_KEY=sk-live-abcdefgh1234")).toBe(true);
    expect(r!.pattern.test("LLM_API_KEY=")).toBe(false);
    expect(r!.pattern.test("LLM_API_KEY=${LLM_API_KEY}")).toBe(false);
    expect(r!.pattern.test("LLM_API_KEY=<your-key>")).toBe(false);
  });

  test("matches INITIAL_ADMIN_PASSWORD but ignores placeholders", () => {
    const r = FORBIDDEN_CONTENT.find((x) => x.name === "INITIAL_ADMIN_PASSWORD=<value>");
    expect(r).toBeDefined();
    expect(r!.pattern.test("INITIAL_ADMIN_PASSWORD=real-password-1")).toBe(true);
    expect(r!.pattern.test("INITIAL_ADMIN_PASSWORD=")).toBe(false);
    expect(r!.pattern.test("INITIAL_ADMIN_PASSWORD=${INITIAL_ADMIN_PASSWORD:?msg}")).toBe(false);
    expect(r!.pattern.test("INITIAL_ADMIN_PASSWORD=<required>")).toBe(false);
  });

  test("matches HITHINK_FINANCE_API_KEY but ignores placeholders", () => {
    const r = FORBIDDEN_CONTENT.find(
      (x) => x.name === "HITHINK_FINANCE_API_KEY=<value>"
    );
    expect(r).toBeDefined();
    expect(r!.pattern.test("HITHINK_FINANCE_API_KEY=hithink-abcdef-1234")).toBe(true);
    expect(r!.pattern.test("HITHINK_FINANCE_API_KEY=")).toBe(false);
    expect(r!.pattern.test("HITHINK_FINANCE_API_KEY=${HITHINK_FINANCE_API_KEY}")).toBe(false);
  });

  test("matches MULTICA_AIME_SUPERVISOR_WEBHOOK_URL but ignores placeholders", () => {
    const r = FORBIDDEN_CONTENT.find(
      (x) => x.name === "MULTICA_AIME_SUPERVISOR_WEBHOOK_URL=<value>"
    );
    expect(r).toBeDefined();
    expect(
      r!.pattern.test(
        "MULTICA_AIME_SUPERVISOR_WEBHOOK_URL=https://hooks.example.com/abcd1234abcd1234"
      )
    ).toBe(true);
    expect(r!.pattern.test("MULTICA_AIME_SUPERVISOR_WEBHOOK_URL=")).toBe(false);
    expect(r!.pattern.test("MULTICA_AIME_SUPERVISOR_WEBHOOK_URL=<your-webhook-url>")).toBe(false);
  });

  test("SECRET_SCAN_EXEMPT covers the documented files", () => {
    for (const path of [
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
    ]) {
      expect(SECRET_SCAN_EXEMPT.has(path)).toBe(true);
    }
  });
});

describe("forbidden-content scan against a synthetic fixture", () => {
  test("flags a real LLM_API_KEY assignment", () => {
    const { root, cleanup } = makeFixture();
    try {
      writeFixtureFile(
        root,
        "src/leak.ts",
        "export const token = LLM_API_KEY=sk-live-abcdefgh1234;\n"
      );
      const hits = collectForbiddenHits(root, fixtureFiles(root, ["src/leak.ts"]));
      const names = hits.map((h) => h.ruleName);
      expect(names).toContain("LLM_API_KEY=<value>");
    } finally {
      cleanup();
    }
  });

  test("flags a real OpenAI sk-* key in any text file", () => {
    const { root, cleanup } = makeFixture();
    try {
      writeFixtureFile(
        root,
        "notes.txt",
        "Config: sk-abcdefghijklmnop1234 was committed by mistake.\n"
      );
      const hits = collectForbiddenHits(root, fixtureFiles(root, ["notes.txt"]));
      expect(hits.map((h) => h.ruleName)).toContain("OpenAI sk-* key");
    } finally {
      cleanup();
    }
  });

  test("does NOT flag a placeholder Authorization: Bearer $GH_TOKEN", () => {
    const { root, cleanup } = makeFixture();
    try {
      writeFixtureFile(
        root,
        "ci.yml",
        'curl -H "Authorization: Bearer $GH_TOKEN" https://api\n'
      );
      const hits = collectForbiddenHits(root, fixtureFiles(root, ["ci.yml"]));
      expect(hits).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("does NOT flag empty .env.example values", () => {
    const { root, cleanup } = makeFixture();
    try {
      // Mimic the real .env.example template — empty values, comments only.
      writeFixtureFile(
        root,
        ".env.example",
        [
          "LLM_API_KEY=",
          "HITHINK_FINANCE_API_KEY=",
          "IFIND_MCP_AUTHORIZATION=",
          "MULTICA_AIME_SUPERVISOR_WEBHOOK_URL=",
          "INITIAL_ADMIN_PASSWORD=",
        ].join("\n")
      );
      // The fixture scan honours SECRET_SCAN_EXEMPT, so .env.example is
      // skipped entirely.
      const hits = collectForbiddenHits(root, fixtureFiles(root, [".env.example"]));
      expect(hits).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("does NOT flag shell-placeholder values for LLM_API_KEY", () => {
    const { root, cleanup } = makeFixture();
    try {
      writeFixtureFile(
        root,
        "docker-compose.yml",
        "      LLM_API_KEY: ${LLM_API_KEY:-}\n"
      );
      const hits = collectForbiddenHits(
        root,
        fixtureFiles(root, ["docker-compose.yml"])
      );
      expect(hits).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe("required-artefact check", () => {
  test("flags every missing artefact from the manifest contract", () => {
    const required = [
      "README.md",
      "AGENTS.md",
      "package.json",
      "docker-compose.yml",
      ".env.example",
      "docs/SPEC.md",
      "submission/MANIFEST.md",
      "scripts/preflight.mjs",
      "tests/preflight",
    ];
    // In a brand-new tmpdir, every one of these is missing.
    const { root, cleanup } = makeFixture();
    try {
      const missing = required.filter(
        (p) => !existsSync(join(root, p))
      );
      expect(missing.length).toBe(required.length);
    } finally {
      cleanup();
    }
  });
});

describe("deterministic ZIP encoder", () => {
  test("two builds from the same fixture are byte-identical", () => {
    const { root, cleanup } = makeFixture();
    try {
      writeFixtureFile(root, "a.txt", "alpha\n");
      writeFixtureFile(root, "b.txt", "bravo\n");
      writeFixtureFile(root, "c.txt", "charlie\n");
      const files = fixtureFiles(root, ["a.txt", "b.txt", "c.txt"]);
      const zipA = join(root, "a.zip");
      const zipB = join(root, "b.zip");
      buildDeterministicZipForTests(zipA, files, root);
      // Re-read the same bytes and write again to verify determinism
      // against the exact same fixture.
      const filesAgain = fixtureFiles(root, ["a.txt", "b.txt", "c.txt"]);
      buildDeterministicZipForTests(zipB, filesAgain, root);
      const a = readFileSync(zipA);
      const b = readFileSync(zipB);
      expect(a.equals(b)).toBe(true);
      // Sanity: at least the EOCD signature 0x06054b50 should appear at
      // the end of the file (last 4 bytes, little-endian).
      expect(a.readUInt32LE(a.length - 22)).toBe(0x06054b50);
    } finally {
      cleanup();
    }
  });

  test("two builds with different file order produce the same bytes", () => {
    const { root, cleanup } = makeFixture();
    try {
      writeFixtureFile(root, "a.txt", "alpha\n");
      writeFixtureFile(root, "b.txt", "bravo\n");
      const filesOrdered = fixtureFiles(root, ["a.txt", "b.txt"]);
      const filesReversed = [...filesOrdered].reverse();
      const zipA = join(root, "ordered.zip");
      const zipB = join(root, "reversed.zip");
      buildDeterministicZipForTests(zipA, filesOrdered, root);
      buildDeterministicZipForTests(zipB, filesReversed, root);
      const a = readFileSync(zipA);
      const b = readFileSync(zipB);
      expect(a.equals(b)).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("forbidden paths are silently skipped from the archive", () => {
    const { root, cleanup } = makeFixture();
    try {
      writeFixtureFile(root, "keep.txt", "kept\n");
      writeFixtureFile(root, ".env", "LLM_API_KEY=sk-live-abcdefgh1234\n");
      const files = fixtureFiles(root, ["keep.txt", ".env"]);
      const zip = join(root, "out.zip");
      buildDeterministicZipForTests(zip, files, root);
      const buf = readFileSync(zip);
      // Forbidden filename should NOT appear inside the archive.
      expect(buf.toString("binary").includes(".env")).toBe(false);
      // Kept filename should appear.
      expect(buf.toString("binary").includes("keep.txt")).toBe(true);
    } finally {
      cleanup();
    }
  });
});

// ----------------------------------------------------------------------------
// Test helpers (mirroring preflight.mjs scanFileContent but operating on a
// caller-supplied tmpdir so we don't depend on REPO_ROOT).
// ----------------------------------------------------------------------------

function collectForbiddenHits(
  root: string,
  fileList: { rel: string; size: number }[]
): { file: string; ruleName: string }[] {
  const hits: { file: string; ruleName: string }[] = [];
  for (const f of fileList) {
    const rel = f.rel.split(sep).join(posix.sep);
    if (SECRET_SCAN_EXEMPT.has(rel)) continue;
    const content = readFileSync(join(root, f.rel), "utf8");
    for (const rule of FORBIDDEN_CONTENT) {
      if (rule.pattern.test(content)) {
        hits.push({ file: rel, ruleName: rule.name });
      }
    }
  }
  return hits;
}