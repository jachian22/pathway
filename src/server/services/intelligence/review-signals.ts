import { createHash } from "node:crypto";

import { getPlaceDetails } from "@/server/services/google-places";
import {
  REVIEW_OLD_THRESHOLD_DAYS,
  REVIEW_RECENCY_WINDOW_DAYS,
  SOURCE_TIMEOUTS_MS,
} from "@/server/services/intelligence/constants";
import { type ReviewEvidenceRef, type ReviewSignals } from "@/server/services/intelligence/types";
import { truncateSnippet, withTimeout } from "@/server/services/intelligence/utils";

interface ReviewInput {
  name?: string;
  publishTime?: string;
  rating?: number;
  text?: { text?: string };
}

function classifyTheme(text: string): ReviewEvidenceRef["theme"] {
  const value = text.toLowerCase();
  if (/(wait|line|queued|queue|seated)/.test(value)) return "wait_time";
  if (/(slow service|service slow|took forever|server)/.test(value)) return "service_speed";
  if (/(host|front desk|check in|reservation)/.test(value)) return "host_queue";
  if (/(kitchen|food took|cold food|hot food)/.test(value)) return "kitchen_delay";
  return "other";
}

function isRecent(publishTime?: string, recencyWindowDays = REVIEW_RECENCY_WINDOW_DAYS): boolean {
  if (!publishTime) return false;
  const publishedAt = new Date(publishTime);
  if (Number.isNaN(publishedAt.getTime())) return false;
  const threshold = new Date();
  threshold.setDate(threshold.getDate() - recencyWindowDays);
  return publishedAt >= threshold;
}

function hashRef(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export async function buildReviewSignals(placeId: string): Promise<ReviewSignals | null> {
  try {
    const details = await withTimeout(getPlaceDetails(placeId), SOURCE_TIMEOUTS_MS.reviews);
    const reviews = ((details.reviews ?? []) as ReviewInput[]).filter((review) =>
      isRecent(review.publishTime),
    );

    const themes: Record<string, number> = {
      wait_time: 0,
      service_speed: 0,
      host_queue: 0,
      kitchen_delay: 0,
      other: 0,
    };

    const refs: ReviewEvidenceRef[] = [];

    for (const review of reviews) {
      const text = review.text?.text ?? "";
      if (!text) continue;

      const theme = classifyTheme(text);
      themes[theme] = (themes[theme] ?? 0) + 1;

      const refId = review.name ? hashRef(review.name) : hashRef(`${placeId}:${text}:${review.publishTime}`);
      refs.push({
        source: "google_reviews",
        placeId,
        reviewIdOrHash: refId,
        publishTime: review.publishTime ?? new Date().toISOString(),
        rating: review.rating,
        theme,
        excerpt: truncateSnippet(text),
      });
    }

    const evidenceCount = refs.length;
    if (evidenceCount === 0) {
      return {
        placeId,
        sampleReviewCount: reviews.length,
        evidenceCount: 0,
        recencyWindowDays: REVIEW_RECENCY_WINDOW_DAYS,
        themes,
        topRefs: [],
        guestSnapshot:
          "Quick read: there is not enough recent review evidence to call a clear operational pattern yet.",
        confidence: "low",
      };
    }

    const sortedThemes = Object.entries(themes)
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1]);

    const topTheme = sortedThemes[0]?.[0] ?? "service_speed";
    const topIssue = sortedThemes.find(([name]) => name !== topTheme)?.[0] ?? "wait_time";

    const recentDates = refs
      .map((ref) => new Date(ref.publishTime))
      .filter((date) => !Number.isNaN(date.getTime()));

    let confidence: ReviewSignals["confidence"] = "medium";
    if (evidenceCount < 3) confidence = "low";
    if (
      recentDates.length > 0 &&
      recentDates.every((date) => {
        const threshold = new Date();
        threshold.setDate(threshold.getDate() - REVIEW_OLD_THRESHOLD_DAYS);
        return date < threshold;
      })
    ) {
      confidence = "low";
    }

    const topRefs = refs
      .sort((a, b) => {
        const diff = new Date(b.publishTime).getTime() - new Date(a.publishTime).getTime();
        return Number.isNaN(diff) ? 0 : diff;
      })
      .slice(0, 3);

    const guestSnapshot =
      `Quick read on what guests are saying: strongest praise trends around ${topTheme.replace("_", " ")}, ` +
      `while friction most often shows up in ${topIssue.replace("_", " ")} mentions.`;

    return {
      placeId,
      sampleReviewCount: reviews.length,
      evidenceCount,
      recencyWindowDays: REVIEW_RECENCY_WINDOW_DAYS,
      themes,
      topRefs,
      guestSnapshot,
      confidence,
    };
  } catch {
    return null;
  }
}
