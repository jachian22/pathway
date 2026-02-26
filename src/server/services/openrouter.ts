import { env } from "@/env";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

type ToolMessage = {
  role: "tool";
  tool_call_id: string;
  content: string;
};

type AssistantToolMessage = {
  role: "assistant";
  content: string | null;
  tool_calls: ToolCall[];
};

type OpenRouterLoopMessage = ChatMessage | ToolMessage | AssistantToolMessage;

interface ChatCompletionResponse {
  id: string;
  choices: {
    message: {
      role: string;
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface OpenRouterErrorResponse {
  error?: {
    message?: string;
    code?: string | number;
    type?: string;
  };
}

interface ChatCompletionOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  responseFormat?: {
    type: "json_object";
  };
}

interface ModelFailure {
  status?: number;
  message: string;
  retryable: boolean;
}

interface ModelResult {
  data?: ChatCompletionResponse;
  failure?: ModelFailure;
}

export interface ToolExecution {
  toolName: string;
  sourceName: string;
  args: Record<string, unknown>;
  status: "ok" | "error" | "timeout" | "stale";
  latencyMs: number;
  cacheHit?: boolean;
  sourceFreshnessSeconds?: number;
  errorCode?: string;
  result: Record<string, unknown>;
}

export interface ToolLoopModelAttempt {
  attemptNumber: number;
  model: string;
  status: "ok" | "error";
  statusCode?: number;
  retryable?: boolean;
  finishReason?: string;
  hasToolCalls?: boolean;
  errorCode?: string;
  attemptLatencyMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ToolLoopProviderFailure {
  model: string;
  statusCode?: number;
  retryable: boolean;
  errorCode?: string;
}

export interface ToolLoopDiagnostics {
  primaryModel: string;
  fallbackModel?: string;
  finalModel?: string;
  finalFinishReason?: string;
  roundsExecuted: number;
  toolCallCount: number;
  toolCallsByName: Record<string, number>;
  unknownToolCount: number;
  argParseFailureCount: number;
  roundLimitHit: boolean;
  toolCallLimitHit: boolean;
  emptyFinalContent: boolean;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  modelAttempts: ToolLoopModelAttempt[];
  providerFailures: ToolLoopProviderFailure[];
}

interface ToolLoopParams {
  messages: ChatMessage[];
  tools: ToolDefinition[];
  executeTool: (params: {
    name: string;
    args: Record<string, unknown>;
  }) => Promise<ToolExecution>;
  options?: ChatCompletionOptions;
  maxRounds?: number;
  maxToolCalls?: number;
  deadlineMs?: number;
}

export class ToolLoopError extends Error {
  diagnostics: ToolLoopDiagnostics;

  constructor(message: string, diagnostics: ToolLoopDiagnostics) {
    super(message);
    this.name = "ToolLoopError";
    this.diagnostics = diagnostics;
  }
}

function toFailureCodeFromFailure(failure: ModelFailure): string {
  if (failure.status) {
    return `OPENROUTER_${failure.status}`;
  }
  if (failure.message.toLowerCase().includes("timed out")) {
    return "OPENROUTER_TIMEOUT";
  }
  return "OPENROUTER_ERROR";
}

function isRetryableStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}

function isRetryableErrorSignal(
  message: string,
  code?: string,
  type?: string,
): boolean {
  const signal = `${message} ${code ?? ""} ${type ?? ""}`.toLowerCase();

  return [
    "rate limit",
    "temporar",
    "timeout",
    "unavailable",
    "overload",
    "capacity",
    "provider",
    "upstream",
    "endpoint",
  ].some((needle) => signal.includes(needle));
}

function parseErrorPayload(raw: string): {
  message: string;
  code?: string;
  type?: string;
} {
  try {
    const parsed = JSON.parse(raw) as OpenRouterErrorResponse;
    const code =
      typeof parsed.error?.code === "number"
        ? String(parsed.error.code)
        : parsed.error?.code;
    const message = parsed.error?.message ?? raw;
    return {
      message,
      code,
      type: parsed.error?.type,
    };
  } catch {
    return { message: raw };
  }
}

async function requestChatCompletion(
  messages: OpenRouterLoopMessage[],
  model: string,
  options?: ChatCompletionOptions,
  tools?: ToolDefinition[],
): Promise<ModelResult> {
  let response: Response;
  const timeoutMs = options?.timeoutMs;
  const controller =
    timeoutMs && timeoutMs > 0 ? new AbortController() : undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  try {
    const fetchPromise = fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          "HTTP-Referer": "https://pathway-liart.vercel.app",
          "X-Title": "Pathway",
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: options?.temperature ?? 0.7,
          max_tokens: options?.maxTokens ?? 1024,
          response_format: options?.responseFormat,
          tools: tools?.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
        }),
        signal: controller?.signal,
      },
    );

    if (timeoutMs && timeoutMs > 0) {
      const timeoutPromise = new Promise<Response>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          controller?.abort();
          reject(new Error(`REQUEST_TIMEOUT_${timeoutMs}`));
        }, timeoutMs);
      });

      response = await Promise.race([fetchPromise, timeoutPromise]);
    } else {
      response = await fetchPromise;
    }
  } catch (error) {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    if (
      error instanceof Error &&
      (error.name === "AbortError" ||
        error.message.startsWith("REQUEST_TIMEOUT_"))
    ) {
      return {
        failure: {
          message: `Request timed out after ${timeoutMs ?? 0}ms`,
          retryable: true,
        },
      };
    }

    const message =
      error instanceof Error
        ? error.message
        : "Network error while reaching OpenRouter";
    return {
      failure: {
        message,
        retryable: true,
      },
    };
  }
  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
  }

  if (!response.ok) {
    const raw = await response.text();
    const parsedError = parseErrorPayload(raw);
    const retryable =
      isRetryableStatus(response.status) ||
      isRetryableErrorSignal(
        parsedError.message,
        parsedError.code,
        parsedError.type,
      );
    return {
      failure: {
        status: response.status,
        message: parsedError.message,
        retryable,
      },
    };
  }

  const data = (await response.json()) as ChatCompletionResponse;
  return { data };
}

