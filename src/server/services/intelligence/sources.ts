import { and, gte, lte } from "drizzle-orm";

import type { DbClient } from "@/server/db";
import { doeCalendarDays } from "@/server/db/schema";
import { searchEvents } from "@/server/services/ticketmaster";
import { getForecast } from "@/server/services/weather";
import { fetchDotClosuresNearby } from "@/server/services/nyc-dot";
import {
  IMPACT_VENUES,
  SOURCE_TIMEOUTS_MS,
  REVIEW_RECENCY_WINDOW_DAYS,
} from "@/server/services/intelligence/constants";
import { readCache, writeCache } from "@/server/services/intelligence/cache";
import { buildReviewSignals } from "@/server/services/intelligence/review-signals";
import {
  type ClosureSignal,
  type DoeSignal,
  type ResolvedLocation,
  type ReviewSignals,
  type SourceStatus,
  type VenueEventSignal,
  type WeatherSignal,
} from "@/server/services/intelligence/types";
import {
  toDatePlusDays,
  toIso,
  toMiles,
  withTimeout,
} from "@/server/services/intelligence/utils";

export interface SourceBundle {
  weather: { byLocation: Record<string, WeatherSignal>; status: SourceStatus };
  events: {
    byLocation: Record<string, VenueEventSignal[]>;
    status: SourceStatus;
  };
  closures: {
    byLocation: Record<string, ClosureSignal[]>;
    status: SourceStatus;
  };
  doe: { days: DoeSignal[]; status: SourceStatus };
  reviews: { byLocation: Record<string, ReviewSignals>; status: SourceStatus };
  competitorReview: ReviewSignals | null;
}

interface TicketmasterEventLite {
  name: string;
  dates: {
    start: {
      localDate?: string;
      localTime?: string;
    };
  };
}

interface VenueEventsResult {
  venue: (typeof IMPACT_VENUES)[number];
  events: TicketmasterEventLite[];
}

function statusFromError(error: unknown): SourceStatus {
  if (error instanceof Error && error.message.includes("timeout")) {
    return { status: "timeout" };
  }
  return { status: "error" };
}

function ageSeconds(fetchedAtMs: number): number {
  return Math.max(0, Math.floor((Date.now() - fetchedAtMs) / 1000));
}

function makeWeatherSignal(
  locationLabel: string,
  forecasts: Awaited<ReturnType<typeof getForecast>>,
): WeatherSignal {
  const rainy = forecasts.list.find((item) => item.pop >= 0.6);
  const extreme = forecasts.list.find(
    (item) => item.main.feels_like <= 35 || item.main.feels_like >= 90,
  );

  return {
    locationLabel,
    rainLikely: !!rainy,
    rainWindow: rainy?.dt_txt ?? null,
    tempExtremeLikely: !!extreme,
    tempWindow: extreme?.dt_txt ?? null,
  };
}

export async function fetchWeatherSource(
  locations: ResolvedLocation[],
): Promise<{
  byLocation: Record<string, WeatherSignal>;
  status: SourceStatus;
}> {
  const cacheKey = `weather:${locations.map((loc) => loc.placeId).join(",")}:${new Date().toISOString().slice(0, 10)}`;
  const cached = readCache<Record<string, WeatherSignal>>(cacheKey);
  if (cached) {
    return {
      byLocation: cached.value,
      status: {
        status: "ok",
        freshnessSeconds: ageSeconds(cached.fetchedAtMs),
        cacheHit: true,
      },
    };
  }

  try {
    const entries = await Promise.all(
      locations.map(async (location) => {
        const forecast = await withTimeout(
          getForecast(location.lat, location.lon, "imperial"),
          SOURCE_TIMEOUTS_MS.weather,
        );
        return [
          location.label,
          makeWeatherSignal(location.label, forecast),
        ] as const;
      }),
    );

    const byLocation = Object.fromEntries(entries);
    writeCache(cacheKey, byLocation, 3 * 60 * 60 * 1000);

    return {
      byLocation,
      status: {
        status: "ok",
        freshnessSeconds: 0,
        cacheHit: false,
      },
    };
  } catch (error) {
    return {
      byLocation: {},
      status: statusFromError(error),
    };
  }
}

function toEventDateTime(localDate?: string, localTime?: string): Date {
  if (!localDate) return new Date();
  const iso = `${localDate}T${localTime ?? "19:00:00"}`;
  return new Date(iso);
}

