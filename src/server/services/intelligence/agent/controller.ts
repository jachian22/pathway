import { env } from "@/env";
import { type DbClient } from "@/server/db";
import { buildCompiledAgentContext } from "@/server/services/intelligence/agent/context";
import { applyAgentPolicy } from "@/server/services/intelligence/agent/policy";
import {
  AGENT_IDENTITY_PROMPT,
  AGENT_OUTPUT_PROMPT,
  AGENT_TOOL_POLICY_PROMPT,
} from "@/server/services/intelligence/agent/prompt";
import { type AgentResponse } from "@/server/services/intelligence/agent/schema";
import { parseAgentResponse } from "@/server/services/intelligence/agent/schema";
import {
  type AgentSourceSnapshot,
  createAgentTools,
} from "@/server/services/intelligence/agent/tools";
import {
  type ToolExecution,
  ToolLoopError,
  type ToolLoopDiagnostics,
  chatCompletion,
  chatCompletionWithTools,
} from "@/server/services/openrouter";
import {
  type CardType,
  type Recommendation,
  type ResolvedLocation,
  type ReviewSignals,
  type SourceStatus,
} from "@/server/services/intelligence/types";

interface CompetitorInput {
  placeId?: string;
  snapshot?: string;
  resolvedName?: string;
  status: "not_requested" | "limit_reached" | "not_found" | "resolved";
}

interface AgentTurnInput {
  db: DbClient;
  sessionId: string;
  turnIndex: number;
  cardType: CardType;
  resolvedLocations: ResolvedLocation[];
  baselineByLocation: Map<string, number>;
  baselineAssumedForFirstLocation: boolean;
  competitor: CompetitorInput;
  competitorName?: string;
}

interface Snapshot {
  locationLabel: string;
  text: string;
  sampleReviewCount: number;
  recencyWindowDays: number;
  confidence: "low" | "medium" | "high";
}

export type AgentFailureStage =
  | "provider"
  | "tool_loop"
  | "schema_parse"
  | "repair"
  | "policy"
  | "none";

export interface AgentPhaseTelemetry {
  phase:
    | "prefetch_core"
    | "llm_tool_loop"
    | "schema_parse"
    | "repair"
    | "policy";
  status: "ok" | "error";
  durationMs: number;
  failureStage?: AgentFailureStage;
  failureCode?: string;
}

export interface AgentTurnOutput {
  summary: string;
  message: string;
  recommendations: Recommendation[];
  snapshots: Snapshot[];
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
    weather: SourceStatus;
    events: SourceStatus;
    closures: SourceStatus;
    doe: SourceStatus;
    reviews: SourceStatus;
  };
  toolExecutions: ToolExecution[];
  reviewSignals: {
    byLocation: Record<string, ReviewSignals>;
    competitorReview: ReviewSignals | null;
  };
  policyCapsApplied: boolean;
  assumptions: string[];
  promptMeta: {
    promptVersion: string;
    toolContractVersion: string;
    policyVersion: string;
  };
  circuitBreakerEvents: {
    sourceName: string;
    state: "open";
    failureCount: number;
  }[];
  degraded: boolean;
  failureReason?: string;
  repairFailureReason?: string;
  rootFailureStage: AgentFailureStage;
  rootFailureCode?: string;
  repairFailureStage?: AgentFailureStage;
  repairFailureCode?: string;
  failureStage: AgentFailureStage;
  failureCode?: string;
  diagnostics: {
    parseOk: boolean;
    repairAttempted: boolean;
    repairOk: boolean;
    toolLoop?: ToolLoopDiagnostics;
    prefetchToolCallCount: number;
    prefetchToolCallsByName: Record<string, number>;
    loopToolCallCount: number;
    loopToolCallsByName: Record<string, number>;
  };
  phaseTelemetry: AgentPhaseTelemetry[];
}

const MAX_REPAIR_TIMEOUT_MS = 1200;
const MIN_REPAIR_BUDGET_MS = 300;
const SIGNAL_PACK_SUMMARY_TIMEOUT_MS = 700;
const SIGNAL_PACK_SUMMARY_MAX_TOKENS = 220;

