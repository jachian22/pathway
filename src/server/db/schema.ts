import { sql } from "drizzle-orm";
import { check, index, numeric, pgTableCreator, uniqueIndex } from "drizzle-orm/pg-core";

export const createTable = pgTableCreator((name) => `pathway_${name}`);

export const posts = createTable(
  "post",
  (d) => ({
    id: d.integer().primaryKey().generatedByDefaultAsIdentity(),
    name: d.varchar({ length: 256 }),
    createdAt: d.timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: d.timestamp({ withTimezone: true }).$onUpdate(() => new Date()),
  }),
  (t) => [index("post_name_idx").on(t.name)],
);

export const chatSessions = createTable(
  "chat_sessions",
  (d) => ({
    id: d.uuid().primaryKey().defaultRandom(),
    startedAt: d.timestamp({ withTimezone: true }).defaultNow().notNull(),
    endedAt: d.timestamp({ withTimezone: true }),
    status: d.text().default("active").notNull(),
    cardType: d.text().default("none").notNull(),
    locationCount: d.smallint().default(0).notNull(),
    model: d.text().notNull(),
    promptVersion: d.text().notNull(),
    ruleVersion: d.text().notNull(),
    distinctId: d.text(),
    traceId: d.text(),
    firstInsightLatencyMs: d.integer(),
    hadFallback: d.boolean().default(false).notNull(),
    meta: d
      .jsonb()
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
  }),
  (t) => [
    index("chat_sessions_started_at_idx").on(t.startedAt),
    index("chat_sessions_distinct_id_idx").on(t.distinctId),
    check("chat_sessions_status_check", sql`${t.status} in ('active','ended','error')`),
    check(
      "chat_sessions_card_type_check",
      sql`${t.cardType} in ('staffing','risk','opportunity','none')`,
    ),
    check("chat_sessions_location_count_check", sql`${t.locationCount} between 0 and 3`),
  ],
);

export const chatMessages = createTable(
  "chat_messages",
  (d) => ({
    id: d.bigserial({ mode: "number" }).primaryKey(),
    sessionId: d
      .uuid()
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    messageIndex: d.integer().notNull(),
    turnIndex: d.integer().notNull(),
    role: d.text().notNull(),
    contentText: d.text(),
    contentJson: d.jsonb().$type<Record<string, unknown>>(),
    piiRedacted: d.boolean().default(true).notNull(),
    inputTokens: d.integer(),
    outputTokens: d.integer(),
    latencyMs: d.integer(),
    createdAt: d.timestamp({ withTimezone: true }).defaultNow().notNull(),
  }),
  (t) => [
    uniqueIndex("chat_messages_session_message_index_uidx").on(t.sessionId, t.messageIndex),
    index("chat_messages_session_turn_idx").on(t.sessionId, t.turnIndex),
    check("chat_messages_role_check", sql`${t.role} in ('user','assistant','tool','system')`),
  ],
);

export const chatToolCalls = createTable(
  "chat_tool_calls",
  (d) => ({
    id: d.bigserial({ mode: "number" }).primaryKey(),
    sessionId: d
      .uuid()
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    messageId: d
      .bigint({ mode: "number" })
      .references(() => chatMessages.id, { onDelete: "set null" }),
    turnIndex: d.integer().notNull(),
    toolName: d.text().notNull(),
    sourceName: d.text().notNull(),
    argsJson: d
      .jsonb()
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    resultJson: d.jsonb().$type<Record<string, unknown>>(),
    status: d.text().notNull(),
    latencyMs: d.integer().notNull(),
    cacheHit: d.boolean().default(false).notNull(),
    sourceFreshnessSeconds: d.integer(),
    errorCode: d.text(),
    createdAt: d.timestamp({ withTimezone: true }).defaultNow().notNull(),
  }),
  (t) => [
    index("chat_tool_calls_session_turn_idx").on(t.sessionId, t.turnIndex),
    index("chat_tool_calls_source_created_idx").on(t.sourceName, t.createdAt),
    check(
      "chat_tool_calls_source_name_check",
      sql`${t.sourceName} in ('geocode','weather','events','closures','doe','reviews','memory')`,
    ),
    check("chat_tool_calls_status_check", sql`${t.status} in ('ok','error','timeout','stale')`),
  ],
);