function resolveModels(options?: ChatCompletionOptions): {
  primaryModel: string;
  fallbackModel?: string;
} {
  const primaryModel = options?.model ?? env.OPENROUTER_MODEL;
  const fallbackModel =
    options?.model || env.OPENROUTER_FALLBACK_MODEL === primaryModel
      ? undefined
      : env.OPENROUTER_FALLBACK_MODEL;

  return { primaryModel, fallbackModel };
}

function throwFromFailure(
  primaryModel: string,
  primaryFailure: ModelFailure,
  fallbackModel?: string,
  fallbackFailure?: ModelFailure,
): never {
  if (fallbackModel && fallbackFailure) {
    const fallbackLabel = fallbackFailure.status
      ? `${fallbackFailure.status} - ${fallbackFailure.message}`
      : fallbackFailure.message;
    const primaryLabel = primaryFailure.status
      ? `${primaryFailure.status} - ${primaryFailure.message}`
      : primaryFailure.message;
    throw new Error(
      `OpenRouter API error. primary(${primaryModel}): ${primaryLabel}; fallback(${fallbackModel}): ${fallbackLabel}`,
    );
  }

  if (primaryFailure.status) {
    throw new Error(
      `OpenRouter API error: ${primaryFailure.status} - ${primaryFailure.message}`,
    );
  }

  throw new Error(`OpenRouter API error: ${primaryFailure.message}`);
}

export async function chatCompletion(
  messages: ChatMessage[],
  options?: ChatCompletionOptions,
): Promise<string> {
  const { primaryModel, fallbackModel } = resolveModels(options);

  const primaryResult = await requestChatCompletion(
    messages,
    primaryModel,
    options,
  );
  const primaryContent = primaryResult.data?.choices[0]?.message?.content;
  if (primaryContent) {
    return primaryContent;
  }

  if (fallbackModel && primaryResult.failure?.retryable) {
    const fallbackResult = await requestChatCompletion(
      messages,
      fallbackModel,
      options,
    );
    const fallbackContent = fallbackResult.data?.choices[0]?.message?.content;
    if (fallbackContent) {
      return fallbackContent;
    }

    const fallbackFailure = fallbackResult.failure ?? {
      message: "No content from fallback model",
      retryable: false,
    };
    const primaryFailure = primaryResult.failure ?? {
      message: "No content from primary model",
      retryable: false,
    };
    throwFromFailure(
      primaryModel,
      primaryFailure,
      fallbackModel,
      fallbackFailure,
    );
  }

  const primaryFailure = primaryResult.failure ?? {
    message: "No response content from OpenRouter",
    retryable: false,
  };
  throwFromFailure(primaryModel, primaryFailure);
}

