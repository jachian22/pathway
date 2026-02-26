# Agentic Chat Implementation Plan (v1.2)

Last updated: 2026-02-26
Owner: Chat + Intelligence
Status: Implemented (shadow-mode backlog excluded by decision)

## 1) Goal

Move from a mostly rules-first chat flow to a hybrid agentic system where:

- the model decides what tools to call and how to synthesize signals
- deterministic policy code enforces safety, latency, and output guarantees
- UI still receives structured recommendation data for cards and analytics

## 2) Non-goals for v1.2

- No full autonomous multi-agent graph
- No unconstrained free-form responses without schema validation
- No expansion beyond NYC staffing/prep scope
- No increase above one competitor review check per session
- No shadow-mode dual-run in v1.2 (deferred)

## 3) Target architecture

Hybrid controller:

1. Policy precheck layer (deterministic)
- input limits, NYC scope, session constraints

2. Agent planning and tool-use layer (LLM)
- selects relevant tools per turn
- runs with tool-call and time budgets

3. Policy postcheck layer (deterministic)
- confidence caps
- freshness caps
- output schema validation and one repair pass

4. Renderer contract
- short narrative + structured `recommendations[]` + optional snapshots

## 3.1 Execution contract (serial-first)

Per turn execution order:

1. Serial
- load session state
- derive turn intent
- resolve locations and scope

2. Parallel (safe/idempotent reads only)
- fetch `weather`, `events`, `closures` core bundle
- fetch `doe` and `reviews` conditionally

3. Serial
- LLM synthesis over gathered context
- deterministic policy validation/repair
- persist messages, tool calls, recommendations

## 3.2 Bootstrap context pattern (compiled)

Use versioned compiled context each turn instead of large raw markdown injection:

- `identity_context` (Patty persona + mission)
- `tool_contract_context` (tool semantics and limits)
- `session_memory_context` (locations, baselines, assumptions)

Implementation note:
- Build in code with explicit version tags:
  - `prompt_version`
  - `tool_contract_version`
  - `policy_version`

## 4) Runtime policy (hard guardrails)

- Max tool calls per turn: `8`
- Max tool rounds per turn: `2`
- Max wall-clock budget per turn: `4500ms`
- Required response object:
  - `narrative`
  - `recommendations[]`
  - `assumptions[]`
  - `follow_up_question`
- Recommendation schema remains:
  - action
  - time window
  - confidence
  - source + freshness
- Confidence caps enforced in code:
  - unresolved assumption -> max `medium`
  - stale primary source -> max `low`
  - all sources unavailable -> forced `low` + `system`
- Source citation rule:
  - no recommendation without at least one supporting tool result unless fallback path

## 5) Tool strategy

First insight default behavior:

- Always fetch core signals in parallel:
  - weather
  - events
  - closures
- Conditionally fetch:
  - DOE (if weekday/lunch/day-mix context is relevant)
  - reviews (if location is confirmed and signal is potentially useful)
  - competitor reviews only on explicit ask

Follow-up behavior:

- Agent chooses smallest relevant subset of tools
- Use cache-first + stale-while-revalidate
- Allow explicit user refresh to force live fetch

## 6) Implementation phases

## Phase A: Contracts and scaffolding

Deliverables:

- Add agent response schema and validator
- Add tool interfaces and typed tool results
- Add feature flag for agent path
- Add compiled bootstrap context builder and versioning
- Separate advisory prompt rules from hard policy rules in code

Code targets:

- `src/server/services/intelligence/agent/schema.ts`
- `src/server/services/intelligence/agent/tools.ts`
- `src/server/services/intelligence/agent/prompt.ts`
- `src/server/services/intelligence/agent/controller.ts`
- `src/server/services/intelligence/agent/context.ts`
- `src/server/services/intelligence/agent/versions.ts`
- `src/env.js` for `INTELLIGENCE_AGENT_MODE` flag

Acceptance:

- Schema validator rejects malformed model output
- Existing rules path unchanged when flag is off
- Prompt context includes explicit version fields

## Phase B: Tool-calling loop

Deliverables:

- Implement OpenRouter tool-call loop with budgets
- Support up to 2 rounds and 8 calls
- Stop conditions for timeout, call cap, or sufficient evidence
- Add source circuit-breaker behavior for repeated failures/timeouts

Code targets:

- `src/server/services/openrouter.ts` (tool-call support)
- `src/server/services/intelligence/agent/controller.ts`
- `src/server/services/intelligence/agent/circuit-breaker.ts`

Acceptance:

- Tool loop exits deterministically on all paths
- No infinite loops
- Timeout path returns conservative fallback
- Failing source is short-circuited within turn once breaker threshold is reached

## Phase C: Policy enforcement and repair

Deliverables:

- Post-processing policy layer:
  - confidence caps
  - freshness caps
  - assumption disclosure
- One-pass repair prompt when schema fails
- Enforce "no source citation -> no hard recommendation" unless fallback path

Code targets:

- `src/server/services/intelligence/agent/policy.ts`
- `src/server/services/intelligence/agent/controller.ts`

Acceptance:

- Every turn ends with format-compliant recommendations
- Invalid model output is repaired or safely downgraded

## Phase D: Orchestrator integration

Deliverables:

- Route `runFirstInsight` through agent path when flag is enabled
- Keep deterministic path available as fallback
- Preserve current DB writes and observability chain
- Add per-session mutex (lane behavior) to prevent concurrent turn races
- Add idempotency key per turn to prevent duplicate writes on retry

Code targets:

