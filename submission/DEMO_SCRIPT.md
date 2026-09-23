# Demo video — script / storyboard

> 60–180 second storyboard for the AIME Decision Review end-to-end
> demo. **This is a script, not a recording.** No video is fabricated;
> the deliverable in this issue is the storyboard itself. The actual
> 60–180s demo recording is an optional artefact referenced in
> `submission/MANIFEST.md` §3 and `docs/SUBMISSION.md`.

## Target length

90 seconds (default). The storyboard fits in 60–180s depending on how
long the live review run takes; the scene breakdown is timing-anchored
so it can be edited to either bound.

## Scene breakdown (90s default)

| # | Scene                          | Approx. length | What the viewer sees                                                                                                          |
|---|--------------------------------|----------------|------------------------------------------------------------------------------------------------------------------------------|
| 1 | Title card                     | 0:00 – 0:05    | "AIME Decision Review — investment decision复盘" over the empty conversation shell.                                          |
| 2 | User input                     | 0:05 – 0:20    | A natural-language paragraph in the composer (the canonical Maotai trade, see `submission/PROJECT_DESCRIPTION.md`).           |
| 3 | Extraction                     | 0:20 – 0:30    | `DecisionExtractorAgent` produces one (or more) `DecisionCandidate` cards: symbol / action / time / price / rationale.      |
| 4 | Confirmation                   | 0:30 – 0:40    | The user reviews and confirms the extracted decision(s); the Review Agent is queued.                                          |
| 5 | T0 alignment                   | 0:40 – 0:50    | The review screen shows T0 (exact or approximate) prominently and begins classifying evidence around it.                      |
| 6 | Review Agent activity          | 0:50 – 1:10    | Product-level trace events stream in: `market_data_retrieved`, `index_sector_context_retrieved`, `news_events_retrieved`, `evidence_time_aligned`. |
| 7 | Findings / Evidence / Learning | 1:10 – 1:25    | The Findings / Evidence / Learning panel renders with the T0 split, decision-quality vs outcome, citations, lessons, checklist. |
| 8 | Closing card                   | 1:25 – 1:30    | Submission pointer: SHA placeholder + `submission/PROJECT_DESCRIPTION.md` + `submission/AI_VALIDATION_RECORD.md` + `docs/SPEC.md`. |

## Voice-over / on-screen text per scene

### 1 — Title card (0:00–0:05)

On screen:

> **AIME Decision Review**
> Investment decision review · T0-frozen · ex-ante vs ex-post

### 2 — User input (0:05–0:20)

The composer fills with the canonical input:

```text
我 2024-03-15 在 ¥1,720 买了 600519（贵州茅台）。
当时看了 2023 年报，现金流稳定，估值回到五年中枢。
二季度回调我扛住了，三季度反弹。
```

On-screen caption: "自然语言描述一笔历史投资决策" (Natural-language
description of one historical decision.)

### 3 — Extraction (0:20–0:30)

`DecisionExtractorAgent` returns one `DecisionCandidate` card. Visible
fields:

- Symbol: `600519`
- Name: `贵州茅台`
- Action: `buy`
- Market: `CN`
- Executed at: `2024-03-15T…Z` (exact)
- Price: `¥1,720`
- Time precision: `exact`
- Confidence: `0.91`
- `needsConfirmation`: `[]`

On-screen caption: "DecisionExtractorAgent — 只做结构化抽取，不做复盘"
(Extraction only; no review.)

### 4 — Confirmation (0:30–0:40)

The user clicks **确认** (Confirm). The shell transitions to Running
state. On-screen caption: "用户确认后进入 DecisionReviewAgent"
(After confirmation, enter DecisionReviewAgent.)

### 5 — T0 alignment (0:40–0:50)

The center conversation area shows:

- T0: `2024-03-15` (exact)
- "ex-ante evidence cutoff: ≤ 2024-03-14T23:59:59Z"
- "ex-post evidence floor: > 2024-03-29T00:00:00Z" (illustrative)

A divider line splits the panel vertically: ex-ante (left) /
ex-post (right). On-screen caption: "T0 锁定 — 仅 ex-ante 评估决策质量"
(T0 frozen — only ex-ante evidence evaluates decision quality.)

### 6 — Review Agent activity (0:50–1:10)

