# Submission skeleton

This directory holds the **submission skeleton** for AIME Decision Review.
It is the reproducible pre-submit package: a manifest, validation record,
deployment evidence template, license inventory, and a preflight script
that verifies the working tree is submission-ready before the final ZIP is
produced.

The skeleton is intentionally **commit-free of evidence we cannot prove**:
`submission/DEPLOYMENT_EVIDENCE.template.md` is a template; once the real
production deployment runs and a human records the URL, image tag, smoke
tests, and timestamps, the template is replaced with a populated
`submission/DEPLOYMENT_EVIDENCE.md` that the preflight will then validate.

## Files

| File                                       | Purpose                                                |
|--------------------------------------------|--------------------------------------------------------|
| `MANIFEST.md`                              | Required artefacts, forbidden patterns, ZIP naming      |
| `PROJECT_DESCRIPTION.md`                   | Submission-facing 1–2 page summary (Problem / Solution / Key Features / Agent Workflow / MCP+data / canonical example / technical highlights / known limitations) |
| `DEMO_SCRIPT.md`                           | 60–180s demo-video storyboard (no recording is fabricated) |
| `DEPLOYMENT_EVIDENCE.template.md`          | Deployment evidence template (fill in after deploy)     |
| `LICENSE_INVENTORY.md`                     | Third-party attribution + inspiration/copy distinctions|
| `TEST_NOTES.md`                            | Known boundaries + test status by `TEST_PLAN.md` case, golden-path matrix |
| `AI_VALIDATION_RECORD.md`                  | AI usage record, separating fixture vs real validation |
| `BUILD_INFO.txt` (generated)                | Commit SHA + dirty state + builder timestamp            |

## How to use

```bash
# 1. Run the preflight script from the repository root.
node scripts/preflight.mjs

# 2. (Optional) Produce the deterministic submission ZIP.
node scripts/preflight.mjs --zip ./dist/aime-decision-review.zip

# 3. Run the bun:test coverage for the preflight itself.
cd apps/api && bun test ../../tests/preflight/
```

The script exits non-zero if:

- any required artefact listed in `MANIFEST.md` §1 is missing;
- the working tree contains any forbidden path or named file from §2.1;
- the working tree contains forbidden content from §2.2;
- the working tree is dirty (uncommitted changes) **and** `--allow-dirty` is
  not passed (default: dirty tree → warn, exit 0, unless `--strict` is
  passed).

## What this skeleton deliberately does NOT do

- It does not deploy the product. Production deployment is a separate task
  driven by `docs/DEPLOYMENT.md` and recorded in `DEPLOYMENT_EVIDENCE.md`.
- It does not fabricate validation evidence. `AI_VALIDATION_RECORD.md`
  marks every entry as **fixture** (mock LLM + mock MCP) until a real
  credentialed run is recorded by a human.
- It does not modify the main React shell (`src/App.tsx`,
  `src/api.ts`, `src/auth-api.ts`, `src/styles.css`, `src/main.tsx`).

## Status of this skeleton

The skeleton itself ships in a **green state** as soon as the preflight
script reports "OK". Validation/deployment evidence is **not** part of the
skeleton — those slots remain explicit placeholders until a real run
exists.