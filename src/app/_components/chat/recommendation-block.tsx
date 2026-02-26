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

export function RecommendationBlock({
  recommendations,
  snapshots,
}: RecommendationBlockProps) {
  const [openEvidenceIndex, setOpenEvidenceIndex] = useState<number | null>(
    null,
  );
  const [openDetailIndex, setOpenDetailIndex] = useState<number | null>(null);

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

  const hasExplanationBlock = recommendations.some(
    (item) => item.explanation.why.length > 0,
  );
  const hasTriggerBlock = recommendations.some(
    (item) => item.explanation.escalationTrigger.length > 0,
  );

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
        <div className="border-surface-3 bg-surface-1 mb-5 rounded-lg border p-4">
          <h3 className="text-text-secondary text-sm font-semibold tracking-wide uppercase">
            Guest Signal Snapshot
          </h3>
          <div className="mt-3 space-y-3">
            {snapshots.map((snapshot) => (
              <div key={snapshot.locationLabel}>
                <p className="text-charcoal font-medium">
                  {snapshot.locationLabel}
                </p>
                <p className="text-text-primary text-sm">{snapshot.text}</p>
                <p className="text-text-secondary mt-1 text-xs">
                  sample {snapshot.sampleReviewCount}, last{" "}
                  {snapshot.recencyWindowDays} days, confidence{" "}
                  {snapshot.confidence}
                </p>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <h3 className="text-charcoal text-lg font-semibold">Actions</h3>
      <div className="mt-4 space-y-4">
        {recommendations.map((item, idx) => (
          <div
            key={`${item.locationLabel}-${item.action}-${idx}`}
            className="border-surface-3 bg-surface-0 rounded-lg border p-4"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className={confidenceBadge(item.confidence)}>
                {item.confidence}
              </span>
              <span className="text-text-secondary text-xs">
                source: {item.sourceName}
                {item.sourceFreshnessSeconds
                  ? ` · ${Math.floor(item.sourceFreshnessSeconds / 3600)}h old`
                  : ""}
              </span>
            </div>

            <p className="text-charcoal mt-2 font-medium">{item.action}</p>
            <p className="text-text-secondary mt-1 text-sm">
              Time window: {item.timeWindow}
            </p>
            {item.explanation.why.length > 0 ||
            item.explanation.escalationTrigger.length > 0 ? (
              <div className="mt-3">
                <button
                  type="button"
                  className="suggestion-chip"
                  onClick={() => {
                    const next = openDetailIndex === idx ? null : idx;
                    setOpenDetailIndex(next);
                    if (next !== null) {
                      captureEvent("recommendation_details_viewed", {
                        recommendation_index: idx,
                        has_why: item.explanation.why.length > 0,
                        has_trigger:
                          item.explanation.escalationTrigger.length > 0,
                      });
                    }
                  }}
                >
                  {openDetailIndex === idx
                    ? "Hide why & trigger"
                    : "Show why & trigger"}
                </button>

                {openDetailIndex === idx ? (
                  <div className="border-surface-3 bg-surface-1 mt-3 space-y-2 rounded-md border p-3">
                    {item.explanation.why.length > 0 ? (
                      <p className="text-text-primary text-sm">
                        Why: {item.explanation.why.slice(0, 2).join("; ")}
                      </p>
                    ) : null}

                    {item.explanation.escalationTrigger.length > 0 ? (
                      <p className="text-text-primary text-sm">
                        Trigger: {item.explanation.escalationTrigger}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}

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
                        evidence_refs_shown_count:
                          item.evidence?.topRefs.length ?? 0,
                        contains_quote_snippets: true,
                      });
                    }
                  }}
                >
                  {openEvidenceIndex === idx
                    ? "Hide evidence"
                    : "Show evidence"}
                </button>

                {openEvidenceIndex === idx ? (
                  <div className="border-surface-3 bg-surface-1 mt-3 space-y-2 rounded-md border p-3">
                    {item.evidence.topRefs.map((ref) => (
                      <div
                        key={ref.reviewIdOrHash}
                        className="text-text-primary text-sm"
                      >
                        <p>“{ref.excerpt}”</p>
                        <p className="text-text-secondary mt-1 text-xs">
                          {new Date(ref.publishTime).toLocaleDateString()} ·
                          rating {ref.rating ?? "n/a"} · {ref.theme}
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
