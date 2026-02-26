import { type CardType, type ClosureSignal, type DoeSignal, type Recommendation, type ReviewSignals, type VenueEventSignal, type WeatherSignal } from "@/server/services/intelligence/types";

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

function topTheme(review: ReviewSignals): string {
  const entries = Object.entries(review.themes).sort((a, b) => b[1] - a[1]);
  return entries[0]?.[0]?.replaceAll("_", " ") ?? "service";
}

function secondTheme(review: ReviewSignals): string {
  const entries = Object.entries(review.themes).sort((a, b) => b[1] - a[1]);
  return entries[1]?.[0]?.replaceAll("_", " ") ?? "wait time";
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
  const row = days.find((day) => !day.isSchoolDay);
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

function buildEventRecommendation(input: LocationInputs, doeModifier: DoeModifier | null): Recommendation | null {
  const event = input.events?.[0];
  if (!event) return null;

  const impactStart = new Date(event.impactStartAt);
  const impactEnd = new Date(event.impactEndAt);
  const timeWindow = `${impactStart.toLocaleDateString("en-US", { weekday: "short" })} ${impactStart.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}-${impactEnd.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;

  let action = `${timeWindow}: +1-2 FOH at ${input.locationLabel}`;
  const why = [`${event.eventName} at ${event.venueName} increases nearby foot traffic`];
  const eventDate = event.startAt.slice(0, 10);
  const doeApplies = doeModifier?.date === eventDate;

  if (input.review && input.review.evidenceCount > 0) {
    const primaryTheme = topTheme(input.review);
    if (primaryTheme.includes("wait") || primaryTheme.includes("host")) {
      action = `${timeWindow}: add 1 host + 1 FOH floater at ${input.locationLabel}`;
      why.push("Recent guest feedback flags wait/host pressure during peak windows");
    }
  }

  if (doeApplies) {
    if (action.includes("+1-2 FOH")) {
      action = action.replace("+1-2 FOH", "+1-2 FOH + 1 flex runner");
    } else {
      action = `${action} + keep 1 flex runner`;
    }
    why.push(`NYC DOE marks ${doeModifier.eventType} on ${doeModifier.weekday}, which can shift midday-to-dinner demand mix`);
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
      escalationTrigger: "Move to the upper staffing range if quoted wait exceeds 15 minutes by 6:30pm.",
    },
    reviewBacked: Boolean(input.review && input.review.evidenceCount > 0),
  };
}

function buildClosureRecommendation(input: LocationInputs): Recommendation | null {
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
      deltaReasoning: "Shifting delivery timing reduces service disruption risk.",
      escalationTrigger: "If vendors confirm delay risk, reroute deliveries to alternate windows.",
    },
    reviewBacked: false,
  };
}

function buildWeatherRecommendation(input: LocationInputs): Recommendation | null {
  if (!input.weather) return null;

  if (!input.weather.rainLikely && !input.weather.tempExtremeLikely) return null;

  const timeWindow = input.weather.rainWindow
    ? `${new Date(input.weather.rainWindow).toLocaleDateString("en-US", { weekday: "short" })} service window`
    : "Next 72h";

  const reason = input.weather.rainLikely
    ? "Rain probability is elevated during service hours"
    : "Feels-like temperature is extreme during peak periods";

  return {
    locationLabel: input.locationLabel,
    action: `${timeWindow}: reduce patio/prep exposure and bias staffing indoors at ${input.locationLabel}`,
    timeWindow,
    confidence: "medium",
    sourceName: "weather",
    explanation: {
      why: [reason],
      deltaReasoning: "Weather volatility can shift dine-in behavior and pacing.",
      escalationTrigger: "If precipitation begins before peak, rebalance FOH to indoor sections.",
    },
    reviewBacked: false,
  };
}

function buildDoeRecommendation(input: LocationInputs, doeModifier: DoeModifier): Recommendation {
  const timeWindow = `${doeModifier.weekday} lunch (11am-2pm)`;
  return {
    locationLabel: input.locationLabel,
    action: `${timeWindow}: keep 1 flex FOH at ${input.locationLabel} and move non-urgent prep before 10am`,
    timeWindow,
    confidence: "medium",
    sourceName: "doe",
    explanation: {
      why: [
        `NYC DOE calendar marks ${doeModifier.eventType} on ${doeModifier.weekday}.`,
        "School-day schedule shifts can change lunchtime pacing and family order mix.",
      ],
      deltaReasoning: "A flex role protects throughput while avoiding overstaffing.",
      escalationTrigger: "Escalate +1 FOH if lunch queue exceeds normal pace by noon.",
    },
    reviewBacked: false,
  };
}

function buildReviewOnlyRecommendation(input: LocationInputs): Recommendation | null {
  const review = input.review;
  if (!review || review.evidenceCount < 3) return null;

  const dominantTheme = topTheme(review);
  const timeWindow = "Next 3 days peak windows";
  return {
    locationLabel: input.locationLabel,
    action: `${timeWindow}: run a host/FOH throughput check every 15 min at ${input.locationLabel}`,
    timeWindow,
    confidence: review.confidence,
    sourceName: "reviews",
    evidence: {
      evidenceCount: review.evidenceCount,
      recencyWindowDays: review.recencyWindowDays,
      topRefs: review.topRefs,
    },
    explanation: {
      why: [`Guest reviews repeatedly reference ${dominantTheme} friction.`],
      deltaReasoning: "Monitoring and quick staffing adjustments reduce repeat complaint patterns.",
      escalationTrigger: "Escalate +1 FOH if queue or quoted wait rises above normal baseline.",
    },
    reviewBacked: true,
  };
}

function buildSnapshot(locationLabel: string, review: ReviewSignals): GuestSnapshot {
  return {
    locationLabel,
    text:
      `${review.guestSnapshot} Operationally, this points to pressure around ${secondTheme(review)} patterns in peak periods.`,
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
    competitorSnapshot?: string;
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
        deltaReasoning: "Conservative operating posture minimizes disruption risk under uncertainty.",
        escalationTrigger: "Re-run checks when new external signals arrive.",
      },
      reviewBacked: false,
    });
  }

  const summaryLines = [mapCardIntro(cardType)];
  for (const recommendation of recommendations.slice(0, 4)) {
    summaryLines.push(`- ${recommendation.action} (${recommendation.confidence})`);
  }
  if (options?.competitorSnapshot) {
    summaryLines.push(options.competitorSnapshot);
  }

  return {
    summary: summaryLines.join("\n"),
    recommendations,
    snapshots,
  };
}
