import { and, count, desc, eq, sql } from "drizzle-orm";

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

function buildMessage(output: {
  summary: string;
  snapshots: FirstInsightOutput["snapshots"];
  recommendations: Recommendation[];
}): string {
  const summaryHeadline = output.summary.split("\n")[0]?.trim();
  const headline =
    summaryHeadline && summaryHeadline.length > 0
      ? summaryHeadline
      : "Next 3 days staffing and prep signals:";
  const lines: string[] = [headline];

  const keyDrivers = Array.from(
    new Set(
      output.recommendations
        .flatMap((rec) => rec.explanation.why.slice(0, 1))
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  ).slice(0, 2);

  if (keyDrivers.length > 0) {
    lines.push("", "What stands out:");
    for (const item of keyDrivers) {
      lines.push(`- ${item}`);
    }
  }

  const snapshot = output.snapshots[0];
  if (snapshot) {
    lines.push("", `${snapshot.locationLabel}: ${snapshot.text}`);
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
): Promise<{ placeId?: string; snapshot?: string }> {
  if (!competitorName || competitorName.trim().length === 0) {
    return {};
  }

  const already = await ctx.db
    .select({ total: count() })
    .from(chatCompetitorChecks)
    .where(eq(chatCompetitorChecks.sessionId, sessionId));

  if ((already[0]?.total ?? 0) >= 1) {
    return {
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
      snapshot: `Could not resolve competitor "${competitorName}" from places search.`,
    };
  }

  return {
    placeId: resolved.id,
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

export async function runFirstInsight(
  ctx: IntelligenceContext,
  input: FirstInsightInput,
): Promise<FirstInsightOutput> {
  const startedMs = nowMs();
  const sessionId = await getOrCreateSession(ctx, input);
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

    await persistRecommendations(ctx, {
      sessionId,
      messageId: assistantMessageId,
      turnIndex,
      recommendations: [fallbackRecommendation],
    });

    await ctx.db.insert(chatFallbacks).values({
      sessionId,
      turnIndex,
      fallbackType: "validation",
      reason: "No resolvable NYC locations",
      sourcesDown: ["geocode"],
      responseText: fallbackText,
    });

    await ctx.db
      .update(chatSessions)
      .set({ hadFallback: true })
      .where(eq(chatSessions.id, sessionId));

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

  await syncBaselineMemory(ctx, {
    sessionId,
    distinctId: input.distinctId,
    turnIndex,
    locationLabels: resolvedLocations.map((location) => location.label),
    baselineByLocation,
    recomputeLatencyMs: nowMs() - startedMs,
  });

  const competitor = await resolveCompetitor(
    ctx,
    sessionId,
    turnIndex,
    input.competitorName,
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

  const competitorSnapshot = sourceBundle.competitorReview
    ? `Quick read on competitor: ${sourceBundle.competitorReview.guestSnapshot}`
    : competitor.snapshot;

  const recommendationOutput = buildRecommendations(
    input.cardType,
    recommendationInputs,
    {
      doeDays: sourceBundle.doe.days,
      competitorSnapshot,
    },
  );

  const messageText = buildMessage({
    summary: recommendationOutput.summary,
    snapshots: recommendationOutput.snapshots,
    recommendations: recommendationOutput.recommendations,
  });

  const assistantMessageId = await insertMessage(
    ctx.db,
    sessionId,
    turnIndex,
    "assistant",
    messageText,
  );

  const sourceEntries = [
    ["weather", sourceBundle.weather.status],
    ["events", sourceBundle.events.status],
    ["closures", sourceBundle.closures.status],
    ["doe", sourceBundle.doe.status],
    ["reviews", sourceBundle.reviews.status],
  ] as const;

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

  await persistRecommendations(ctx, {
    sessionId,
    messageId: assistantMessageId,
    turnIndex,
    recommendations: recommendationOutput.recommendations,
  });

  await persistReviewSignalRuns(ctx, {
    sessionId,
    turnIndex,
    resolvedLocations: resolvedLocations.map((location) => ({
      label: location.label,
      placeId: location.placeId,
    })),
    reviewByLocation: sourceBundle.reviews.byLocation,
    competitorReview: sourceBundle.competitorReview,
    sourceStatus: sourceBundle.reviews.status,
    distinctId: input.distinctId,
  });

  const usedFallback = sourceEntries.some(
    ([, status]) => status.status !== "ok",
  );
  const latencyMs = nowMs() - startedMs;

  if (usedFallback) {
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
  }

  await ctx.db
    .update(chatSessions)
    .set({
      locationCount: resolvedLocations.length,
      firstInsightLatencyMs: latencyMs,
      hadFallback: usedFallback,
    })
    .where(eq(chatSessions.id, sessionId));

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
      prompt_version: PROMPT_VERSION,
      rule_version: RULE_VERSION,
      used_fallback: usedFallback,
      env: process.env.NODE_ENV,
    },
    {
      recommendation_count: recommendationOutput.recommendations.length,
      format_compliant: true,
      source_status_weather: sourceBundle.weather.status.status,
      source_status_events: sourceBundle.events.status.status,
      source_status_closures: sourceBundle.closures.status.status,
      source_status_doe: sourceBundle.doe.status.status,
      source_status_reviews: sourceBundle.reviews.status.status,
      source_freshness_weather_s: sourceBundle.weather.status.freshnessSeconds,
      source_freshness_events_s: sourceBundle.events.status.freshnessSeconds,
      source_freshness_closures_s:
        sourceBundle.closures.status.freshnessSeconds,
      source_freshness_reviews_s: sourceBundle.reviews.status.freshnessSeconds,
      review_backed_recommendation_count:
        recommendationOutput.recommendations.filter((rec) => rec.reviewBacked)
          .length,
      review_evidence_refs_count: recommendationOutput.recommendations.reduce(
        (acc, rec) => acc + (rec.evidence?.topRefs.length ?? 0),
        0,
      ),
    },
    { sendToPosthog: true, posthogDistinctId: input.distinctId },
  );

  return {
    sessionId,
    turnIndex,
    summary: recommendationOutput.summary,
    message: messageText,
    locationLabels: resolvedLocations.map((location) => location.label),
    recommendations: recommendationOutput.recommendations,
    snapshots: recommendationOutput.snapshots,
    sources: {
      weather: sourceBundle.weather.status,
      events: sourceBundle.events.status,
      closures: sourceBundle.closures.status,
      doe: sourceBundle.doe.status,
      reviews: sourceBundle.reviews.status,
    },
    usedFallback,
    firstInsightLatencyMs: latencyMs,
    invalidLocations: parsedLocations.invalid,
  };
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
