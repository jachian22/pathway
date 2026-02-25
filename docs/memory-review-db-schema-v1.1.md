# Memory + Review Evidence DB Schema (v1.1)

Last updated: 2026-02-25  
Status: Migration-ready

Related:

- `docs/restaurant-intelligence-v1.1.md`
- `docs/agent-design-decisions.md`
- `docs/landing-page-chat-analytics-spec.md`

Note:

- SQL below uses unprefixed table names (`chat_sessions`, etc.).
- If using Drizzle `pgTableCreator((n) => \`pathway_${n}\`)`, apply the same definitions with the `pathway_` prefix.

## 1) Goals

1. Persist session memory and cross-session preferences without transcript stuffing.
2. Keep append-only audit trail of assumptions and corrections.
3. Make review-backed recommendations referenceable (date/context/source ref).
4. Support analytics queries without parsing raw free text.

## 2) SQL Migration

```sql
-- 0) Safety: UUID extension
create extension if not exists pgcrypto;

-- 1) Expand existing source constraints for v1.1 (doe + reviews)
alter table if exists chat_tool_calls
  drop constraint if exists chat_tool_calls_source_name_check;

alter table if exists chat_tool_calls
  add constraint chat_tool_calls_source_name_check
  check (source_name in ('geocode', 'weather', 'events', 'closures', 'doe', 'reviews', 'memory'));

alter table if exists chat_recommendations
  drop constraint if exists chat_recommendations_source_name_check;

alter table if exists chat_recommendations
  add constraint chat_recommendations_source_name_check
  check (source_name in ('weather', 'events', 'closures', 'doe', 'reviews', 'system'));

alter table if exists source_runs
  drop constraint if exists source_runs_source_name_check;

alter table if exists source_runs
  add constraint source_runs_source_name_check
  check (source_name in ('weather', 'events', 'closures', 'doe', 'reviews'));

-- 2) Recommendation summary fields for evidence coverage queries
alter table if exists chat_recommendations
  add column if not exists review_backed boolean not null default false,
  add column if not exists evidence_count integer not null default 0,
  add column if not exists recency_window_days smallint,
  add column if not exists explanation_json jsonb not null default '{}'::jsonb;

create index if not exists idx_chat_recommendations_review_backed
  on chat_recommendations (review_backed, created_at desc);

-- 3) Append-only memory event log (audit trail)
create table if not exists chat_memory_events (
  id bigserial primary key,
  session_id uuid references chat_sessions(id) on delete cascade,
  distinct_id text,
  turn_index integer not null,
  event_type text not null
    check (event_type in (
      'fact_set',
      'fact_corrected',
      'assumption_set',
      'assumption_corrected',
      'fact_expired',
      'fact_deleted'
    )),
  memory_scope text not null
    check (memory_scope in ('session', 'cross_session')),
  memory_namespace text not null
    check (memory_namespace in ('baseline', 'location', 'preference', 'constraint', 'system', 'other')),
  memory_key text not null,
  old_value_json jsonb,
  new_value_json jsonb not null,
  value_source text not null
    check (value_source in ('explicit', 'assumed', 'inferred', 'default')),
  assumed boolean not null default false,
  confidence_cap text not null default 'none'
    check (confidence_cap in ('none', 'medium', 'low')),
  correlation_id text,
  created_at timestamptz not null default now(),
  check (
    (memory_scope = 'session' and session_id is not null)
    or
    (memory_scope = 'cross_session' and distinct_id is not null)
  )
);

create index if not exists idx_chat_memory_events_session_turn
  on chat_memory_events (session_id, turn_index, created_at desc);

create index if not exists idx_chat_memory_events_distinct_created
  on chat_memory_events (distinct_id, created_at desc);

create index if not exists idx_chat_memory_events_key_created
  on chat_memory_events (memory_namespace, memory_key, created_at desc);

-- 4) Session memory projection (current state for fast reads)
create table if not exists chat_session_memory (
  id bigserial primary key,
  session_id uuid not null references chat_sessions(id) on delete cascade,
  memory_namespace text not null
    check (memory_namespace in ('baseline', 'location', 'preference', 'constraint', 'system', 'other')),
  memory_key text not null,
  value_json jsonb not null,
  value_source text not null
    check (value_source in ('explicit', 'assumed', 'inferred', 'default')),
  assumed boolean not null default false,
  confidence_cap text not null default 'none'
    check (confidence_cap in ('none', 'medium', 'low')),
  source_turn_index integer not null,
  source_event_id bigint references chat_memory_events(id) on delete set null,
  first_set_at timestamptz not null default now(),
  last_updated_at timestamptz not null default now(),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, memory_namespace, memory_key)
);

create index if not exists idx_chat_session_memory_session_updated
  on chat_session_memory (session_id, last_updated_at desc);

create index if not exists idx_chat_session_memory_expiry
  on chat_session_memory (expires_at);

-- 5) Cross-session preference memory (light personalization)
create table if not exists chat_user_preferences (
  id bigserial primary key,
  distinct_id text not null,
  preference_namespace text not null
    check (preference_namespace in ('baseline', 'ui', 'workflow', 'other')),
  preference_key text not null,
  value_json jsonb not null,
  value_source text not null
    check (value_source in ('explicit', 'inferred', 'default')),
  last_session_id uuid references chat_sessions(id) on delete set null,
  first_set_at timestamptz not null default now(),
  last_updated_at timestamptz not null default now(),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (distinct_id, preference_namespace, preference_key)
);

create index if not exists idx_chat_user_preferences_distinct
  on chat_user_preferences (distinct_id, last_updated_at desc);

create index if not exists idx_chat_user_preferences_expiry
  on chat_user_preferences (expires_at);

-- 6) Competitor checks (explicit user-triggered)
create table if not exists chat_competitor_checks (
  id bigserial primary key,
  session_id uuid not null references chat_sessions(id) on delete cascade,
  turn_index integer not null,
  query_text text not null,
  resolved_place_id text,
  resolved_name text,
  status text not null
    check (status in ('resolved', 'not_found', 'ambiguous', 'error')),
  latency_ms integer,
  created_at timestamptz not null default now()
);

create index if not exists idx_chat_competitor_checks_session_turn
  on chat_competitor_checks (session_id, turn_index, created_at desc);

-- 7) Review signal extraction runs (structured diagnostic output)
create table if not exists chat_review_signal_runs (
  id bigserial primary key,
  session_id uuid not null references chat_sessions(id) on delete cascade,
  turn_index integer not null,
  entity_type text not null
    check (entity_type in ('own_location', 'competitor')),
  place_id text not null,
  source_name text not null default 'reviews'
    check (source_name = 'reviews'),
  sample_review_count integer not null default 0,
  evidence_count integer not null default 0,
  recency_window_days smallint not null,
  themes_detected text[] not null default '{}',
  signal_scores_json jsonb not null default '{}'::jsonb,
  status text not null
    check (status in ('ok', 'error', 'timeout', 'stale')),
  latency_ms integer,
  cache_hit boolean not null default false,
  source_freshness_seconds integer,
  error_code text,
  created_at timestamptz not null default now()
);

create index if not exists idx_chat_review_signal_runs_session_turn
  on chat_review_signal_runs (session_id, turn_index, created_at desc);

create index if not exists idx_chat_review_signal_runs_place_created
  on chat_review_signal_runs (place_id, created_at desc);

-- 8) Evidence refs linked to recommendations (traceability contract)
create table if not exists chat_recommendation_evidence (
  id bigserial primary key,
  recommendation_id bigint not null references chat_recommendations(id) on delete cascade,
  session_id uuid not null references chat_sessions(id) on delete cascade,
  turn_index integer not null,
  source_name text not null
    check (source_name in ('reviews', 'events', 'weather', 'closures', 'doe', 'system')),
  entity_type text not null
    check (entity_type in ('own_location', 'competitor', 'system')),
  place_id text,
  review_id_hash text,
  review_publish_at timestamptz,
  review_rating numeric(2,1),
  theme text not null
    check (theme in (
      'wait_time',
      'service_speed',
      'host_queue',
      'kitchen_delay',
      'food_quality',
      'value',
      'other'
    )),
  excerpt text,
  evidence_rank smallint not null default 1
    check (evidence_rank between 1 and 10),
  evidence_weight numeric(6,3),
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (
    (source_name = 'reviews' and place_id is not null and review_publish_at is not null)
    or
    (source_name <> 'reviews')
  )
);

create index if not exists idx_chat_recommendation_evidence_recommendation
  on chat_recommendation_evidence (recommendation_id, evidence_rank);

create index if not exists idx_chat_recommendation_evidence_session_turn
  on chat_recommendation_evidence (session_id, turn_index, created_at desc);

create index if not exists idx_chat_recommendation_evidence_place_publish
  on chat_recommendation_evidence (place_id, review_publish_at desc);
```

