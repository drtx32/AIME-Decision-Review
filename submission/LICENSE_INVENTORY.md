# License & third-party attribution inventory

This file lists every third-party dependency, asset, and reference that
ships in (or shapes) the submission archive. It is the authoritative
inventory for license compliance and for distinguishing **inspiration /
reference** from **copied** code.

## 1. Direct dependencies

All direct dependencies are pulled from the npm / Bun public registries
and ship under their own licenses. The versions and hashes are recorded in
the relevant lockfile (`package-lock.json` for the frontend,
`apps/api/bun.lock` for the backend) and reproducible with `npm ci` and
`bun install --frozen-lockfile`.

### 1.1 Frontend (`package.json`)

| Package                  | Version  | License             | Source                          |
|--------------------------|----------|---------------------|---------------------------------|
| react                    | latest   | MIT                 | https://github.com/facebook/react |
| react-dom                | latest   | MIT                 | https://github.com/facebook/react |
| @vitejs/plugin-react     | latest   | MIT                 | https://github.com/vitejs/vite-plugin-react |
| vite                     | latest   | MIT                 | https://github.com/vitejs/vite   |
| typescript               | latest   | Apache-2.0          | https://github.com/microsoft/TypeScript |
| lucide-react             | latest   | ISC                 | https://github.com/lucide-icons/lucide |

No `echarts` dependency ships in this submission — see §3.1.

### 1.2 Backend (`apps/api/package.json`)

| Package          | Version  | License             | Source                              |
|------------------|----------|---------------------|--------------------------------------|
| @openai/agents   | ^0.1.9   | MIT                 | https://github.com/openai/openai-agents-js |
| hono             | ^4.6.5   | MIT                 | https://github.com/honojs/hono       |
| openai           | ^5.23.2  | Apache-2.0          | https://github.com/openai/openai-node |
| zod              | ^3.23.8  | MIT                 | https://github.com/colinhacks/zod    |

Dev:

| Package          | Version  | License             | Source                              |
|------------------|----------|---------------------|--------------------------------------|
| @types/bun       | ^1.2.0   | MIT                 | https://github.com/oven-sh/bun-types |
| typescript       | ^5.7.2   | Apache-2.0          | https://github.com/microsoft/TypeScript |

### 1.3 Container base images

| Image (Dockerfile) | Tag                | License             |
|--------------------|--------------------|---------------------|
| `oven/bun`         | `1.2` / `1.2-slim` | MIT                 |
| `node`             | `22-alpine`        | MIT                 |

### 1.4 Infrastructure images

| Image            | Tag           | License             |
|------------------|---------------|---------------------|
| `nginx`          | `1.27-alpine` | BSD-2-Clause        |
| `alpine` (CI)    | `latest`      | MIT                 |

## 2. Inspirations and references

The codebase draws on public API shapes and protocol primitives but does
**not** copy source code from these references. The distinction matters
for license compliance — copying source under a non-permissive license
would require an explicit attribution; reading a public schema and
implementing an equivalent interface from scratch does not.

### 2.1 Hermes WebUI

- **What we read**: the **public REST surface** (routes, request/response
  shapes, and SSE conventions) of the Hermes WebUI demo.
- **What we did NOT do**: copy any TypeScript or Python source. We did
  not vendor any file, image, asset, prompt, or generated text.
- **Implementation**: every backend route in `apps/api/src/routes/api.ts`
  is implemented from the canonical `docs/SPEC.md` (§17). The shape is
  informed by common REST conventions that Hermes WebUI also follows;
  when in doubt the SPEC wins.
- **License of the inspiration**: not applicable (we did not incorporate
  source).

### 2.2 ECharts

- **What we asked for**: chart visualisation on the Result page.
- **What we did NOT do**: add `echarts` as a runtime dependency. The
  Result page in `src/App.tsx` renders attribution / lesson / evidence
  content as plain text and styled cards. Chart visualisation is
  intentionally deferred — the UI contract is text + structured cards,
  matching the T0 split.
- **Implementation**: no chart library ships in this submission ZIP. If
  charts are added in a follow-up, they must come from `echarts`
  (Apache-2.0) and `echarts-for-react` (MIT), both under permissive
  licenses.

### 2.3 OpenAI Agents SDK TS

- **What we use**: `@openai/agents` (MIT, see §1.2) for agent loop /
  tool-call plumbing primitives. The Decision Review Agent in
  `apps/api/src/agents/decision-review.ts` is original code that drives
  the SDK primitives; it does not copy any sample or example agent
  from the SDK repository.

### 2.4 Hono

- **What we use**: `hono` (MIT, see §1.2) as the HTTP framework. We use
  only the documented public API; no vendored source.

### 2.5 Bun + bun:sqlite

- **What we use**: `oven/bun` runtime and the built-in `bun:sqlite`
  driver (MIT). No vendored source.

## 3. Things deliberately NOT vendored

- **`.env`** with real credentials — never present, never committed.
- **Production SQLite database** — the `api-data` volume is host-only;
  no `*.db` ships in the submission archive (see
  `submission/MANIFEST.md` §2.3).
- **Any generated artefact that contains real LLM output** — no real LLM
  call has been recorded, so there is nothing to ship.
- **Any asset, screenshot, or video containing a real customer decision
  or real account data** — none exist in this submission.

## 4. Submission license

The AIME Decision Review source code in this repository is the original
work of the contributors listed in git history and is provided under the
license declared at the repository root (to be added by the maintainers
in a follow-up; until then, the default copyright notice applies). All
third-party packages in §1 retain their own licenses; this submission does
not relicense or sublicense any of them.

## 5. Attribution template

When a third-party asset or library is added in a follow-up PR, append a
row to the matching table above and (if the license requires it) add an
attribution block to the relevant README section.