export async function chatCompletionWithTools(params: ToolLoopParams): Promise<{
  content: string;
  toolExecutions: ToolExecution[];
  diagnostics: ToolLoopDiagnostics;
}> {
  const maxRounds = params.maxRounds ?? 2;
  const maxToolCalls = params.maxToolCalls ?? 8;
  const { primaryModel, fallbackModel } = resolveModels(params.options);
  const toolMap = new Map(params.tools.map((tool) => [tool.name, tool]));

  const toolExecutions: ToolExecution[] = [];
  const messages: OpenRouterLoopMessage[] = [...params.messages];
  let currentModel = primaryModel;
  let retriedWithFallback = false;
  const diagnostics: ToolLoopDiagnostics = {
    primaryModel,
    fallbackModel,
    roundsExecuted: 0,
    finalFinishReason: undefined,
    toolCallCount: 0,
    toolCallsByName: {},
    unknownToolCount: 0,
    argParseFailureCount: 0,
    roundLimitHit: false,
    toolCallLimitHit: false,
    emptyFinalContent: false,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    modelAttempts: [],
    providerFailures: [],
  };

  for (let round = 0; round < maxRounds; round += 1) {
    const remainingMs =
      params.deadlineMs !== undefined ? params.deadlineMs - Date.now() : null;
    if (remainingMs !== null && remainingMs <= 0) {
      throw new ToolLoopError("AGENT_TURN_BUDGET_EXCEEDED", diagnostics);
    }

    const requestTimeoutMs =
      remainingMs !== null
        ? Math.max(
            1,
            Math.min(
              params.options?.timeoutMs ?? Number.POSITIVE_INFINITY,
              remainingMs,
            ),
          )
        : params.options?.timeoutMs;

    diagnostics.roundsExecuted = round + 1;
    const attemptStartedAtMs = Date.now();
    const result = await requestChatCompletion(
      messages,
      currentModel,
      { ...params.options, timeoutMs: requestTimeoutMs },
      params.tools,
    );

    if (result.failure) {
      const failureCode = toFailureCodeFromFailure(result.failure);
      diagnostics.modelAttempts.push({
        attemptNumber: diagnostics.modelAttempts.length + 1,
        model: currentModel,
        status: "error",
        statusCode: result.failure.status,
        retryable: result.failure.retryable,
        errorCode: failureCode,
        attemptLatencyMs: Date.now() - attemptStartedAtMs,
      });
      diagnostics.providerFailures.push({
        model: currentModel,
        statusCode: result.failure.status,
        retryable: result.failure.retryable,
        errorCode: failureCode,
      });
      if (
        !retriedWithFallback &&
        fallbackModel &&
        result.failure.retryable &&
        currentModel !== fallbackModel
      ) {
        currentModel = fallbackModel;
        retriedWithFallback = true;
        continue;
      }

      const errorLabel = result.failure.status
        ? `${result.failure.status} - ${result.failure.message}`
        : result.failure.message;
      throw new ToolLoopError(
        `OpenRouter API error: ${errorLabel}`,
        diagnostics,
      );
    }

    const message = result.data?.choices[0]?.message;
    const finishReason = result.data?.choices[0]?.finish_reason;
    const usage = result.data?.usage;
    const promptTokens = usage?.prompt_tokens ?? 0;
    const completionTokens = usage?.completion_tokens ?? 0;
    const totalTokens = usage?.total_tokens ?? 0;
    diagnostics.promptTokens += promptTokens;
    diagnostics.completionTokens += completionTokens;
    diagnostics.totalTokens += totalTokens;
    if (!message) {
      throw new ToolLoopError(
        "OpenRouter API error: missing response message",
        diagnostics,
      );
    }

    const toolCalls = message.tool_calls ?? [];
    diagnostics.modelAttempts.push({
      attemptNumber: diagnostics.modelAttempts.length + 1,
      model: currentModel,
      status: "ok",
      finishReason: finishReason ?? undefined,
      hasToolCalls: toolCalls.length > 0,
      attemptLatencyMs: Date.now() - attemptStartedAtMs,
      promptTokens,
      completionTokens,
      totalTokens,
    });
    if (toolCalls.length === 0) {
      if (!message.content) {
        diagnostics.emptyFinalContent = true;
        throw new ToolLoopError(
          "OpenRouter API error: missing final content",
          diagnostics,
        );
      }
      diagnostics.finalModel = currentModel;
      diagnostics.finalFinishReason = finishReason ?? undefined;
      return {
        content: message.content,
        toolExecutions,
        diagnostics,
      };
    }

    messages.push({
      role: "assistant",
      content: message.content,
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      const remainingMsBeforeTool =
        params.deadlineMs !== undefined ? params.deadlineMs - Date.now() : null;
      if (remainingMsBeforeTool !== null && remainingMsBeforeTool <= 0) {
        throw new ToolLoopError("AGENT_TURN_BUDGET_EXCEEDED", diagnostics);
      }

      if (toolExecutions.length >= maxToolCalls) {
        diagnostics.toolCallLimitHit = true;
        throw new ToolLoopError("AGENT_TOOL_CALL_LIMIT_REACHED", diagnostics);
      }

      const tool = toolMap.get(call.function.name);
      if (!tool) {
        diagnostics.unknownToolCount += 1;
        const unknownResult = {
          error: `Unknown tool: ${call.function.name}`,
        };
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(unknownResult),
        });
        toolExecutions.push({
          toolName: call.function.name,
          sourceName: "system",
          args: {},
          status: "error",
          latencyMs: 0,
          errorCode: "UNKNOWN_TOOL",
          result: unknownResult,
        });
        continue;
      }

      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(call.function.arguments) as Record<
          string,
          unknown
        > | null;
        args = parsed ?? {};
      } catch {
        diagnostics.argParseFailureCount += 1;
        args = {};
      }

      const execution = await params.executeTool({
        name: tool.name,
        args,
      });
      toolExecutions.push(execution);
      diagnostics.toolCallCount = toolExecutions.length;
      diagnostics.toolCallsByName[tool.name] =
        (diagnostics.toolCallsByName[tool.name] ?? 0) + 1;
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(execution.result),
      });
    }
  }

  diagnostics.roundLimitHit = true;
  throw new ToolLoopError("AGENT_TOOL_ROUND_LIMIT_REACHED", diagnostics);
}
