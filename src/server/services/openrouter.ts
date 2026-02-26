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

  try {
    response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
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
        tools: tools?.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        })),
      }),
    });
  } catch (error) {
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

export async function chatCompletionWithTools(
  params: ToolLoopParams,
): Promise<{ content: string; toolExecutions: ToolExecution[] }> {
  const maxRounds = params.maxRounds ?? 2;
  const maxToolCalls = params.maxToolCalls ?? 8;
  const { primaryModel, fallbackModel } = resolveModels(params.options);
  const toolMap = new Map(params.tools.map((tool) => [tool.name, tool]));

  const toolExecutions: ToolExecution[] = [];
  const messages: OpenRouterLoopMessage[] = [...params.messages];
  let currentModel = primaryModel;
  let retriedWithFallback = false;

  for (let round = 0; round < maxRounds; round += 1) {
    const result = await requestChatCompletion(
      messages,
      currentModel,
      params.options,
      params.tools,
    );

    if (result.failure) {
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

      throwFromFailure(currentModel, result.failure);
    }

    const message = result.data?.choices[0]?.message;
    if (!message) {
      throw new Error("OpenRouter API error: missing response message");
    }

    const toolCalls = message.tool_calls ?? [];
    if (toolCalls.length === 0) {
      if (!message.content) {
        throw new Error("OpenRouter API error: missing final content");
      }
      return {
        content: message.content,
        toolExecutions,
      };
    }

    messages.push({
      role: "assistant",
      content: message.content,
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      if (toolExecutions.length >= maxToolCalls) {
        throw new Error("AGENT_TOOL_CALL_LIMIT_REACHED");
      }

      const tool = toolMap.get(call.function.name);
      if (!tool) {
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
        args = {};
      }

      const execution = await params.executeTool({
        name: tool.name,
        args,
      });
      toolExecutions.push(execution);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(execution.result),
      });
    }
  }

  throw new Error("AGENT_TOOL_ROUND_LIMIT_REACHED");
}
