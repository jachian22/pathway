# Landing Page Chat Analytics and Observability Spec

Last updated: 2026-02-25  
Status: Implementation-ready for v1/v1.1

Related:

- `docs/restaurant-intelligence-v1.1.md`
- `docs/agent-design-decisions.md`
- `docs/analytics-emission-plan.md`

Reference principles:

- Request-centric, context-rich logging (`https://loggingsucks.com/`)

## 1) Analytics Goals

We need to answer these concrete questions:

1. Did users reach value fast?
2. Did users get actionable outputs?
3. Did users trust outputs enough to continue?
4. Where did users get stuck or frustrated?
5. Did the system degrade or break mid-journey?
6. Which data-source failures hurt usefulness most?
7. Which acquisition channels produce useful sessions?

## 2) Instrumentation Principles

1. Log one canonical "turn outcome" event for each assistant turn.
2. Keep all events correlated with `trace_id`, `session_id`, and `turn_index`.
3. Distinguish product events (user behavior) from reliability events (system behavior).
4. Emit explicit terminal events so drop-off vs breakage is measurable.
5. Track assumptions/fallbacks as first-class events.

## 3) Identity and Session Model

Identifiers:

1. `session_id`: UUID for one chat session.
2. `distinct_id`: PostHog/browser identity (best-effort across visits).
3. `trace_id`: unique per request/turn orchestration path.
4. `request_id`: platform request id.

Session start:

1. First meaningful action: location submission, starter card click, or free-text submit.

Session end reasons:

1. `completed`
2. `user_exit`
3. `inactive_timeout`
4. `error`

## 4) Global Event Envelope (Required on Every Event)

```json
{
  "ts": "2026-02-25T19:20:31.442Z",
  "event": "string",
  "session_id": "uuid",
  "distinct_id": "string",
  "trace_id": "string",
  "request_id": "string",
  "turn_index": 1,
  "route": "/api/trpc/intelligence.firstInsight",
  "card_type": "staffing|risk|opportunity|none",
  "location_count": 2,
  "latency_ms": 1834,
  "used_fallback": false,
  "model": "openrouter/model-id",
  "prompt_version": "v1.3.0",
  "rule_version": "v1.2.1",
  "release": "web-2026.02.25.3",
  "env": "production"
}
```

Acquisition context on session start:

1. `landing_page_variant`
2. `referrer_domain`
3. `utm_source`
4. `utm_medium`
5. `utm_campaign`

## 5) PostHog Product Event Definitions

`chat_session_started`

1. Trigger: first user action after load.
2. Required fields:
   - `entry_type` (`card|free_text|location_submit`)
   - `time_to_start_ms`
   - acquisition context fields

`locations_parsed`

1. Trigger: parser attempt completes.
2. Required fields:
   - `parse_status` (`success|partial|error`)
   - `valid_count`
   - `invalid_count`
   - `nyc_validation_failed`
   - `ambiguous_count`

`starter_card_clicked`

1. Trigger: card click.
2. Required fields:
   - `card_label`
   - `card_type`

`first_insight_rendered`

1. Trigger: first assistant insight visible in UI.
2. Required fields:
   - `first_insight_latency_ms`
   - `used_fallback`
   - `sources_available`
   - `recommendation_count`

`recommendation_rendered`

1. Trigger: recommendation block displayed.
2. Required fields:
   - `recommendation_count`
   - `format_compliant`
   - `max_confidence`
   - `has_explanation_block`
   - `has_trigger_block`
   - `review_backed_recommendation_count`
   - `review_evidence_refs_count`

`competitor_check_requested`

1. Trigger: user asks to analyze one competitor.
2. Required fields:
   - `competitor_query`
   - `competitor_resolved` (`true|false`)
   - `competitor_place_id`

`review_signal_extracted`

1. Trigger: review signal extraction succeeds.
2. Required fields:
   - `place_id`
   - `entity_type` (`own|competitor`)
   - `sample_review_count`
   - `evidence_count`
   - `recency_window_days`
   - `themes_detected` (array)

`guest_signal_snapshot_rendered`

1. Trigger: conversational review summary snapshot is shown.
2. Required fields:
   - `snapshot_type` (`own|competitor|combined`)
   - `sample_review_count`
   - `recency_window_days`
   - `snapshot_confidence`
   - `used_direct_quote_count`

`review_evidence_viewed`

1. Trigger: user opens evidence drawer/details.
2. Required fields:
   - `snapshot_type` (`own|competitor|combined`)
   - `evidence_refs_shown_count`
   - `contains_quote_snippets` (`true|false`)

`assumption_set`

1. Trigger: system proceeds on unresolved ambiguity.
2. Required fields:
   - `assumption_type` (`baseline_scope|baseline_value|location_mapping|time_window`)
   - `assumption_text`
   - `confidence_cap_applied` (`none|medium|low`)

`assumption_corrected`

