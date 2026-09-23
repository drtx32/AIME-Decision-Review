# Third-party and attribution review

Checked for the final submission candidate on 2026-09-23.

## Direct dependencies

| Dependency | Declared version | License | Use |
| --- | --- | --- | --- |
| React / React DOM | 19.3.0 | MIT | Web UI |
| Vite / @vitejs/plugin-react | 8.3.0 / 6.1.1 | MIT | Web build |
| TypeScript | 7.0.2 | Apache-2.0 | Type checking |
| lucide-react | 1.47.0 | ISC | UI icons |
| Hono | 4.6.14 | MIT | API HTTP framework |
| @openai/agents | 0.1.9 | MIT | Agent SDK primitives |
| openai | 5.23.2 | Apache-2.0 | OpenAI-compatible provider client |
| Zod | 3.23.8 | MIT | Runtime schemas |

Lockfiles remain the reproducibility source of truth for transitive dependencies.

## Hermes WebUI reference boundary

Hermes WebUI was used as an interaction/layout reference for chat-shell, activity/worklog, composer, session and warning-state behavior. AIME does not vendor or redistribute the Hermes WebUI source tree or assets in this repository. Any copied code must retain its upstream license/attribution; the final preflight should verify that no incompatible vendored source was introduced during the deadline integration.

## Fonts and external assets

The web UI may load Google Fonts referenced by stylesheet declarations. The submission package does not intentionally bundle font binaries; deployments without external font access fall back to system font stacks.

## External services

Fuyao, iFinD and the configured LLM provider are external services accessed through server-side configuration. Credentials, private gateway dumps and proprietary response payloads must not be committed or included in the submission archive.
