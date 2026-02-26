CREATE TABLE "pathway_chat_competitor_checks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sessionId" uuid NOT NULL,
	"turnIndex" integer NOT NULL,
	"queryText" text NOT NULL,
	"resolvedPlaceId" text,
	"resolvedName" text,
	"status" text NOT NULL,
	"latencyMs" integer,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_competitor_checks_status_check" CHECK ("pathway_chat_competitor_checks"."status" in ('resolved','not_found','ambiguous','error'))
);
--> statement-breakpoint
CREATE TABLE "pathway_chat_fallbacks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sessionId" uuid NOT NULL,
	"turnIndex" integer NOT NULL,
	"fallbackType" text NOT NULL,
	"reason" text NOT NULL,
	"sourcesDown" text[] DEFAULT '{}'::text[] NOT NULL,
	"responseText" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_fallbacks_type_check" CHECK ("pathway_chat_fallbacks"."fallbackType" in ('partial_data','all_sources_down','timeout','validation'))
);
--> statement-breakpoint
CREATE TABLE "pathway_chat_memory_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sessionId" uuid,
	"distinctId" text,
	"turnIndex" integer NOT NULL,
	"eventType" text NOT NULL,
	"memoryScope" text NOT NULL,
	"memoryNamespace" text NOT NULL,
	"memoryKey" text NOT NULL,
	"oldValueJson" jsonb,
	"newValueJson" jsonb NOT NULL,
	"valueSource" text NOT NULL,
	"assumed" boolean DEFAULT false NOT NULL,
	"confidenceCap" text DEFAULT 'none' NOT NULL,
	"correlationId" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_memory_events_type_check" CHECK ("pathway_chat_memory_events"."eventType" in ('fact_set','fact_corrected','assumption_set','assumption_corrected','fact_expired','fact_deleted')),
	CONSTRAINT "chat_memory_events_scope_check" CHECK ("pathway_chat_memory_events"."memoryScope" in ('session','cross_session')),
	CONSTRAINT "chat_memory_events_namespace_check" CHECK ("pathway_chat_memory_events"."memoryNamespace" in ('baseline','location','preference','constraint','system','other')),
	CONSTRAINT "chat_memory_events_value_source_check" CHECK ("pathway_chat_memory_events"."valueSource" in ('explicit','assumed','inferred','default')),
	CONSTRAINT "chat_memory_events_confidence_cap_check" CHECK ("pathway_chat_memory_events"."confidenceCap" in ('none','medium','low')),
	CONSTRAINT "chat_memory_events_scope_presence_check" CHECK ((("pathway_chat_memory_events"."memoryScope" = 'session' and "pathway_chat_memory_events"."sessionId" is not null) or ("pathway_chat_memory_events"."memoryScope" = 'cross_session' and "pathway_chat_memory_events"."distinctId" is not null)))
);
--> statement-breakpoint
CREATE TABLE "pathway_chat_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sessionId" uuid NOT NULL,
	"messageIndex" integer NOT NULL,
	"turnIndex" integer NOT NULL,
	"role" text NOT NULL,
	"contentText" text,
	"contentJson" jsonb,
	"piiRedacted" boolean DEFAULT true NOT NULL,
	"inputTokens" integer,
	"outputTokens" integer,
	"latencyMs" integer,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_messages_role_check" CHECK ("pathway_chat_messages"."role" in ('user','assistant','tool','system'))
);
--> statement-breakpoint
CREATE TABLE "pathway_chat_recommendation_evidence" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"recommendationId" bigint NOT NULL,
	"sessionId" uuid NOT NULL,
	"turnIndex" integer NOT NULL,
	"sourceName" text NOT NULL,
	"entityType" text NOT NULL,
	"placeId" text,
	"reviewIdHash" text,
	"reviewPublishAt" timestamp with time zone,
	"reviewRating" numeric(2, 1),
	"theme" text NOT NULL,
	"excerpt" text,
	"evidenceRank" smallint DEFAULT 1 NOT NULL,
	"evidenceWeight" numeric(6, 3),
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_recommendation_evidence_source_name_check" CHECK ("pathway_chat_recommendation_evidence"."sourceName" in ('reviews','events','weather','closures','doe','system')),
	CONSTRAINT "chat_recommendation_evidence_entity_type_check" CHECK ("pathway_chat_recommendation_evidence"."entityType" in ('own_location','competitor','system')),
	CONSTRAINT "chat_recommendation_evidence_theme_check" CHECK ("pathway_chat_recommendation_evidence"."theme" in ('wait_time','service_speed','host_queue','kitchen_delay','food_quality','value','other')),
	CONSTRAINT "chat_recommendation_evidence_rank_check" CHECK ("pathway_chat_recommendation_evidence"."evidenceRank" between 1 and 10),
	CONSTRAINT "chat_recommendation_evidence_reviews_required_check" CHECK ((("pathway_chat_recommendation_evidence"."sourceName" = 'reviews' and "pathway_chat_recommendation_evidence"."placeId" is not null and "pathway_chat_recommendation_evidence"."reviewPublishAt" is not null) or ("pathway_chat_recommendation_evidence"."sourceName" <> 'reviews')))
);
--> statement-breakpoint
CREATE TABLE "pathway_chat_recommendations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sessionId" uuid NOT NULL,
	"messageId" bigint,
	"turnIndex" integer NOT NULL,
	"locationLabel" text NOT NULL,
	"action" text NOT NULL,
	"timeWindow" text NOT NULL,
	"confidence" text NOT NULL,
	"sourceName" text NOT NULL,
	"sourceFreshnessSeconds" integer,
	"ruleVersion" text NOT NULL,
	"impactScore" numeric(6, 2),
	"reviewBacked" boolean DEFAULT false NOT NULL,
	"evidenceCount" integer DEFAULT 0 NOT NULL,
	"recencyWindowDays" smallint,
	"explanationJson" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_recommendations_confidence_check" CHECK ("pathway_chat_recommendations"."confidence" in ('low','medium','high')),
	CONSTRAINT "chat_recommendations_source_name_check" CHECK ("pathway_chat_recommendations"."sourceName" in ('weather','events','closures','doe','reviews','system'))
);
--> statement-breakpoint
CREATE TABLE "pathway_chat_review_signal_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sessionId" uuid NOT NULL,
	"turnIndex" integer NOT NULL,
	"entityType" text NOT NULL,
	"placeId" text NOT NULL,
	"sourceName" text DEFAULT 'reviews' NOT NULL,
	"sampleReviewCount" integer DEFAULT 0 NOT NULL,
	"evidenceCount" integer DEFAULT 0 NOT NULL,
	"recencyWindowDays" smallint NOT NULL,
	"themesDetected" text[] DEFAULT '{}'::text[] NOT NULL,
	"signalScoresJson" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text NOT NULL,
	"latencyMs" integer,
	"cacheHit" boolean DEFAULT false NOT NULL,
	"sourceFreshnessSeconds" integer,
	"errorCode" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_review_signal_runs_entity_type_check" CHECK ("pathway_chat_review_signal_runs"."entityType" in ('own_location','competitor')),
	CONSTRAINT "chat_review_signal_runs_source_name_check" CHECK ("pathway_chat_review_signal_runs"."sourceName" = 'reviews'),
	CONSTRAINT "chat_review_signal_runs_status_check" CHECK ("pathway_chat_review_signal_runs"."status" in ('ok','error','timeout','stale'))
);
--> statement-breakpoint
CREATE TABLE "pathway_chat_session_memory" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sessionId" uuid NOT NULL,
	"memoryNamespace" text NOT NULL,
	"memoryKey" text NOT NULL,
	"valueJson" jsonb NOT NULL,
	"valueSource" text NOT NULL,
	"assumed" boolean DEFAULT false NOT NULL,
	"confidenceCap" text DEFAULT 'none' NOT NULL,
	"sourceTurnIndex" integer NOT NULL,
	"sourceEventId" bigint,
	"firstSetAt" timestamp with time zone DEFAULT now() NOT NULL,
	"lastUpdatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"expiresAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_session_memory_namespace_check" CHECK ("pathway_chat_session_memory"."memoryNamespace" in ('baseline','location','preference','constraint','system','other')),
	CONSTRAINT "chat_session_memory_value_source_check" CHECK ("pathway_chat_session_memory"."valueSource" in ('explicit','assumed','inferred','default')),
	CONSTRAINT "chat_session_memory_confidence_cap_check" CHECK ("pathway_chat_session_memory"."confidenceCap" in ('none','medium','low'))
);
--> statement-breakpoint
CREATE TABLE "pathway_chat_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"startedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"endedAt" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"cardType" text DEFAULT 'none' NOT NULL,
	"locationCount" smallint DEFAULT 0 NOT NULL,
	"model" text NOT NULL,
	"promptVersion" text NOT NULL,
	"ruleVersion" text NOT NULL,
	"distinctId" text,
	"traceId" text,
	"firstInsightLatencyMs" integer,
	"hadFallback" boolean DEFAULT false NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "chat_sessions_status_check" CHECK ("pathway_chat_sessions"."status" in ('active','ended','error')),
	CONSTRAINT "chat_sessions_card_type_check" CHECK ("pathway_chat_sessions"."cardType" in ('staffing','risk','opportunity','none')),
	CONSTRAINT "chat_sessions_location_count_check" CHECK ("pathway_chat_sessions"."locationCount" between 0 and 3)
);
--> statement-breakpoint
CREATE TABLE "pathway_chat_tool_calls" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sessionId" uuid NOT NULL,
	"messageId" bigint,
	"turnIndex" integer NOT NULL,
	"toolName" text NOT NULL,
	"sourceName" text NOT NULL,
	"argsJson" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resultJson" jsonb,
	"status" text NOT NULL,
	"latencyMs" integer NOT NULL,
	"cacheHit" boolean DEFAULT false NOT NULL,
	"sourceFreshnessSeconds" integer,
	"errorCode" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_tool_calls_source_name_check" CHECK ("pathway_chat_tool_calls"."sourceName" in ('geocode','weather','events','closures','doe','reviews','memory')),
	CONSTRAINT "chat_tool_calls_status_check" CHECK ("pathway_chat_tool_calls"."status" in ('ok','error','timeout','stale'))
);
--> statement-breakpoint
CREATE TABLE "pathway_chat_user_preferences" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"distinctId" text NOT NULL,
	"preferenceNamespace" text NOT NULL,
	"preferenceKey" text NOT NULL,
	"valueJson" jsonb NOT NULL,
	"valueSource" text NOT NULL,
	"lastSessionId" uuid,
	"firstSetAt" timestamp with time zone DEFAULT now() NOT NULL,
	"lastUpdatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"expiresAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_user_preferences_namespace_check" CHECK ("pathway_chat_user_preferences"."preferenceNamespace" in ('baseline','ui','workflow','other')),
	CONSTRAINT "chat_user_preferences_value_source_check" CHECK ("pathway_chat_user_preferences"."valueSource" in ('explicit','inferred','default'))
);
--> statement-breakpoint
CREATE TABLE "pathway_doe_calendar_days" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"calendarDate" date NOT NULL,
	"eventType" text NOT NULL,
	"isSchoolDay" boolean NOT NULL,
	"sourceUpdatedAt" timestamp with time zone,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pathway_source_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sourceName" text NOT NULL,
	"runStartedAt" timestamp with time zone NOT NULL,
	"runFinishedAt" timestamp with time zone,
	"status" text NOT NULL,
	"itemsFetched" integer,
	"latestRecordAt" timestamp with time zone,
	"errorMessage" text,
	CONSTRAINT "source_runs_source_name_check" CHECK ("pathway_source_runs"."sourceName" in ('weather','events','closures','doe','reviews')),
	CONSTRAINT "source_runs_status_check" CHECK ("pathway_source_runs"."status" in ('ok','error','partial'))
);
--> statement-breakpoint
ALTER TABLE "pathway_chat_competitor_checks" ADD CONSTRAINT "pathway_chat_competitor_checks_sessionId_pathway_chat_sessions_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."pathway_chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pathway_chat_fallbacks" ADD CONSTRAINT "pathway_chat_fallbacks_sessionId_pathway_chat_sessions_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."pathway_chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pathway_chat_memory_events" ADD CONSTRAINT "pathway_chat_memory_events_sessionId_pathway_chat_sessions_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."pathway_chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pathway_chat_messages" ADD CONSTRAINT "pathway_chat_messages_sessionId_pathway_chat_sessions_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."pathway_chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pathway_chat_recommendation_evidence" ADD CONSTRAINT "pathway_chat_recommendation_evidence_recommendationId_pathway_chat_recommendations_id_fk" FOREIGN KEY ("recommendationId") REFERENCES "public"."pathway_chat_recommendations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pathway_chat_recommendation_evidence" ADD CONSTRAINT "pathway_chat_recommendation_evidence_sessionId_pathway_chat_sessions_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."pathway_chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pathway_chat_recommendations" ADD CONSTRAINT "pathway_chat_recommendations_sessionId_pathway_chat_sessions_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."pathway_chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pathway_chat_recommendations" ADD CONSTRAINT "pathway_chat_recommendations_messageId_pathway_chat_messages_id_fk" FOREIGN KEY ("messageId") REFERENCES "public"."pathway_chat_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pathway_chat_review_signal_runs" ADD CONSTRAINT "pathway_chat_review_signal_runs_sessionId_pathway_chat_sessions_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."pathway_chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pathway_chat_session_memory" ADD CONSTRAINT "pathway_chat_session_memory_sessionId_pathway_chat_sessions_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."pathway_chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pathway_chat_session_memory" ADD CONSTRAINT "pathway_chat_session_memory_sourceEventId_pathway_chat_memory_events_id_fk" FOREIGN KEY ("sourceEventId") REFERENCES "public"."pathway_chat_memory_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pathway_chat_tool_calls" ADD CONSTRAINT "pathway_chat_tool_calls_sessionId_pathway_chat_sessions_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."pathway_chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pathway_chat_tool_calls" ADD CONSTRAINT "pathway_chat_tool_calls_messageId_pathway_chat_messages_id_fk" FOREIGN KEY ("messageId") REFERENCES "public"."pathway_chat_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pathway_chat_user_preferences" ADD CONSTRAINT "pathway_chat_user_preferences_lastSessionId_pathway_chat_sessions_id_fk" FOREIGN KEY ("lastSessionId") REFERENCES "public"."pathway_chat_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_competitor_checks_session_turn_created_idx" ON "pathway_chat_competitor_checks" USING btree ("sessionId","turnIndex","createdAt");--> statement-breakpoint
CREATE INDEX "chat_fallbacks_session_turn_idx" ON "pathway_chat_fallbacks" USING btree ("sessionId","turnIndex");--> statement-breakpoint
CREATE INDEX "chat_memory_events_session_turn_idx" ON "pathway_chat_memory_events" USING btree ("sessionId","turnIndex","createdAt");--> statement-breakpoint
CREATE INDEX "chat_memory_events_distinct_created_idx" ON "pathway_chat_memory_events" USING btree ("distinctId","createdAt");--> statement-breakpoint
CREATE INDEX "chat_memory_events_key_created_idx" ON "pathway_chat_memory_events" USING btree ("memoryNamespace","memoryKey","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_session_message_index_uidx" ON "pathway_chat_messages" USING btree ("sessionId","messageIndex");--> statement-breakpoint
CREATE INDEX "chat_messages_session_turn_idx" ON "pathway_chat_messages" USING btree ("sessionId","turnIndex");--> statement-breakpoint
CREATE INDEX "chat_recommendation_evidence_recommendation_rank_idx" ON "pathway_chat_recommendation_evidence" USING btree ("recommendationId","evidenceRank");--> statement-breakpoint
CREATE INDEX "chat_recommendation_evidence_session_turn_created_idx" ON "pathway_chat_recommendation_evidence" USING btree ("sessionId","turnIndex","createdAt");--> statement-breakpoint
CREATE INDEX "chat_recommendation_evidence_place_publish_idx" ON "pathway_chat_recommendation_evidence" USING btree ("placeId","reviewPublishAt");--> statement-breakpoint
CREATE INDEX "chat_recommendations_session_turn_idx" ON "pathway_chat_recommendations" USING btree ("sessionId","turnIndex");--> statement-breakpoint
CREATE INDEX "chat_recommendations_review_backed_idx" ON "pathway_chat_recommendations" USING btree ("reviewBacked","createdAt");--> statement-breakpoint
CREATE INDEX "chat_review_signal_runs_session_turn_created_idx" ON "pathway_chat_review_signal_runs" USING btree ("sessionId","turnIndex","createdAt");--> statement-breakpoint
CREATE INDEX "chat_review_signal_runs_place_created_idx" ON "pathway_chat_review_signal_runs" USING btree ("placeId","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_session_memory_session_namespace_key_uidx" ON "pathway_chat_session_memory" USING btree ("sessionId","memoryNamespace","memoryKey");--> statement-breakpoint
CREATE INDEX "chat_session_memory_session_updated_idx" ON "pathway_chat_session_memory" USING btree ("sessionId","lastUpdatedAt");--> statement-breakpoint
CREATE INDEX "chat_session_memory_expiry_idx" ON "pathway_chat_session_memory" USING btree ("expiresAt");--> statement-breakpoint
CREATE INDEX "chat_sessions_started_at_idx" ON "pathway_chat_sessions" USING btree ("startedAt");--> statement-breakpoint
CREATE INDEX "chat_sessions_distinct_id_idx" ON "pathway_chat_sessions" USING btree ("distinctId");--> statement-breakpoint
CREATE INDEX "chat_tool_calls_session_turn_idx" ON "pathway_chat_tool_calls" USING btree ("sessionId","turnIndex");--> statement-breakpoint
CREATE INDEX "chat_tool_calls_source_created_idx" ON "pathway_chat_tool_calls" USING btree ("sourceName","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_user_preferences_distinct_namespace_key_uidx" ON "pathway_chat_user_preferences" USING btree ("distinctId","preferenceNamespace","preferenceKey");--> statement-breakpoint
CREATE INDEX "chat_user_preferences_distinct_updated_idx" ON "pathway_chat_user_preferences" USING btree ("distinctId","lastUpdatedAt");--> statement-breakpoint
CREATE INDEX "chat_user_preferences_expiry_idx" ON "pathway_chat_user_preferences" USING btree ("expiresAt");--> statement-breakpoint
CREATE UNIQUE INDEX "doe_calendar_days_date_uidx" ON "pathway_doe_calendar_days" USING btree ("calendarDate");--> statement-breakpoint
CREATE INDEX "doe_calendar_days_school_day_idx" ON "pathway_doe_calendar_days" USING btree ("isSchoolDay","calendarDate");--> statement-breakpoint
CREATE INDEX "source_runs_name_finished_idx" ON "pathway_source_runs" USING btree ("sourceName","runFinishedAt");
