import { env } from "@/env";
import { toMiles } from "@/server/services/intelligence/utils";

export interface DotClosure {
  id: string;
  title: string;
  street?: string;
  startAt?: string;
  endAt?: string;
  lat?: number;
  lon?: number;
}

interface DotFetchOptions {
  lat: number;
  lon: number;
  radiusMiles?: number;
  limit?: number;
}

function parseNumber(input: unknown): number | undefined {
  if (typeof input === "number") return input;
  if (typeof input === "string") {
    const parsed = Number(input);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function toId(input: unknown, fallbackIndex: number): string {
  if (typeof input === "string" && input.trim().length > 0) return input;
  if (typeof input === "number" && Number.isFinite(input)) return String(input);
  return String(fallbackIndex);
}

function extractLatLon(record: Record<string, unknown>): {
  lat?: number;
  lon?: number;
} {
  const latitude =
    parseNumber(record.latitude) ??
    parseNumber(record.lat) ??
    parseNumber(
      (record.location as Record<string, unknown> | undefined)?.latitude,
    );

  const longitude =
    parseNumber(record.longitude) ??
    parseNumber(record.lon) ??
    parseNumber(
      (record.location as Record<string, unknown> | undefined)?.longitude,
    );

  return { lat: latitude, lon: longitude };
}

function extractStartEnd(record: Record<string, unknown>): {
  startAt?: string;
  endAt?: string;
} {
  const startAt =
    (record.start_date as string | undefined) ??
    (record.start_datetime as string | undefined) ??
    (record.from_date as string | undefined) ??
    (record.start_time as string | undefined);

  const endAt =
    (record.end_date as string | undefined) ??
    (record.end_datetime as string | undefined) ??
    (record.to_date as string | undefined) ??
    (record.end_time as string | undefined);

  return { startAt, endAt };
}

function extractTitle(record: Record<string, unknown>): string {
  const name =
    (record.event_name as string | undefined) ??
    (record.activity as string | undefined) ??
    (record.type as string | undefined) ??
    (record.description as string | undefined) ??
    "Street closure";
  return name;
}

function extractStreet(record: Record<string, unknown>): string | undefined {
  return (
    (record.street_name as string | undefined) ??
    (record.on_street_name as string | undefined) ??
    (record.street as string | undefined) ??
    (record.from_street_name as string | undefined)
  );
}

export async function fetchDotClosuresNearby(
  options: DotFetchOptions,
): Promise<DotClosure[]> {
  const baseUrl = env.NYC_DOT_CLOSURES_URL;
  if (!baseUrl) {
    return [];
  }

  const limit = options.limit ?? 200;
  const url = new URL(baseUrl);
  url.searchParams.set("$limit", String(limit));
  url.searchParams.set("$order", "updated_at DESC");

  const headers: HeadersInit = {};
  if (env.NYC_OPEN_DATA_APP_TOKEN) {
    headers["X-App-Token"] = env.NYC_OPEN_DATA_APP_TOKEN;
  }

  const response = await fetch(url.toString(), {
    headers,
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`NYC DOT closures error: ${response.status} - ${text}`);
  }

  const data = (await response.json()) as Record<string, unknown>[];
  const radiusMiles = options.radiusMiles ?? 0.5;

  return data
    .map((record, index) => {
      const { lat, lon } = extractLatLon(record);
      const { startAt, endAt } = extractStartEnd(record);
      const title = extractTitle(record);
      const street = extractStreet(record);

      return {
        id: toId(record.id ?? record.unique_id, index),
        title,
        street,
        startAt,
        endAt,
        lat,
        lon,
      } satisfies DotClosure;
    })
    .filter((closure) => {
      if (closure.lat === undefined || closure.lon === undefined) {
        return true;
      }
      return (
        toMiles(options.lat, options.lon, closure.lat, closure.lon) <=
        radiusMiles
      );
    });
}
