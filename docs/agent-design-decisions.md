# Agent Design Decisions (ADR Log)

Last updated: 2026-02-25  
Scope: Chat agent architecture and execution policy for Restaurant Intelligence

## ADR-001: Single-agent orchestrator for v1/v1.1

- Status: Accepted
- Decision: Use one orchestrating chat agent, not a multi-agent graph.
- Why:
  - Lower complexity and faster iteration for MVP.
  - Easier observability and debugging with one control loop.
  - Reduced latency overhead versus cross-agent delegation.
- Alternatives considered:
  - Multi-agent (planner + analyst + formatter).
- Tradeoffs:
  - Less specialization by domain in early versions.
  - Must keep capability modules clean to avoid monolith drift.
- Revisit when:
  - Any single workflow regularly exceeds ~15-20 internal steps.
  - Distinct domains require separate evaluation harnesses.

## ADR-002: Deterministic recommendations, LLM for phrasing

- Status: Accepted
- Decision: Generate recommendations via deterministic rules. Use LLM only to compose user-facing language.
- Why:
  - Stable, auditable actions.
  - Predictable confidence assignment and fallback behavior.
  - Lower hallucination risk for operational decisions.
- Alternatives considered:
  - End-to-end LLM reasoning for both decisioning and copy.
- Tradeoffs:
  - Less creative outputs.
  - Rules maintenance burden as domains expand.
- Revisit when:
  - Coverage of deterministic rules becomes a bottleneck for new verticals.

## ADR-003: Bounded execution, flexible conversation

- Status: Accepted
- Decision:
  - Bounded: fixed tool graph, strict max passes, schema validation.
  - Flexible: allow why/what-if/corrections without breaking flow.
- Why:
  - Prevents tool-call spirals and latency spikes.
  - Preserves conversational UX while keeping operational guarantees.
- Alternatives considered:
  - Free-form autonomous tool loops.
- Tradeoffs:
  - Some complex user requests get deflected back into supported paths.
- Revisit when:
  - Product evolves into open-ended analyst workflows.

## ADR-004: Clarify-vs-assume policy (low-friction)

- Status: Accepted
- Decision:
  - Ask clarifying questions only for high-impact ambiguity.
  - Ask at most one clarification per turn.
  - If unresolved, proceed with explicit assumption.
- Why:
  - Reduces user frustration from repeated questioning.
  - Maintains momentum to first actionable insight.
- Alternatives considered:
  - Always clarify when any ambiguity exists.
  - Never clarify, always assume.
- Tradeoffs:
  - Some recommendations start with medium confidence until corrected.
- Revisit when:
  - Users show persistent confusion about inferred assumptions.

## ADR-005: Baseline scope disambiguation for multi-location sessions

- Status: Accepted
- Decision:
  - When user gives baseline and multiple locations exist, ask once:
    - "Apply to all locations or just first location?"
  - Default to first-mentioned location if no response.
- Why:
  - Minimal-friction disambiguation with highest practical value.
- Alternatives considered:
  - Ask for exact location every time.
  - Apply to all by default.
- Tradeoffs:
  - First-location default may occasionally mismatch user intent.
- Revisit when:
  - Error analysis shows frequent first-location mismatches.

## ADR-006: Assumptions are mutable and explicitly logged

- Status: Accepted
- Decision:
  - Users can correct assumptions at any time.
  - Corrections trigger immediate recommendation recompute.
  - Persist `assumption_set` and `assumption_corrected` events.
- Why:
  - Preserves trust and recovers from ambiguity quickly.
  - Improves product learning from correction patterns.
- Alternatives considered:
  - Lock assumptions per turn/session.
- Tradeoffs:
  - Slightly more state handling complexity.
- Revisit when:
  - Correction frequency stays near zero (could simplify).

## ADR-007: Tool execution policy = cache-first + stale-while-revalidate

- Status: Accepted
- Decision:
  - Serve cached data fast, refresh in background.
  - Force-live fetch only on explicit user refresh.
- Why:
  - Best latency/reliability balance for P95 <5s goal.
  - Avoids blocking on third-party API variability.
- Alternatives considered:
  - Live-first
  - Cache-only
- Tradeoffs:
  - Occasional slightly stale recommendations.
  - Requires freshness disclosure in response.
- Revisit when:
  - Users frequently request manual refresh due to freshness concerns.

## ADR-008: Source and provider choices for v1/v1.1

- Status: Accepted
- Decision:
  - Geocoding/autocomplete: Google Places.
  - Events: Ticketmaster (major venue subset).
  - Closures: NYC DOT.
  - DOE: precomputed calendar signal (no runtime PDF parsing).
