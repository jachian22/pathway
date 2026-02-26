import { randomUUID } from "node:crypto";

export function getOrCreateTraceId(headers: Headers): string {
  const fromHeader =
    headers.get("x-trace-id") ??
    headers.get("x-request-id") ??
    headers.get("x-vercel-id") ??
    headers.get("traceparent");

  if (fromHeader && fromHeader.trim().length > 0) {
    return fromHeader;
  }

  return randomUUID();
}

export function nowMs(): number {
  return Date.now();
}
