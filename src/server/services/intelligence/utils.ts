import {
  NYC_BOUNDS,
  NYC_BOROUGH_TOKENS,
  NYC_ZIP_PREFIXES,
} from "@/server/services/intelligence/constants";

export function isWithinNycBounds(lat: number, lon: number): boolean {
  return (
    lat >= NYC_BOUNDS.minLat &&
    lat <= NYC_BOUNDS.maxLat &&
    lon >= NYC_BOUNDS.minLon &&
    lon <= NYC_BOUNDS.maxLon
  );
}

export function isNycZip(input: string): boolean {
  const zip = input.trim();
  if (!/^\d{5}$/.test(zip)) return false;
  return NYC_ZIP_PREFIXES.includes(zip.slice(0, 3));
}

export function isNycAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  const hasNyState = /\bny\b|new york,\s*ny/.test(normalized);
  const hasBoroughToken = NYC_BOROUGH_TOKENS.some((token) =>
    normalized.includes(token),
  );
  const zipRegex = /\b(\d{5})\b/;
  const zipMatch = zipRegex.exec(normalized);
  const zipOk = zipMatch
    ? NYC_ZIP_PREFIXES.includes(zipMatch[1]!.slice(0, 3))
    : false;
  return hasNyState && (hasBoroughToken || zipOk);
}

export function toMiles(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 3958.8;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("unknown_error"));
      });
  });
}

export function toIso(date: Date): string {
  // Ticketmaster expects RFC3339 without fractional seconds.
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function toDatePlusDays(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date;
}

export function truncateSnippet(text: string, maxLen = 160): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen - 1)}…`;
}
