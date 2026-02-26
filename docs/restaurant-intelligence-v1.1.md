# Restaurant Intelligence Lead Magnet - v1.1 Hardened Spec

Last updated: 2026-02-25  
Status: Build-ready

Related: `docs/agent-design-decisions.md` for architecture tradeoffs and rationale.
Related: `docs/landing-page-chat-analytics-spec.md` for event schemas, metrics, and dashboards.
Related: `docs/analytics-emission-plan.md` for exact event emission ownership and code mapping.
Related: `docs/memory-review-db-schema-v1.1.md` for migration-ready memory and review evidence tables.
Related: `BRAND.md` for required visual and voice guidelines.

## 0) Gate Remediation Notes (2026-02-25)

Implemented from blocking-gate findings:

1. Assistant response terminal invariant:

- Every response now ends with a schema-compliant final action line (even when a follow-up question is present).

2. Location noise rejection hardening:

- Very short ambiguous location tokens are rejected before provider lookup to prevent false-positive matches.

3. One-question clarification flow:

- Ambiguous multi-location baseline scope prompts exactly one clarification, then defaults to first-mentioned location if still unresolved.

4. Assumption correction auditability:

- Added `assumption_corrected` persistence/emission path when explicit baseline replaces prior assumption.

5. Source-status semantics normalization:

- Distinguishes `ok` (including no nearby events) from `stale`/`error`/`timeout`.

6. Ticketmaster datetime compatibility:

- Discovery API requests must use `YYYY-MM-DDTHH:mm:ssZ` (no fractional seconds).

## 1) Product Contract

Primary promise: **Plan staffing and prep for the next 3 days across your NYC locations.**

Hard output contract: every assistant response must end with at least one recommendation in this shape:

`[Action] + [Time Window] + [Confidence: low|medium|high] + [Source + Freshness]`

Example:

`Tue 5-9pm: +1-2 FOH at Hell's Kitchen (confidence: high, source: Ticketmaster MSG event feed, updated 1h ago)`

Default response depth (balanced):

1. Recommendation
2. Why (max 2 bullets)
3. Trigger-to-escalate/de-escalate
4. Final action line (required schema above)

Verbose explanations are opt-in when users ask "why" or request detail.

## 2) Scope and Constraints (Locked)

- Max locations per session: `3`
- Geography: `NYC only`
- Sources in v1: `weather`, `major venue events`, `street closures (NYC DOT)`
- Additional sources in v1.1: `school calendar signal (NYC DOE)`, `review diagnostics (Google Places Reviews)`
- First visible insight latency: `P95 < 5s`
- Time-to-value from first valid location: `< 30s`
- No empty states: degraded conditions must return conservative action guidance

## 3) Key Deltas From Previous Spec

These deltas align scope with current codebase reality.

1. Event provider for v1 is `Ticketmaster` (already integrated), not Seatgeek.
2. App API surface is currently `tRPC` on Next.js, not hand-written Next route handlers. Keep tRPC for v1.
3. Geocoding/autocomplete source is `Google Places` (already integrated). Mapbox stays optional.
4. Core intelligence orchestration endpoint does not exist yet and must be added.
5. DB schema is still starter schema and must be migrated to chat/session/tool/recommendation tables.
6. Street closure source integration is not yet implemented and is required for v1 (NYC DOT feed).
7. NYC DOE is included in v1.1 as a precomputed calendar signal, not runtime PDF parsing.
8. Review diagnostics become first-class in v1.1 and require evidence traceability for each review-backed claim.

## 4) User Flow (Canonical)

`Land -> Input 1-3 locations -> Pick starter card -> First insight -> Optional refinement turn`

Starter cards:

- `Help me plan staffing`
- `What should I watch out for?`
- `Any opportunities I'm missing?`

All cards call the same engine and rules; card only changes framing copy.

## 5) Input Validation Contract

Accepted input forms:

- Full address
- ZIP code
- Neighborhood/place name from autocomplete
- Multi-location paste with commas/newlines

NYC validation:

- Address/geocode accepted only when state is `NY` and borough/city resolves to one of:
  - Manhattan
  - Brooklyn
  - Queens
  - Bronx
  - Staten Island
- ZIP accepted only for prefixes:
  - `100-104`
  - `111-114`
  - `116`
