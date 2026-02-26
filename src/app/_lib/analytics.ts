"use client";

import posthog from "posthog-js";

type EventPayload = Record<string, unknown>;

export function captureEvent(event: string, payload: EventPayload = {}): void {
  if (!posthog.__loaded) return;

  posthog.capture(event, {
    ...payload,
    schema_version: "1.0.0",
  });
}

export function getDistinctId(): string | undefined {
  if (!posthog.__loaded) return undefined;
  return posthog.get_distinct_id();
}