1. Trigger: user correction overrides assumption.
2. Required fields:
   - `assumption_type`
   - `old_value`
   - `new_value`
   - `recompute_latency_ms`

`baseline_provided`

1. Trigger: user gives staffing baseline.
2. Required fields:
   - `scope` (`all|single|assumed_single`)
   - `location_label`
   - `baseline_foh`
   - `daypart`

`fallback_used`

1. Trigger: any degraded response path.
2. Required fields:
   - `fallback_type` (`partial_data|all_sources_down|timeout|validation`)
   - `sources_down`
   - `reason`

`chat_session_ended`

1. Trigger: session ends.
2. Required fields:
   - `end_reason` (`completed|user_exit|inactive_timeout|error`)
   - `duration_ms`
   - `total_turns`
   - `had_fallback`

## 6) Server-Side Reliability Event Definitions

`chat.turn.completed` (canonical wide event)

1. Emitted once per assistant turn.
2. Required fields:
   - `first_insight_latency_ms`
   - `output_tokens`
   - `input_tokens`
   - `recommendation_count`
   - `format_compliant`
   - `assumptions_open_count`
   - `assumptions_corrected_count`
   - `source_status_weather`
   - `source_status_events`
   - `source_status_closures`
   - `source_status_doe`
   - `source_status_reviews`
   - `cache_hit_weather`
   - `cache_hit_events`
   - `cache_hit_closures`
   - `cache_hit_reviews`
   - `source_freshness_weather_s`
   - `source_freshness_events_s`
   - `source_freshness_closures_s`
   - `source_freshness_reviews_s`
   - `review_backed_recommendation_count`
   - `review_evidence_refs_count`

`tool.weather.completed`, `tool.events.completed`, `tool.closures.completed`, `tool.doe.completed`, `tool.reviews.completed`

1. Emitted once per tool call.
2. Required fields:
   - `status` (`ok|error|timeout|stale`)
   - `latency_ms`
   - `cache_hit`
   - `source_freshness_seconds`
   - `error_code`

`chat.error`

1. Emitted on errors.
2. Required fields:
   - `error_type`
   - `error_message`
   - `turn_stage`
   - `is_user_visible`

## 7) Journey Stage Model (for Funnel + Dropoff)

Stages:

1. `landing_viewed`
2. `session_started`
3. `locations_valid`
4. `card_selected`
5. `first_insight_rendered`
6. `recommendation_rendered`
7. `follow_up_turn`
8. `session_ended`

Required terminal condition:

1. Every started session must emit either `first_insight_rendered` or `chat.error` or `chat_session_ended` with non-success reason within 120s.

## 8) Metric Dictionary and Formulas

`Activation Rate`

1. Definition: share of landing visitors who start a chat session.
2. Formula: `chat_session_started / landing_page_viewed`
3. Source: PostHog

`Location Parse Success Rate`

1. Definition: sessions with at least one valid NYC location.
2. Formula: `sessions where locations_parsed.valid_count >= 1 / sessions with locations_parsed`
3. Source: PostHog

`Time to First Insight`

1. Definition: time from first input to first assistant insight shown.
2. Formula: percentile over `first_insight_latency_ms`
3. Target: P95 < 5000ms (API), <30000ms input-to-value
4. Source: PostHog + server logs

`Actionability Rate`

1. Definition: sessions where at least one compliant recommendation rendered.
2. Formula: `sessions with recommendation_rendered.format_compliant=true and recommendation_count>=1 / sessions_started`
3. Source: PostHog

`Trust/Engagement Proxy`

1. Definition: sessions with a second user turn after first insight.
2. Formula: `sessions with total_turns >= 2 / sessions with first_insight_rendered`
3. Source: PostHog + DB

`Assumption Friction Rate`

1. Definition: sessions where assumption was required and not corrected.
2. Formula: `sessions with assumption_set and no assumption_corrected / sessions_started`
3. Source: PostHog + DB

`Fallback Rate`

1. Definition: sessions using degraded path.
2. Formula: `sessions with fallback_used / sessions_started`
3. Source: PostHog + DB

`Silent Failure Rate`

1. Definition: started sessions with no terminal outcome in SLA window.
2. Formula: `sessions_started - sessions_with_terminal_event_within_120s`
3. Source: DB/logs

`Recommendation Utility Proxy`

1. Definition: sessions with user acceptance language after recommendation.
2. Formula: `sessions with follow-up intent in {accept, implement, ask_how} / sessions with recommendation_rendered`
3. Source: classified user turns

`Review Evidence Coverage`

1. Definition: review-backed recommendations that include required references.
2. Formula: `review-backed recs with evidenceCount>0 and review_evidence_refs_count>0 / all review-backed recs`
3. Source: PostHog + DB

`Snapshot Engagement Rate`

1. Definition: sessions where users open review evidence after snapshot.
2. Formula: `sessions with review_evidence_viewed / sessions with guest_signal_snapshot_rendered`
3. Source: PostHog