- Neighborhood/place accepted only if geocode point is within NYC bounds polygon

Error behavior:

- Invalid entries are rejected per-item, valid entries continue.
- UI always shows partial progress (`2 valid, 1 needs correction`).
- Reject short ambiguous free-text tokens (`<3` chars) before provider lookup unless token is ZIP/address-like.
- Invalid-input rejection copy should remain corrective and specific, e.g.:
  - "I couldn't confidently match that to a NYC location. Please share a fuller NYC address, ZIP, or neighborhood (for example: 350 5th Ave, 11201, or Astoria)."

## 6) Intelligence Engine Contract

Add one orchestration procedure (tRPC):

`intelligence.firstInsight`

Input:

```ts
{
  sessionId?: string;
  cardType: "staffing" | "risk" | "opportunity";
  locations: string[]; // 1..3 raw user inputs
  baselineContext?: {
    locationLabel: string;
    baselineFoh?: number;
    baselineBoh?: number;
  }[];
}
```

Output:

```ts
{
  sessionId: string;
  turnIndex: number;
  summary: string;
  recommendations: {
    locationLabel: string;
    action: string;
    timeWindow: string;
    confidence: "low" | "medium" | "high";
    sourceName: "weather" | "events" | "closures" | "doe" | "reviews" | "system";
    sourceFreshnessSeconds?: number;
    evidence?: {
      evidenceCount: number;
      recencyWindowDays: number;
      topRefs: {
        source: "google_reviews";
        placeId: string;
        reviewIdOrHash: string;
        publishTime: string;
        rating?: number;
        theme: "wait_time" | "service_speed" | "host_queue" | "kitchen_delay" | "other";
        excerpt?: string;
      }[];
    };
  }[];
  sources: {
    weather: { status: "ok" | "error" | "stale" | "timeout"; freshnessSeconds?: number };
    events: { status: "ok" | "error" | "stale" | "timeout"; freshnessSeconds?: number };
    closures: { status: "ok" | "error" | "stale" | "timeout"; freshnessSeconds?: number };
    doe: { status: "ok" | "error" | "stale" | "timeout"; freshnessSeconds?: number };
    reviews: { status: "ok" | "error" | "stale" | "timeout"; freshnessSeconds?: number };
  };
  usedFallback: boolean;
  firstInsightLatencyMs: number;
}
```

## 7) Rules and Scoring (Deterministic)

Use deterministic rules to generate recommendations. LLM is phrasing-only.

### 7.1 Venue impact windows

- MSG, Barclays: `0.4 mi`, impact window `T-2h` to `T+1h`
- Yankee Stadium, Citi Field, UBS Arena: `0.3 mi`, impact window `T-2h` to `T+1h`

### 7.2 Weather triggers

- Rain probability >= `60%` during service window -> patio/setup reduction action
- Feels-like <= `35F` or >= `90F` during peak -> staffing/prep caution action

### 7.3 Closures triggers

- Closure intersects location access path and overlaps delivery window -> move delivery window action

### 7.4 School calendar (DOE) triggers

- Non-school day, recess, or major school holiday in next 3 days -> apply neighborhood demand modifier
- DOE signal should modify recommendation sizing; it should not be the only source for hard staffing moves

### 7.5 Priority and tie-break

1. Closures
2. Major venue events
3. Weather
4. DOE calendar modifier
5. Reviews diagnostic modifier (role/daypart weighting)

Tie-break by higher impact score, then higher confidence, then shorter action window.

### 7.6 Confidence mapping

- `high`: source-confirmed event/closure with explicit time window
- `medium`: weather forecast, DOE calendar signal, review diagnostics, or event timing uncertainty
- `low`: inferred spillover impact or multi-source degradation

Hard confidence caps:

- If baseline scope/location is assumed (unconfirmed), cap at `medium`.
- If primary source freshness exceeds stale alert threshold, cap at `low`.
- If all sources are unavailable, force `low` and `source=system`.

### 7.6.1 Clarification policy (implemented)

- Ask at most one clarification question for ambiguous baseline scope in multi-location sessions:
  - "Apply to all locations or just first-mentioned location?"
