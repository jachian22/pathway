import {
  type AgentRecommendation,
  type AgentResponse,
} from "@/server/services/intelligence/agent/schema";
import {
  type Recommendation,
  type ReviewSignals,
  type SourceStatus,
} from "@/server/services/intelligence/types";

interface PolicyInput {
  parsed: AgentResponse;
  sourceStatusByName: Record<
    "weather" | "events" | "closures" | "doe" | "reviews",
    SourceStatus
  >;
  firstLocationLabel?: string;
  baselineAssumedForFirstLocation: boolean;
  reviewByLocation: Record<string, ReviewSignals>;
}

const confidenceRank = {
  low: 1,
  medium: 2,
  high: 3,
} as const;

function clampConfidence(
  current: Recommendation["confidence"],
  cap: Recommendation["confidence"],
): Recommendation["confidence"] {
  return confidenceRank[current] <= confidenceRank[cap] ? current : cap;
}

function ensureCitations(
  recommendation: AgentRecommendation,
  sourceStatusByName: PolicyInput["sourceStatusByName"],
): AgentRecommendation["citations"] {
  if (recommendation.citations.length > 0) {
    return recommendation.citations;
  }

  if (recommendation.sourceName === "system") {
    return [
      {
        sourceName: "system",
        note: "Deterministic fallback policy path",
      },
    ];
  }

  const source = sourceStatusByName[recommendation.sourceName];
  if (!source) return [];
  return [
    {
      sourceName: recommendation.sourceName,
      freshnessSeconds: source.freshnessSeconds,
      note: `Source status: ${source.status}`,
    },
  ];
}

export function applyAgentPolicy(input: PolicyInput): {
  recommendations: Recommendation[];
  assumptions: string[];
  followUpQuestion?: string;
  policyCapsApplied: boolean;
} {
  let policyCapsApplied = false;
  const assumptions = [...input.parsed.assumptions];

  if (input.baselineAssumedForFirstLocation && input.firstLocationLabel) {
    assumptions.push(
      `Baseline staffing for ${input.firstLocationLabel} remains assumed until explicitly confirmed.`,
    );
  }

  const recommendations: Recommendation[] = input.parsed.recommendations.map(
    (rec) => {
      let confidence = rec.confidence;
      const sourceStatus =
        rec.sourceName === "system"
          ? undefined
          : input.sourceStatusByName[rec.sourceName];

      if (
        sourceStatus &&
        (sourceStatus.status === "stale" ||
          sourceStatus.status === "error" ||
          sourceStatus.status === "timeout")
      ) {
        confidence = clampConfidence(confidence, "low");
        policyCapsApplied = true;
      }

      if (
        input.baselineAssumedForFirstLocation &&
        input.firstLocationLabel &&
        rec.locationLabel === input.firstLocationLabel
      ) {
        confidence = clampConfidence(confidence, "medium");
        policyCapsApplied = true;
      }

      const citations = ensureCitations(rec, input.sourceStatusByName);
      if (citations.length === 0 && rec.sourceName !== "system") {
        confidence = "low";
        policyCapsApplied = true;
      }

      const reviewSignal = input.reviewByLocation[rec.locationLabel];
      const evidence =
        rec.evidence ??
        (rec.reviewBacked && reviewSignal
          ? {
              evidenceCount: reviewSignal.evidenceCount,
              recencyWindowDays: reviewSignal.recencyWindowDays,
              topRefs: reviewSignal.topRefs.slice(0, 3),
            }
          : undefined);

      return {
        locationLabel: rec.locationLabel,
        action: rec.action,
        timeWindow: rec.timeWindow,
        confidence,
        sourceName: rec.sourceName,
        sourceFreshnessSeconds: sourceStatus?.freshnessSeconds,
        evidence,
        explanation: {
          why: rec.why.slice(0, 2),
          deltaReasoning: rec.deltaReasoning,
          escalationTrigger: rec.escalationTrigger,
        },
        reviewBacked: rec.reviewBacked,
      };
    },
  );

  return {
    recommendations,
    assumptions,
    followUpQuestion: input.parsed.followUpQuestion,
    policyCapsApplied,
  };
}
