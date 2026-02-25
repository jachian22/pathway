# Analytics Emission Plan (Code Mapping)

Last updated: 2026-02-25  
Status: Ready to implement

Related:

- `docs/landing-page-chat-analytics-spec.md`
- `docs/restaurant-intelligence-v1.1.md`
- `docs/memory-review-db-schema-v1.1.md`

## 1) Purpose

Map each required analytics/reliability event to:

1. exact emitting layer
2. code location
3. payload builder
4. trigger point

This avoids duplicate/missing events in a landing-page chat flow.

## 2) Proposed Observability Modules

Create these modules first:

1. `src/server/observability/events.ts`
   - Typed event names and payload schemas.
2. `src/server/observability/logger.ts`
   - JSON logger for server events.
3. `src/server/observability/posthog-server.ts`
   - Server capture helper for PostHog.
4. `src/server/observability/emit.ts`
   - Unified emit function:
     - emits structured log
     - optionally emits PostHog event
     - enforces required envelope fields
5. `src/server/observability/trace.ts`
   - `trace_id` and timing/span helpers.

Client helper:

1. `src/app/_lib/analytics.ts`
   - Browser-side PostHog capture wrapper.
   - Adds global properties and schema version.

## 3) Request Context Wiring (tRPC)

Current context file: `src/server/api/trpc.ts`

Add to `createTRPCContext`:

1. `trace_id` (from header or generated)
2. `request_id` (header if available)
3. `started_at_ms`
4. optional `session_id` passthrough from request metadata

Why:

1. Every event from routers/services needs consistent envelope fields.

## 4) Emission Ownership Rules

Single owner per event to prevent duplicates:

1. UI-only events emitted from client.
2. Reliability/tool events emitted from server only.
3. Session terminal event emitted from server when session ends, not from UI.
4. `recommendation_rendered` emitted from UI when block is actually visible.

## 5) Event-to-Code Mapping

## 5.1 Client Product Events

`landing_page_viewed`

1. Emitter: client
2. File: `src/app/page.tsx` or chat page component `useEffect`
3. Trigger: first render
4. Builder: `captureLandingViewed()`

`chat_session_started`

1. Emitter: client
2. File: planned chat component `src/app/_components/chat/staffing-chat.tsx`
3. Trigger: first meaningful action (location submit/card/free text)
4. Builder: `captureSessionStarted({ entry_type, time_to_start_ms, ...utm })`

`locations_parsed`

1. Emitter: client after parser result; server can mirror for reliability
2. File: `staffing-chat.tsx` input submit handler
3. Trigger: parse attempt complete
4. Builder: `captureLocationsParsed({ parse_status, valid_count, invalid_count, nyc_validation_failed, ambiguous_count })`

`starter_card_clicked`

1. Emitter: client
2. File: starter card click handler in `staffing-chat.tsx`
3. Trigger: card click
4. Builder: `captureStarterCardClicked({ card_label, card_type })`

`first_insight_rendered`

1. Emitter: client
2. File: chat message list render callback in `staffing-chat.tsx`
3. Trigger: first assistant insight enters DOM
4. Builder: `captureFirstInsightRendered({ first_insight_latency_ms, used_fallback, sources_available, recommendation_count })`

`recommendation_rendered`

1. Emitter: client
2. File: recommendation block component
3. Trigger: recommendation block mounted/visible
4. Builder: `captureRecommendationRendered({ recommendation_count, format_compliant, max_confidence, has_explanation_block, has_trigger_block, review_backed_recommendation_count, review_evidence_refs_count })`

`baseline_provided`

1. Emitter: client
2. File: user message submit handler + baseline parser
3. Trigger: baseline intent detected
4. Builder: `captureBaselineProvided({ scope, location_label, baseline_foh, daypart })`

`competitor_check_requested`

1. Emitter: client
2. File: competitor prompt handler in `staffing-chat.tsx`
3. Trigger: user submits competitor name for review check
4. Builder: `captureCompetitorCheckRequested({ competitor_query, competitor_resolved, competitor_place_id })`

`assumption_set`

1. Emitter: server authoritative, optional client mirror disabled by default
2. File: planned `src/server/services/intelligence/orchestrator.ts`
3. Trigger: unresolved ambiguity accepted with default
4. Builder: `emitAssumptionSet({ assumption_type, assumption_text, confidence_cap_applied })`

`assumption_corrected`

1. Emitter: server authoritative
2. File: orchestrator refinement flow
3. Trigger: user correction changes prior assumed value
4. Builder: `emitAssumptionCorrected({ assumption_type, old_value, new_value, recompute_latency_ms })`

`review_signal_extracted`

1. Emitter: server authoritative
2. File: `src/server/services/intelligence/review-signals.ts`
3. Trigger: review feature extraction completes
4. Builder: `emitReviewSignalExtracted({ place_id, entity_type, sample_review_count, evidence_count, recency_window_days, themes_detected })`

`guest_signal_snapshot_rendered`

1. Emitter: client
2. File: recommendation block component after snapshot section render
3. Trigger: snapshot enters visible UI
4. Builder: `captureGuestSignalSnapshotRendered({ snapshot_type, sample_review_count, recency_window_days, snapshot_confidence, used_direct_quote_count })`

`review_evidence_viewed`

