import {
  type CardType,
  type Recommendation,
} from "@/server/services/intelligence/types";

interface CardProfile {
  objective: string;
  followUpDefault: string;
  prefetch: {
    doe: boolean;
    reviews: boolean;
    competitor: boolean;
  };
  sourceWeights: Record<Recommendation["sourceName"], number>;
  reviewBackedBonus: number;
}

const CONFIDENCE_SCORE: Record<Recommendation["confidence"], number> = {
  low: 10,
  medium: 20,
  high: 30,
};

const CARD_PROFILES: Record<CardType, CardProfile> = {
  staffing: {
    objective:
      "Prioritize labor alignment against demand shifts and baseline staffing gaps.",
    followUpDefault:
      "Want me to tune these to your current FOH baseline by location?",
    prefetch: {
      doe: false,
      reviews: true,
      competitor: false,
    },
    sourceWeights: {
      weather: 6,
      events: 9,
      closures: 5,
      doe: 4,
      reviews: 8,
      system: 1,
    },
    reviewBackedBonus: 4,
  },
  risk: {
    objective:
      "Prioritize downside prevention, access disruption risk, and conservative escalation triggers.",
    followUpDefault:
      "Want tighter risk triggers for when to staff up or pull back?",
    prefetch: {
      doe: true,
      reviews: false,
      competitor: false,
    },
    sourceWeights: {
      weather: 10,
      events: 7,
      closures: 12,
      doe: 8,
      reviews: 4,
      system: 1,
    },
    reviewBackedBonus: 1,
  },
  opportunity: {
    objective:
      "Prioritize reversible upside plays for peak windows while containing downside risk.",
    followUpDefault: "Want a conservative versus aggressive opportunity plan?",
    prefetch: {
      doe: false,
      reviews: false,
      competitor: true,
    },
    sourceWeights: {
      weather: 7,
      events: 12,
      closures: 3,
      doe: 4,
      reviews: 8,
      system: 1,
    },
    reviewBackedBonus: 3,
  },
};

export function getCardProfile(cardType: CardType): CardProfile {
  return CARD_PROFILES[cardType];
}

export function rankRecommendationsByCardProfile(
  cardType: CardType,
  recommendations: Recommendation[],
): Recommendation[] {
  const profile = getCardProfile(cardType);
  return recommendations
    .map((recommendation, index) => {
      const sourceWeight =
        profile.sourceWeights[recommendation.sourceName] ?? 1;
      const reviewBonus = recommendation.reviewBacked
        ? profile.reviewBackedBonus
        : 0;
      const score =
        CONFIDENCE_SCORE[recommendation.confidence] * 10 +
        sourceWeight * 5 +
        reviewBonus;

      return {
        recommendation,
        index,
        score,
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    })
    .map((entry) => entry.recommendation);
}

export function defaultFollowUpByCard(cardType: CardType): string {
  return getCardProfile(cardType).followUpDefault;
}