export const chatRecommendations = createTable(
  "chat_recommendations",
  (d) => ({
    id: d.bigserial({ mode: "number" }).primaryKey(),
    sessionId: d
      .uuid()
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    messageId: d
      .bigint({ mode: "number" })
      .references(() => chatMessages.id, { onDelete: "set null" }),
    turnIndex: d.integer().notNull(),
    locationLabel: d.text().notNull(),
    action: d.text().notNull(),
    timeWindow: d.text().notNull(),
    confidence: d.text().notNull(),
    sourceName: d.text().notNull(),
    sourceFreshnessSeconds: d.integer(),
    ruleVersion: d.text().notNull(),
    impactScore: numeric({ precision: 6, scale: 2 }),
    reviewBacked: d.boolean().default(false).notNull(),
    evidenceCount: d.integer().default(0).notNull(),
    recencyWindowDays: d.smallint(),
    explanationJson: d
      .jsonb()
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    meta: d
      .jsonb()
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    createdAt: d.timestamp({ withTimezone: true }).defaultNow().notNull(),
  }),
  (t) => [
    index("chat_recommendations_session_turn_idx").on(t.sessionId, t.turnIndex),
    index("chat_recommendations_review_backed_idx").on(t.reviewBacked, t.createdAt),
    check(
      "chat_recommendations_confidence_check",
      sql`${t.confidence} in ('low','medium','high')`,
    ),
    check(
      "chat_recommendations_source_name_check",
      sql`${t.sourceName} in ('weather','events','closures','doe','reviews','system')`,
    ),
  ],
);

export const chatFallbacks = createTable(
  "chat_fallbacks",
  (d) => ({
    id: d.bigserial({ mode: "number" }).primaryKey(),
    sessionId: d
      .uuid()
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    turnIndex: d.integer().notNull(),
    fallbackType: d.text().notNull(),
    reason: d.text().notNull(),
    sourcesDown: d.text().array().default(sql`'{}'::text[]`).notNull(),
    responseText: d.text().notNull(),
    createdAt: d.timestamp({ withTimezone: true }).defaultNow().notNull(),
  }),
  (t) => [
    index("chat_fallbacks_session_turn_idx").on(t.sessionId, t.turnIndex),
    check(
      "chat_fallbacks_type_check",
      sql`${t.fallbackType} in ('partial_data','all_sources_down','timeout','validation')`,
    ),
  ],
);

export const sourceRuns = createTable(
  "source_runs",
  (d) => ({
    id: d.bigserial({ mode: "number" }).primaryKey(),
    sourceName: d.text().notNull(),
    runStartedAt: d.timestamp({ withTimezone: true }).notNull(),
    runFinishedAt: d.timestamp({ withTimezone: true }),
    status: d.text().notNull(),
    itemsFetched: d.integer(),
    latestRecordAt: d.timestamp({ withTimezone: true }),
    errorMessage: d.text(),
  }),
  (t) => [
    index("source_runs_name_finished_idx").on(t.sourceName, t.runFinishedAt),
    check(
      "source_runs_source_name_check",
      sql`${t.sourceName} in ('weather','events','closures','doe','reviews')`,
    ),
    check("source_runs_status_check", sql`${t.status} in ('ok','error','partial')`),
  ],
);

export const chatMemoryEvents = createTable(
  "chat_memory_events",
  (d) => ({
    id: d.bigserial({ mode: "number" }).primaryKey(),
    sessionId: d.uuid().references(() => chatSessions.id, { onDelete: "cascade" }),
    distinctId: d.text(),
    turnIndex: d.integer().notNull(),
    eventType: d.text().notNull(),
    memoryScope: d.text().notNull(),
    memoryNamespace: d.text().notNull(),
    memoryKey: d.text().notNull(),
    oldValueJson: d.jsonb().$type<Record<string, unknown>>(),
    newValueJson: d.jsonb().$type<Record<string, unknown>>().notNull(),
    valueSource: d.text().notNull(),
    assumed: d.boolean().default(false).notNull(),
    confidenceCap: d.text().default("none").notNull(),
    correlationId: d.text(),
    createdAt: d.timestamp({ withTimezone: true }).defaultNow().notNull(),
  }),
  (t) => [
    index("chat_memory_events_session_turn_idx").on(t.sessionId, t.turnIndex, t.createdAt),
    index("chat_memory_events_distinct_created_idx").on(t.distinctId, t.createdAt),
    index("chat_memory_events_key_created_idx").on(t.memoryNamespace, t.memoryKey, t.createdAt),
    check(
      "chat_memory_events_type_check",
      sql`${t.eventType} in ('fact_set','fact_corrected','assumption_set','assumption_corrected','fact_expired','fact_deleted')`,
    ),
    check("chat_memory_events_scope_check", sql`${t.memoryScope} in ('session','cross_session')`),
    check(
      "chat_memory_events_namespace_check",
      sql`${t.memoryNamespace} in ('baseline','location','preference','constraint','system','other')`,
    ),
    check(
      "chat_memory_events_value_source_check",
      sql`${t.valueSource} in ('explicit','assumed','inferred','default')`,
    ),
    check("chat_memory_events_confidence_cap_check", sql`${t.confidenceCap} in ('none','medium','low')`),
    check(
      "chat_memory_events_scope_presence_check",
      sql`((${t.memoryScope} = 'session' and ${t.sessionId} is not null) or (${t.memoryScope} = 'cross_session' and ${t.distinctId} is not null))`,
    ),
  ],
);

