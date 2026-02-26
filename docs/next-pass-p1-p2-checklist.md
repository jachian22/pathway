# Next Pass Checklist (P1/P2)

Last updated: 2026-02-26
Owner: Chat + Intelligence stack

## Current Status (2026-02-26)

- `P1.1` Implemented
- `P1.2` Implemented
- `P1.3` Partially implemented (`decline_adjustment`, `evidence_question`, `baseline_update`; generic follow-up still routes to full recompute)
- `P1.4` Implemented
- `P1.5` Implemented
- `P2.x` Pending

## P1 (Must Fix Before Next External Test)

### P1.1 Competitor visibility in first insight

- Problem:
  - Competitor analysis is easy to miss because it is not consistently surfaced in first-turn UI.
- Implementation:
  - Add a dedicated `Competitor Snapshot` section in the recommendation card area.
  - Always render one line in assistant text when competitor query was submitted:
    - `Competitor check: [resolved_name]` or `Competitor check could not be resolved`.
  - Files:
    - `src/app/_components/chat/recommendation-block.tsx`
    - `src/server/services/intelligence/orchestrator.ts`
- Acceptance tests:
  - Given competitor name resolves, first assistant turn includes explicit competitor mention + competitor snapshot block.
  - Given competitor name does not resolve, first assistant turn shows explicit non-resolution message (no crash).

### P1.2 Multi-competitor free text parsing policy

- Problem:
  - Free text can include multiple competitors; behavior is ambiguous.
- Implementation:
  - Parse competitor input into candidate tokens (`,` `/` `&` `and`).
  - Use first non-empty token only (v1.1 policy).
  - Emit parse analytics fields: `competitor_candidate_count`, `competitor_selected_index`.
  - Files:
    - `src/app/_components/chat/insight-setup-panel.tsx`
    - `src/app/_components/chat/staffing-chat.tsx`
    - `src/server/services/intelligence/orchestrator.ts`
- Acceptance tests:
  - Input `A, B, C` resolves using `A` only.
  - UI/assistant text confirms which competitor was used.

### P1.3 Stop repeated full-summary text on follow-ups

- Problem:
  - Follow-up turns repeatedly output `Next 3 days ... What stands out ...` even for direct questions.
- Implementation:
  - Add follow-up intent routing:
    - `decline_adjustment` (`no`, `all set`, `looks good`)
    - `evidence_question` (where/which review mention)
    - `baseline_update`
    - `new_insight_request`
  - Only use full summary template for `new_insight_request`.
  - Files:
    - `src/app/_components/chat/staffing-chat.tsx`
    - `src/server/services/intelligence/orchestrator.ts`
- Acceptance tests:
  - User says `no` after adjustment prompt -> assistant does not ask the same adjustment question again.
  - User asks `where did you see wait times?` -> assistant answers evidence directly, no repeated summary scaffold.

### P1.4 Evidence question answering path

- Problem:
  - Evidence exists in `topRefs`, but follow-up Q&A does not reliably use it.
- Implementation:
  - Add a targeted evidence response path that selects matching refs by theme and returns 2-3 citations:
    - date
    - short excerpt
    - rating (if available)
  - Files:
    - `src/server/services/intelligence/orchestrator.ts`
    - `src/server/services/intelligence/review-signals.ts` (if weighting tweaks needed)
    - `src/app/_components/chat/recommendation-block.tsx` (no functional change required; keep drawer)
- Acceptance tests:
  - `where are wait times mentioned?` returns references with dates/snippets.
  - If insufficient evidence, assistant states that clearly instead of repeating generic claim.

### P1.5 Remove biased wait-time boilerplate defaults

- Problem:
  - Many restaurants are labeled with wait-time friction even when evidence is weak.
- Implementation:
  - Replace hard defaults:
    - `secondTheme` fallback should not default to `wait time`.
    - Theme claims require threshold (example: >=2 refs and >=30% share).
  - If threshold not met, return `insufficient recent review evidence` language.
  - Files:
    - `src/server/services/intelligence/review-signals.ts`
    - `src/server/services/intelligence/recommendation-engine.ts`
- Acceptance tests:
  - Low-evidence locations no longer emit deterministic wait-time friction claims.
  - Theme claim appears only when threshold conditions are satisfied.

## P2 (Polish + Trust Improvements)

### P2.1 De-dup across chat bubble and structured cards

- Problem:
  - Same content appears in plain bubble and cards.
- Implementation:
  - Treat bubble as concise lead + one CTA.
  - Keep rich detail in structured cards only.
  - Files:
    - `src/server/services/intelligence/orchestrator.ts` (`buildMessage`)
    - `src/app/_components/chat/recommendation-block.tsx`
- Acceptance tests:
  - Snapshot content appears in one place only.
  - Bubble length target <= 80-100 words for first insight.

### P2.2 Better conversational close behavior

- Problem:
  - Conversational flow feels forced/repetitive after user confirmation/decline.
- Implementation:
  - Track last assistant prompt type and last user intent.
  - Suppress duplicate CTA prompts across adjacent turns.
  - Files:
    - `src/app/_components/chat/staffing-chat.tsx`
    - `src/server/services/intelligence/orchestrator.ts`
- Acceptance tests:
  - No repeated identical close question across two consecutive turns unless user requests rerun.

### P2.3 Competitor + own-location visual separation

- Problem:
  - Diagnostic provenance can be unclear.
- Implementation:
  - Render separate labeled blocks:
    - `Guest Signal Snapshot (Your Location)`
    - `Competitor Snapshot (Optional)`
  - Files:
    - `src/app/_components/chat/recommendation-block.tsx`
- Acceptance tests:
  - User can visually distinguish own-location vs competitor insights instantly.

## Regression Test Matrix (Run After P1)

1. Starter cards

- Each card (`staffing`, `risk`, `opportunity`) yields distinct framing and non-identical recommendation ordering.

2. Follow-up intents

- `no`
- `we usually have 4 foh`
- `where did you see wait times?`
- `rerun with same locations`

3. Competitor handling

- Single competitor
- Multiple competitors in one input
- Unresolvable competitor

4. Reliability

- Source partial outage path still returns actionable output.
- Retry banner + retry action works and does not duplicate user message.

## Instrumentation Adds

Add events/properties to validate improvements:

- `followup_intent_routed`:
  - `intent`, `used_full_summary` (bool)
- `evidence_answered`:
  - `theme`, `ref_count`, `had_sufficient_evidence`
- `competitor_parse_applied`:
  - `candidate_count`, `selected_index`, `selected_value_hash`
- `response_deduped`:
  - `removed_snapshot_from_bubble` (bool)

## Suggested Execution Order

1. P1.5 wait-time bias thresholds
2. P1.4 evidence answer path
3. P1.3 follow-up intent routing
4. P1.1 competitor first-turn visibility
5. P1.2 multi-competitor parse policy
6. Run regression matrix
7. P2 polish items