interface SignalPackLocation {
  locationLabel: string;
  weather: {
    rainLikely: boolean;
    rainWindow: string | null;
    tempExtremeLikely: boolean;
    tempWindow: string | null;
  } | null;
  topEvent: {
    venue: string;
    event: string;
    impactWindow: string;
  } | null;
  topClosure: {
    title: string;
    window: string;
  } | null;
  review: {
    topTheme: string | null;
    evidenceCount: number;
    recencyWindowDays: number;
  } | null;
}

interface SignalPack {
  window: "next_3_days";
  locations: SignalPackLocation[];
  doe: {
    date: string;
    eventType: string;
  }[];
  competitor: {
    label: string;
    topTheme: string | null;
    evidenceCount: number;
    recencyWindowDays: number;
  } | null;
  sourceStatus: {
    weather: SourceStatus["status"];
    events: SourceStatus["status"];
    closures: SourceStatus["status"];
    doe: SourceStatus["status"];
    reviews: SourceStatus["status"];
  };
}

function formatWindow(startAt?: string, endAt?: string): string {
  if (!startAt && !endAt) return "timing not specified";
  if (!startAt) return `until ${endAt ?? "unknown"}`;
  if (!endAt) return `from ${startAt}`;
  return `${startAt} to ${endAt}`;
}

function topReviewTheme(signal: ReviewSignals): string | null {
  const entries = Object.entries(signal.themes ?? {});
  if (entries.length === 0) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0]?.[0] ?? null;
}

function buildDeterministicSignalPack(params: {
  resolvedLocations: ResolvedLocation[];
  sourceSnapshot: AgentSourceSnapshot;
  sourceStatuses: AgentTurnOutput["sources"];
  competitor: CompetitorInput;
}): SignalPack {
  const locations = params.resolvedLocations.map((location) => {
    const weather = params.sourceSnapshot.weatherByLocation[location.label];
    const events = params.sourceSnapshot.eventsByLocation[location.label] ?? [];
    const closures =
      params.sourceSnapshot.closuresByLocation[location.label] ?? [];
    const review = params.sourceSnapshot.reviewByLocation[location.label];
    const topEvent = events[0];
    const topClosure = closures[0];

    return {
      locationLabel: location.label,
      weather: weather
        ? {
            rainLikely: weather.rainLikely,
            rainWindow: weather.rainWindow,
            tempExtremeLikely: weather.tempExtremeLikely,
            tempWindow: weather.tempWindow,
          }
        : null,
      topEvent: topEvent
        ? {
            venue: topEvent.venueName,
            event: topEvent.eventName,
            impactWindow: formatWindow(
              topEvent.impactStartAt,
              topEvent.impactEndAt,
            ),
          }
        : null,
      topClosure: topClosure
        ? {
            title: topClosure.title,
            window: formatWindow(topClosure.startAt, topClosure.endAt),
          }
        : null,
      review: review
        ? {
            topTheme: topReviewTheme(review),
            evidenceCount: review.evidenceCount,
            recencyWindowDays: review.recencyWindowDays,
          }
        : null,
    } satisfies SignalPackLocation;
  });

  const doe = (params.sourceSnapshot.doeDays ?? [])
    .filter((day) => day.eventType.toLowerCase() !== "weekend")
    .slice(0, 2)
    .map((day) => ({
      date: day.date,
      eventType: day.eventType,
    }));

  const competitorReview = params.sourceSnapshot.competitorReview;
  const competitor =
    params.competitor.status === "resolved" && competitorReview
      ? {
          label: params.competitor.resolvedName ?? "Competitor",
          topTheme: topReviewTheme(competitorReview),
          evidenceCount: competitorReview.evidenceCount,
          recencyWindowDays: competitorReview.recencyWindowDays,
        }
      : null;

  return {
    window: "next_3_days",
    locations,
    doe,
    competitor,
    sourceStatus: {
      weather: params.sourceStatuses.weather.status,
      events: params.sourceStatuses.events.status,
      closures: params.sourceStatuses.closures.status,
      doe: params.sourceStatuses.doe.status,
      reviews: params.sourceStatuses.reviews.status,
    },
  };
}