export const chatSessionMemory = createTable(
  "chat_session_memory",
  (d) => ({
    id: d.bigserial({ mode: "number" }).primaryKey(),
    sessionId: d
      .uuid()
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    memoryNamespace: d.text().notNull(),
    memoryKey: d.text().notNull(),
    valueJson: d.jsonb().$type<Record<string, unknown>>().notNull(),
    valueSource: d.text().notNull(),
    assumed: d.boolean().default(false).notNull(),
    confidenceCap: d.text().default("none").notNull(),
    sourceTurnIndex: d.integer().notNull(),
    sourceEventId: d
      .bigint({ mode: "number" })
      .references(() => chatMemoryEvents.id, { onDelete: "set null" }),
    firstSetAt: d.timestamp({ withTimezone: true }).defaultNow().notNull(),
    lastUpdatedAt: d.timestamp({ withTimezone: true }).defaultNow().notNull(),
    expiresAt: d.timestamp({ withTimezone: true }),
    createdAt: d.timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: d.timestamp({ withTimezone: true }).defaultNow().notNull(),
  }),
  (t) => [
    uniqueIndex("chat_session_memory_session_namespace_key_uidx").on(
      t.sessionId,
      t.memoryNamespace,
      t.memoryKey,
    ),
    index("chat_session_memory_session_updated_idx").on(t.sessionId, t.lastUpdatedAt),
    index("chat_session_memory_expiry_idx").on(t.expiresAt),
    check(
      "chat_session_memory_namespace_check",
      sql`${t.memoryNamespace} in ('baseline','location','preference','constraint','system','other')`,
    ),
    check(
      "chat_session_memory_value_source_check",
      sql`${t.valueSource} in ('explicit','assumed','inferred','default')`,
    ),
    check("chat_session_memory_confidence_cap_check", sql`${t.confidenceCap} in ('none','medium','low')`),
  ],
);

export const chatUserPreferences = createTable(
  "chat_user_preferences",
  (d) => ({
    id: d.bigserial({ mode: "number" }).primaryKey(),
    distinctId: d.text().notNull(),
    preferenceNamespace: d.text().notNull(),
    preferenceKey: d.text().notNull(),
    valueJson: d.jsonb().$type<Record<string, unknown>>().notNull(),
    valueSource: d.text().notNull(),
    lastSessionId: d.uuid().references(() => chatSessions.id, { onDelete: "set null" }),
    firstSetAt: d.timestamp({ withTimezone: true }).defaultNow().notNull(),
    lastUpdatedAt: d.timestamp({ withTimezone: true }).defaultNow().notNull(),
    expiresAt: d.timestamp({ withTimezone: true }),
    createdAt: d.timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: d.timestamp({ withTimezone: true }).defaultNow().notNull(),
  }),
  (t) => [
    uniqueIndex("chat_user_preferences_distinct_namespace_key_uidx").on(
      t.distinctId,
      t.preferenceNamespace,
      t.preferenceKey,
    ),
    index("chat_user_preferences_distinct_updated_idx").on(t.distinctId, t.lastUpdatedAt),
    index("chat_user_preferences_expiry_idx").on(t.expiresAt),
    check(
      "chat_user_preferences_namespace_check",
      sql`${t.preferenceNamespace} in ('baseline','ui','workflow','other')`,
    ),
    check(
      "chat_user_preferences_value_source_check",
      sql`${t.valueSource} in ('explicit','inferred','default')`,
    ),
  ],
);

export const chatCompetitorChecks = createTable(
  "chat_competitor_checks",
  (d) => ({
    id: d.bigserial({ mode: "number" }).primaryKey(),
    sessionId: d
      .uuid()
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    turnIndex: d.integer().notNull(),
    queryText: d.text().notNull(),
    resolvedPlaceId: d.text(),
    resolvedName: d.text(),
    status: d.text().notNull(),
    latencyMs: d.integer(),
    createdAt: d.timestamp({ withTimezone: true }).defaultNow().notNull(),
  }),
  (t) => [
    index("chat_competitor_checks_session_turn_created_idx").on(t.sessionId, t.turnIndex, t.createdAt),
    check(
      "chat_competitor_checks_status_check",
      sql`${t.status} in ('resolved','not_found','ambiguous','error')`,
    ),
  ],
);

