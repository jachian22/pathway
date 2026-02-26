import {
  defaultFollowUpByCard,
  rankRecommendationsByCardProfile,
} from "@/server/services/intelligence/agent/card-profile";
import {
  type CardType,
  type Recommendation,
  type SourceStatus,
} from "@/server/services/intelligence/types";

interface PolicyInput {
  cardType: CardType;
  recommendations: Recommendation[];
  followUpQuestion?: string;
  sourceStatusByName: Record<
    "weather" | "events" | "closures" | "doe" | "reviews",
    SourceStatus
  >;
  firstLocationLabel?: string;
  baselineAssumedForFirstLocation: boolean;
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

export function applyAgentPolicy(input: PolicyInput): {
  recommendations: Recommendation[];
  assumptions: string[];
  followUpQuestion?: string;
  policyCapsApplied: boolean;
} {
  let policyCapsApplied = false;
  const assumptions: string[] = [];

  if (input.baselineAssumedForFirstLocation && input.firstLocationLabel) {
    assumptions.push(
      `Baseline staffing for ${input.firstLocationLabel} remains assumed until explicitly confirmed.`,
    );
  }

  const adjusted = input.recommendations.map((recommendation) => {
    let confidence = recommendation.confidence;
    const sourceStatus =
      recommendation.sourceName === "system"
        ? undefined
        : input.sourceStatusByName[recommendation.sourceName];

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
      recommendation.locationLabel === input.firstLocationLabel
    ) {
      confidence = clampConfidence(confidence, "medium");
      policyCapsApplied = true;
    }

    return {
      ...recommendation,
      confidence,
      sourceFreshnessSeconds: sourceStatus?.freshnessSeconds,
    };
  });

  const rankedRecommendations = rankRecommendationsByCardProfile(
    input.cardType,
    adjusted,
  );

  return {
    recommendations: rankedRecommendations,
    assumptions,
    followUpQuestion:
      input.followUpQuestion ?? defaultFollowUpByCard(input.cardType),
    policyCapsApplied,
  };
}