export async function fetchEventsSource(
  locations: ResolvedLocation[],
): Promise<{
  byLocation: Record<string, VenueEventSignal[]>;
  status: SourceStatus;
}> {
  const cacheKey = `events:${new Date().toISOString().slice(0, 10)}`;
  const cached = readCache<Record<string, VenueEventSignal[]>>(cacheKey);
  if (cached) {
    return {
      byLocation: cached.value,
      status: {
        status: "ok",
        freshnessSeconds: ageSeconds(cached.fetchedAtMs),
        cacheHit: true,
      },
    };
  }

  try {
    const start = toIso(new Date());
    const end = toIso(toDatePlusDays(3));

    const venueResults = await Promise.allSettled(
      IMPACT_VENUES.map(async (venue) => {
        const response = await withTimeout(
          searchEvents({
            keyword: venue.name,
            city: "New York",
            stateCode: "NY",
            startDateTime: start,
            endDateTime: end,
            size: 8,
            page: 0,
            sort: "date,asc",
          }),
          SOURCE_TIMEOUTS_MS.events,
        );

        return {
          venue,
          events: (response._embedded?.events ?? []) as TicketmasterEventLite[],
        };
      }),
    );

    const successfulResponses = venueResults
      .filter(
        (result): result is PromiseFulfilledResult<VenueEventsResult> =>
          result.status === "fulfilled",
      )
      .map((result) => result.value);
    const failedCount = venueResults.length - successfulResponses.length;

    const byLocation: Record<string, VenueEventSignal[]> = Object.fromEntries(
      locations.map((location) => [location.label, [] as VenueEventSignal[]]),
    );

    if (successfulResponses.length === 0) {
      return {
        byLocation,
        status: {
          status: "error",
          errorCode: "EVENTS_UNAVAILABLE",
        },
      };
    }

    for (const location of locations) {
      const locationEvents = byLocation[location.label] ?? [];
      for (const venueResult of successfulResponses) {
        const distanceMiles = toMiles(
          location.lat,
          location.lon,
          venueResult.venue.lat,
          venueResult.venue.lon,
        );
        if (distanceMiles > venueResult.venue.impactRadiusMiles) continue;

        for (const event of venueResult.events) {
          const startAt = toEventDateTime(
            event.dates.start.localDate,
            event.dates.start.localTime,
          );
          const impactStartAt = new Date(
            startAt.getTime() - 2 * 60 * 60 * 1000,
          );
          const impactEndAt = new Date(startAt.getTime() + 60 * 60 * 1000);

          locationEvents.push({
            venueId: venueResult.venue.id,
            venueName: venueResult.venue.name,
            eventName: event.name,
            startAt: startAt.toISOString(),
            impactStartAt: impactStartAt.toISOString(),
            impactEndAt: impactEndAt.toISOString(),
            distanceMiles,
          });
        }
      }
    }

    writeCache(cacheKey, byLocation, 12 * 60 * 60 * 1000);

    return {
      byLocation,
      status: {
        status: failedCount > 0 ? "stale" : "ok",
        freshnessSeconds: 0,
        cacheHit: false,
        ...(failedCount > 0 ? { errorCode: "EVENTS_PARTIAL" } : {}),
      },
    };
  } catch (error) {
    return {
      byLocation: {},
      status: statusFromError(error),
    };
  }
}

export async function fetchClosuresSource(
  locations: ResolvedLocation[],
): Promise<{
  byLocation: Record<string, ClosureSignal[]>;
  status: SourceStatus;
}> {
  const cacheKey = `closures:${new Date().toISOString().slice(0, 10)}:${locations.map((loc) => loc.placeId).join(",")}`;
  const cached = readCache<Record<string, ClosureSignal[]>>(cacheKey);
  if (cached) {
    return {
      byLocation: cached.value,
      status: {
        status: "ok",
        freshnessSeconds: ageSeconds(cached.fetchedAtMs),
        cacheHit: true,
      },
    };
  }

  try {
    const byLocation: Record<string, ClosureSignal[]> = {};
    await Promise.all(
      locations.map(async (location) => {
        const closures = await withTimeout(
          fetchDotClosuresNearby({
            lat: location.lat,
            lon: location.lon,
            radiusMiles: 0.6,
            limit: 100,
          }),
          SOURCE_TIMEOUTS_MS.closures,
        );

        byLocation[location.label] = closures.slice(0, 5).map((closure) => ({
          locationLabel: location.label,
          title: closure.title,
          startAt: closure.startAt,
          endAt: closure.endAt,
          street: closure.street,
        }));
      }),
    );

    writeCache(cacheKey, byLocation, 6 * 60 * 60 * 1000);

    return {
      byLocation,
      status: {
        status: "ok",
        freshnessSeconds: 0,
        cacheHit: false,
      },
    };
  } catch (error) {
    return {
      byLocation: {},
      status: statusFromError(error),
    };
  }
}

