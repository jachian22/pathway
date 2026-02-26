import { and, count, desc, eq, sql } from "drizzle-orm";

import { env } from "@/env";
import type { DbClient } from "@/server/db";
import {
  chatCompetitorChecks,
  chatFallbacks,
  chatMemoryEvents,
  chatMessages,
  chatRecommendationEvidence,
  chatRecommendations,
  chatReviewSignalRuns,
  chatSessions,
  chatToolCalls,
} from "@/server/db/schema";
import { emitEvent } from "@/server/observability/emit";
import { searchPlaces } from "@/server/services/google-places";
import { runAgentTurn } from "@/server/services/intelligence/agent/controller";
import { runIdempotent } from "@/server/services/intelligence/agent/idempotency";
import { withSessionLock } from "@/server/services/intelligence/agent/lock";
import {
  MODEL_ID,
  PROMPT_VERSION,
  RULE_VERSION,
} from "@/server/services/intelligence/constants";
import { resolveLocations } from "@/server/services/intelligence/location";
import { buildRecommendations } from "@/server/services/intelligence/recommendation-engine";
import { fetchSourceBundle } from "@/server/services/intelligence/sources";
import {
  type CardType,
  type Recommendation,
} from "@/server/services/intelligence/types";
import { nowMs } from "@/server/observability/trace";

interface BaselineContextInput {
  locationLabel: string;
  baselineFoh?: number;
  baselineBoh?: number;
}

export interface FirstInsightInput {
  sessionId?: string;
  distinctId?: string;
  idempotencyKey?: string;
  cardType: CardType;
  locations: string[];
  baselineContext?: BaselineContextInput[];
  competitorName?: string;
}

export interface IntelligenceContext {
  db: DbClient;
  traceId: string;
  requestId?: string;
}

export interface FirstInsightOutput {
  sessionId: string;
  turnIndex: number;
  summary: string;
  message: string;
  locationLabels: string[];
  recommendations: Recommendation[];
  snapshots: {
    locationLabel: string;
    text: string;
    sampleReviewCount: number;
    recencyWindowDays: number;
    confidence: "low" | "medium" | "high";
  }[];
  competitorSnapshot?: {
    label: string;
    text: string;
    confidence: "low" | "medium" | "high";
    sampleReviewCount: number;
    recencyWindowDays: number;
    status:
      | "resolved_with_reviews"
      | "resolved_no_recent_reviews"
      | "not_found"
      | "limit_reached";
  };
  sources: {
    weather: {
      status: "ok" | "error" | "stale" | "timeout";
      freshnessSeconds?: number;
    };
    events: {
      status: "ok" | "error" | "stale" | "timeout";
      freshnessSeconds?: number;
    };
    closures: {
      status: "ok" | "error" | "stale" | "timeout";
      freshnessSeconds?: number;
    };
    doe: {
      status: "ok" | "error" | "stale" | "timeout";
      freshnessSeconds?: number;
    };
    reviews: {
      status: "ok" | "error" | "stale" | "timeout";
      freshnessSeconds?: number;
    };
  };
  usedFallback: boolean;
  firstInsightLatencyMs: number;
  invalidLocations: string[];
}

async function safeSideEffect(
  ctx: IntelligenceContext,
  params: {
    sessionId: string;
    turnIndex: number;
    operation: string;
    requestId?: string;
  },
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    await emitEvent(
      {
        event: "chat.error",
        trace_id: ctx.traceId,
        request_id: params.requestId ?? ctx.requestId,
        session_id: params.sessionId,
        turn_index: params.turnIndex,
        route: "intelligence.firstInsight",
        env: process.env.NODE_ENV,
      },
      {
        error_type: "side_effect_failure",
        error_message: `${params.operation}: ${message}`,
      },
      {
        level: "warn",
      },
    );
  }
}

function buildMessage(output: {
  summary: string;
  recommendations: Recommendation[];
  competitorSnapshot?: FirstInsightOutput["competitorSnapshot"];
}): string {
  const summaryHeadline = output.summary.split("\n")[0]?.trim();
  const headline =
    summaryHeadline && summaryHeadline.length > 0
      ? summaryHeadline
      : "Next 3 days staffing and prep signals:";
  const lines: string[] = [headline];

  const topRecommendation = output.recommendations[0];
  if (topRecommendation) {
    lines.push("", `Top action: ${topRecommendation.action}`);
  }

  const topDriver = topRecommendation?.explanation.why[0]?.trim();
  if (topDriver && topDriver.length > 0) {
    lines.push(`Why now: ${topDriver}`);
  }

  if (output.competitorSnapshot) {
    lines.push(
      "",
      `Competitor check: ${output.competitorSnapshot.label} (${output.competitorSnapshot.confidence}).`,
    );
  }

  if (output.recommendations.length > 1) {
    lines.push(
      `I added ${output.recommendations.length - 1} more actions in the cards below.`,
    );
  }

  if (output.recommendations.length > 0) {
    lines.push(
      "",
      "Want to adjust any of these based on your current staffing?",
    );
  }

  return lines.join("\n");
}

function buildValidationFallbackRecommendation(): Recommendation {
  return {
    locationLabel: "your NYC locations",
    action:
      "Next 24h: run standard staffing and prep, keep delivery timing flexible, and re-check once valid NYC locations are entered",
    timeWindow: "Next 24h",
    confidence: "low",
    sourceName: "system",
    explanation: {
      why: [
        "No valid NYC locations were detected from this input.",
        "A conservative operating baseline reduces risk until location context is confirmed.",
      ],
      deltaReasoning:
        "Use baseline staffing for the next 24 hours, then re-run once location inputs are corrected.",
      escalationTrigger:
        "Escalate only if live service indicators exceed your normal baseline.",
    },
    reviewBacked: false,
  };
}

async function getOrCreateSession(
  ctx: IntelligenceContext,
  input: FirstInsightInput,
): Promise<string> {
  if (input.sessionId) {
    return input.sessionId;
  }

  const inserted = await ctx.db
    .insert(chatSessions)
    .values({
      status: "active",
      cardType: input.cardType,
      locationCount: input.locations.length,
      model: MODEL_ID,
      promptVersion: PROMPT_VERSION,
      ruleVersion: RULE_VERSION,
      distinctId: input.distinctId,
      traceId: ctx.traceId,
      meta: {
        source: "landing_page_chat",
      },
    })
    .returning({ id: chatSessions.id });

  return inserted[0]!.id;
}

async function getNextTurnIndex(
  dbClient: DbClient,
  sessionId: string,
): Promise<number> {
  const rows = await dbClient
    .select({ turnIndex: chatMessages.turnIndex })
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .orderBy(desc(chatMessages.turnIndex))
    .limit(1);

  return (rows[0]?.turnIndex ?? 0) + 1;
}

async function insertMessage(
  dbClient: DbClient,
  sessionId: string,
  turnIndex: number,
  role: "user" | "assistant",
  contentText: string,
): Promise<number> {
  const maxMessage = await dbClient
    .select({
      maxMessageIndex: sql<number>`coalesce(max(${chatMessages.messageIndex}), 0)`,
    })
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId));

  const messageIndex = (maxMessage[0]?.maxMessageIndex ?? 0) + 1;

  const inserted = await dbClient
    .insert(chatMessages)
    .values({
      sessionId,
      messageIndex,
      turnIndex,
      role,
      contentText,
      piiRedacted: true,
    })
    .returning({ id: chatMessages.id });

  return inserted[0]!.id;
}