- Why:
  - Aligns with existing integrations and low-risk shipping path.
  - DOE runtime PDF parsing is brittle and latency-unfriendly.
- Alternatives considered:
  - Mapbox geocoding
  - Seatgeek events
  - Runtime DOE PDF extraction
- Tradeoffs:
  - Provider lock-in risks and migration cost later.
- Revisit when:
  - Coverage, cost, or data quality materially degrades.

## ADR-009: Explainability is required, not optional

- Status: Accepted
- Decision:
  - Response pattern should include:
    - Recommendation
    - Why (top drivers)
    - Trigger-to-escalate/de-escalate
    - Final action line with confidence/source/freshness
- Why:
  - Users need operational reasoning to trust schedule changes.
- Alternatives considered:
  - Action-only concise responses.
- Tradeoffs:
  - Slightly longer responses.
  - Requires structured explanation fields in recommendation payload.
- Revisit when:
  - Engagement data indicates response verbosity harms completion.

## ADR-010: Observability must prove usefulness and reliability

- Status: Accepted
- Decision:
  - Track product value, friction, and reliability with explicit event chain monitoring.
- Why:
  - Need to distinguish "not useful" vs "broken" vs "slow."
- Required views:
  - Value: first insight completion, follow-up turns, recommendation acceptance proxies.
  - Friction: invalid input loops, early exits, clarification loops.
  - Reliability: missing event-chain steps, source timeout/error rates, fallback rates.
- Revisit when:
  - Core funnel stabilizes and optimization focus shifts.

## ADR-011: Default response depth = balanced

- Status: Accepted
- Decision:
  - Default assistant responses use a balanced structure:
    - Recommendation
    - Why (max 2 bullets)
    - Trigger-to-escalate/de-escalate
    - Final action line with confidence/source/freshness
  - Expand to verbose only when user asks for deeper explanation.
- Why:
  - Preserves readability on mobile while maintaining trust.
- Alternatives considered:
  - Action-only compact default
  - Always-verbose default
- Tradeoffs:
  - Slightly longer default response than compact mode.
- Revisit when:
  - Engagement data indicates explanation depth is too high or too low.

## ADR-012: Conservative confidence calibration with hard caps

- Status: Accepted
- Decision:
  - Start with conservative confidence thresholds.
  - Apply hard caps:
    - unresolved baseline/location assumption -> max `medium`
    - primary source stale beyond threshold -> max `low`
    - all sources unavailable -> force `low` + `system` source
- Why:
  - Avoids overconfident recommendations and improves operator trust.
- Alternatives considered:
  - More aggressive confidence assignment to increase assertiveness.
- Tradeoffs:
  - Some correct recommendations will appear less certain.
- Revisit when:
  - Correction and acceptance metrics suggest calibration is too conservative.

## ADR-013: Blocking evaluation gate for non-copy changes

- Status: Accepted
- Decision:
  - Non-copy prompt/rule/flow changes must pass a blocking staging gate.
  - Minimum blocking checks:
    - output format compliance
    - P95 first insight latency
    - per-source timeout fallback behavior
    - one-question clarify policy compliance
    - assumption correction recompute behavior
    - event-chain completeness
- Why:
  - Prevents regressions that are expensive to detect in production.
- Alternatives considered:
  - Best-effort/manual QA only
  - Fully non-blocking CI checks
- Tradeoffs:
  - Slightly slower release cycle.
- Revisit when:
  - Test suite stabilizes and change risk profile is lower.

## ADR-014: Email collection and recommendation delivery deferred to v1.2

- Status: Accepted
- Decision:
  - Do not add outbound email flows in v1/v1.1.
  - Add in v1.2 as a narrow feature:
    - one-off "send now" recommendation to-do email
    - one scheduled "send later once" refresh email
- Why:
  - Keeps MVP focused on core chat value and latency.
  - Avoids premature deliverability/compliance overhead during initial validation.
- Alternatives considered:
  - Ship email capture in MVP
  - Defer email indefinitely
- Tradeoffs:
  - Less immediate lead capture in v1/v1.1.
  - Additional implementation pass needed in v1.2.
- Revisit when:
  - Core value metrics stabilize and lead capture becomes top KPI.

## ADR-015: Layered memory model (working + session + light cross-session)

- Status: Accepted
- Decision:
  - Use three memory layers:
    - working memory (per-turn, non-persistent)
    - session memory (persistent for active chat behavior)
    - light cross-session memory (structured preferences only)
  - Prefer structured fields over transcript replay for decisioning context.
- Why:
  - Preserves conversational continuity without over-collecting data.
  - Keeps inference context compact and predictable for latency/control.
  - Supports correction and auditability through explicit memory events.