- If unresolved on the next user turn, default to first-mentioned location and continue.
- Emit `assumption_set` when defaulting scope.
- Emit `assumption_corrected` when user later supplies explicit baseline/scope.

### 7.7 Reviews diagnostic rules (first-class)

- Reviews are a modifier that helps choose role-specific staffing actions (host vs FOH vs BOH), not a standalone demand forecaster.
- Own-location reviews are eligible by default once place match is confirmed.
- Competitor review pull requires explicit user request and is capped to one named competitor per session.
- Review-backed claims must include evidence count and recency window.
- Confidence for review-only evidence is capped at `medium` unless corroborated by external demand signals.
- When review signals are available, include a conversational `Guest Signal Snapshot` blurb before the final action line.

### 7.7.1 Guest Signal Snapshot (required when reviews available)

Snapshot purpose:

- Confirm directionally what guests say about operations and bridge directly to staffing implications.

Snapshot structure (conversational):

1. What guests praise (top 1-2 themes)
2. Where friction shows up (top 1-2 themes)
3. When it appears (daypart/time cues if available)
4. Operational implication (role/daypart bottleneck)

Required metadata attached to snapshot:

1. `sample_review_count`
2. `recency_window_days`
3. `confidence`

Own-location example shape:

- "Quick read on what guests are saying about your location: people consistently praise [theme], but [friction theme] keeps coming up during [daypart]. Operationally, that points to [role] pressure."

Competitor snapshot shape:

- "Quick read on what guests say about [competitor]: [strength theme], but [friction theme] during [daypart]. Compared with your location, they appear stronger/weaker on [dimension]."

### 7.8 Review evidence traceability contract (required)

For every recommendation that references review signals:

1. Include `evidenceCount` and `recencyWindowDays`.
2. Include at least one reference in `topRefs` with `publishTime` and `theme`.
3. Provide review context on demand (`show evidence`) with:

- review date/time
- rating (if available)
- short excerpt/snippet
- place identifier

4. If references are old or sparse, recommendation confidence must be downgraded.
5. Use direct quote snippets only in evidence mode; summary copy should default to paraphrase.
6. Limit direct quote snippets to short fragments; avoid full raw review body rendering/storage.

## 8) Fallback Behavior (No Empty State)

Fallback precedence:

1. If one source fails: continue with available sources and emit fallback_used event.
2. If weather is stale <= 6h: use stale weather and tag freshness.
3. If weather stale > 6h: omit weather recommendations.
4. If events unavailable: explicitly note event blind spot and continue.
5. If reviews unavailable: continue with external signals and mark diagnostic gap in explanation.
6. If all sources unavailable: return 24h conservative operating guidance and recheck advice.

Source status semantics:

- `ok`: source request succeeded, including zero relevant nearby impacts.
- `stale`: partial source success or stale-cache path.
- `error`: source unavailable (all attempts failed).
- `timeout`: source timed out.

All-source-down response (canonical):

`Live feeds are temporarily unavailable. For the next 24 hours, run standard staffing/prep, keep delivery timing flexible, and recheck in 30 minutes. (confidence: low, source: system status, updated now)`

## 9) Performance Budget (P95 < 5s)

Budget split:

- Parse + validate locations: `<= 400ms`
- Geocode up to 3 locations in parallel: `<= 900ms`
- Weather/events/closures fetch in parallel: `<= 2500ms`
- Rules + response assembly: `<= 500ms`
- LLM phrasing pass (optional/fast): `<= 500ms`
- Total budget: `<= 4800ms`

Execution requirements:

- Strict upstream timeouts per source (fail fast, partial result).
- Parallel fetches with `Promise.allSettled`.
- Return first actionable block from available data; late data can refine follow-up turn.
- Review fetch/analysis should be non-blocking for first insight if not ready within `<=800ms`.

## 10) Caching and Freshness

Store source payloads in Redis (Upstash) with TTL:

- Weather: TTL `3h`, stale alert `>6h`
- Events: TTL `12h`, stale alert `>24h`
- Closures: TTL `6h`, stale alert `>12h`
- DOE calendar: refresh daily, stale alert `>7 days`
- Reviews: TTL `24h`, stale alert `>72h`

Cache key shape:

- `weather:{lat}:{lon}:{yyyymmdd}`
- `events:{venue_id}:{yyyymmdd}`
- `closures:{geo_bucket}:{yyyymmdd}`
- `doe_calendar:{school_year}`
- `reviews:{place_id}:{window_days}`
- `geocode:{normalized_input}`

## 11) Data Sources (v1 + v1.1)

- Weather: OpenWeather forecast endpoint
- Events: Ticketmaster Discovery API limited to:
  - Madison Square Garden
  - Barclays Center
  - Yankee Stadium
  - Citi Field
  - UBS Arena
- Closures: NYC DOT / NYC Open Data street closure feed (Socrata)
- School calendar (v1.1): NYC DOE official calendar, ingested into a normalized table via scheduled/manual update
- Reviews diagnostics (v1.1): Google Places Reviews for confirmed own location; one named competitor on explicit request

DOE ingestion rule:

- Do not parse DOE PDF at request time.
- Precompute and store calendar rows (`date`, `event_type`, `is_school_day`, `source_updated_at`) and query locally during chat turns.
- Use the seed loader for normalized rows:
  - `pnpm doe:seed -- --file data/doe-calendar.seed.csv`
  - optional reset: `pnpm doe:seed -- --file data/doe-calendar.seed.csv --truncate`
- `data/doe-calendar.seed.csv` is a starter seed file; replace with official DOE-normalized dates for production.

Reviews usage rule:

- Review data is used as role/daypart diagnostic evidence to shape staffing actions.
- Do not claim review-backed findings without referenceable review metadata.

Out of scope remains:

- Email capture/reminder workflows (deferred to v1.2)
- Film permits
- Health inspections
- Competitor permits
- Non-NYC coverage
- Dynamic model routing

## 12) Persistence and Analytics

Use the proposed Postgres tables:

- `chat_sessions`
- `chat_messages`
- `chat_tool_calls`
- `chat_recommendations`
- `chat_fallbacks`
- `source_runs`

Store redacted transcript text only; no raw email/phone/address in free text.
Store review evidence metadata for traceability (`place_id`, `review_id/hash`, `publish_time`, `theme`, `rating`, short excerpt).

PostHog events (required in MVP):

- `chat_session_started`
- `locations_parsed`
- `starter_card_clicked`
- `first_insight_rendered`
- `recommendation_rendered`
- `baseline_provided`
- `fallback_used`
- `chat_session_ended`

## 12.1) Memory Model (v1/v1.1)

Use layered memory to balance UX continuity, latency, and data minimization.

Layers:

1. Working memory (per turn, ephemeral)

- Tool payloads, temporary assumptions, recommendation draft fields.
- Not persisted after response finalization.

2. Session memory (persistent by `session_id`)

- Current locations, card type, baseline values, assumption flags, corrections.

3. Light cross-session memory (persistent by `distinct_id`, best-effort)

- Structured preferences only (example: baseline scope default, preferred daypart labels).
- No full transcript replay memory.

Write/update rules:

1. Explicit user input always overrides inferred/default values.
2. Latest explicit value wins over prior explicit values for the same key.
3. Assumed values must be marked (`assumed=true`) and confidence-capped until confirmed.
4. Corrections must emit memory events and trigger recommendation recompute.

Read rules per turn:

1. Load session memory first.
2. Layer cross-session preferences as defaults only.
3. Build compact structured context for the model; avoid raw transcript stuffing.
4. If unresolved assumptions remain, include an explicit assumption line in response.

Retention and privacy:

1. Session-level transcript/tool traces: 90 days.
2. Cross-session preference memory: 30-90 days (start at 90, tune later).
3. Support hard delete by `session_id` and by user identifier.
4. Do not store raw email/phone/full address in transcript text fields.

## 13) Logging Contract

All server logs must be JSON and include:

- `trace_id`
- `request_id`
- `session_id`
- `turn_index`
- `event`
- `latency_ms`

Event names to standardize:

- `chat.request.received`
- `locations.resolved`
- `tool.weather.completed`
- `tool.events.completed`
- `tool.closures.completed`
- `tool.doe.completed`
- `tool.reviews.completed`
- `rules.recommendations.generated`
- `chat.response.sent`
- `chat.fallback.triggered`
- `source.freshness.breach`
- `chat.error`

## 14) UI Contract