async function resolveCompetitor(
  ctx: IntelligenceContext,
  sessionId: string,
  turnIndex: number,
  competitorName?: string,
): Promise<{
  placeId?: string;
  snapshot?: string;
  resolvedName?: string;
  status: "not_requested" | "limit_reached" | "not_found" | "resolved";
}> {
  if (!competitorName || competitorName.trim().length === 0) {
    return { status: "not_requested" };
  }

  const already = await ctx.db
    .select({ total: count() })
    .from(chatCompetitorChecks)
    .where(eq(chatCompetitorChecks.sessionId, sessionId));

  if ((already[0]?.total ?? 0) >= 1) {
    return {
      status: "limit_reached",
      snapshot:
        "Competitor check already used in this session (v1.1 limit is one).",
    };
  }

  const results = await searchPlaces({
    query: competitorName,
    maxResults: 1,
  });

  const resolved = results[0];

  await ctx.db.insert(chatCompetitorChecks).values({
    sessionId,
    turnIndex,
    queryText: competitorName,
    resolvedPlaceId: resolved?.id,
    resolvedName: resolved?.displayName.text,
    status: resolved ? "resolved" : "not_found",
  });

  if (!resolved) {
    return {
      status: "not_found",
      snapshot: `Could not resolve competitor "${competitorName}" from places search.`,
    };
  }

  return {
    status: "resolved",
    placeId: resolved.id,
    resolvedName: resolved.displayName.text,
    snapshot: `Competitor check resolved: ${resolved.displayName.text}.`,
  };
}

async function recordToolCall(
  ctx: IntelligenceContext,
  params: {
    sessionId: string;
    messageId: number;
    turnIndex: number;
    toolName: string;
    sourceName: string;
    status: "ok" | "error" | "stale" | "timeout";
    latencyMs: number;
    cacheHit?: boolean;
    sourceFreshnessSeconds?: number;
    resultJson?: Record<string, unknown>;
    errorCode?: string;
  },
): Promise<void> {
  await ctx.db.insert(chatToolCalls).values({
    sessionId: params.sessionId,
    messageId: params.messageId,
    turnIndex: params.turnIndex,
    toolName: params.toolName,
    sourceName: params.sourceName,
    argsJson: {},
    resultJson: params.resultJson,
    status: params.status,
    latencyMs: params.latencyMs,
    cacheHit: params.cacheHit ?? false,
    sourceFreshnessSeconds: params.sourceFreshnessSeconds,
    errorCode: params.errorCode,
  });

  await emitEvent(
    {
      event: `tool.${params.sourceName}.completed`,
      trace_id: ctx.traceId,
      request_id: ctx.requestId,
      session_id: params.sessionId,
      turn_index: params.turnIndex,
      route: "intelligence.firstInsight",
      latency_ms: params.latencyMs,
      env: process.env.NODE_ENV,
    },
    {
      tool_name: params.toolName,
      source_name: params.sourceName,
      status: params.status,
      cache_hit: params.cacheHit ?? false,
      source_freshness_seconds: params.sourceFreshnessSeconds,
      error_code: params.errorCode,
    },
    { level: params.status === "ok" ? "info" : "warn" },
  );
}

async function persistRecommendations(
  ctx: IntelligenceContext,
  params: {
    sessionId: string;
    messageId: number;
    turnIndex: number;
    recommendations: Recommendation[];
  },
): Promise<void> {
  for (const recommendation of params.recommendations) {
    const inserted = await ctx.db
      .insert(chatRecommendations)
      .values({
        sessionId: params.sessionId,
        messageId: params.messageId,
        turnIndex: params.turnIndex,
        locationLabel: recommendation.locationLabel,
        action: recommendation.action,
        timeWindow: recommendation.timeWindow,
        confidence: recommendation.confidence,
        sourceName: recommendation.sourceName,
        sourceFreshnessSeconds: recommendation.sourceFreshnessSeconds,
        ruleVersion: RULE_VERSION,
        reviewBacked: recommendation.reviewBacked,
        evidenceCount: recommendation.evidence?.evidenceCount ?? 0,
        recencyWindowDays: recommendation.evidence?.recencyWindowDays,
        explanationJson: recommendation.explanation,
        meta: {
          topRefs: recommendation.evidence?.topRefs ?? [],
        },
      })
      .returning({ id: chatRecommendations.id });

    const recommendationId = inserted[0]!.id;

    if (recommendation.evidence?.topRefs) {
      for (const [index, ref] of recommendation.evidence.topRefs.entries()) {
        await ctx.db.insert(chatRecommendationEvidence).values({
          recommendationId,
          sessionId: params.sessionId,
          turnIndex: params.turnIndex,
          sourceName: "reviews",
          entityType: "own_location",
          placeId: ref.placeId,
          reviewIdHash: ref.reviewIdOrHash,
          reviewPublishAt: new Date(ref.publishTime),
          reviewRating:
            ref.rating !== undefined ? String(ref.rating) : undefined,
          theme: ref.theme,
          excerpt: ref.excerpt,
          evidenceRank: index + 1,
          meta: {
            source: ref.source,
          },
        });
      }
    }
  }
}

