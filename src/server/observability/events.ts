export const ANALYTICS_SCHEMA_VERSION = "1.0.0";

export interface EventEnvelope {
  event: string;
  trace_id: string;
  request_id?: string;
  session_id?: string;
  distinct_id?: string;
  turn_index?: number;
  route?: string;
  latency_ms?: number;
  card_type?: "staffing" | "risk" | "opportunity" | "none";
  location_count?: number;
  model?: string;
  prompt_version?: string;
  rule_version?: string;
  release?: string;
  env?: string;
  used_fallback?: boolean;
  [key: string]: unknown;
}

const DISALLOWED_KEYS = new Set(["address", "email", "phone", "content_text", "raw_review_text"]);

export function sanitizeEventPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (DISALLOWED_KEYS.has(key)) continue;
    sanitized[key] = value;
  }
  sanitized.schema_version = ANALYTICS_SCHEMA_VERSION;
  return sanitized;
}

export function buildEventPayload(envelope: EventEnvelope, payload: Record<string, unknown> = {}) {
  return sanitizeEventPayload({
    ...envelope,
    ...payload,
  });
}