function buildDeterministicSignalPackSummary(signalPack: SignalPack): string {
  const lines: string[] = [];
  for (const location of signalPack.locations) {
    const fragments: string[] = [];
    if (location.weather?.rainLikely) {
      fragments.push("rain risk in service windows");
    }
    if (location.topEvent) {
      fragments.push(
        `${location.topEvent.event} near ${location.topEvent.venue}`,
      );
    }
    if (location.topClosure) {
      fragments.push(`closure: ${location.topClosure.title}`);
    }
    if (location.review?.topTheme && location.review.evidenceCount > 0) {
      fragments.push(
        `reviews theme=${location.review.topTheme} (${location.review.evidenceCount} refs)`,
      );
    }
    lines.push(
      `${location.locationLabel}: ${fragments.length > 0 ? fragments.join("; ") : "no major external signals"}`,
    );
  }

  if (signalPack.doe.length > 0) {
    lines.push(
      `DOE modifiers: ${signalPack.doe.map((d) => `${d.date} ${d.eventType}`).join(", ")}`,
    );
  }
  if (signalPack.competitor) {
    lines.push(
      `Competitor ${signalPack.competitor.label}: theme=${signalPack.competitor.topTheme ?? "mixed"} (${signalPack.competitor.evidenceCount} refs)`,
    );
  }
  lines.push(
    `Source status: w=${signalPack.sourceStatus.weather}, e=${signalPack.sourceStatus.events}, c=${signalPack.sourceStatus.closures}, d=${signalPack.sourceStatus.doe}, r=${signalPack.sourceStatus.reviews}`,
  );

  return lines.join(" | ");
}

function parseJsonObject<T>(content: string): T | null {
  const firstBrace = content.indexOf("{");
  const lastBrace = content.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }
  try {
    return JSON.parse(content.slice(firstBrace, lastBrace + 1)) as T;
  } catch {
    return null;
  }
}

async function summarizeSignalPackWithLlm(params: {
  cardType: CardType;
  signalPack: SignalPack;
  deterministicSummary: string;
  model?: string;
  timeoutMs: number;
}): Promise<string> {
  const response = await chatCompletion(
    [
      {
        role: "system",
        content:
          "Summarize structured operations signals for an NYC restaurant staffing assistant.",
      },
      {
        role: "user",
        content: [
          'Return JSON only: {"summary":"<=70 words single paragraph"}.',
          `Card type: ${params.cardType}`,
          `Signal pack: ${JSON.stringify(params.signalPack)}`,
          `Fallback deterministic summary: ${params.deterministicSummary}`,
        ].join("\n"),
      },
    ],
    {
      model: params.model,
      temperature: 0.1,
      maxTokens: SIGNAL_PACK_SUMMARY_MAX_TOKENS,
      timeoutMs: Math.min(params.timeoutMs, SIGNAL_PACK_SUMMARY_TIMEOUT_MS),
      responseFormat: { type: "json_object" },
    },
  );

  const parsed = parseJsonObject<{ summary?: string }>(response);
  const summary = parsed?.summary?.trim();
  if (!summary) {
    throw new Error("AGENT_SIGNAL_PACK_SUMMARY_INVALID");
  }
  return summary;
}

function inferFailureCode(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "unknown_error";
  const isZodError = error instanceof Error && error.name === "ZodError";
  if (message.includes("AGENT_TOOL_CALL_LIMIT_REACHED")) {
    return "AGENT_TOOL_CALL_LIMIT_REACHED";
  }
  if (message.includes("AGENT_TOOL_ROUND_LIMIT_REACHED")) {
    return "AGENT_TOOL_ROUND_LIMIT_REACHED";
  }
  if (message.includes("AGENT_TURN_BUDGET_EXCEEDED")) {
    return "AGENT_TURN_BUDGET_EXCEEDED";
  }
  if (message.includes("AGENT_REPAIR_SKIPPED_PROVIDER_EMPTY")) {
    return "AGENT_REPAIR_SKIPPED_PROVIDER_EMPTY";
  }
  if (message.includes("AGENT_RESPONSE_NO_JSON")) {
    return "AGENT_RESPONSE_NO_JSON";
  }
  if (message.includes("AGENT_RESPONSE_TRUNCATED")) {
    return "AGENT_RESPONSE_TRUNCATED";
  }
  if (message.includes("AGENT_REPAIR_TIMEOUT_LOCAL")) {
    return "AGENT_REPAIR_TIMEOUT_LOCAL";
  }
  if (message.includes("Unexpected token")) {
    return "AGENT_RESPONSE_INVALID_JSON";
  }
  if (message.includes("ZodError") || isZodError) {
    return "AGENT_RESPONSE_SCHEMA_INVALID";
  }
  if (message.includes("OpenRouter API error")) {
    return "OPENROUTER_ERROR";
  }
  return "AGENT_UNKNOWN_ERROR";
}