async function persistReviewSignalRuns(
  ctx: IntelligenceContext,
  params: {
    sessionId: string;
    turnIndex: number;
    resolvedLocations: { label: string; placeId: string }[];
    reviewByLocation: Record<
      string,
      {
        sampleReviewCount: number;
        evidenceCount: number;
        recencyWindowDays: number;
        themes: Record<string, number>;
      }
    >;
    competitorReview: {
      placeId: string;
      sampleReviewCount: number;
      evidenceCount: number;
      recencyWindowDays: number;
      themes: Record<string, number>;
    } | null;
    sourceStatus: {
      status: "ok" | "error" | "stale" | "timeout";
      cacheHit?: boolean;
      freshnessSeconds?: number;
      errorCode?: string;
    };
    distinctId?: string;
  },
): Promise<void> {
  for (const location of params.resolvedLocations) {
    const signal = params.reviewByLocation[location.label];
    if (!signal) continue;
    await ctx.db.insert(chatReviewSignalRuns).values({
      sessionId: params.sessionId,
      turnIndex: params.turnIndex,
      entityType: "own_location",
      placeId: location.placeId,
      sourceName: "reviews",
      sampleReviewCount: signal.sampleReviewCount,
      evidenceCount: signal.evidenceCount,
      recencyWindowDays: signal.recencyWindowDays,
      themesDetected: Object.keys(signal.themes).filter(
        (key) => (signal.themes[key] ?? 0) > 0,
      ),
      signalScoresJson: signal.themes,
      status: params.sourceStatus.status,
      latencyMs: 0,
      cacheHit: params.sourceStatus.cacheHit ?? false,
      sourceFreshnessSeconds: params.sourceStatus.freshnessSeconds,
      errorCode: params.sourceStatus.errorCode,
    });

    await emitEvent(
      {
        event: "review_signal_extracted",
        trace_id: ctx.traceId,
        request_id: ctx.requestId,
        session_id: params.sessionId,
        turn_index: params.turnIndex,
        route: "intelligence.firstInsight",
        env: process.env.NODE_ENV,
      },
      {
        place_id: location.placeId,
        entity_type: "own",
        sample_review_count: signal.sampleReviewCount,
        evidence_count: signal.evidenceCount,
        recency_window_days: signal.recencyWindowDays,
        themes_detected: Object.keys(signal.themes).filter(
          (key) => (signal.themes[key] ?? 0) > 0,
        ),
      },
      { sendToPosthog: true, posthogDistinctId: params.distinctId },
    );
  }

  if (params.competitorReview) {
    await ctx.db.insert(chatReviewSignalRuns).values({
      sessionId: params.sessionId,
      turnIndex: params.turnIndex,
      entityType: "competitor",
      placeId: params.competitorReview.placeId,
      sourceName: "reviews",
      sampleReviewCount: params.competitorReview.sampleReviewCount,
      evidenceCount: params.competitorReview.evidenceCount,
      recencyWindowDays: params.competitorReview.recencyWindowDays,
      themesDetected: Object.keys(params.competitorReview.themes).filter(
        (key) => (params.competitorReview?.themes[key] ?? 0) > 0,
      ),
      signalScoresJson: params.competitorReview.themes,
      status: params.sourceStatus.status,
      latencyMs: 0,
      cacheHit: params.sourceStatus.cacheHit ?? false,
      sourceFreshnessSeconds: params.sourceStatus.freshnessSeconds,
      errorCode: params.sourceStatus.errorCode,
    });

    await emitEvent(
      {
        event: "review_signal_extracted",
        trace_id: ctx.traceId,
        request_id: ctx.requestId,
        session_id: params.sessionId,
        turn_index: params.turnIndex,
        route: "intelligence.firstInsight",
        env: process.env.NODE_ENV,
      },
      {
        place_id: params.competitorReview.placeId,
        entity_type: "competitor",
        sample_review_count: params.competitorReview.sampleReviewCount,
        evidence_count: params.competitorReview.evidenceCount,
        recency_window_days: params.competitorReview.recencyWindowDays,
        themes_detected: Object.keys(params.competitorReview.themes).filter(
          (key) => (params.competitorReview?.themes[key] ?? 0) > 0,
        ),
      },
      { sendToPosthog: true, posthogDistinctId: params.distinctId },
    );
  }
}

function baselineMemoryKey(locationLabel: string): string {
  return `baseline.foh.${locationLabel}`;
}

async function latestBaselineMemoryEvent(
  ctx: IntelligenceContext,
  sessionId: string,
  key: string,
): Promise<{
  eventType: string;
  newValueJson: Record<string, unknown>;
  assumed: boolean;
} | null> {
  const rows = await ctx.db
    .select({
      eventType: chatMemoryEvents.eventType,
      newValueJson: chatMemoryEvents.newValueJson,
      assumed: chatMemoryEvents.assumed,
    })
    .from(chatMemoryEvents)
    .where(
      and(
        eq(chatMemoryEvents.sessionId, sessionId),
        eq(chatMemoryEvents.memoryNamespace, "baseline"),
        eq(chatMemoryEvents.memoryKey, key),
      ),
    )
    .orderBy(desc(chatMemoryEvents.createdAt))
    .limit(1);

  return rows[0] ?? null;
}

async function syncBaselineMemory(
  ctx: IntelligenceContext,
  params: {
    sessionId: string;
    distinctId?: string;
    turnIndex: number;
    locationLabels: string[];
    baselineByLocation: Map<string, number>;
    recomputeLatencyMs: number;
  },
): Promise<void> {
  for (const [index, locationLabel] of params.locationLabels.entries()) {
    const key = baselineMemoryKey(locationLabel);
    const latest = await latestBaselineMemoryEvent(ctx, params.sessionId, key);
    const baselineFoh = params.baselineByLocation.get(locationLabel);

    if (baselineFoh !== undefined) {
      const nextValue = {
        locationLabel,
        baselineFoh,
      };

      if (latest?.assumed) {
        await ctx.db.insert(chatMemoryEvents).values({
          sessionId: params.sessionId,
          distinctId: params.distinctId,
          turnIndex: params.turnIndex,
          eventType: "assumption_corrected",
          memoryScope: "session",
          memoryNamespace: "baseline",
          memoryKey: key,
          oldValueJson: latest.newValueJson,
          newValueJson: nextValue,
          valueSource: "explicit",
          assumed: false,
          confidenceCap: "none",
        });

        await emitEvent(
          {
            event: "assumption_corrected",
            trace_id: ctx.traceId,
            request_id: ctx.requestId,
            session_id: params.sessionId,
            turn_index: params.turnIndex,
            route: "intelligence.firstInsight",
            env: process.env.NODE_ENV,
          },
          {
            assumption_type: "baseline_value",
            old_value: latest.newValueJson,
            new_value: nextValue,
            recompute_latency_ms: params.recomputeLatencyMs,
          },
          { sendToPosthog: true, posthogDistinctId: params.distinctId },
        );
        continue;
      }

      const noChange =
        JSON.stringify(latest?.newValueJson ?? null) ===
        JSON.stringify(nextValue);
      if (!latest || !noChange) {
        await ctx.db.insert(chatMemoryEvents).values({
          sessionId: params.sessionId,
          distinctId: params.distinctId,
          turnIndex: params.turnIndex,
          eventType: latest ? "fact_corrected" : "fact_set",
          memoryScope: "session",
          memoryNamespace: "baseline",
          memoryKey: key,
          oldValueJson: latest?.newValueJson,
          newValueJson: nextValue,
          valueSource: "explicit",
          assumed: false,
          confidenceCap: "none",
        });
      }
      continue;
    }

    // Ambiguous baseline defaults to first-mentioned location after one clarification attempt.
    if (index !== 0 || latest?.assumed) {
      continue;
    }

    await ctx.db.insert(chatMemoryEvents).values({
      sessionId: params.sessionId,
      distinctId: params.distinctId,
      turnIndex: params.turnIndex,
      eventType: "assumption_set",
      memoryScope: "session",
      memoryNamespace: "baseline",
      memoryKey: key,
      newValueJson: {
        locationLabel,
        baselineFoh: null,
        assumption:
          "No baseline provided; defaulting scope to first-mentioned location.",
      },
      valueSource: "assumed",
      assumed: true,
      confidenceCap: "medium",
    });

    await emitEvent(
      {
        event: "assumption_set",
        trace_id: ctx.traceId,
        request_id: ctx.requestId,
        session_id: params.sessionId,
        turn_index: params.turnIndex,
        route: "intelligence.firstInsight",
        env: process.env.NODE_ENV,
      },
      {
        assumption_type: "baseline_value",
        assumption_text:
          "No baseline provided; defaulted to first-mentioned location.",
        confidence_cap_applied: "medium",
      },
      { sendToPosthog: true, posthogDistinctId: params.distinctId },
    );
  }
}

