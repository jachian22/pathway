import { type DbClient } from "@/server/db";
import {
  type ToolDefinition,
  type ToolExecution,
} from "@/server/services/openrouter";
import {
  fetchDoeSource,
  fetchEventsSource,
  fetchClosuresSource,
  fetchReviewsSource,
  fetchWeatherSource,
} from "@/server/services/intelligence/sources";
import {
  type ClosureSignal,
  type DoeSignal,
  type ResolvedLocation,
  type ReviewSignals,
  type SourceStatus,
  type VenueEventSignal,
  type WeatherSignal,
} from "@/server/services/intelligence/types";
import { TurnCircuitBreaker } from "@/server/services/intelligence/agent/circuit-breaker";

interface CompetitorContext {
  placeId?: string;
  resolvedName?: string;
  status: "not_requested" | "limit_reached" | "not_found" | "resolved";
}

interface CreateAgentToolsInput {
  db: DbClient;
  resolvedLocations: ResolvedLocation[];
  memoryPayload: Record<string, unknown>;
  competitor: CompetitorContext;
}

interface SourceState {
  weather?: Awaited<ReturnType<typeof fetchWeatherSource>>;
  events?: Awaited<ReturnType<typeof fetchEventsSource>>;
  closures?: Awaited<ReturnType<typeof fetchClosuresSource>>;
  doe?: Awaited<ReturnType<typeof fetchDoeSource>>;
  reviews?: Awaited<ReturnType<typeof fetchReviewsSource>>;
}

interface SourceStatusMap {
  weather: SourceStatus;
  events: SourceStatus;
  closures: SourceStatus;
  doe: SourceStatus;
  reviews: SourceStatus;
}

export interface AgentSourceSnapshot {
  weatherByLocation: Record<string, WeatherSignal>;
  eventsByLocation: Record<string, VenueEventSignal[]>;
  closuresByLocation: Record<string, ClosureSignal[]>;
  doeDays: DoeSignal[];
  reviewByLocation: Record<string, ReviewSignals>;
  competitorReview: ReviewSignals | null;
}

function defaultSourceStatus(): SourceStatus {
  return { status: "ok" };
}

function pickLocationLabel(
  args: Record<string, unknown>,
  resolvedLocations: ResolvedLocation[],
): string {
  const provided =
    typeof args.locationLabel === "string" ? args.locationLabel.trim() : "";
  if (!provided) {
    return resolvedLocations[0]?.label ?? "your locations";
  }
  return (
    resolvedLocations.find((location) => location.label === provided)?.label ??
    resolvedLocations[0]?.label ??
    provided
  );
}

