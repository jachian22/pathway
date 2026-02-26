export type LogLevel = "info" | "warn" | "error";

export interface StructuredLog {
  ts: string;
  level: LogLevel;
  event: string;
  trace_id: string;
  request_id?: string;
  session_id?: string;
  turn_index?: number;
  route?: string;
  latency_ms?: number;
  [key: string]: unknown;
}

export function logStructured(level: LogLevel, payload: Omit<StructuredLog, "ts" | "level">): void {
  const log = {
    ts: new Date().toISOString(),
    level,
    ...payload,
  } as StructuredLog;

  const line = JSON.stringify(log);
  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
}