export const chatReviewSignalRuns = createTable(
  "chat_review_signal_runs",
  (d) => ({
    id: d.bigserial({ mode: "number" }).primaryKey(),
    sessionId: d
      .uuid()
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    turnIndex: d.integer().notNull(),
    entityType: d.text().notNull(),
    placeId: d.text().notNull(),
    sourceName: d.text().default("reviews").notNull(),
    sampleReviewCount: d.integer().default(0).notNull(),
    evidenceCount: d.integer().default(0).notNull(),
    recencyWindowDays: d.smallint().notNull(),
    themesDetected: d.text().array().default(sql`'{}'::text[]`).notNull(),
    signalScoresJson: d
      .jsonb()
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    status: d.text().notNull(),
    latencyMs: d.integer(),
    cacheHit: d.boolean().default(false).notNull(),
    sourceFreshnessSeconds: d.integer(),
    errorCode: d.text(),
    createdAt: d.timestamp({ withTimezone: true }).defaultNow().notNull(),
  }),
  (t) => [
    index("chat_review_signal_runs_session_turn_created_idx").on(t.sessionId, t.turnIndex, t.createdAt),
    index("chat_review_signal_runs_place_created_idx").on(t.placeId, t.createdAt),
    check(
      "chat_review_signal_runs_entity_type_check",
      sql`${t.entityType} in ('own_location','competitor')`,
    ),
    check("chat_review_signal_runs_source_name_check", sql`${t.sourceName} = 'reviews'`),
    check(
      "chat_review_signal_runs_status_check",
      sql`${t.status} in ('ok','error','timeout','stale')`,
    ),
  ],
);

export const chatRecommendationEvidence = createTable(
  "chat_recommendation_evidence",
  (d) => ({
    id: d.bigserial({ mode: "number" }).primaryKey(),
    recommendationId: d
      .bigint({ mode: "number" })
      .notNull()
      .references(() => chatRecommendations.id, { onDelete: "cascade" }),
    sessionId: d
      .uuid()
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    turnIndex: d.integer().notNull(),
    sourceName: d.text().notNull(),
    entityType: d.text().notNull(),
    placeId: d.text(),
    reviewIdHash: d.text(),
    reviewPublishAt: d.timestamp({ withTimezone: true }),
    reviewRating: numeric({ precision: 2, scale: 1 }),
    theme: d.text().notNull(),
    excerpt: d.text(),
    evidenceRank: d.smallint().default(1).notNull(),
    evidenceWeight: numeric({ precision: 6, scale: 3 }),
    meta: d
      .jsonb()
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    createdAt: d.timestamp({ withTimezone: true }).defaultNow().notNull(),
  }),
  (t) => [
    index("chat_recommendation_evidence_recommendation_rank_idx").on(
      t.recommendationId,
      t.evidenceRank,
    ),
    index("chat_recommendation_evidence_session_turn_created_idx").on(
      t.sessionId,
      t.turnIndex,
      t.createdAt,
    ),
    index("chat_recommendation_evidence_place_publish_idx").on(t.placeId, t.reviewPublishAt),
    check(
      "chat_recommendation_evidence_source_name_check",
      sql`${t.sourceName} in ('reviews','events','weather','closures','doe','system')`,
    ),
    check(
      "chat_recommendation_evidence_entity_type_check",
      sql`${t.entityType} in ('own_location','competitor','system')`,
    ),
    check(
      "chat_recommendation_evidence_theme_check",
      sql`${t.theme} in ('wait_time','service_speed','host_queue','kitchen_delay','food_quality','value','other')`,
    ),
    check(
      "chat_recommendation_evidence_rank_check",
      sql`${t.evidenceRank} between 1 and 10`,
    ),
    check(
      "chat_recommendation_evidence_reviews_required_check",
      sql`((${t.sourceName} = 'reviews' and ${t.placeId} is not null and ${t.reviewPublishAt} is not null) or (${t.sourceName} <> 'reviews'))`,
    ),
  ],
);

export const doeCalendarDays = createTable(
  "doe_calendar_days",
  (d) => ({
    id: d.bigserial({ mode: "number" }).primaryKey(),
    calendarDate: d.date().notNull(),
    eventType: d.text().notNull(),
    isSchoolDay: d.boolean().notNull(),
    sourceUpdatedAt: d.timestamp({ withTimezone: true }),
    meta: d
      .jsonb()
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    createdAt: d.timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: d.timestamp({ withTimezone: true }).defaultNow().notNull(),
  }),
  (t) => [
    uniqueIndex("doe_calendar_days_date_uidx").on(t.calendarDate),
    index("doe_calendar_days_school_day_idx").on(t.isSchoolDay, t.calendarDate),
  ],
);
