import {
  type CardType,
  type ClosureSignal,
  type DoeSignal,
  type Recommendation,
  type ReviewEvidenceRef,
  type ReviewSignals,
  type VenueEventSignal,
  type WeatherSignal,
} from "@/server/services/intelligence/types";

interface LocationInputs {
  locationLabel: string;
  weather?: WeatherSignal;
  events?: VenueEventSignal[];
  closures?: ClosureSignal[];
  review?: ReviewSignals;
  baselineFoh?: number;
  baselineAssumed?: boolean;
}

interface DoeModifier {
  date: string;
  eventType: string;
  weekday: string;
}

export interface GuestSnapshot {
  locationLabel: string;
  text: string;
  sampleReviewCount: number;
  recencyWindowDays: number;
  confidence: "low" | "medium" | "high";
}

export interface RecommendationEngineOutput {
  summary: string;
  recommendations: Recommendation[];
  snapshots: GuestSnapshot[];
}

const THEME_MIN_COUNT = 2;
const THEME_MIN_SHARE = 0.3;

function humanizeTheme(theme: string): string {
  return theme.replaceAll("_", " ");
}

function sortedThemes(
  review: ReviewSignals,
): Array<[ReviewEvidenceRef["theme"], number]> {
  return (
    Object.entries(review.themes) as Array<[ReviewEvidenceRef["theme"], number]>
  )
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
}

function strongestOperationalTheme(
  review: ReviewSignals,
): ReviewEvidenceRef["theme"] | null {
  const entries = sortedThemes(review);
  const candidate = entries.find(([theme]) => theme !== "other");
  if (!candidate) return null;

  const [theme, count] = candidate;
  if (count < THEME_MIN_COUNT) return null;
  if (count / Math.max(review.evidenceCount, 1) < THEME_MIN_SHARE) return null;
  return theme;
}

function mapCardIntro(cardType: CardType): string {
  if (cardType === "risk") {
    return "Next 3 days risk signals for your locations:";
  }
  if (cardType === "opportunity") {
    return "Next 3 days opportunity signals for your locations:";
  }
  return "Next 3 days staffing and prep signals for your locations:";
}

function firstDoeModifier(days: DoeSignal[]): DoeModifier | null {
  const row = days.find((day) => {
    if (day.isSchoolDay) return false;
    if (day.eventType.toLowerCase().includes("weekend")) return false;
    const weekday = new Date(`${day.date}T00:00:00`).getDay();
    return weekday >= 1 && weekday <= 5;
  });
  if (!row) return null;

  const day = new Date(`${row.date}T00:00:00`);
  const weekday = day.toLocaleDateString("en-US", { weekday: "short" });
  const eventType = row.eventType.replaceAll("_", " ");

  return {
    date: row.date,
    eventType,
    weekday,
  };
}

function doeSignalLine(doeModifier: DoeModifier): string {
  return `NYC DOE marks ${doeModifier.eventType} on ${doeModifier.weekday}, which can shift midday-to-dinner demand mix`;
}

