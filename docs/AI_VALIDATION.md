# AI Usage & Validation Log

This file records how AI tools are used in the project, what they generated, how outputs were checked, and what humans corrected.

## Rules

- Never paste secrets, API keys, Authorization headers, cookies, or sensitive user data.
- Record material AI-assisted implementation/design decisions.
- Distinguish AI-generated suggestions from verified results.
- For important financial outputs, record how evidence/claims were validated.
- Update this file during development.

## Entry template

### YYYY-MM-DD HH:MM — <task>

**AI/tool used**
- Agent/model/tool:

**Task**
- What AI was asked to do:

**Output**
- What it produced:

**Validation**
- Commands/tests/manual checks performed:
- Data/evidence cross-checks:

**Human corrections**
- What was changed, rejected, or constrained:

**Residual risk / unresolved**
- What is still uncertain:

---

## Initial project decisions — 2026-09-22

**AI/tool used**
- ChatGPT for product architecture and task decomposition
- Multica agents for parallel frontend/backend implementation

**Task**
- Convert AIME topic 11 “Investment Decision Review & Learning” into an executable MVP architecture.

**Output**
- React/Vite/Bun frontend plan
- Bun/Hono/OpenAI Agents SDK backend plan
- T0 ex-ante/ex-post evidence design
- Fuyao + iFinD MCP registry strategy
- bounded reflection and tool error semantics

**Validation**
- Checked against assignment requirements: runnable Web product, source repository, README, AI usage/validation record, testing, evidence traceability, and explicit handling of missing/conflicting/failed data.

**Human corrections**
- Scope reduced to a single-agent MVP.
- Streamlit rejected in favor of React/Vite/TypeScript/Bun.
- Heavy sandbox/runtime work rejected as unnecessary.
- Fuyao fund/futures/options retained because cross-asset evidence can matter in stock decision review.
- iFinD servers configured broadly but intended for lazy/intent-based loading.

**Residual risk / unresolved**
- Real MCP capabilities still need live verification per server.
- LLM provider compatibility and production deployment need integration testing.