async function runFirstInsightUnlocked(
  ctx: IntelligenceContext,
  input: FirstInsightInput & { sessionId: string },
  params: {
    startedMs: number;
    lockWaitMs: number;
    idempotencyReused: boolean;
  },
): Promise<FirstInsightOutput> {
  const startedMs = params.startedMs;
  const sessionId = input.sessionId;
  const turnIndex = await getNextTurnIndex(ctx.db, sessionId);

  const parsedLocations = await resolveLocations(input.locations);
  const resolvedLocations = parsedLocations.resolved.slice(0, 3);

  const userMessageText = `Locations: ${input.locations.join(" | ")}`;
  await insertMessage(ctx.db, sessionId, turnIndex, "user", userMessageText);

  if (resolvedLocations.length === 0) {
    const fallbackText =
      "I couldn't confidently match that to a NYC location. Please share a fuller NYC address, ZIP, or neighborhood (for example: 350 5th Ave, 11201, or Astoria).";
    const fallbackRecommendation = buildValidationFallbackRecommendation();

    const assistantMessageId = await insertMessage(
      ctx.db,
      sessionId,
      turnIndex,
      "assistant",
      fallbackText,
    );

    await safeSideEffect(
      ctx,
      {
        sessionId,
        turnIndex,
        operation: "persist_validation_recommendation",
      },
      async () => {
        await persistRecommendations(ctx, {
          sessionId,
          messageId: assistantMessageId,
          turnIndex,
          recommendations: [fallbackRecommendation],
        });
      },
    );

    await safeSideEffect(
      ctx,
      {
        sessionId,
        turnIndex,
        operation: "persist_validation_fallback",
      },
      async () => {
        await ctx.db.insert(chatFallbacks).values({
          sessionId,
          turnIndex,
          fallbackType: "validation",
          reason: "No resolvable NYC locations",
          sourcesDown: ["geocode"],
          responseText: fallbackText,
        });
      },
    );

    await safeSideEffect(
      ctx,
      {
        sessionId,
        turnIndex,
        operation: "mark_session_had_fallback",
      },
      async () => {
        await ctx.db
          .update(chatSessions)
          .set({ hadFallback: true })
          .where(eq(chatSessions.id, sessionId));
      },
    );

    await safeSideEffect(
      ctx,
      {
        sessionId,
        turnIndex,
        operation: "emit_validation_fallback",
      },
      async () => {
        await emitEvent(
          {
            event: "chat.fallback.triggered",
            trace_id: ctx.traceId,
            request_id: ctx.requestId,
            session_id: sessionId,
            turn_index: turnIndex,
            route: "intelligence.firstInsight",
          },
          {
            fallback_type: "validation",
          },
          {
            level: "warn",
            sendToPosthog: true,
            posthogDistinctId: input.distinctId,
          },
        );
      },
    );

    return {
      sessionId,
      turnIndex,
      summary: fallbackText,
      message: fallbackText,
      locationLabels: [],
      recommendations: [fallbackRecommendation],
      snapshots: [],
      sources: {
        weather: { status: "error" },
        events: { status: "error" },
        closures: { status: "error" },
        doe: { status: "error" },
        reviews: { status: "error" },
      },
      usedFallback: true,
      firstInsightLatencyMs: nowMs() - startedMs,
      invalidLocations: parsedLocations.invalid,
    };
  }

  const baselineByLocation = new Map<string, number>();
  for (const baseline of input.baselineContext ?? []) {
    if (baseline.baselineFoh !== undefined) {
      baselineByLocation.set(baseline.locationLabel, baseline.baselineFoh);
    }
  }

  await safeSideEffect(
    ctx,
    {
      sessionId,
      turnIndex,
      operation: "sync_baseline_memory",
    },
    async () => {
      await syncBaselineMemory(ctx, {
        sessionId,
        distinctId: input.distinctId,
        turnIndex,
        locationLabels: resolvedLocations.map((location) => location.label),
        baselineByLocation,
        recomputeLatencyMs: nowMs() - startedMs,
      });
    },
  );

  let competitor: Awaited<ReturnType<typeof resolveCompetitor>> = {
    status: "not_requested",
  };
  try {
    competitor = await resolveCompetitor(
      ctx,
      sessionId,
      turnIndex,
      input.competitorName,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    await emitEvent(
      {
        event: "chat.error",
        trace_id: ctx.traceId,
        request_id: ctx.requestId,
        session_id: sessionId,
        turn_index: turnIndex,
        route: "intelligence.firstInsight",
        env: process.env.NODE_ENV,
      },
      {
        error_type: "competitor_resolution_failure",
        error_message: message,
      },
      {
        level: "warn",
      },
    );
  }

  const useAgentMode = env.INTELLIGENCE_AGENT_MODE === "on";

  let recommendationOutput: {
    summary: string;
    recommendations: Recommendation[];
    snapshots: FirstInsightOutput["snapshots"];
  };
  let competitorSnapshotForUi: FirstInsightOutput["competitorSnapshot"];
  let messageText: string;
  let sourceEntries: Array<
    [
      "weather" | "events" | "closures" | "doe" | "reviews",
      {
        status: "ok" | "error" | "stale" | "timeout";
        freshnessSeconds?: number;
        cacheHit?: boolean;
        errorCode?: string;
      },
    ]
  >;
  let reviewByLocationForPersistence: Record<
    string,
    {
      sampleReviewCount: number;
      evidenceCount: number;
      recencyWindowDays: number;
      themes: Record<string, number>;
    }
  > = {};
  let competitorReviewForPersistence: {
    placeId: string;
    sampleReviewCount: number;
    evidenceCount: number;
    recencyWindowDays: number;
    themes: Record<string, number>;
  } | null = null;
  let toolExecutions: Array<{
    toolName: string;
    sourceName: string;
    status: "ok" | "error" | "stale" | "timeout";
    latencyMs: number;
    cacheHit?: boolean;
    sourceFreshnessSeconds?: number;
    errorCode?: string;
    result: Record<string, unknown>;
  }> = [];
  let agentOutputForTelemetry: Awaited<ReturnType<typeof runAgentTurn>> | null =
    null;
  let agentFallbackApplied = false;
  let agentFallbackReason: string | undefined;
  let agentFallbackRepairFailureReason: string | undefined;
  if (useAgentMode) {
    const agentOutput = await runAgentTurn({
      db: ctx.db,
      sessionId,
      turnIndex,
      cardType: input.cardType,
      resolvedLocations,
      baselineByLocation,
      baselineAssumedForFirstLocation: !baselineByLocation.has(
        resolvedLocations[0]?.label ?? "",
      ),
      competitor,
      competitorName: input.competitorName,
    });
    agentOutputForTelemetry = agentOutput;

    recommendationOutput = {
      summary: agentOutput.summary,
      recommendations: agentOutput.recommendations,
      snapshots: agentOutput.snapshots,
    };
    competitorSnapshotForUi = agentOutput.competitorSnapshot;
    messageText = agentOutput.message;
    sourceEntries = [
      ["weather", agentOutput.sources.weather],
      ["events", agentOutput.sources.events],
      ["closures", agentOutput.sources.closures],
      ["doe", agentOutput.sources.doe],
      ["reviews", agentOutput.sources.reviews],
    ];
    reviewByLocationForPersistence = Object.fromEntries(
      Object.entries(agentOutput.reviewSignals.byLocation).map(
        ([label, signal]) => [
          label,
          {
            sampleReviewCount: signal.sampleReviewCount,
            evidenceCount: signal.evidenceCount,
            recencyWindowDays: signal.recencyWindowDays,
            themes: signal.themes,
          },
        ],
      ),
    );
    competitorReviewForPersistence = agentOutput.reviewSignals.competitorReview
      ? {
          placeId: agentOutput.reviewSignals.competitorReview.placeId,
          sampleReviewCount:
            agentOutput.reviewSignals.competitorReview.sampleReviewCount,
          evidenceCount:
            agentOutput.reviewSignals.competitorReview.evidenceCount,
          recencyWindowDays:
            agentOutput.reviewSignals.competitorReview.recencyWindowDays,
          themes: agentOutput.reviewSignals.competitorReview.themes,
        }
      : null;
    toolExecutions = agentOutput.toolExecutions;

    await safeSideEffect(
      ctx,
      {
        sessionId,
        turnIndex,
        operation: "emit_agent_metadata",
      },
      async () => {
        await emitEvent(
          {
            event: "agent_response_validated",
            trace_id: ctx.traceId,
            request_id: ctx.requestId,
            session_id: sessionId,
            turn_index: turnIndex,
            route: "intelligence.firstInsight",
            env: process.env.NODE_ENV,
          },
          {
            agent_mode: env.INTELLIGENCE_AGENT_MODE,
            prompt_version: agentOutput.promptMeta.promptVersion,
            tool_contract_version: agentOutput.promptMeta.toolContractVersion,
            policy_version: agentOutput.promptMeta.policyVersion,
            policy_caps_applied: agentOutput.policyCapsApplied,
            tool_call_count:
              agentOutput.diagnostics.prefetchToolCallCount +
              agentOutput.diagnostics.loopToolCallCount,
            prefetch_tool_call_count:
              agentOutput.diagnostics.prefetchToolCallCount,
            loop_tool_call_count: agentOutput.diagnostics.loopToolCallCount,
            assumptions_count: agentOutput.assumptions.length,
            degraded: agentOutput.degraded,
            failure_reason: agentOutput.failureReason,
            repair_failure_reason: agentOutput.repairFailureReason,
            root_failure_stage: agentOutput.rootFailureStage,
            root_failure_code: agentOutput.rootFailureCode,
            repair_failure_stage: agentOutput.repairFailureStage,
            repair_failure_code: agentOutput.repairFailureCode,
            failure_stage: agentOutput.rootFailureStage,
            failure_code: agentOutput.rootFailureCode,
            parse_ok: agentOutput.diagnostics.parseOk,
            repair_attempted: agentOutput.diagnostics.repairAttempted,
            repair_ok: agentOutput.diagnostics.repairOk,
            loop_rounds:
              agentOutput.diagnostics.toolLoop?.roundsExecuted ?? undefined,
            loop_tool_call_limit_hit:
              agentOutput.diagnostics.toolLoop?.toolCallLimitHit ?? false,
            loop_round_limit_hit:
              agentOutput.diagnostics.toolLoop?.roundLimitHit ?? false,
            loop_unknown_tool_count:
              agentOutput.diagnostics.toolLoop?.unknownToolCount ?? 0,
            loop_arg_parse_failure_count:
              agentOutput.diagnostics.toolLoop?.argParseFailureCount ?? 0,
          },
        );
      },
    );

    await safeSideEffect(
      ctx,
      {
        sessionId,
        turnIndex,
        operation: "emit_agent_phase_diagnostics",
      },
      async () => {
        for (const phase of agentOutput.phaseTelemetry) {
          await emitEvent(
            {
              event: "agent.turn.phase",
              trace_id: ctx.traceId,
              request_id: ctx.requestId,
              session_id: sessionId,
              turn_index: turnIndex,
              route: "intelligence.firstInsight",
              env: process.env.NODE_ENV,
            },
            {
              phase: phase.phase,
              phase_status: phase.status,
              phase_ms: phase.durationMs,
              failure_stage: phase.failureStage,
              failure_code: phase.failureCode,
            },
            { level: phase.status === "ok" ? "info" : "warn" },
          );
        }

        const loopDiagnostics = agentOutput.diagnostics.toolLoop;
        if (!loopDiagnostics) {
          return;
        }

        for (const attempt of loopDiagnostics.modelAttempts) {
          await emitEvent(
            {
              event: "agent.model.attempt",
              trace_id: ctx.traceId,
              request_id: ctx.requestId,
              session_id: sessionId,
              turn_index: turnIndex,
              route: "intelligence.firstInsight",
              env: process.env.NODE_ENV,
            },
            {
              attempt_number: attempt.attemptNumber,
              model: attempt.model,
              model_attempt_status: attempt.status,
              status_code: attempt.statusCode,
              retryable: attempt.retryable,
              finish_reason: attempt.finishReason,
              has_tool_calls: attempt.hasToolCalls,
              failure_code: attempt.errorCode,
            },
            { level: attempt.status === "ok" ? "info" : "warn" },
          );
        }

        for (const providerFailure of loopDiagnostics.providerFailures) {
          await emitEvent(
            {
              event: "agent.provider.failure",
              trace_id: ctx.traceId,
              request_id: ctx.requestId,
              session_id: sessionId,
              turn_index: turnIndex,
              route: "intelligence.firstInsight",
              env: process.env.NODE_ENV,
            },
            {
              model: providerFailure.model,
              status_code: providerFailure.statusCode,
              retryable: providerFailure.retryable,
              failure_code: providerFailure.errorCode,
            },
            { level: "warn" },
          );
        }
      },
    );

    await safeSideEffect(
      ctx,
      {
        sessionId,
        turnIndex,
        operation: "emit_agent_circuit_breakers",
      },
      async () => {
        for (const event of agentOutput.circuitBreakerEvents) {
          await emitEvent(
            {
              event: "agent_circuit_breaker_opened",
              trace_id: ctx.traceId,
              request_id: ctx.requestId,
              session_id: sessionId,
              turn_index: turnIndex,
              route: "intelligence.firstInsight",
              env: process.env.NODE_ENV,
            },
            {
              source_name: event.sourceName,
              failure_count: event.failureCount,
            },
            { level: "warn" },
          );
        }
      },
    );

    const shouldFallbackToDeterministic =
      agentOutput.degraded ||
      agentOutput.recommendations.every((rec) => rec.sourceName === "system");

    if (shouldFallbackToDeterministic) {
      agentFallbackApplied = true;
      agentFallbackReason =
        agentOutput.failureReason ??
        "agent_returned_system_only_recommendations";
      agentFallbackRepairFailureReason = agentOutput.repairFailureReason;
      await safeSideEffect(
        ctx,
        {
          sessionId,
          turnIndex,
          operation: "emit_agent_fallback_applied",
        },
        async () => {
          await emitEvent(
            {
              event: "agent_fallback_applied",
              trace_id: ctx.traceId,
              request_id: ctx.requestId,
              session_id: sessionId,
              turn_index: turnIndex,
              route: "intelligence.firstInsight",
              env: process.env.NODE_ENV,
            },
            {
              reason: agentFallbackReason,
              repair_failure_reason: agentFallbackRepairFailureReason,
              root_failure_stage: agentOutput.rootFailureStage,
              root_failure_code: agentOutput.rootFailureCode,
              repair_failure_stage: agentOutput.repairFailureStage,
              repair_failure_code: agentOutput.repairFailureCode,
              failure_stage: agentOutput.rootFailureStage,
              failure_code: agentOutput.rootFailureCode,
            },
            { level: "warn" },
          );
        },
      );

      const sourceBundle = await fetchSourceBundle(
        ctx.db,
        resolvedLocations,
        competitor.placeId,
      );

      const recommendationInputs = resolvedLocations.map((location, idx) => ({
        locationLabel: location.label,
        weather: sourceBundle.weather.byLocation[location.label],
        events: sourceBundle.events.byLocation[location.label],
        closures: sourceBundle.closures.byLocation[location.label],
        review: sourceBundle.reviews.byLocation[location.label],
        baselineFoh: baselineByLocation.get(location.label),
        baselineAssumed: !baselineByLocation.has(location.label) && idx === 0,
      }));

      competitorSnapshotForUi = (() => {
        if (competitor.status === "not_requested") {
          return undefined;
        }

        if (competitor.status === "limit_reached") {
          return {
            label: "Competitor check",
            text: "Already used in this session. You can run one competitor check per chat.",
            confidence: "low",
            sampleReviewCount: 0,
            recencyWindowDays: 90,
            status: "limit_reached",
          };
        }

        if (competitor.status === "not_found") {
          return {
            label: input.competitorName ?? "Competitor",
            text:
              competitor.snapshot ??
              "Could not resolve this competitor from places search.",
            confidence: "low",
            sampleReviewCount: 0,
            recencyWindowDays: 90,
            status: "not_found",
          };
        }

        if (sourceBundle.competitorReview) {
          return {
            label: competitor.resolvedName ?? "Competitor",
            text: sourceBundle.competitorReview.guestSnapshot,
            confidence: sourceBundle.competitorReview.confidence,
            sampleReviewCount: sourceBundle.competitorReview.sampleReviewCount,
            recencyWindowDays: sourceBundle.competitorReview.recencyWindowDays,
            status: "resolved_with_reviews",
          };
        }

        return {
          label: competitor.resolvedName ?? "Competitor",
          text: "Resolved successfully, but there is not enough recent review evidence to summarize yet.",
          confidence: "low",
          sampleReviewCount: 0,
          recencyWindowDays: 90,
          status: "resolved_no_recent_reviews",
        };
      })();

      const competitorSummaryLine = competitorSnapshotForUi
        ? `Competitor check: ${competitorSnapshotForUi.label}. ${competitorSnapshotForUi.text}`
        : undefined;

      recommendationOutput = buildRecommendations(
        input.cardType,
        recommendationInputs,
        {
          doeDays: sourceBundle.doe.days,
          competitorSnapshot: competitorSummaryLine,
        },
      );

      messageText = buildMessage({
        summary: recommendationOutput.summary,
        recommendations: recommendationOutput.recommendations,
        competitorSnapshot: competitorSnapshotForUi,
      });

      sourceEntries = [
        ["weather", sourceBundle.weather.status],
        ["events", sourceBundle.events.status],
        ["closures", sourceBundle.closures.status],
        ["doe", sourceBundle.doe.status],
        ["reviews", sourceBundle.reviews.status],
      ];
      reviewByLocationForPersistence = sourceBundle.reviews.byLocation;
      competitorReviewForPersistence = sourceBundle.competitorReview
        ? {
            placeId: sourceBundle.competitorReview.placeId,
            sampleReviewCount: sourceBundle.competitorReview.sampleReviewCount,
            evidenceCount: sourceBundle.competitorReview.evidenceCount,
            recencyWindowDays: sourceBundle.competitorReview.recencyWindowDays,
            themes: sourceBundle.competitorReview.themes,
          }
        : null;
    }
  } else {
    const sourceBundle = await fetchSourceBundle(
      ctx.db,
      resolvedLocations,
      competitor.placeId,
    );

    const recommendationInputs = resolvedLocations.map((location, idx) => ({
      locationLabel: location.label,
      weather: sourceBundle.weather.byLocation[location.label],
      events: sourceBundle.events.byLocation[location.label],
      closures: sourceBundle.closures.byLocation[location.label],
      review: sourceBundle.reviews.byLocation[location.label],
      baselineFoh: baselineByLocation.get(location.label),
      baselineAssumed: !baselineByLocation.has(location.label) && idx === 0,
    }));

    competitorSnapshotForUi = (() => {
      if (competitor.status === "not_requested") {
        return undefined;
      }

      if (competitor.status === "limit_reached") {
        return {
          label: "Competitor check",
          text: "Already used in this session. You can run one competitor check per chat.",
          confidence: "low",
          sampleReviewCount: 0,
          recencyWindowDays: 90,
          status: "limit_reached",
        };
      }

      if (competitor.status === "not_found") {
        return {
          label: input.competitorName ?? "Competitor",
          text:
            competitor.snapshot ??
            "Could not resolve this competitor from places search.",
          confidence: "low",
          sampleReviewCount: 0,
          recencyWindowDays: 90,
          status: "not_found",
        };
      }

      if (sourceBundle.competitorReview) {
        return {
          label: competitor.resolvedName ?? "Competitor",
          text: sourceBundle.competitorReview.guestSnapshot,
          confidence: sourceBundle.competitorReview.confidence,
          sampleReviewCount: sourceBundle.competitorReview.sampleReviewCount,
          recencyWindowDays: sourceBundle.competitorReview.recencyWindowDays,
          status: "resolved_with_reviews",
        };
      }

      return {
        label: competitor.resolvedName ?? "Competitor",
        text: "Resolved successfully, but there is not enough recent review evidence to summarize yet.",
        confidence: "low",
        sampleReviewCount: 0,
        recencyWindowDays: 90,
        status: "resolved_no_recent_reviews",
      };
    })();

    const competitorSummaryLine = competitorSnapshotForUi
      ? `Competitor check: ${competitorSnapshotForUi.label}. ${competitorSnapshotForUi.text}`
      : undefined;

    recommendationOutput = buildRecommendations(
      input.cardType,
      recommendationInputs,
      {
        doeDays: sourceBundle.doe.days,
        competitorSnapshot: competitorSummaryLine,
      },
    );

    messageText = buildMessage({
      summary: recommendationOutput.summary,
      recommendations: recommendationOutput.recommendations,
      competitorSnapshot: competitorSnapshotForUi,
    });

    sourceEntries = [
      ["weather", sourceBundle.weather.status],
      ["events", sourceBundle.events.status],
      ["closures", sourceBundle.closures.status],
      ["doe", sourceBundle.doe.status],
      ["reviews", sourceBundle.reviews.status],
    ];
    reviewByLocationForPersistence = sourceBundle.reviews.byLocation;
    competitorReviewForPersistence = sourceBundle.competitorReview
      ? {
          placeId: sourceBundle.competitorReview.placeId,
          sampleReviewCount: sourceBundle.competitorReview.sampleReviewCount,
          evidenceCount: sourceBundle.competitorReview.evidenceCount,
          recencyWindowDays: sourceBundle.competitorReview.recencyWindowDays,
          themes: sourceBundle.competitorReview.themes,
        }
      : null;
  }

  const assistantMessageId = await insertMessage(
    ctx.db,
    sessionId,
    turnIndex,
    "assistant",
    messageText,
  );

  await safeSideEffect(
    ctx,
    {
      sessionId,
      turnIndex,
      operation: "record_tool_calls",
    },
    async () => {
      if (useAgentMode) {
        for (const execution of toolExecutions) {
          if (
            !["weather", "events", "closures", "doe", "reviews"].includes(
              execution.sourceName,
            )
          ) {
            continue;
          }
          await recordToolCall(ctx, {
            sessionId,
            messageId: assistantMessageId,
            turnIndex,
            toolName: execution.toolName,
            sourceName: execution.sourceName,
            status: execution.status,
            latencyMs: execution.latencyMs,
            cacheHit: execution.cacheHit,
            sourceFreshnessSeconds: execution.sourceFreshnessSeconds,
            errorCode: execution.errorCode,
            resultJson: execution.result,
          });
        }
        return;
      }

      for (const [sourceName, status] of sourceEntries) {
        await recordToolCall(ctx, {
          sessionId,
          messageId: assistantMessageId,
          turnIndex,
          toolName: sourceName,
          sourceName,
          status: status.status,
          latencyMs: 0,
          cacheHit: status.cacheHit,
          sourceFreshnessSeconds: status.freshnessSeconds,
          errorCode: status.errorCode,
          resultJson: {
            status: status.status,
          },
        });
      }
    },
  );

  await safeSideEffect(
    ctx,
    {
      sessionId,
      turnIndex,
      operation: "persist_recommendations",
    },
    async () => {
      await persistRecommendations(ctx, {
        sessionId,
        messageId: assistantMessageId,
        turnIndex,
        recommendations: recommendationOutput.recommendations,
      });
    },
  );

  await safeSideEffect(
    ctx,
    {
      sessionId,
      turnIndex,
      operation: "persist_review_signal_runs",
    },
    async () => {
      await persistReviewSignalRuns(ctx, {
        sessionId,
        turnIndex,
        resolvedLocations: resolvedLocations.map((location) => ({
          label: location.label,
          placeId: location.placeId,
        })),
        reviewByLocation: reviewByLocationForPersistence,
        competitorReview: competitorReviewForPersistence,
        sourceStatus:
          sourceEntries.find(([name]) => name === "reviews")?.[1] ??
          ({ status: "error", errorCode: "REVIEWS_MISSING" } as const),
        distinctId: input.distinctId,
      });
    },
  );

  const usedFallback = sourceEntries.some(
    ([, status]) => status.status !== "ok",
  );
  const usedAnyFallback = usedFallback || agentFallbackApplied;
  const latencyMs = nowMs() - startedMs;
  const sourceStatusMap = Object.fromEntries(sourceEntries) as Record<
    "weather" | "events" | "closures" | "doe" | "reviews",
    {
      status: "ok" | "error" | "stale" | "timeout";
      freshnessSeconds?: number;
      cacheHit?: boolean;
      errorCode?: string;
    }
  >;

  if (usedFallback) {
    await safeSideEffect(
      ctx,
      {
        sessionId,
        turnIndex,
        operation: "persist_partial_fallback",
      },
      async () => {
        await ctx.db.insert(chatFallbacks).values({
          sessionId,
          turnIndex,
          fallbackType: "partial_data",
          reason: "One or more sources unavailable",
          sourcesDown: sourceEntries
            .filter(([, status]) => status.status !== "ok")
            .map(([source]) => source),
          responseText: messageText,
        });
      },
    );
  }

  await safeSideEffect(
    ctx,
    {
      sessionId,
      turnIndex,
      operation: "update_chat_session",
    },
    async () => {
      await ctx.db
        .update(chatSessions)
        .set({
          locationCount: resolvedLocations.length,
          firstInsightLatencyMs: latencyMs,
          hadFallback: usedAnyFallback,
        })
        .where(eq(chatSessions.id, sessionId));
    },
  );

  await safeSideEffect(
    ctx,
    {
      sessionId,
      turnIndex,
      operation: "emit_turn_completed",
    },
    async () => {
      await emitEvent(
        {
          event: "chat.turn.completed",
          trace_id: ctx.traceId,
          request_id: ctx.requestId,
          session_id: sessionId,
          turn_index: turnIndex,
          route: "intelligence.firstInsight",
          latency_ms: latencyMs,
          card_type: input.cardType,
          location_count: resolvedLocations.length,
          model: MODEL_ID,
          prompt_version:
            useAgentMode && agentOutputForTelemetry
              ? agentOutputForTelemetry.promptMeta.promptVersion
              : PROMPT_VERSION,
          rule_version:
            useAgentMode && agentOutputForTelemetry
              ? agentOutputForTelemetry.promptMeta.policyVersion
              : RULE_VERSION,
          used_fallback: usedAnyFallback,
          env: process.env.NODE_ENV,
        },
        {
          recommendation_count: recommendationOutput.recommendations.length,
          format_compliant: true,
          source_status_weather: sourceStatusMap.weather.status,
          source_status_events: sourceStatusMap.events.status,
          source_status_closures: sourceStatusMap.closures.status,
          source_status_doe: sourceStatusMap.doe.status,
          source_status_reviews: sourceStatusMap.reviews.status,
          source_freshness_weather_s: sourceStatusMap.weather.freshnessSeconds,
          source_freshness_events_s: sourceStatusMap.events.freshnessSeconds,
          source_freshness_closures_s:
            sourceStatusMap.closures.freshnessSeconds,
          source_freshness_reviews_s: sourceStatusMap.reviews.freshnessSeconds,
          agent_source_status_weather:
            agentOutputForTelemetry?.sources.weather.status,
          agent_source_status_events:
            agentOutputForTelemetry?.sources.events.status,
          agent_source_status_closures:
            agentOutputForTelemetry?.sources.closures.status,
          agent_source_status_doe: agentOutputForTelemetry?.sources.doe.status,
          agent_source_status_reviews:
            agentOutputForTelemetry?.sources.reviews.status,
          final_source_status_weather: sourceStatusMap.weather.status,
          final_source_status_events: sourceStatusMap.events.status,
          final_source_status_closures: sourceStatusMap.closures.status,
          final_source_status_doe: sourceStatusMap.doe.status,
          final_source_status_reviews: sourceStatusMap.reviews.status,
          prefetch_tool_call_count:
            agentOutputForTelemetry?.diagnostics.prefetchToolCallCount,
          loop_tool_call_count:
            agentOutputForTelemetry?.diagnostics.loopToolCallCount,
          review_backed_recommendation_count:
            recommendationOutput.recommendations.filter(
              (rec) => rec.reviewBacked,
            ).length,
          review_evidence_refs_count:
            recommendationOutput.recommendations.reduce(
              (acc, rec) => acc + (rec.evidence?.topRefs.length ?? 0),
              0,
            ),
        },
        { sendToPosthog: true, posthogDistinctId: input.distinctId },
      );
    },
  );

  if (useAgentMode && agentOutputForTelemetry) {
    await safeSideEffect(
      ctx,
      {
        sessionId,
        turnIndex,
        operation: "emit_agent_turn_wide",
      },
      async () => {
        const loopDiagnostics = agentOutputForTelemetry.diagnostics.toolLoop;
        const combinedToolCallsByName: Record<string, number> = {
          ...agentOutputForTelemetry.diagnostics.prefetchToolCallsByName,
        };
        for (const [name, count] of Object.entries(
          agentOutputForTelemetry.diagnostics.loopToolCallsByName,
        )) {
          combinedToolCallsByName[name] =
            (combinedToolCallsByName[name] ?? 0) + count;
        }

        await emitEvent(
          {
            event: "agent.turn.wide",
            trace_id: ctx.traceId,
            request_id: ctx.requestId,
            session_id: sessionId,
            turn_index: turnIndex,
            route: "intelligence.firstInsight",
            latency_ms: latencyMs,
            card_type: input.cardType,
            location_count: resolvedLocations.length,
            model: MODEL_ID,
            prompt_version: agentOutputForTelemetry.promptMeta.promptVersion,
            rule_version: agentOutputForTelemetry.promptMeta.policyVersion,
            used_fallback: usedAnyFallback,
            env: process.env.NODE_ENV,
          },
          {
            agent_mode: env.INTELLIGENCE_AGENT_MODE,
            lock_wait_ms: params.lockWaitMs,
            idempotency_reused: params.idempotencyReused,
            primary_model: loopDiagnostics?.primaryModel,
            fallback_model: loopDiagnostics?.fallbackModel,
            final_model: loopDiagnostics?.finalModel,
            loop_rounds: loopDiagnostics?.roundsExecuted,
            tool_call_count:
              agentOutputForTelemetry.diagnostics.prefetchToolCallCount +
              agentOutputForTelemetry.diagnostics.loopToolCallCount,
            tool_calls_by_name: combinedToolCallsByName,
            prefetch_tool_call_count:
              agentOutputForTelemetry.diagnostics.prefetchToolCallCount,
            prefetch_tool_calls_by_name:
              agentOutputForTelemetry.diagnostics.prefetchToolCallsByName,
            loop_tool_call_count:
              agentOutputForTelemetry.diagnostics.loopToolCallCount,
            loop_tool_calls_by_name:
              agentOutputForTelemetry.diagnostics.loopToolCallsByName,
            loop_unknown_tool_count: loopDiagnostics?.unknownToolCount ?? 0,
            loop_arg_parse_failure_count:
              loopDiagnostics?.argParseFailureCount ?? 0,
            loop_round_limit_hit: loopDiagnostics?.roundLimitHit ?? false,
            loop_tool_call_limit_hit:
              loopDiagnostics?.toolCallLimitHit ?? false,
            loop_empty_final_content:
              loopDiagnostics?.emptyFinalContent ?? false,
            parse_ok: agentOutputForTelemetry.diagnostics.parseOk,
            repair_attempted:
              agentOutputForTelemetry.diagnostics.repairAttempted,
            repair_ok: agentOutputForTelemetry.diagnostics.repairOk,
            policy_caps_applied: agentOutputForTelemetry.policyCapsApplied,
            root_failure_stage: agentOutputForTelemetry.rootFailureStage,
            root_failure_code: agentOutputForTelemetry.rootFailureCode,
            repair_failure_stage: agentOutputForTelemetry.repairFailureStage,
            repair_failure_code: agentOutputForTelemetry.repairFailureCode,
            failure_stage: agentOutputForTelemetry.rootFailureStage,
            failure_code: agentOutputForTelemetry.rootFailureCode,
            fallback_applied: agentFallbackApplied,
            fallback_reason: agentFallbackReason,
            fallback_repair_failure_reason: agentFallbackRepairFailureReason,
            agent_source_status_weather:
              agentOutputForTelemetry.sources.weather.status,
            agent_source_status_events:
              agentOutputForTelemetry.sources.events.status,
            agent_source_status_closures:
              agentOutputForTelemetry.sources.closures.status,
            agent_source_status_doe: agentOutputForTelemetry.sources.doe.status,
            agent_source_status_reviews:
              agentOutputForTelemetry.sources.reviews.status,
            final_source_status_weather: sourceStatusMap.weather.status,
            final_source_status_events: sourceStatusMap.events.status,
            final_source_status_closures: sourceStatusMap.closures.status,
            final_source_status_doe: sourceStatusMap.doe.status,
            final_source_status_reviews: sourceStatusMap.reviews.status,
            source_status_weather: sourceStatusMap.weather.status,
            source_status_events: sourceStatusMap.events.status,
            source_status_closures: sourceStatusMap.closures.status,
            source_status_doe: sourceStatusMap.doe.status,
            source_status_reviews: sourceStatusMap.reviews.status,
          },
          {
            level:
              usedAnyFallback ||
              agentFallbackApplied ||
              agentOutputForTelemetry.degraded
                ? "warn"
                : "info",
          },
        );
      },
    );
  }

  return {
    sessionId,
    turnIndex,
    summary: recommendationOutput.summary,
    message: messageText,
    locationLabels: resolvedLocations.map((location) => location.label),
    recommendations: recommendationOutput.recommendations,
    snapshots: recommendationOutput.snapshots,
    competitorSnapshot: competitorSnapshotForUi,
    sources: {
      weather: sourceStatusMap.weather,
      events: sourceStatusMap.events,
      closures: sourceStatusMap.closures,
      doe: sourceStatusMap.doe,
      reviews: sourceStatusMap.reviews,
    },
    usedFallback: usedAnyFallback,
    firstInsightLatencyMs: latencyMs,
    invalidLocations: parsedLocations.invalid,
  };
}

export async function runFirstInsight(
  ctx: IntelligenceContext,
  input: FirstInsightInput,
): Promise<FirstInsightOutput> {
  const startedMs = nowMs();
  const sessionId = await getOrCreateSession(ctx, input);

  return withSessionLock(sessionId, async (lockWaitMs) => {
    if (lockWaitMs > 0) {
      await emitEvent(
        {
          event: "agent_lock_waited",
          trace_id: ctx.traceId,
          request_id: ctx.requestId,
          session_id: sessionId,
          route: "intelligence.firstInsight",
          env: process.env.NODE_ENV,
        },
        {
          lock_wait_ms: lockWaitMs,
        },
      );
    }

    const run = async (idempotencyReused: boolean) =>
      runFirstInsightUnlocked(
        ctx,
        {
          ...input,
          sessionId,
        },
        {
          startedMs,
          lockWaitMs,
          idempotencyReused,
        },
      );

    if (!input.idempotencyKey) {
      return run(false);
    }

    const key = `${sessionId}:${input.idempotencyKey}`;
    const { reused, value } = await runIdempotent(key, () => run(false));
    if (reused) {
      await emitEvent(
        {
          event: "agent_idempotency_reused",
          trace_id: ctx.traceId,
          request_id: ctx.requestId,
          session_id: sessionId,
          route: "intelligence.firstInsight",
          env: process.env.NODE_ENV,
        },
        {
          idempotency_reused: true,
        },
      );
    }
    return value;
  });
}

export async function endChatSession(
  ctx: IntelligenceContext,
  input: {
    sessionId: string;
    distinctId?: string;
    endReason: "completed" | "user_exit" | "inactive_timeout" | "error";
  },
): Promise<{ ok: true }> {
  const now = new Date();

  await ctx.db
    .update(chatSessions)
    .set({
      endedAt: now,
      status: input.endReason === "error" ? "error" : "ended",
    })
    .where(eq(chatSessions.id, input.sessionId));

  await emitEvent(
    {
      event: "chat_session_ended",
      trace_id: ctx.traceId,
      request_id: ctx.requestId,
      session_id: input.sessionId,
      route: "intelligence.endSession",
      env: process.env.NODE_ENV,
    },
    {
      end_reason: input.endReason,
    },
    { sendToPosthog: true, posthogDistinctId: input.distinctId },
  );

  return { ok: true };
}
