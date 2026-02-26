"use client";

import { useEffect, useMemo, useState } from "react";

import { captureEvent } from "@/app/_lib/analytics";
import { type RouterOutputs } from "@/trpc/react";

type FirstInsightOutput = RouterOutputs["intelligence"]["firstInsight"];
type Recommendation = FirstInsightOutput["recommendations"][number];
type Snapshot = FirstInsightOutput["snapshots"][number];

interface RecommendationBlockProps {
  recommendations: Recommendation[];
  snapshots: Snapshot[];
}

function confidenceBadge(confidence: Recommendation["confidence"]): string {
  if (confidence === "high") return "badge-resolved";
  if (confidence === "medium") return "badge-in-progress";
  return "badge-escalated";
}

export function RecommendationBlock({ recommendations, snapshots }: RecommendationBlockProps) {
  const [openEvidenceIndex, setOpenEvidenceIndex] = useState<number | null>(null);

  const reviewBackedRecommendationCount = useMemo(
    () => recommendations.filter((item) => item.reviewBacked).length,
    [recommendations],
  );

  const reviewEvidenceRefsCount = useMemo(
    () =>
      recommendations.reduce((acc, item) => {
        return acc + (item.evidence?.topRefs?.length ?? 0);
      }, 0),
    [recommendations],
  );

  const hasExplanationBlock = recommendations.some((item) => item.explanation.why.length > 0);
  const hasTriggerBlock = recommendations.some((item) => item.explanation.escalationTrigger.length > 0);

  useEffect(() => {
    captureEvent("recommendation_rendered", {
      recommendation_count: recommendations.length,
      format_compliant: true,
      max_confidence: recommendations.some((item) => item.confidence === "high")
        ? "high"
        : recommendations.some((item) => item.confidence === "medium")
          ? "medium"
          : "low",
      has_explanation_block: hasExplanationBlock,
      has_trigger_block: hasTriggerBlock,
      review_backed_recommendation_count: reviewBackedRecommendationCount,
      review_evidence_refs_count: reviewEvidenceRefsCount,
    });
  }, [
    recommendations,
    hasExplanationBlock,
    hasTriggerBlock,
    reviewBackedRecommendationCount,
    reviewEvidenceRefsCount,
  ]);

  useEffect(() => {
    if (snapshots.length === 0) return;
    const first = snapshots[0];
    if (!first) return;

    captureEvent("guest_signal_snapshot_rendered", {
      snapshot_type: snapshots.length > 1 ? "combined" : "own",
      sample_review_count: first.sampleReviewCount,
      recency_window_days: first.recencyWindowDays,
      snapshot_confidence: first.confidence,
      used_direct_quote_count: 0,
    });
  }, [snapshots]);

  return (
    <div className="card mt-4">
      {snapshots.length > 0 ? (
        <div className="mb-5 rounded-lg border border-surface-3 bg-surface-1 p-4">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-text-secondary">Guest Signal Snapshot</h3>
          <div className="mt-3 space-y-3">
            {snapshots.map((snapshot) => (
              <div key={snapshot.locationLabel}>
                <p className="font-medium text-charcoal">{snapshot.locationLabel}</p>
                <p className="text-sm text-text-primary">{snapshot.text}</p>
                <p className="mt-1 text-xs text-text-secondary">
                  sample {snapshot.sampleReviewCount}, last {snapshot.recencyWindowDays} days, confidence {snapshot.confidence}
                </p>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <h3 className="text-lg font-semibold text-charcoal">Actions</h3>
      <div className="mt-4 space-y-4">
        {recommendations.map((item, idx) => (
          <div key={`${item.locationLabel}-${item.action}-${idx}`} className="rounded-lg border border-surface-3 bg-surface-0 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className={confidenceBadge(item.confidence)}>{item.confidence}</span>
              <span className="text-xs text-text-secondary">
                source: {item.sourceName}
                {item.sourceFreshnessSeconds ? ` · ${Math.floor(item.sourceFreshnessSeconds / 3600)}h old` : ""}
              </span>
            </div>

            <p className="mt-2 font-medium text-charcoal">{item.action}</p>
            <p className="mt-1 text-sm text-text-secondary">Time window: {item.timeWindow}</p>

            {item.explanation.why.length > 0 ? (
              <p className="mt-2 text-sm text-text-primary">Why: {item.explanation.why.slice(0, 2).join("; ")}</p>
            ) : null}

            <p className="mt-2 text-sm text-text-primary">Trigger: {item.explanation.escalationTrigger}</p>

            {item.evidence && item.evidence.topRefs.length > 0 ? (
              <div className="mt-3">
                <button
                  type="button"
                  className="suggestion-chip"
                  onClick={() => {
                    const next = openEvidenceIndex === idx ? null : idx;
                    setOpenEvidenceIndex(next);

                    if (next !== null) {
                      captureEvent("review_evidence_viewed", {
                        snapshot_type: "own",
                        evidence_refs_shown_count: item.evidence?.topRefs.length ?? 0,
                        contains_quote_snippets: true,
                      });
                    }
                  }}
                >
                  {openEvidenceIndex === idx ? "Hide evidence" : "Show evidence"}
                </button>

                {openEvidenceIndex === idx ? (
                  <div className="mt-3 space-y-2 rounded-md border border-surface-3 bg-surface-1 p-3">
                    {item.evidence.topRefs.map((ref) => (
                      <div key={ref.reviewIdOrHash} className="text-sm text-text-primary">
                        <p>“{ref.excerpt}”</p>
                        <p className="mt-1 text-xs text-text-secondary">
                          {new Date(ref.publishTime).toLocaleDateString()} · rating {ref.rating ?? "n/a"} · {ref.theme}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