function buildEventRecommendation(
  input: LocationInputs,
  doeModifier: DoeModifier | null,
): Recommendation | null {
  const event = input.events?.[0];
  if (!event) return null;

  const impactStart = new Date(event.impactStartAt);
  const impactEnd = new Date(event.impactEndAt);
  const timeWindow = `${impactStart.toLocaleDateString("en-US", { weekday: "short" })} ${impactStart.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}-${impactEnd.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;

  let action = `${timeWindow}: +1-2 FOH at ${input.locationLabel}`;
  const why = [
    `${event.eventName} at ${event.venueName} increases nearby foot traffic`,
  ];
  const eventDate = event.startAt.slice(0, 10);
  const doeApplies = doeModifier?.date === eventDate;

  if (input.review && input.review.evidenceCount > 0) {
    const primaryTheme = strongestOperationalTheme(input.review);
    if (primaryTheme === "wait_time" || primaryTheme === "host_queue") {
      action = `${timeWindow}: add 1 host + 1 FOH floater at ${input.locationLabel}`;
      why.push(
        "Recent guest feedback flags wait/host pressure during peak windows",
      );
    }
  }

  if (doeApplies) {
    if (action.includes("+1-2 FOH")) {
      action = action.replace("+1-2 FOH", "+1-2 FOH + 1 flex runner");
    } else {
      action = `${action} + keep 1 flex runner`;
    }
    why.push(doeSignalLine(doeModifier));
  }

  const baselineText = input.baselineFoh
    ? `Baseline ${input.baselineFoh} FOH at ${input.locationLabel}`
    : "Baseline staffing not provided";

  return {
    locationLabel: input.locationLabel,
    action,
    timeWindow,
    confidence: input.baselineAssumed ? "medium" : "high",
    sourceName: input.review ? "reviews" : "events",
    evidence: input.review
      ? {
          evidenceCount: input.review.evidenceCount,
          recencyWindowDays: input.review.recencyWindowDays,
          topRefs: input.review.topRefs,
        }
      : undefined,
    explanation: {
      baselineAssumption: baselineText,
      why,
      deltaReasoning:
        input.baselineFoh !== undefined
          ? `With baseline ${input.baselineFoh}, adding coverage protects throughput during event overlap.`
          : "Adding coverage protects throughput in the event window.",
      escalationTrigger:
        "Move to the upper staffing range if quoted wait exceeds 15 minutes by 6:30pm.",
    },
    reviewBacked: Boolean(input.review && input.review.evidenceCount > 0),
  };
}

function buildClosureRecommendation(
  input: LocationInputs,
): Recommendation | null {
  const closure = input.closures?.[0];
  if (!closure) return null;

  const timeWindow = `${closure.startAt ? new Date(closure.startAt).toLocaleDateString("en-US", { weekday: "short" }) : "Next day"} AM window`;

  return {
    locationLabel: input.locationLabel,
    action: `${timeWindow}: move delivery before closure window at ${input.locationLabel}`,
    timeWindow,
    confidence: "high",
    sourceName: "closures",
    explanation: {
      why: [
        `${closure.title}${closure.street ? ` on ${closure.street}` : ""} can block or slow access`,
      ],
      deltaReasoning:
        "Shifting delivery timing reduces service disruption risk.",
      escalationTrigger:
        "If vendors confirm delay risk, reroute deliveries to alternate windows.",
    },
    reviewBacked: false,
  };
}

function buildWeatherRecommendation(
  input: LocationInputs,
): Recommendation | null {
  if (!input.weather) return null;

  if (!input.weather.rainLikely && !input.weather.tempExtremeLikely)
    return null;

  const timeWindow = input.weather.rainWindow
    ? `${new Date(input.weather.rainWindow).toLocaleDateString("en-US", { weekday: "short" })} service window`
    : "Next 72h";

  const reason = input.weather.rainLikely
    ? "Rain probability is elevated during service hours"
    : "Feels-like temperature is extreme during peak periods";

  return {
    locationLabel: input.locationLabel,
    action: `${timeWindow}: rebalance FOH for weather-driven traffic shifts at ${input.locationLabel}`,
    timeWindow,
    confidence: "medium",
    sourceName: "weather",
    explanation: {
      why: [reason],
      deltaReasoning:
        "Weather volatility can shift dine-in behavior and pacing.",
      escalationTrigger:
        "If precipitation begins before peak, rebalance FOH to indoor sections.",
    },
    reviewBacked: false,
  };
}

function priorityByCard(cardType: CardType, rec: Recommendation): number {
  if (cardType === "risk") {
    if (rec.sourceName === "closures") return 100;
    if (rec.sourceName === "weather") return 90;
    if (rec.sourceName === "events") return 80;
    if (rec.sourceName === "doe") return 60;
    if (rec.sourceName === "reviews") return 40;
    return 0;
  }

  if (cardType === "opportunity") {
    if (rec.sourceName === "events") return 100;
    if (rec.sourceName === "reviews") return 90;
    if (rec.sourceName === "doe") return 70;
    if (rec.sourceName === "weather") return 30;
    if (rec.sourceName === "closures") return 10;
    return 0;
  }

  if (rec.sourceName === "events") return 100;
  if (rec.sourceName === "closures") return 90;
  if (rec.sourceName === "weather") return 80;
  if (rec.sourceName === "doe") return 70;
  if (rec.sourceName === "reviews") return 60;
  return 0;
}

function buildDoeRecommendation(
  input: LocationInputs,
  doeModifier: DoeModifier,
): Recommendation {
  const timeWindow = `${doeModifier.weekday} lunch (11am-2pm)`;
  return {
    locationLabel: input.locationLabel,
    action: `${timeWindow}: keep 1 flex FOH at ${input.locationLabel} and move non-urgent prep before 10am`,
    timeWindow,
    confidence: "medium",
    sourceName: "doe",
    explanation: {
      why: [
        doeSignalLine(doeModifier),
        "Weekday school-calendar shifts can change lunchtime traffic and pickup mix.",
      ],
      deltaReasoning:
        "A flex role protects throughput while avoiding overstaffing.",
      escalationTrigger:
        "Escalate +1 FOH if lunch queue exceeds normal pace by noon.",
    },
    reviewBacked: false,
  };
}

function buildReviewOnlyRecommendation(
  input: LocationInputs,
): Recommendation | null {
  const review = input.review;
  if (!review || review.evidenceCount < 3) return null;

  const dominantTheme = strongestOperationalTheme(review);
  const timeWindow = "Next 3 days peak windows";
  return {
    locationLabel: input.locationLabel,
    action: `${timeWindow}: run a host/FOH throughput check every 15 min at ${input.locationLabel}`,
    timeWindow,
    confidence: dominantTheme ? review.confidence : "low",
    sourceName: "reviews",
    evidence: {
      evidenceCount: review.evidenceCount,
      recencyWindowDays: review.recencyWindowDays,
      topRefs: review.topRefs,
    },
    explanation: {
      why: dominantTheme
        ? [
            `Guest reviews repeatedly reference ${humanizeTheme(dominantTheme)} friction.`,
          ]
        : [
            "Recent review mentions are mixed, with no single dominant friction theme.",
          ],
      deltaReasoning:
        "Monitoring and quick staffing adjustments reduce repeat complaint patterns.",
      escalationTrigger:
        "Escalate +1 FOH if queue or quoted wait rises above normal baseline.",
    },
    reviewBacked: true,
  };
}

function buildSnapshot(
  locationLabel: string,
  review: ReviewSignals,
): GuestSnapshot {
  const dominantTheme = strongestOperationalTheme(review);
  const operationsLine = dominantTheme
    ? `Operationally, this points to pressure around ${humanizeTheme(dominantTheme)} patterns in peak periods.`
    : "Operationally, evidence is mixed, so keep standard monitoring unless live service signals rise.";

  return {
    locationLabel,
    text: `${review.guestSnapshot} ${operationsLine}`,
    sampleReviewCount: review.sampleReviewCount,
    recencyWindowDays: review.recencyWindowDays,
    confidence: review.confidence,
  };
}

export function buildRecommendations(
  cardType: CardType,
  inputs: LocationInputs[],
  options?: {
    doeDays?: DoeSignal[];
  },
): RecommendationEngineOutput {
  const recommendations: Recommendation[] = [];
  const snapshots: GuestSnapshot[] = [];
  const doeModifier = firstDoeModifier(options?.doeDays ?? []);

  for (const input of inputs) {
    if (input.review && input.review.evidenceCount > 0) {
      snapshots.push(buildSnapshot(input.locationLabel, input.review));
    }

    const closureRec = buildClosureRecommendation(input);
    if (closureRec) recommendations.push(closureRec);

    const eventRec = buildEventRecommendation(input, doeModifier);
    if (eventRec) recommendations.push(eventRec);

    const weatherRec = buildWeatherRecommendation(input);
    if (weatherRec) recommendations.push(weatherRec);

    if (!closureRec && !eventRec && doeModifier) {
      recommendations.push(buildDoeRecommendation(input, doeModifier));
    }

    if (!closureRec && !eventRec && !weatherRec && !doeModifier) {
      const reviewRec = buildReviewOnlyRecommendation(input);
      if (reviewRec) {
        recommendations.push(reviewRec);
      }
    }
  }

  if (recommendations.length === 0) {
    recommendations.push({
      locationLabel: inputs[0]?.locationLabel ?? "your locations",
      action:
        "Next 24h: run standard staffing and prep, keep delivery timing flexible, and recheck in 30 minutes",
      timeWindow: "Next 24h",
      confidence: "low",
      sourceName: "system",
      explanation: {
        why: ["No high-signal external factors are currently available."],
        deltaReasoning:
          "Conservative operating posture minimizes disruption risk under uncertainty.",
        escalationTrigger: "Re-run checks when new external signals arrive.",
      },
      reviewBacked: false,
    });
  }

  recommendations.sort((a, b) => {
    const delta = priorityByCard(cardType, b) - priorityByCard(cardType, a);
    if (delta !== 0) return delta;
    if (a.confidence !== b.confidence) {
      const score = { high: 3, medium: 2, low: 1 } as const;
      return score[b.confidence] - score[a.confidence];
    }
    return a.locationLabel.localeCompare(b.locationLabel);
  });

  const summaryLines = [mapCardIntro(cardType)];
  const summaryCap = cardType === "opportunity" ? 3 : 4;
  for (const recommendation of recommendations.slice(0, summaryCap)) {
    summaryLines.push(
      `- ${recommendation.action} (${recommendation.confidence})`,
    );
  }

  return {
    summary: summaryLines.join("\n"),
    recommendations,
    snapshots,
  };
}
