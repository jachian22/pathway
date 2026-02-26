import { searchPlaces } from "@/server/services/google-places";
import { SOURCE_TIMEOUTS_MS } from "@/server/services/intelligence/constants";
import { type ResolvedLocation } from "@/server/services/intelligence/types";
import {
  isNycAddress,
  isNycZip,
  isWithinNycBounds,
  withTimeout,
} from "@/server/services/intelligence/utils";

function splitLocationInput(raw: string): string[] {
  const normalized = raw.trim();
  if (normalized.length === 0) return [];

  if (normalized.includes("\n") || normalized.includes(";")) {
    return normalized
      .split(/[\n;]+/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  const zipMatches = Array.from(normalized.matchAll(/\b\d{5}(?:-\d{4})?\b/g));
  if (zipMatches.length <= 1) {
    return [normalized];
  }

  const pieces = normalized
    .split(/(?<=\b\d{5}(?:-\d{4})?)\s*,\s*/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return pieces.length > 0 ? pieces : [normalized];
}

export function parseLocationInputs(input: string[]): string[] {
  const expanded = input.flatMap(splitLocationInput);
  const deduped = Array.from(new Set(expanded));
  return deduped.slice(0, 3);
}

export interface ParsedLocationResult {
  parsed: string[];
  invalid: string[];
}

function isLikelyAddressInput(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    /\d/.test(normalized) &&
    /\b(st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|pl|place|ct|court|way|pkwy|parkway)\b/.test(
      normalized,
    )
  );
}

function shouldRejectBeforeLookup(input: string): boolean {
  const normalized = input.trim();
  if (normalized.length === 0) return true;

  if (isNycZip(normalized) || isLikelyAddressInput(normalized)) {
    return false;
  }

  return normalized.length < 3;
}

export function parseLocations(input: string[]): ParsedLocationResult {
  const parsed = parseLocationInputs(input);
  const invalid = parsed.filter((item) => shouldRejectBeforeLookup(item));
  return {
    parsed: parsed.filter((item) => !invalid.includes(item)),
    invalid,
  };
}

export async function resolveLocations(
  inputs: string[],
): Promise<{ resolved: ResolvedLocation[]; invalid: string[] }> {
  const parsed = parseLocationInputs(inputs);
  const invalid: string[] = [];

  const resolutions = await Promise.all(
    parsed.map(async (input) => {
      if (shouldRejectBeforeLookup(input)) {
        invalid.push(input);
        return null;
      }

      try {
        const results = await withTimeout(
          searchPlaces({
            query: input,
            maxResults: 3,
          }),
          SOURCE_TIMEOUTS_MS.geocode,
        );

        const selected = results.find((place) => {
          const lat = place.location.latitude;
          const lon = place.location.longitude;
          return (
            isWithinNycBounds(lat, lon) && isNycAddress(place.formattedAddress)
          );
        });

        if (!selected) {
          invalid.push(input);
          return null;
        }

        const resolvedLocation: ResolvedLocation = {
          input,
          label: selected.displayName.text,
          placeId: selected.id,
          address: selected.formattedAddress,
          lat: selected.location.latitude,
          lon: selected.location.longitude,
          isNyc: true,
        };

        return resolvedLocation;
      } catch {
        invalid.push(input);
        return null;
      }
    }),
  );

  return {
    resolved: resolutions.filter((value): value is ResolvedLocation =>
      Boolean(value),
    ),
    invalid,
  };
}
