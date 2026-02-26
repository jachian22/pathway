import { type DbClient } from "@/server/db";
import { buildCompiledAgentContext } from "@/server/services/intelligence/agent/context";
import { applyAgentPolicy } from "@/server/services/intelligence/agent/policy";
import {
  AGENT_IDENTITY_PROMPT,
  AGENT_OUTPUT_PROMPT,
  AGENT_REPAIR_PROMPT,
  AGENT_TOOL_POLICY_PROMPT,
} from "@/server/services/intelligence/agent/prompt";
import { type AgentResponse } from "@/server/services/intelligence/agent/schema";
import { parseAgentResponse } from "@/server/services/intelligence/agent/schema";
import { createAgentTools } from "@/server/services/intelligence/agent/tools";
import {
  type ToolExecution,
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
  failureStage: AgentFailureStage;
  failureCode?: string;
  diagnostics: {
    parseOk: boolean;
    repairAttempted: boolean;
    repairOk: boolean;
    toolLoop?: ToolLoopDiagnostics;
  };
  phaseTelemetry: AgentPhaseTelemetry[];
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
  if (message.includes("AGENT_RESPONSE_NO_JSON")) {
    return "AGENT_RESPONSE_NO_JSON";
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
    message.includes("AGENT_TOOL_ROUND_LIMIT_REACHED")
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
      text: "Already used in this session (v1.1 limit is one competitor check).",
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
  const memoryPayload = {
    sessionId: input.sessionId,
    turnIndex: input.turnIndex,
    cardType: input.cardType,
    locations: input.resolvedLocations.map((location) => ({
      label: location.label,
      placeId: location.placeId,
    })),
    baselines: Object.fromEntries(input.baselineByLocation.entries()),
    baselineAssumedForFirstLocation: input.baselineAssumedForFirstLocation,
    competitorName: input.competitorName ?? null,
  };

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
    memoryPayload,
    competitor: input.competitor,
  });

  const phaseTelemetry: AgentPhaseTelemetry[] = [];
  const prefetchStartedAtMs = Date.now();
  const prefetchExecutions = await tools.prefetchCore();
  phaseTelemetry.push({
    phase: "prefetch_core",
    status: "ok",
    durationMs: Date.now() - prefetchStartedAtMs,
  });

  const systemPrompt = [
    AGENT_IDENTITY_PROMPT,
    AGENT_TOOL_POLICY_PROMPT,
    AGENT_OUTPUT_PROMPT,
    `Prompt version: ${context.promptVersion}`,
    `Tool contract version: ${context.toolContractVersion}`,
    `Policy version: ${context.policyVersion}`,
    `Identity context:\n${context.identityContext}`,
    `Tool contract context:\n${context.toolContractContext}`,
    `Session memory context:\n${context.sessionMemoryContext}`,
  ].join("\n\n");

  const userPrompt = [
    `Card type: ${input.cardType}`,
    `Location labels: ${input.resolvedLocations.map((location) => location.label).join(", ")}`,
    "Goal: produce staffing/prep recommendations for next 3 days with concrete action windows.",
    "If uncertainty is material, ask one short follow-up question.",
  ].join("\n");

  let toolExecutions: ToolExecution[] = prefetchExecutions;
  let parsed: AgentResponse | null = null;
  let toolLoopDiagnostics: ToolLoopDiagnostics | undefined;
  let rawContent = "";
  let degraded = false;
  let failureReason: string | undefined;
  let repairFailureReason: string | undefined;
  let failureStage: AgentFailureStage = "none";
  let failureCode: string | undefined;
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
        temperature: 0.2,
        maxTokens: 1200,
      },
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
    failureReason = error instanceof Error ? error.message : "unknown_error";
    failureCode = inferFailureCode(error);
    failureStage = inferFailureStage(error);
    phaseTelemetry.push({
      phase: "llm_tool_loop",
      status: "error",
      durationMs: Date.now() - llmLoopStartedAtMs,
      failureStage,
      failureCode,
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
      failureCode = inferFailureCode(error);
      failureStage = "schema_parse";
      phaseTelemetry.push({
        phase: "schema_parse",
        status: "error",
        durationMs: Date.now() - parseStartedAtMs,
        failureStage,
        failureCode,
      });
    }
  }

  if (llmLoopError) {
    repairAttempted = true;
    const repairStartedAtMs = Date.now();
    const reason =
      llmLoopError instanceof Error ? llmLoopError.message : "unknown_error";
    try {
      const repaired = await chatCompletion(
        [
          {
            role: "system",
            content: `${systemPrompt}\n\n${AGENT_REPAIR_PROMPT}`,
          },
          {
            role: "user",
            content: `Validation/tool loop failed with: ${reason}\nOutput to repair:\n${rawContent || "(none)"}`,
          },
        ],
        {
          temperature: 0.1,
          maxTokens: 1200,
        },
      );
      parsed = parseAgentResponse(repaired);
      parseOk = true;
      repairOk = true;
      phaseTelemetry.push({
        phase: "repair",
        status: "ok",
        durationMs: Date.now() - repairStartedAtMs,
      });
    } catch (repairError) {
      degraded = true;
      repairFailureReason =
        repairError instanceof Error
          ? repairError.message
          : "unknown_repair_error";
      failureCode ??= inferFailureCode(repairError);
      failureStage = "repair";
      phaseTelemetry.push({
        phase: "repair",
        status: "error",
        durationMs: Date.now() - repairStartedAtMs,
        failureStage,
        failureCode,
      });
      parsed = {
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
            deltaReasoning:
              "Fallback keeps operations stable under uncertainty.",
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
    failureStage = "policy";
    failureCode = "AGENT_POLICY_ERROR";
    failureReason = error instanceof Error ? error.message : "unknown_error";
    phaseTelemetry.push({
      phase: "policy",
      status: "error",
      durationMs: Date.now() - policyStartedAtMs,
      failureStage,
      failureCode,
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
    failureStage,
    failureCode,
    diagnostics: {
      parseOk,
      repairAttempted,
      repairOk,
      toolLoop: toolLoopDiagnostics,
    },
    phaseTelemetry,
  };
}
