export type CardType = "staffing" | "risk" | "opportunity";

export interface ResolvedLocation {
  input: string;
  label: string;
  placeId: string;
  address: string;
  lat: number;
  lon: number;
  isNyc: boolean;
}

export interface SourceStatus {
  status: "ok" | "error" | "stale" | "timeout";
  freshnessSeconds?: number;
  cacheHit?: boolean;
  errorCode?: string;
}

export interface ToolResult<T> {
  data: T;
  status: SourceStatus;
  latencyMs: number;
}

export interface VenueEventSignal {
  venueId: string;
  venueName: string;
  eventName: string;
  startAt: string;
  impactStartAt: string;
  impactEndAt: string;
  distanceMiles: number;
}

export interface WeatherSignal {
  locationLabel: string;
  rainLikely: boolean;
  rainWindow: string | null;
  tempExtremeLikely: boolean;
  tempWindow: string | null;
}

export interface ClosureSignal {
  locationLabel: string;
  title: string;
  startAt?: string;
  endAt?: string;
  street?: string;
}

export interface DoeSignal {
  date: string;
  eventType: string;
  isSchoolDay: boolean;
}

export interface ReviewEvidenceRef {
  source: "google_reviews";
  placeId: string;
  reviewIdOrHash: string;
  publishTime: string;
  rating?: number;
  theme:
    | "wait_time"
    | "service_speed"
    | "host_queue"
    | "kitchen_delay"
    | "other";
  excerpt?: string;
}

export interface ReviewSignals {
  placeId: string;
  sampleReviewCount: number;
  evidenceCount: number;
  recencyWindowDays: number;
  themes: Record<string, number>;
  topRefs: ReviewEvidenceRef[];
  guestSnapshot: string;
  confidence: "low" | "medium" | "high";
}

export interface Recommendation {
  locationLabel: string;
  action: string;
  timeWindow: string;
  confidence: "low" | "medium" | "high";
  sourceName: "weather" | "events" | "closures" | "doe" | "reviews" | "system";
  sourceFreshnessSeconds?: number;
  evidence?: {
    evidenceCount: number;
    recencyWindowDays: number;
    topRefs: ReviewEvidenceRef[];
  };
  explanation: {
    baselineAssumption?: string;
    why: string[];
    deltaReasoning: string;
    escalationTrigger: string;
  };
  reviewBacked: boolean;
}