- `src/server/services/intelligence/orchestrator.ts`
- `src/server/api/routers/intelligence.ts`
- `src/server/services/intelligence/agent/lock.ts`
- `src/server/services/intelligence/agent/idempotency.ts`

Acceptance:

- No breaking API change for frontend
- Same analytics/session IDs continue to work
- Concurrent submits for same session execute one-at-a-time
- Retry of same turn idempotency key does not duplicate persistence

## Phase E: UX and messaging polish

Deliverables:

- Keep bubble concise and non-duplicative
- Keep action cards as primary detail surface
- Ensure competitor snapshot and evidence behavior remain explicit

Code targets:

- `src/app/_components/chat/staffing-chat.tsx`
- `src/app/_components/chat/recommendation-block.tsx`

Acceptance:

- No repeated summary loops on direct follow-up questions
- Evidence questions return citations directly

## Phase F: Production rollout (no shadow mode)

Deliverables:

- Roll out agent path directly to production for live evaluation
- Keep deterministic path as immediate rollback target
- Monitor quality, latency, and failures from live traffic

Acceptance:

- `agent_mode` can be switched from `on` to deterministic fallback without deploy
- Production error and fallback rates remain within existing guardrails

## 7) Observability additions

Add events:

- `agent_turn_started`
- `agent_tool_called`
- `agent_tool_call_failed`
- `agent_response_validated`
- `agent_response_repaired`
- `agent_fallback_applied`
- `agent_lock_waited`
- `agent_idempotency_reused`
- `agent_circuit_breaker_opened`

Key properties:

- `agent_mode` (`off|on`)
- `tool_call_count`
- `tool_round_count`
- `turn_budget_ms`
- `schema_valid`
- `repair_used`
- `policy_caps_applied`
- `fallback_reason`
- `lock_wait_ms`
- `idempotency_reused`
- `circuit_breaker_source`

## 8) Quality gates

Blocking before cutover:

- Typecheck, lint, build, format all pass
- P95 first insight under 5s in production sample
- Output schema compliance >= 99%
- Zero uncaught client exceptions in critical path
- Fallback path success >= 99.9%
- Recommendation format compliance == 100%

## 9) Risks and mitigations

Risk: tool over-calling causes latency spikes
- Mitigation: hard per-turn call/time caps and core-source prefetch

Risk: model generates non-parseable output
- Mitigation: strict schema + one repair pass + deterministic fallback

Risk: hallucinated rationale
- Mitigation: enforce citation requirement and no-source-no-claim policy

Risk: regression in conversion due to response style drift
- Mitigation: staged production rollout with fast rollback switch

Risk: duplicate writes or conflicting state from rapid user submits
- Mitigation: per-session mutex + idempotency key enforcement

## 10) Execution order recommendation

1. Phase A
2. Phase B
3. Phase C
4. Phase D
5. Phase E polish
6. Phase F production rollout with rollback guard

## 11) Decisions locked for implementation

1. Core first-turn set:
- Keep `closures` always-on with `weather` and `events` for first insight.

2. Turn budget:
- Use `4500ms` max wall-clock per turn.

3. Repair policy:
- One repair pass only, then deterministic fallback if still invalid.

4. Rollout rule:
- Start with direct production testing of agent path.
- Keep deterministic rollback available at all times.

## 12) Backlog (post-v1.2)

1. Shadow mode
- Add dual-run (`agent_mode=shadow`) for side-by-side output comparison.
- Record structured deltas and harness metrics without affecting user-visible output.

2. Harness experimentation layer
- Use shadow-mode traces to evaluate new prompts, models, and tool policies safely.

## 13) Engineering acceptance checklist (file-mapped)

1. Advisory vs hard guardrails split
- Advisory lives in:
  - `src/server/services/intelligence/agent/prompt.ts`
- Hard constraints live in:
  - `src/server/services/intelligence/agent/policy.ts`
  - `src/server/services/intelligence/agent/controller.ts`
- Pass criteria:
  - breaking hard constraints is impossible even if prompt output violates them

2. Serial-first execution contract
- Implemented in:
  - `src/server/services/intelligence/agent/controller.ts`
- Pass criteria:
  - location resolution always runs before any source tool fetch
  - only safe read tools run in parallel group

3. Compiled bootstrap context
- Implemented in:
  - `src/server/services/intelligence/agent/context.ts`
  - `src/server/services/intelligence/agent/versions.ts`
- Pass criteria:
  - each turn logs prompt/tool/policy versions

4. Per-session lane behavior (mutex)
- Implemented in:
  - `src/server/services/intelligence/agent/lock.ts`
  - `src/server/services/intelligence/orchestrator.ts`
- Pass criteria:
  - second in-flight turn for same `session_id` waits or is rejected deterministically

5. Turn idempotency
- Implemented in:
  - `src/server/services/intelligence/agent/idempotency.ts`
  - `src/server/services/intelligence/orchestrator.ts`
- Pass criteria:
  - repeated same idempotency key does not create duplicate messages/tool-call rows

6. Tool budget and circuit breaker
- Implemented in:
  - `src/server/services/intelligence/agent/controller.ts`
  - `src/server/services/intelligence/agent/circuit-breaker.ts`
- Pass criteria:
  - `max_calls <= 8`, `max_rounds <= 2`, `turn_ms <= 4500`
  - repeatedly failing source is short-circuited and recorded

7. Deterministic post-policy override
- Implemented in:
  - `src/server/services/intelligence/agent/policy.ts`
- Pass criteria:
  - confidence/freshness caps always applied
  - malformed output repaired once or downgraded to deterministic fallback