function inferFailureStage(error: unknown): AgentFailureStage {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "unknown_error";
  const isZodError = error instanceof Error && error.name === "ZodError";
  if (
    message.includes("AGENT_TOOL_CALL_LIMIT_REACHED") ||
    message.includes("AGENT_TOOL_ROUND_LIMIT_REACHED") ||
    message.includes("AGENT_TURN_BUDGET_EXCEEDED")
  ) {
    return "tool_loop";
  }
  if (message.includes("AGENT_RESPONSE_NO_JSON")) {
    return "schema_parse";
  }
  if (
    message.includes("Unexpected token") ||
    message.includes("ZodError") ||
    isZodError
  ) {
    return "schema_parse";
  }
  if (message.includes("OpenRouter API error")) {
    return "provider";
  }
  return "provider";
}

function remainingBudgetMs(deadlineMs: number): number {
  return Math.max(0, deadlineMs - Date.now());
}

async function withLocalTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutCode: string,
): Promise<T> {
  if (timeoutMs <= 0) {
    throw new Error("AGENT_TURN_BUDGET_EXCEEDED");
  }

  return await new Promise<T>((resolve, reject) => {
    const handle = setTimeout(() => {
      reject(new Error(timeoutCode));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(handle);
        resolve(value);
      },
      (error) => {
        clearTimeout(handle);
        reject(
          error instanceof Error ? error : new Error(String(error ?? "error")),
        );
      },
    );
  });
}

function shouldSkipRepairForProviderEmpty(reason?: string): boolean {
  if (!reason) return false;
  return (
    reason.includes("missing final content") ||
    reason.includes("No response content from OpenRouter")
  );
}

function mapCardIntro(cardType: CardType): string {
  if (cardType === "risk")
    return "Next 3 days risk signals for your locations:";
  if (cardType === "opportunity")
    return "Next 3 days opportunity signals for your locations:";
  return "Next 3 days staffing and prep signals for your locations:";
}

function buildSummary(
  cardType: CardType,
  recommendations: Recommendation[],
): string {
  const lines = [mapCardIntro(cardType)];
  for (const recommendation of recommendations.slice(0, 4)) {
    lines.push(`- ${recommendation.action} (${recommendation.confidence})`);
  }
  return lines.join("\n");
}

function buildMessage(params: {
  narrative: string;
  recommendations: Recommendation[];
  followUpQuestion?: string;
  competitorSnapshot?: AgentTurnOutput["competitorSnapshot"];
}): string {
  const lines: string[] = [params.narrative.trim()];
  const top = params.recommendations[0];
  if (top) {
    lines.push("", `Top action: ${top.action}`);
    const sourceLine = `${top.confidence} confidence · source ${top.sourceName}`;
    lines.push(sourceLine);
  }
  if (params.competitorSnapshot) {
    lines.push("", `Competitor check: ${params.competitorSnapshot.label}.`);
  }
  if (params.followUpQuestion) {
    lines.push("", params.followUpQuestion);
  }
  return lines.join("\n");
}

function buildSnapshots(
  resolvedLocations: ResolvedLocation[],
  reviewByLocation: Record<string, ReviewSignals>,
): Snapshot[] {
  return resolvedLocations
    .map((location) => {
      const signal = reviewByLocation[location.label];
      if (!signal || signal.evidenceCount === 0) return null;
      return {
        locationLabel: location.label,
        text: signal.guestSnapshot,
        sampleReviewCount: signal.sampleReviewCount,
        recencyWindowDays: signal.recencyWindowDays,
        confidence: signal.confidence,
      };
    })
    .filter((value): value is Snapshot => value !== null);
}

