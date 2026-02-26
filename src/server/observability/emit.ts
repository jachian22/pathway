import { logStructured, type LogLevel } from "@/server/observability/logger";
import {
  buildEventPayload,
  type EventEnvelope,
} from "@/server/observability/events";
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
  try {
    const level = options.level ?? "info";
    const data = buildEventPayload(envelope, payload);

    try {
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
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "unknown_log_error";
      console.warn(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "warn",
          event: "observability.log.failure",
          trace_id: envelope.trace_id,
          request_id: envelope.request_id,
          reason: message,
        }),
      );
    }

    if (options.sendToPosthog && options.posthogDistinctId) {
      await capturePosthogServer({
        distinctId: options.posthogDistinctId,
        event: envelope.event,
        properties: data,
      });
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown_emit_error";
    console.warn(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        event: "observability.emit.failure",
        trace_id: envelope.trace_id,
        request_id: envelope.request_id,
        reason: message,
      }),
    );
  }
}
