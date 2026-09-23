# Third-party and attribution review

Checked 2026-09-23 against the tracked source tree and the declared lockfiles.
The repository contains no copied third-party source tree, vendored binary,
Hermes reference, or Hermes-specific asset. `rg` found no `Hermes`/license
reference requiring attribution beyond the dependencies below.

## Direct runtime/build dependencies

License identifiers were checked against package metadata for the declared
versions; the lockfiles remain the reproducibility source of truth.

| Dependency | Declared version | License | Use |
| --- | --- | --- | --- |
| React / React DOM | `19.3.0` | MIT | Web UI |
| Vite / `@vitejs/plugin-react` | `8.3.0` / `6.1.1` | MIT | Web build |
| TypeScript | `7.0.2` | Apache-2.0 | Type checking |
| `lucide-react` | `1.47.0` | ISC | UI icons |
| Hono | `4.6.14` | MIT | API HTTP framework |
| `@openai/agents` | `0.1.9` | MIT | Agent SDK primitives |
| `openai` | `5.23.2` | Apache-2.0 | OpenAI-compatible provider client |
| Zod | `3.23.8` | MIT | Runtime schemas |

The Bun runtime and standard-library modules are runtime prerequisites, not
vendored application code. Transitive dependency notices remain in their
package distributions; this project does not redistribute their source.

## Fonts and external assets

`src/styles.css` references Google Fonts CSS for Manrope and DM Mono. These
fonts are published under the SIL Open Font License 1.1 by their respective
authors. The submission archive does not bundle font binaries; a deployment
without Google Fonts access falls back to the declared system/font-family
stack.

## Attribution boundary

Fuyao, iFinD, and MiniMax are external services configured through server-only
environment variables. No service credential, proprietary response dump, or
private gateway asset is committed. Sanitized provider evidence in
`docs/AI_VALIDATION.md` records service names and transport behavior only.