## 3) Canonical Memory Keys

Use consistent keys to avoid ad hoc memory shape drift.

Session memory (`chat_session_memory`):

1. `baseline.scope` -> `{"value":"all"|"single","locationLabel":"..."}`
2. `baseline.foh.{locationLabel}.{daypart}` -> `{"value":4}`
3. `locations.confirmed` -> `{"items":[...]}`
4. `assumption.last` -> structured assumption payload

Cross-session preferences (`chat_user_preferences`):

1. `ui.response_depth` -> `{"value":"balanced"|"verbose"}`
2. `baseline.default_scope` -> `{"value":"all"|"single"}`
3. `workflow.default_card` -> `{"value":"staffing"|"risk"|"opportunity"}`

## 4) Write Semantics

1. Write event first to `chat_memory_events`.
2. Upsert projection row in `chat_session_memory` or `chat_user_preferences`.
3. Set `assumed=true` and `confidence_cap` when defaults are used.
4. On correction:
   - write `assumption_corrected`/`fact_corrected` event
   - overwrite projection value
   - update `last_updated_at`

## 5) Retention Jobs

1. Session memory and transcripts: purge rows older than 90 days.
2. Cross-session preferences: purge expired rows (`expires_at < now()`), default 90 days.
3. Evidence refs:
   - keep metadata for audit window (90 days)
   - avoid storing full raw review bodies

## 6) Deletion Operations

Hard delete by `session_id`:

```sql
delete from chat_sessions where id = $1;
```

Hard delete by user identity:

```sql
delete from chat_user_preferences where distinct_id = $1;
delete from chat_memory_events where distinct_id = $1;
```

## 7) Drizzle Implementation Checklist

1. Add enum-like text checks as shown above (or `pgEnum`).
2. Model `chat_recommendation_evidence` as a first-class table, not JSON-only.
3. Keep `chat_memory_events` append-only in repository layer.
4. Implement projection upserts for:
   - `chat_session_memory`
   - `chat_user_preferences`
5. Add test fixtures for:
   - assumption set/correct flows
   - review-backed recommendation with dated evidence refs
   - retention and hard-delete paths