1. Emitter: client
2. File: evidence drawer toggle handler in `recommendation-block.tsx`
3. Trigger: user opens review evidence panel
4. Builder: `captureReviewEvidenceViewed({ snapshot_type, evidence_refs_shown_count, contains_quote_snippets })`

`fallback_used`

1. Emitter: server authoritative
2. File: orchestrator fallback branch
3. Trigger: any degraded response path used
4. Builder: `emitFallbackUsed({ fallback_type, sources_down, reason })`

`chat_session_ended`

1. Emitter: server
2. File: session timeout worker or explicit end handler
3. Trigger: completion/exit/timeout/error
4. Builder: `emitSessionEnded({ end_reason, duration_ms, total_turns, had_fallback })`

## 5.2 Server Reliability Events

`chat.turn.completed` (canonical wide event)

1. Emitter: server
2. File: `src/server/services/intelligence/orchestrator.ts` at end of each assistant turn
3. Trigger: response finalized (success or fallback)
4. Builder: `emitTurnCompleted({ ...wide_fields })`
5. Include review fields in wide payload:
   - `source_status_reviews`
   - `cache_hit_reviews`
   - `source_freshness_reviews_s`
   - `review_backed_recommendation_count`
   - `review_evidence_refs_count`

`tool.weather.completed`

1. Emitter: server
2. File: wrapper around `src/server/services/weather.ts`
3. Trigger: tool call resolved/rejected
4. Builder: `emitToolCompleted({ tool_name: "weather", status, latency_ms, cache_hit, source_freshness_seconds, error_code })`

`tool.events.completed`

1. Emitter: server
2. File: wrapper around `src/server/services/ticketmaster.ts`
3. Trigger: tool call resolved/rejected
4. Builder: same as above with `tool_name: "events"`

`tool.closures.completed`

1. Emitter: server
2. File: planned closures adapter `src/server/services/nyc-dot.ts`
3. Trigger: tool call resolved/rejected
4. Builder: same schema with `tool_name: "closures"`

`tool.doe.completed` (v1.1)

1. Emitter: server
2. File: planned DOE adapter `src/server/services/doe-calendar.ts`
3. Trigger: lookup resolved/rejected
4. Builder: same schema with `tool_name: "doe"`

`tool.reviews.completed` (v1.1)

1. Emitter: server
2. File: wrapper around Google Places review fetch/extraction service
3. Trigger: review fetch/extraction resolved/rejected
4. Builder: same schema with `tool_name: "reviews"`

`chat.error`

1. Emitter: server
2. File: top-level orchestrator catch block and global tRPC error boundary
3. Trigger: unhandled or user-visible error
4. Builder: `emitChatError({ error_type, error_message, turn_stage, is_user_visible })`

## 6) Payload Builder Contracts

Implement one typed builder per domain:

1. `buildGlobalEnvelope(ctx, sessionMeta)` in `events.ts`
2. `buildProductEvent(name, payload, envelope)` in `events.ts`
3. `buildReliabilityEvent(name, payload, envelope)` in `events.ts`

Required behavior:

1. reject missing required fields
2. attach `schema_version`
3. redact disallowed keys (`address`, `email`, `phone`, transcript raw text)
4. for review evidence, allow only metadata fields and short snippets (no full raw review text payloads)

## 7) Planned Chat Flow Code Locations

These files do not exist yet; create them to keep instrumentation centralized.

1. `src/server/api/routers/intelligence.ts`
   - tRPC entrypoint (`firstInsight`, `refineInsight`, `endSession`)
2. `src/server/services/intelligence/orchestrator.ts`
   - orchestration + canonical event emission owner
3. `src/server/services/intelligence/recommendation-engine.ts`
   - deterministic recommendations + explanation fields
4. `src/server/services/intelligence/review-signals.ts`
   - review feature extraction + evidence ref assembly
5. `src/server/services/intelligence/memory.ts`
   - session/cross-session memory reads/writes
6. `src/app/_components/chat/staffing-chat.tsx`
   - UI flow + client product event capture
7. `src/app/_components/chat/recommendation-block.tsx`
   - `recommendation_rendered` emission

## 8) Implementation Steps (Order)

1. Add observability modules and typed envelope.
2. Wire `trace_id/request_id` into tRPC context.
3. Replace plain `console.log` timing in `trpc.ts` with structured log emission.
4. Implement intelligence orchestrator and server events first.
5. Implement chat UI and client product events second.
6. Add event validation tests and duplicate-event guard tests.
7. Run brand QA against `BRAND.md` for landing/chat UI (tokens, typography, bubble styles, tone).
8. Verify dashboards populate with expected fields.

## 9) Verification Checklist

1. Every event includes required global envelope.
2. `chat.turn.completed` exists exactly once per assistant turn.
3. No duplicate `first_insight_rendered` in one session.
4. `chat_session_started` to terminal event chain exists for >= 98% sessions.
5. No blocked PII keys reach PostHog payloads.

## 10) Gaps to Resolve Before Coding

1. Choose PostHog server ingestion approach (`posthog-node` vs HTTP capture endpoint).
2. Decide definitive `session_end` trigger in landing-page context:
   - inactivity timeout only
   - explicit client signal + server timeout fallback
3. Set final event `schema_version` policy.