- Alternatives considered:
  - Session-only memory
  - Heavy cross-session transcript memory/profile modeling
- Tradeoffs:
  - Session-only is simpler but repeats user setup on return visits.
  - Heavy memory improves personalization but increases privacy, drift, and complexity risk.
  - Light cross-session memory balances utility and governance, but identity continuity is best-effort without accounts.
- Guardrails:
  - Explicit user input overrides all inferred/default values.
  - Assumptions are marked and confidence-capped until confirmed.
  - No raw address/email/phone storage in transcript text fields.
- Revisit when:
  - Product shifts from landing-page experience to authenticated multi-workflow app.

## ADR-016: Request-centric observability with canonical turn events

- Status: Accepted
- Decision:
  - Use request-centric observability with one canonical `chat.turn.completed` event per assistant turn.
  - Attach strong correlation context (`trace_id`, `request_id`, `session_id`, `turn_index`) to all events.
  - Pair product analytics events (PostHog) with reliability events (server logs/tool traces).
- Why:
  - Makes landing-page chat journeys diagnosable despite anonymous identity instability.
  - Enables clear distinction between low usefulness, user friction, and system breakage.
  - Reduces noisy, low-value logs by favoring context-rich outcome events.
- Alternatives considered:
  - Fragmented many-small-log-line approach without canonical outcomes.
- Tradeoffs:
  - Requires strict event contracts and validation.
  - Slightly higher up-front instrumentation effort.
- Revisit when:
  - Full distributed tracing stack is introduced and event model can be simplified.

## ADR-017: Reviews are first-class diagnostic modifiers with mandatory evidence traceability

- Status: Accepted
- Decision:
  - Treat Google reviews as a first-class diagnostic signal for staffing recommendations.
  - Use reviews to shape role/daypart action selection, not as sole demand predictor.
  - Require referenceable evidence for review-backed claims:
    - review date/time
    - source/place reference
    - review id/hash reference
    - theme and short context snippet
- Why:
  - Improves recommendation trust and explainability.
  - Prevents unsupported claims from sparse/noisy review samples.
- Alternatives considered:
  - Keep reviews out of recommendation logic.
  - Use reviews as standalone staffing decision driver.
- Tradeoffs:
  - Additional ingestion/storage/traceability complexity.
  - Confidence often capped at `medium` unless corroborated by external signals.
- Guardrails:
  - Competitor reviews only on explicit user request; one competitor per session in v1.1.
  - Review-backed recommendations must include evidence count + recency window.
  - Old/sparse evidence requires confidence downgrade.
- Revisit when:
  - Review coverage/quality is sufficient for stronger automated weighting.

## ADR-018: Conversational guest signal snapshot with evidence-on-demand quotes

- Status: Accepted
- Decision:
  - When review signals are available, render a conversational "Guest Signal Snapshot" summary.
  - Keep summary text paraphrased by default.
  - Show short direct quote snippets only when user expands evidence details.
- Why:
  - Improves readability and trust for operators.
  - Keeps primary responses actionable and non-robotic.
  - Preserves traceability without overloading the core response.
- Alternatives considered:
  - Purely structured/robotic review summaries.
  - Always include direct quotes inline in main response.
- Tradeoffs:
  - More response assembly logic and UI states.
  - Need strict guardrails to avoid over-quoting or overclaiming.
- Guardrails:
  - Include sample size + recency window on snapshot.
  - Cap confidence when evidence is sparse/old.
  - Limit quote snippets to short fragments and metadata references.
- Revisit when:
  - User feedback indicates snapshot verbosity or evidence mode needs tuning.

## ADR-019: Brand guidelines are implementation constraints for landing/chat UI

- Status: Accepted
- Decision:
  - Treat `BRAND.md` as a required implementation constraint for landing page and chat UI.
  - Enforce brand color tokens, typography, message bubble system, and tone/voice in user-facing copy.
- Why:
  - Ensures consistent product identity and perceived quality.
  - Reduces design drift during rapid iteration.
- Alternatives considered:
  - Treat brand as optional visual guidance only.
- Tradeoffs:
  - Slightly tighter UI flexibility for experiments.
  - Requires explicit QA checks in release process.
- Guardrails:
  - Use tokenized colors in `src/styles/globals.css`, not ad hoc hex values in components.
  - Keep assistant tone approachable, confident, and human-centric.
  - Validate UI states against brand checklist before release.
- Revisit when:
  - Brand system is intentionally revised.

## Open Questions (Next Design Session)

1. Persona-specific variants after default balanced mode is stable (owner vs ops manager).
2. Threshold tuning for confidence and escalation triggers.
3. Policy for user-requested deep dives beyond staffing scope.