Required UI states:

- Empty input
- Parsing/validating input
- First insight loading (skeleton + progress text)
- First insight rendered
- Partial data fallback banner
- All-sources-down banner

Mobile constraints:

- No horizontal scroll at 320px width
- Action lines remain single recommendation units and readable

Brand compliance (required):

1. Use brand color tokens from `src/styles/globals.css` (`cream`, `charcoal`, `forest`, surface/message tokens).
2. Use approved typography:

- headline/section: serif italic (`Playfair Display`)
- body/components: sans (`Geist Sans`)

3. Chat bubbles follow brand system:

- user bubble: forest + white text, right-aligned
- assistant bubble: surface-1 + charcoal text, subtle border

4. Use forest focus rings for interactive states.
5. Preserve approachable/confident/human tone in assistant copy; avoid robotic phrasing in summary blocks.
6. Keep primary CTA button style as charcoal pill and secondary as outlined pill per `BRAND.md`.

## 15) Definition of Done (Hardened)

- Location parser accepts 1-3 entries and enforces NYC validation rules
- First insight P95 is <5s in production-like environment
- Every assistant response contains at least one fully compliant action line
- Partial-source failure paths return non-empty recommendations
- All-source-down path returns canonical conservative action guidance
- PostHog events emitted with required properties and no PII payload leakage
- Structured logs include required fields and event names
- DB writes persist session/message/tool/recommendation/fallback records
- Freshness breach detection and alerts enabled for all active sources
- Review-backed recommendations include referenceable evidence metadata (date/context/source ref)
- Mobile UX tested at 320px, 375px, 390px widths
- UI validated against `BRAND.md` color, typography, and chat component guidelines

## 16) Verification Checklist (Ship Gate)

Run before launch:

1. Output format compliance: 100% assistant responses end with required action-line schema.
2. Synthetic load test verifies `first_insight_latency_ms` P95 < 5000.
3. Chaos test each source timeout independently and verify non-empty graceful fallback.
4. Clarify-vs-assume behavior: ambiguous multi-location baseline triggers exactly one scope question, then proceeds.
5. Assumption correction behavior: correction in follow-up turn recomputes recommendations immediately.
6. Event-chain completeness: `chat_session_started -> locations_parsed -> first_insight_rendered -> recommendation_rendered`.
7. Review traceability: every review-backed recommendation has `evidenceCount`, `recencyWindowDays`, and at least one dated `topRef`.
8. Brand QA: landing/chat UI passes brand token, typography, and tone checklist from `BRAND.md`.

Release policy:

- For non-copy changes (rules, tool policy, state machine, response contracts), this ship gate is blocking in staging.
- Copy-only prompt/polish changes can use a lighter non-blocking check.

## 17) Build Order (Recommended)

1. DB migration + repository layer
2. Source adapters + cache wrapper + freshness tagging
3. Intelligence orchestrator + deterministic rules engine
4. Formatter + LLM phrasing wrapper
5. UI flow wiring + starter cards + chat states
6. PostHog + structured logs + alerts
7. Performance tuning pass and launch checks

## 18) v1.2 Extension: Email Refresh + Recommendation To-dos

Goal:

- Let users request a scheduled refresh email and receive concise recommendation to-dos by email.

Scope for v1.2:

1. Post-insight CTA: `Email me a refresh + to-do list`
2. Collect fields:

- `email`
- `session_id`
- `location_set_id`
- `scheduled_send_at`
- `consent` (explicit)

3. Send one-off email containing:

- top recommendations
- time windows
- confidence/source/freshness
- clear generated-at timestamp

4. Include unsubscribe link and preference-reset endpoint.

Delivery modes (v1.2):

1. `send_now` (immediate summary/to-do email after insight)
2. `send_later_once` (scheduled refresh email for same daypart)

Operational requirements:

- Add provider integration (Resend/SendGrid/Postmark).
- Add cron/scheduler job for queued sends.
- Add retries with idempotency key to prevent duplicate sends.
- Log outcomes (`queued`, `sent`, `failed`, `unsubscribed`).

Data/privacy requirements:

- Store email in dedicated subscription table, not free-text transcripts.
- Do not send raw addresses in analytics payloads.
- Support hard delete by `email` and `session_id`.
