## ELI-343 minimum demo checkpoint

This checkpoint records the code-level regression evidence for the canonical
three-security/five-event narrative. It is not a claim that live provider
data was available in this environment.

### Candidate and execution

- Candidate: record the exact commit SHA in the issue handoff after commit.
- Mode: deterministic API tests with a provider response containing MiniMax-style
  `<think>` reasoning followed by JSON.
- Command: `cd apps/api && bun test`
- Additional check: `cd apps/api && bun run typecheck`

### Assertions covered

- The extractor accepts reasoning-model output and keeps JSON after `<think>`.
- Output capacity is 4096 tokens, avoiding the prior 1800-token truncation.
- Each repeated order attempt is an independent decision entry: 1 executed buy,
  1 unresolved/approximate sell, and 3 unfilled attempts remain 5 records.
- Repeated attempts retain `executedAt=null`; no position is created from an
  unfilled order. `20手` and `8手` remain 2000 and 800 shares respectively.
- Existing session tests continue to enforce approximate-T0 confirmation,
  ex-ante/empty-provider failure semantics, and grounded-learning gating.

### Live-data limitation

Real Fuyao/iFinD retrieval still depends on operator-provided per-intent MCP
tool maps (`HITHINK_FINANCE_TOOL_MAP` / `IFIND_MCP_TOOL_MAP`). Empty maps must
remain an explicit provider-gap/partial result; this checkpoint does not invent
tool names or claim real evidence.