function buildCompetitorSnapshot(
  competitor: CompetitorInput,
  competitorName: string | undefined,
  competitorReview: ReviewSignals | null,
): AgentTurnOutput["competitorSnapshot"] {
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
      label: competitorName ?? "Competitor",
      text:
        competitor.snapshot ??
        "Could not resolve competitor from places search.",
      confidence: "low",
      sampleReviewCount: 0,
      recencyWindowDays: 90,
      status: "not_found",
    };
  }
  if (competitorReview) {
    return {
      label: competitor.resolvedName ?? "Competitor",
      text: competitorReview.guestSnapshot,
      confidence: competitorReview.confidence,
      sampleReviewCount: competitorReview.sampleReviewCount,
      recencyWindowDays: competitorReview.recencyWindowDays,
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
}

function fallbackRecommendation(locationLabel: string): Recommendation {
  return {
    locationLabel,
    action:
      "Next 24h: run standard staffing and prep, keep delivery timing flexible, and recheck in 30 minutes",
    timeWindow: "Next 24h",
    confidence: "low",
    sourceName: "system",
    explanation: {
      why: [
        "Live tool signals were insufficient for a higher-confidence adjustment.",
      ],
      deltaReasoning:
        "Conservative operating posture minimizes disruption risk under uncertainty.",
      escalationTrigger:
        "Re-run checks if service pace deviates from baseline.",
    },
    reviewBacked: false,
  };
}

export async function runAgentTurn(
  input: AgentTurnInput,
): Promise<AgentTurnOutput> {
  const firstLocationLabel = input.resolvedLocations[0]?.label;

  const context = buildCompiledAgentContext({
    sessionId: input.sessionId,
    turnIndex: input.turnIndex,
    cardType: input.cardType,
    locations: input.resolvedLocations,
    baselineByLocation: input.baselineByLocation,
    competitorName: input.competitorName,
    baselineAssumedForFirstLocation: input.baselineAssumedForFirstLocation,
  });

  const tools = createAgentTools({
    db: input.db,
    resolvedLocations: input.resolvedLocations,
    competitor: input.competitor,
  });

  const turnStartedAtMs = Date.now();
  const isFirstTurn = input.turnIndex <= 1;
  const turnBudgetMs = isFirstTurn
    ? env.INTELLIGENCE_TURN_BUDGET_FIRST_MS
    : env.INTELLIGENCE_TURN_BUDGET_FOLLOWUP_MS;
  const turnDeadlineMs = turnStartedAtMs + turnBudgetMs;
  const loopDeadlineMs =
    turnDeadlineMs -
    Math.min(
      env.INTELLIGENCE_TURN_REPAIR_RESERVE_MS,
      Math.max(0, turnBudgetMs - MIN_REPAIR_BUDGET_MS),
    );
  const maxTokensForTurn = isFirstTurn
    ? env.INTELLIGENCE_AGENT_MAX_TOKENS_FIRST_TURN
    : env.INTELLIGENCE_AGENT_MAX_TOKENS_FOLLOWUP;
  const modelOverride = isFirstTurn
    ? (env.OPENROUTER_FAST_MODEL ?? undefined)
    : undefined;
  const phaseTelemetry: AgentPhaseTelemetry[] = [];
  const prefetchStartedAtMs = Date.now();
  const prefetchExecutions = await tools.prefetchCore();
  const prefetchToolCallsByName = prefetchExecutions.reduce<
    Record<string, number>
  >((acc, execution) => {
    acc[execution.toolName] = (acc[execution.toolName] ?? 0) + 1;
    return acc;
  }, {});
  phaseTelemetry.push({
    phase: "prefetch_core",
    status: "ok",
    durationMs: Date.now() - prefetchStartedAtMs,
  });

  const sourceStatusesAfterPrefetch = tools.getSourceStatuses();
  const sourceSnapshotAfterPrefetch = tools.getSourceSnapshot();
  const deterministicSignalPack = buildDeterministicSignalPack({
    resolvedLocations: input.resolvedLocations,
    sourceSnapshot: sourceSnapshotAfterPrefetch,
    sourceStatuses: sourceStatusesAfterPrefetch,
    competitor: input.competitor,
  });
  const deterministicSignalPackSummary = buildDeterministicSignalPackSummary(
    deterministicSignalPack,
  );
  let signalPackSummary = deterministicSignalPackSummary;
  const summaryBudgetMs = Math.min(
    SIGNAL_PACK_SUMMARY_TIMEOUT_MS,
    Math.max(0, loopDeadlineMs - Date.now() - MIN_REPAIR_BUDGET_MS),
  );
  if (summaryBudgetMs >= 200) {
    try {
      signalPackSummary = await summarizeSignalPackWithLlm({
        cardType: input.cardType,
        signalPack: deterministicSignalPack,
        deterministicSummary: deterministicSignalPackSummary,
        model: modelOverride,
        timeoutMs: summaryBudgetMs,
      });
    } catch {
      signalPackSummary = deterministicSignalPackSummary;
    }
  }

  const systemPrompt = [
    AGENT_IDENTITY_PROMPT,
    AGENT_TOOL_POLICY_PROMPT,
    AGENT_OUTPUT_PROMPT,
    `Context: ${context.identityContext}`,
    `Limits: ${context.toolContractContext}`,
    `Memory: ${context.sessionMemoryContext}`,
  ].join("\n\n");

  const userPrompt = [
    `Card type: ${input.cardType}`,
    `Location labels: ${input.resolvedLocations.map((location) => location.label).join(", ")}`,
    "Goal: produce staffing/prep recommendations for next 3 days with concrete action windows.",
    `Signal pack summary: ${signalPackSummary}`,
    "Core signals already fetched (weather/events/closures/doe/reviews). Do not re-fetch unless you need deeper evidence for a specific claim.",
    "If uncertainty is material, ask one short follow-up question.",
  ].join("\n");

  const composeFromSignalPack = async (
    reason: string,
    timeoutMs: number,
  ): Promise<AgentResponse> => {
    const refreshedSourceStatuses = tools.getSourceStatuses();
    const refreshedSourceSnapshot = tools.getSourceSnapshot();
    const refreshedSignalPack = buildDeterministicSignalPack({
      resolvedLocations: input.resolvedLocations,
      sourceSnapshot: refreshedSourceSnapshot,
      sourceStatuses: refreshedSourceStatuses,
      competitor: input.competitor,
    });
    const refreshedSummary =
      buildDeterministicSignalPackSummary(refreshedSignalPack);

    const composed = await chatCompletion(
      [
        {
          role: "system",
          content: [
            AGENT_IDENTITY_PROMPT,
            AGENT_TOOL_POLICY_PROMPT,
            AGENT_OUTPUT_PROMPT,
            "Do not call tools in this step. Use provided signal pack only.",
          ].join("\n\n"),
        },
        {
          role: "user",
          content: [
            `Card type: ${input.cardType}`,
            `Locations: ${input.resolvedLocations.map((location) => location.label).join(", ")}`,
            `Reason for retry: ${reason}`,
            `Signal pack summary: ${refreshedSummary}`,
            `Signal pack JSON: ${JSON.stringify(refreshedSignalPack)}`,
            "Return only valid JSON in the required schema.",
          ].join("\n"),
        },
      ],
      {
        model: modelOverride,
        temperature: 0.1,
        maxTokens: maxTokensForTurn,
        timeoutMs,
        responseFormat: { type: "json_object" },
      },
    );

    return parseAgentResponse(composed);
  };

  let toolExecutions: ToolExecution[] = prefetchExecutions;
  let parsed: AgentResponse | null = null;
  let toolLoopDiagnostics: ToolLoopDiagnostics | undefined;
  let rawContent = "";
  let degraded = false;
  let failureReason: string | undefined;
  let repairFailureReason: string | undefined;
  let rootFailureStage: AgentFailureStage = "none";
  let rootFailureCode: string | undefined;
  let repairFailureStage: AgentFailureStage | undefined;
  let repairFailureCode: string | undefined;
  let parseOk = false;
  let repairAttempted = false;
  let repairOk = false;

  const llmLoopStartedAtMs = Date.now();
  let llmLoopError: unknown;
  try {
    const response = await chatCompletionWithTools({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      tools: tools.tools,
      executeTool: tools.executeTool,
      maxRounds: 2,
      maxToolCalls: 8,
      options: {
        model: modelOverride,
        temperature: 0.2,
        maxTokens: maxTokensForTurn,
        responseFormat: { type: "json_object" },
      },
      deadlineMs: loopDeadlineMs,
    });
    toolExecutions = [...prefetchExecutions, ...response.toolExecutions];
    toolLoopDiagnostics = response.diagnostics;
    rawContent = response.content;
    phaseTelemetry.push({
      phase: "llm_tool_loop",
      status: "ok",
      durationMs: Date.now() - llmLoopStartedAtMs,
    });
  } catch (error) {
    llmLoopError = error;
    if (error instanceof ToolLoopError) {
      toolLoopDiagnostics = error.diagnostics;
    }
    failureReason = error instanceof Error ? error.message : "unknown_error";
    rootFailureCode = inferFailureCode(error);
    rootFailureStage = inferFailureStage(error);
    phaseTelemetry.push({
      phase: "llm_tool_loop",
      status: "error",
      durationMs: Date.now() - llmLoopStartedAtMs,
      failureStage: rootFailureStage,
      failureCode: rootFailureCode,
    });
  }

  if (!llmLoopError) {
    const parseStartedAtMs = Date.now();
    try {
      parsed = parseAgentResponse(rawContent);
      parseOk = true;
      phaseTelemetry.push({
        phase: "schema_parse",
        status: "ok",
        durationMs: Date.now() - parseStartedAtMs,
      });
    } catch (error) {
      llmLoopError = error;
      failureReason = error instanceof Error ? error.message : "unknown_error";
      const inferredFailureCode = inferFailureCode(error);
      rootFailureCode =
        (inferredFailureCode === "AGENT_RESPONSE_NO_JSON" ||
          inferredFailureCode === "AGENT_RESPONSE_INVALID_JSON") &&
        toolLoopDiagnostics?.finalFinishReason === "length"
          ? "AGENT_RESPONSE_TRUNCATED"
          : inferredFailureCode;
      rootFailureStage = "schema_parse";
      phaseTelemetry.push({
        phase: "schema_parse",
        status: "error",
        durationMs: Date.now() - parseStartedAtMs,
        failureStage: rootFailureStage,
        failureCode: rootFailureCode,
      });
    }
  }

  if (llmLoopError) {
    const reason =
      llmLoopError instanceof Error ? llmLoopError.message : "unknown_error";
    const repairStartedAtMs = Date.now();
    const budgetLeftForRepairMs = remainingBudgetMs(turnDeadlineMs);
    const skipForProviderEmpty = shouldSkipRepairForProviderEmpty(reason);
    const skipForBudget = budgetLeftForRepairMs < MIN_REPAIR_BUDGET_MS;

    if (skipForProviderEmpty || skipForBudget) {
      degraded = true;
      repairFailureReason = skipForProviderEmpty
        ? "AGENT_REPAIR_SKIPPED_PROVIDER_EMPTY"
        : "AGENT_TURN_BUDGET_EXCEEDED";
      repairFailureStage = "repair";
      repairFailureCode ??= repairFailureReason;
      phaseTelemetry.push({
        phase: "repair",
        status: "error",
        durationMs: Date.now() - repairStartedAtMs,
        failureStage: repairFailureStage,
        failureCode: repairFailureCode,
      });
    } else {
      repairAttempted = true;
      try {
        const composeTimeoutMs = Math.min(
          budgetLeftForRepairMs,
          MAX_REPAIR_TIMEOUT_MS,
        );
        parsed = await withLocalTimeout(
          composeFromSignalPack(reason, composeTimeoutMs),
          composeTimeoutMs + 150,
          "AGENT_REPAIR_TIMEOUT_LOCAL",
        );
        parseOk = true;
        repairOk = true;
        phaseTelemetry.push({
          phase: "repair",
          status: "ok",
          durationMs: Date.now() - repairStartedAtMs,
        });
      } catch (composeError) {
        degraded = true;
        repairFailureReason =
          composeError instanceof Error
            ? composeError.message
            : "unknown_repair_error";
        repairFailureStage = "repair";
        repairFailureCode ??= inferFailureCode(composeError);
        phaseTelemetry.push({
          phase: "repair",
          status: "error",
          durationMs: Date.now() - repairStartedAtMs,
          failureStage: repairFailureStage,
          failureCode: repairFailureCode,
        });
      }
    }

    parsed ??= {
      narrative:
        "Live model synthesis is temporarily unavailable, so I am using a conservative operating fallback.",
      recommendations: [
        {
          locationLabel: firstLocationLabel ?? "your locations",
          action:
            "Next 24h: run standard staffing and prep, keep delivery timing flexible, and recheck in 30 minutes",
          timeWindow: "Next 24h",
          confidence: "low",
          sourceName: "system",
          why: ["Live model/tool synthesis failed for this turn."],
          deltaReasoning: "Fallback keeps operations stable under uncertainty.",
          escalationTrigger:
            "Escalate only if live service indicators exceed baseline.",
          reviewBacked: false,
          citations: [
            {
              sourceName: "system",
              note: "agent fallback",
            },
          ],
        },
      ],
      assumptions: ["Fallback applied due to agent synthesis failure."],
      followUpQuestion:
        "Want me to retry now with the same locations and baseline?",
    };
  }

  const reviewSignals = tools.getReviewSignals();
  const sourceStatuses = tools.getSourceStatuses();
  const policyStartedAtMs = Date.now();
  let policyApplied: ReturnType<typeof applyAgentPolicy>;
  try {
    policyApplied = applyAgentPolicy({
      parsed: parsed ?? {
        narrative: "Conservative fallback due to missing model output.",
        recommendations: [],
        assumptions: [],
      },
      sourceStatusByName: sourceStatuses,
      firstLocationLabel,
      baselineAssumedForFirstLocation: input.baselineAssumedForFirstLocation,
      reviewByLocation: reviewSignals.byLocation,
    });
    phaseTelemetry.push({
      phase: "policy",
      status: "ok",
      durationMs: Date.now() - policyStartedAtMs,
    });
  } catch (error) {
    degraded = true;
    if (rootFailureStage === "none") {
      rootFailureStage = "policy";
      rootFailureCode = "AGENT_POLICY_ERROR";
    }
    failureReason = error instanceof Error ? error.message : "unknown_error";
    phaseTelemetry.push({
      phase: "policy",
      status: "error",
      durationMs: Date.now() - policyStartedAtMs,
      failureStage: "policy",
      failureCode: "AGENT_POLICY_ERROR",
    });
    policyApplied = {
      recommendations: [
        fallbackRecommendation(firstLocationLabel ?? "your locations"),
      ],
      assumptions: [
        "Fallback applied because response policy enforcement failed.",
      ],
      policyCapsApplied: true,
    };
  }

  const recommendations =
    policyApplied.recommendations.length > 0
      ? policyApplied.recommendations
      : [fallbackRecommendation(firstLocationLabel ?? "your locations")];
  const competitorSnapshot = buildCompetitorSnapshot(
    input.competitor,
    input.competitorName,
    reviewSignals.competitorReview,
  );
  const message = buildMessage({
    narrative:
      parsed?.narrative ??
      "Live model synthesis is temporarily unavailable, so I am using a conservative operating fallback.",
    recommendations,
    followUpQuestion: policyApplied.followUpQuestion,
    competitorSnapshot,
  });

  return {
    summary: buildSummary(input.cardType, recommendations),
    message,
    recommendations,
    snapshots: buildSnapshots(
      input.resolvedLocations,
      reviewSignals.byLocation,
    ),
    competitorSnapshot,
    sources: sourceStatuses,
    toolExecutions,
    reviewSignals,
    policyCapsApplied: policyApplied.policyCapsApplied,
    assumptions: policyApplied.assumptions,
    promptMeta: {
      promptVersion: context.promptVersion,
      toolContractVersion: context.toolContractVersion,
      policyVersion: context.policyVersion,
    },
    circuitBreakerEvents: tools.getCircuitBreakerEvents(),
    degraded,
    failureReason,
    repairFailureReason,
    rootFailureStage,
    rootFailureCode,
    repairFailureStage,
    repairFailureCode,
    failureStage: rootFailureStage,
    failureCode: rootFailureCode,
    diagnostics: {
      parseOk,
      repairAttempted,
      repairOk,
      toolLoop: toolLoopDiagnostics,
      prefetchToolCallCount: prefetchExecutions.length,
      prefetchToolCallsByName,
      loopToolCallCount: toolLoopDiagnostics?.toolCallCount ?? 0,
      loopToolCallsByName: toolLoopDiagnostics?.toolCallsByName ?? {},
    },
    phaseTelemetry,
  };
}
