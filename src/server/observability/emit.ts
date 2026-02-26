import { logStructured, type LogLevel } from "@/server/observability/logger";
import { buildEventPayload, type EventEnvelope } from "@/server/observability/events";
import { capturePosthogServer } from "@/server/observability/posthog-server";

interface EmitOptions {
  level?: LogLevel;
  sendToPosthog?: boolean;
  posthogDistinctId?: string;
}

export async function emitEvent(
  envelope: EventEnvelope,
  payload: Record<string, unknown> = {},
  options: EmitOptions = {},
): Promise<void> {
  const level = options.level ?? "info";
  const data = buildEventPayload(envelope, payload);

  logStructured(level, {
    event: envelope.event,
    trace_id: envelope.trace_id,
    request_id: envelope.request_id,
    session_id: envelope.session_id,
    turn_index: envelope.turn_index,
    route: envelope.route,
    latency_ms: envelope.latency_ms,
    ...data,
  });

  if (options.sendToPosthog && options.posthogDistinctId) {
    await capturePosthogServer({
      distinctId: options.posthogDistinctId,
      event: envelope.event,
      properties: data,
    });
  }
}