export async function fetchDoeSource(
  dbClient: DbClient,
): Promise<{ days: DoeSignal[]; status: SourceStatus }> {
  try {
    const now = new Date();
    const end = toDatePlusDays(3);

    const rows = await withTimeout(
      dbClient
        .select({
          date: doeCalendarDays.calendarDate,
          eventType: doeCalendarDays.eventType,
          isSchoolDay: doeCalendarDays.isSchoolDay,
          sourceUpdatedAt: doeCalendarDays.sourceUpdatedAt,
        })
        .from(doeCalendarDays)
        .where(
          and(
            gte(doeCalendarDays.calendarDate, now.toISOString().slice(0, 10)),
            lte(doeCalendarDays.calendarDate, end.toISOString().slice(0, 10)),
          ),
        )
        .orderBy(doeCalendarDays.calendarDate),
      SOURCE_TIMEOUTS_MS.doe,
    );

    if (rows.length === 0) {
      return {
        days: [],
        status: {
          status: "stale",
          errorCode: "DOE_EMPTY",
        },
      };
    }

    const freshnessSeconds = rows[0]?.sourceUpdatedAt
      ? Math.floor(
          (Date.now() - new Date(rows[0].sourceUpdatedAt).getTime()) / 1000,
        )
      : undefined;
    const stale =
      freshnessSeconds !== undefined && freshnessSeconds > 7 * 24 * 60 * 60;

    return {
      days: rows.map((row) => ({
        date: String(row.date),
        eventType: row.eventType,
        isSchoolDay: row.isSchoolDay,
      })),
      status: {
        status: stale ? "stale" : "ok",
        freshnessSeconds,
        ...(stale ? { errorCode: "DOE_STALE" } : {}),
      },
    };
  } catch (error) {
    return {
      days: [],
      status: statusFromError(error),
    };
  }
}

export async function fetchReviewsSource(
  locations: ResolvedLocation[],
  competitorPlaceId?: string,
): Promise<{
  byLocation: Record<string, ReviewSignals>;
  competitorReview: ReviewSignals | null;
  status: SourceStatus;
}> {
  const cacheKey = `reviews:${locations.map((loc) => loc.placeId).join(",")}:${competitorPlaceId ?? "none"}`;
  const cached = readCache<{
    byLocation: Record<string, ReviewSignals>;
    competitorReview: ReviewSignals | null;
  }>(cacheKey);

  if (cached) {
    return {
      byLocation: cached.value.byLocation,
      competitorReview: cached.value.competitorReview,
      status: {
        status: "ok",
        freshnessSeconds: ageSeconds(cached.fetchedAtMs),
        cacheHit: true,
      },
    };
  }

  try {
    const byLocation: Record<string, ReviewSignals> = {};
    const ownResults = await Promise.all(
      locations.map(async (location) => {
        const signal = await withTimeout(
          buildReviewSignals(location.placeId),
          SOURCE_TIMEOUTS_MS.reviews,
        );
        if (signal) {
          byLocation[location.label] = signal;
        }
      }),
    );

    void ownResults;

    let competitorReview: ReviewSignals | null = null;
    if (competitorPlaceId) {
      competitorReview = await withTimeout(
        buildReviewSignals(competitorPlaceId),
        SOURCE_TIMEOUTS_MS.reviews,
      );
    }

    writeCache(
      cacheKey,
      {
        byLocation,
        competitorReview,
      },
      24 * 60 * 60 * 1000,
    );

    return {
      byLocation,
      competitorReview,
      status: {
        status: "ok",
        freshnessSeconds: 0,
        cacheHit: false,
      },
    };
  } catch (error) {
    return {
      byLocation: {},
      competitorReview: null,
      status: statusFromError(error),
    };
  }
}

export async function fetchSourceBundle(
  dbClient: DbClient,
  locations: ResolvedLocation[],
  competitorPlaceId?: string,
): Promise<SourceBundle> {
  const [weather, events, closures, doe, reviews] = await Promise.all([
    fetchWeatherSource(locations),
    fetchEventsSource(locations),
    fetchClosuresSource(locations),
    fetchDoeSource(dbClient),
    fetchReviewsSource(locations, competitorPlaceId),
  ]);

  return {
    weather,
    events,
    closures,
    doe,
    reviews: {
      byLocation: reviews.byLocation,
      status: reviews.status,
    },
    competitorReview: reviews.competitorReview,
  };
}

export function getReviewRecencyWindowDays(): number {
  return REVIEW_RECENCY_WINDOW_DAYS;
}