## 9) Dashboards (PostHog)

Dashboard 1: `Landing Page Health`

1. Activation rate trend.
2. Location parse success rate trend.
3. P50/P95 time-to-first-insight.
4. Recommendation actionability rate.
5. Silent failure rate.

Dashboard 2: `Journey Friction`

1. Funnel by stage model with drop-offs.
2. Invalid/ambiguous input breakdown.
3. Clarify vs assume counts.
4. Assumption correction rate.
5. Exit after first fallback.
6. Snapshot shown but no follow-up rate.

Dashboard 3: `Reliability and Sources`

1. Tool timeout/error rate by source.
2. Source freshness breach counts.
3. Cache hit rate by source.
4. Fallback rate by source-down combination.
5. Latency contribution by turn stage.
6. Review source timeout/staleness rate.

Dashboard 4: `Usefulness by Acquisition`

1. Actionability rate by `utm_source` and `referrer_domain`.
2. Follow-up turn rate by campaign.
3. Fallback and failure rates by campaign.
4. Review evidence coverage by campaign.
5. Snapshot engagement rate by campaign.

## 10) SQL Query Templates (Postgres)

These assume chat tables from `restaurant-intelligence-v1.1` schema.

Time to first insight (daily P50/P95):

```sql
select
  date_trunc('day', started_at) as day,
  percentile_cont(0.5) within group (order by first_insight_latency_ms) as p50_ms,
  percentile_cont(0.95) within group (order by first_insight_latency_ms) as p95_ms
from chat_sessions
where started_at >= now() - interval '30 days'
  and first_insight_latency_ms is not null
group by 1
order by 1;
```

Actionability rate:

```sql
with session_recs as (
  select
    session_id,
    count(*) as rec_count
  from chat_recommendations
  group by session_id
)
select
  count(*) filter (where coalesce(sr.rec_count, 0) >= 1)::float / nullif(count(*), 0) as actionability_rate
from chat_sessions cs
left join session_recs sr on sr.session_id = cs.id
where cs.started_at >= now() - interval '30 days';
```

Fallback rate and top fallback types:

```sql
select
  cf.fallback_type,
  count(*) as fallback_count
from chat_fallbacks cf
join chat_sessions cs on cs.id = cf.session_id
where cs.started_at >= now() - interval '30 days'
group by cf.fallback_type
order by fallback_count desc;
```

Source reliability:

```sql
select
  source_name,
  status,
  count(*) as calls,
  avg(latency_ms)::int as avg_latency_ms,
  avg(case when cache_hit then 1 else 0 end)::numeric(5,2) as cache_hit_rate
from chat_tool_calls
where created_at >= now() - interval '30 days'
group by source_name, status
order by source_name, status;
```

Review evidence coverage:

```sql
select
  count(*) filter (where source_name = 'reviews') as review_backed_recs,
  count(*) filter (
    where source_name = 'reviews'
      and coalesce((result_json->>'evidence_count')::int, 0) > 0
      and coalesce(jsonb_array_length(result_json->'top_refs'), 0) > 0
  ) as review_backed_with_refs
from chat_tool_calls
where created_at >= now() - interval '30 days';
```

Silent failures (started, no terminal within 120s):

```sql
with started as (
  select id, started_at
  from chat_sessions
  where started_at >= now() - interval '30 days'
),
terminal as (
  select
    cs.id,
    min(cm.created_at) as terminal_at
  from chat_sessions cs
  join chat_messages cm on cm.session_id = cs.id
  where cm.role = 'assistant'
  group by cs.id
)
select
  count(*) as silent_failures
from started s
left join terminal t on t.id = s.id
where t.terminal_at is null
   or t.terminal_at > s.started_at + interval '120 seconds';
```

## 11) Alerting Rules

Page-level alerts:

1. `P95 first_insight_latency_ms > 5000` for 15 minutes.
2. `silent_failure_rate > 2%` over rolling 30 minutes.
3. `recommendation_actionability_rate < 95%` over rolling 60 minutes.

Source-level alerts:

1. any source timeout rate > 10% for 15 minutes.
2. any source freshness breach count above baseline.
3. all-sources-down fallback appears more than 3 times in 10 minutes.

## 12) Data Quality and Privacy Guardrails

1. Do not send raw addresses, emails, or full transcript text to PostHog.
2. Redact free text before persistence.
3. Maintain event versioning with `schema_version` property.
4. Validate required properties at emit time; drop and log invalid events.
5. For review evidence, send metadata only (`place_id`, `review_id/hash`, `publish_time`, `theme`, short snippet); never full raw review bodies to analytics.

## 13) Rollout Plan

1. Phase A: instrument event envelope + core journey events.
2. Phase B: instrument canonical `chat.turn.completed` and tool events.
3. Phase C: build dashboards and alert rules.
4. Phase D: run one-week baseline and tune thresholds.