Product-level trace events stream in the center column. Suggested
sequence (driven by the deterministic mock path; a credentialed live
path will look the same at the event layer):

```text
[planning]      review.created           T0 = 2024-03-15
[planning]      plan.ready              intents=[a-share, a-share-index, news, edb, enterprise]
[retrieving]    market_data_retrieved   fuyao:a-share       (success, 8 items, ≤ T0)
[retrieving]    index_sector_context    fuyao:a-share-index (success, 2 items, ≤ T0)
[retrieving]    news_events_retrieved   ifind:news          (success, 5 items, split by T0)
[retrieving]    macro_retrieved         ifind:edb           (success, 3 items, ≤ T0)
[retrieving]    corporate_filings       ifind:enterprise    (success, 2 items, ≤ T0)
[analyzing]     evidence_time_aligned   ex_ante=20, ex_post=4
[analyzing]     fact_consistency_checked
[reflecting]    reflection              passed
[completed]     final_review_generated
```

On-screen caption: "DecisionReviewAgent — 一次有界反思，无隐藏 CoT"
(One bounded reflection, no hidden chain-of-thought.)

### 7 — Findings / Evidence / Learning (1:10–1:25)

The right-side panel renders:

- **Findings**: T0 split, decision-quality vs outcome (separate cards).
- **Evidence**: a list of citation cards with title, source, source URL,
  `publishedAt`, `retrievedAt`, `relationToDecision` (exAnte / exPost),
  and `confidence`.
- **Learning**: lessons + next-decision checklist, each grounded in the
  evidence above.

On-screen caption: "决策质量 ≠ 收益；T0 后信息不评判原决策。"
(Decision quality ≠ P&L; ex-post evidence does not judge the original
decision.)

### 8 — Closing card (1:25–1:30)

On screen:

```text
AIME Decision Review
Repository · <final SHA placeholder>
Docs · submission/PROJECT_DESCRIPTION.md
       docs/SPEC.md · docs/AI_VALIDATION.md
       submission/AI_VALIDATION_RECORD.md · submission/TEST_NOTES.md
```

## Asset list (not fabricated; for the actual recording)

The following assets would be used by the actual recording once
production deploy evidence is recorded:

| Asset                                                  | Source                                          |
|--------------------------------------------------------|-------------------------------------------------|
| Empty conversation shell                               | `src/App.tsx` (Home state)                       |
| Filled composer with the canonical input                     | Scene 2 caption above                            |
| `DecisionCandidate` card                                | Scene 3 (extractor output rendered in Running state) |
| Confirm / Running transition                           | Scene 4                                         |
| T0 split visual                                         | `docs/SPEC.md` §18; `src/App.tsx` Result state  |
| Trace events list                                       | `apps/api/src/agents/decision-review.ts` (deterministic) |
| Findings / Evidence / Learning panel                   | Right panel of `src/App.tsx` Result state        |
| Final SHA placeholder card                             | From `scripts/preflight.mjs` `BUILD_INFO.txt`     |

## What the demo intentionally does NOT show

- **No real LLM call trace.** The trace events are the same on mock and
  live paths; the demo does not claim a credentialed LLM call.
- **No real Fuyao / iFinD response.** The mock adapters produce the
  same shape and labels as the live adapters; the demo does not claim
  a credentialed MCP call.
- **No real account credentials.** The composer / login / token fields
  never appear with values in the recording.
- **No hidden chain-of-thought.** The trace column shows
  product-level events only (per `docs/SPEC.md` §15); the `<think>`
  blocks the LLM produces are stripped before they reach the SSE
  consumer.

## Recording prerequisites

The actual recording can be produced once the following are all green
on the exact final SHA:

- `node scripts/preflight.mjs` reports 0 errors.
- `cd apps/api && bun test` is green (full `bun test` plus the preflight
  `bun test ../../tests/preflight/`).
- `submission/DEPLOYMENT_EVIDENCE.md` is filled in with URL, image SHA,
  deploy timestamp, and health / smoke evidence — i.e. a real public
  Web URL is reachable from a clean browser.
- `docs/AI_VALIDATION.md` has a recorded credentialed LLM + Fuyao +
  iFinD validation entry (not just fixture entries).

Until those are recorded, this storyboard remains the deliverable; the
recording itself is intentionally not produced.