export function createAgentTools(input: CreateAgentToolsInput): {
  tools: ToolDefinition[];
  executeTool: (params: {
    name: string;
    args: Record<string, unknown>;
  }) => Promise<ToolExecution>;
  prefetchCore: () => Promise<ToolExecution[]>;
  getSourceStatuses: () => SourceStatusMap;
  getReviewSignals: () => {
    byLocation: Record<string, ReviewSignals>;
    competitorReview: ReviewSignals | null;
  };
  getSourceSnapshot: () => AgentSourceSnapshot;
  getCircuitBreakerEvents: () => ReturnType<TurnCircuitBreaker["getEvents"]>;
} {
  const circuitBreaker = new TurnCircuitBreaker(1);
  const state: SourceState = {};

  const sourceStatuses: SourceStatusMap = {
    weather: defaultSourceStatus(),
    events: defaultSourceStatus(),
    closures: defaultSourceStatus(),
    doe: defaultSourceStatus(),
    reviews: defaultSourceStatus(),
  };

  const run = async (
    sourceName: keyof SourceStatusMap,
    operation: () => Promise<void>,
    toolName: string,
    args: Record<string, unknown>,
    resultBuilder: () => Record<string, unknown>,
  ): Promise<ToolExecution> => {
    const started = Date.now();

    if (!circuitBreaker.canRun(sourceName)) {
      return {
        toolName,
        sourceName,
        args,
        status: "error",
        latencyMs: Date.now() - started,
        errorCode: "CIRCUIT_OPEN",
        result: {
          error: `${sourceName} temporarily unavailable in this turn`,
        },
      };
    }

    try {
      await operation();
      const status = sourceStatuses[sourceName];
      if (status.status === "ok" || status.status === "stale") {
        circuitBreaker.markSuccess(sourceName);
      } else {
        circuitBreaker.markFailure(sourceName);
      }

      return {
        toolName,
        sourceName,
        args,
        status: status.status,
        latencyMs: Date.now() - started,
        cacheHit: status.cacheHit,
        sourceFreshnessSeconds: status.freshnessSeconds,
        errorCode: status.errorCode,
        result: resultBuilder(),
      };
    } catch (error) {
      circuitBreaker.markFailure(sourceName);
      return {
        toolName,
        sourceName,
        args,
        status: "error",
        latencyMs: Date.now() - started,
        errorCode: "TOOL_EXECUTION_ERROR",
        result: {
          error: error instanceof Error ? error.message : "unknown_error",
        },
      };
    }
  };

  const tools: ToolDefinition[] = [
    {
      name: "get_memory",
      description:
        "Read current session memory including locations, baseline staffing, card type, and assumptions.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
    {
      name: "get_weather",
      description:
        "Get weather signal for a location for the next 3 days (rain and temperature extremes).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          locationLabel: {
            type: "string",
            description: "Exact location label from memory",
          },
        },
      },
    },
    {
      name: "get_events",
      description:
        "Get nearby major venue event signals for a location (MSG, Barclays, etc.).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          locationLabel: {
            type: "string",
          },
        },
      },
    },
    {
      name: "get_closures",
      description:
        "Get nearby NYC DOT street closure signals for a location to assess access risk.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          locationLabel: {
            type: "string",
          },
        },
      },
    },
    {
      name: "get_doe",
      description:
        "Get DOE calendar signals that may shift weekday lunch/dinner demand mix.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
    {
      name: "get_reviews",
      description:
        "Get own-location guest review signals and evidence references for staffing friction themes.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          locationLabel: {
            type: "string",
          },
        },
      },
    },
    {
      name: "get_competitor_reviews",
      description:
        "Get one competitor's review snapshot when competitor is already resolved for this session.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
  ];

  const executeTool = async (params: {
    name: string;
    args: Record<string, unknown>;
  }): Promise<ToolExecution> => {
    if (params.name === "get_memory") {
      return {
        toolName: params.name,
        sourceName: "system",
        args: params.args,
        status: "ok",
        latencyMs: 0,
        result: input.memoryPayload,
      };
    }

    if (params.name === "get_weather") {
      const locationLabel = pickLocationLabel(
        params.args,
        input.resolvedLocations,
      );
      return run(
        "weather",
        async () => {
          if (!state.weather) {
            state.weather = await fetchWeatherSource(input.resolvedLocations);
            sourceStatuses.weather = state.weather.status;
          }
        },
        params.name,
        params.args,
        () => ({
          locationLabel,
          signal: state.weather?.byLocation[locationLabel] ?? null,
          sourceStatus: sourceStatuses.weather,
        }),
      );
    }

    if (params.name === "get_events") {
      const locationLabel = pickLocationLabel(
        params.args,
        input.resolvedLocations,
      );
      return run(
        "events",
        async () => {
          if (!state.events) {
            state.events = await fetchEventsSource(input.resolvedLocations);
            sourceStatuses.events = state.events.status;
          }
        },
        params.name,
        params.args,
        () => ({
          locationLabel,
          signals: state.events?.byLocation[locationLabel] ?? [],
          sourceStatus: sourceStatuses.events,
        }),
      );
    }

    if (params.name === "get_closures") {
      const locationLabel = pickLocationLabel(
        params.args,
        input.resolvedLocations,
      );
      return run(
        "closures",
        async () => {
          if (!state.closures) {
            state.closures = await fetchClosuresSource(input.resolvedLocations);
            sourceStatuses.closures = state.closures.status;
          }
        },
        params.name,
        params.args,
        () => ({
          locationLabel,
          signals: state.closures?.byLocation[locationLabel] ?? [],
          sourceStatus: sourceStatuses.closures,
        }),
      );
    }

    if (params.name === "get_doe") {
      return run(
        "doe",
        async () => {
          if (!state.doe) {
            state.doe = await fetchDoeSource(input.db);
            sourceStatuses.doe = state.doe.status;
          }
        },
        params.name,
        params.args,
        () => ({
          days: state.doe?.days ?? [],
          sourceStatus: sourceStatuses.doe,
        }),
      );
    }

    if (params.name === "get_reviews") {
      const locationLabel = pickLocationLabel(
        params.args,
        input.resolvedLocations,
      );
      return run(
        "reviews",
        async () => {
          if (!state.reviews) {
            state.reviews = await fetchReviewsSource(input.resolvedLocations);
            sourceStatuses.reviews = state.reviews.status;
          }
        },
        params.name,
        params.args,
        () => ({
          locationLabel,
          signal: state.reviews?.byLocation[locationLabel] ?? null,
          sourceStatus: sourceStatuses.reviews,
        }),
      );
    }

    if (params.name === "get_competitor_reviews") {
      return run(
        "reviews",
        async () => {
          if (
            input.competitor.status !== "resolved" ||
            !input.competitor.placeId
          ) {
            return;
          }
          if (!state.reviews) {
            state.reviews = await fetchReviewsSource(
              input.resolvedLocations,
              input.competitor.placeId,
            );
            sourceStatuses.reviews = state.reviews.status;
          }
        },
        params.name,
        params.args,
        () => ({
          competitorStatus: input.competitor.status,
          competitorName: input.competitor.resolvedName ?? null,
          competitorReview:
            input.competitor.status === "resolved"
              ? (state.reviews?.competitorReview ?? null)
              : null,
          sourceStatus: sourceStatuses.reviews,
        }),
      );
    }

    return {
      toolName: params.name,
      sourceName: "system",
      args: params.args,
      status: "error",
      latencyMs: 0,
      errorCode: "UNKNOWN_TOOL",
      result: {
        error: `Unknown tool ${params.name}`,
      },
    };
  };

  const prefetchCore = async (): Promise<ToolExecution[]> => {
    const baseCalls: Promise<ToolExecution>[] = [
      executeTool({ name: "get_weather", args: {} }),
      executeTool({ name: "get_events", args: {} }),
      executeTool({ name: "get_closures", args: {} }),
      executeTool({ name: "get_doe", args: {} }),
      executeTool({ name: "get_reviews", args: {} }),
    ];

    if (input.competitor.status === "resolved" && input.competitor.placeId) {
      baseCalls.push(executeTool({ name: "get_competitor_reviews", args: {} }));
    }

    return Promise.all(baseCalls);
  };

  const getSourceStatuses = (): SourceStatusMap => sourceStatuses;

  const getReviewSignals = () => ({
    byLocation: state.reviews?.byLocation ?? {},
    competitorReview: state.reviews?.competitorReview ?? null,
  });

  const getSourceSnapshot = (): AgentSourceSnapshot => ({
    weatherByLocation: state.weather?.byLocation ?? {},
    eventsByLocation: state.events?.byLocation ?? {},
    closuresByLocation: state.closures?.byLocation ?? {},
    doeDays: state.doe?.days ?? [],
    reviewByLocation: state.reviews?.byLocation ?? {},
    competitorReview: state.reviews?.competitorReview ?? null,
  });

  return {
    tools,
    executeTool,
    prefetchCore,
    getSourceStatuses,
    getReviewSignals,
    getSourceSnapshot,
    getCircuitBreakerEvents: () => circuitBreaker.getEvents(),
  };
}
