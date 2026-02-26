import { env } from "@/env";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionResponse {
  id: string;
  choices: {
    message: {
      role: string;
      content: string;
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
  content?: string;
  failure?: ModelFailure;
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
  messages: ChatMessage[],
  model: string,
  options?: ChatCompletionOptions,
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
  const content = data.choices[0]?.message?.content;

  if (!content) {
    return {
      failure: {
        message: "No response content from OpenRouter",
        retryable: false,
      },
    };
  }

  return { content };
}

export async function chatCompletion(
  messages: ChatMessage[],
  options?: ChatCompletionOptions,
): Promise<string> {
  const primaryModel = options?.model ?? env.OPENROUTER_MODEL;
  const fallbackModel =
    options?.model || env.OPENROUTER_FALLBACK_MODEL === primaryModel
      ? undefined
      : env.OPENROUTER_FALLBACK_MODEL;

  const primaryResult = await requestChatCompletion(
    messages,
    primaryModel,
    options,
  );
  if (primaryResult.content) {
    return primaryResult.content;
  }

  if (fallbackModel && primaryResult.failure?.retryable) {
    const fallbackResult = await requestChatCompletion(
      messages,
      fallbackModel,
      options,
    );
    if (fallbackResult.content) {
      return fallbackResult.content;
    }

    const fallbackFailure = fallbackResult.failure;
    const fallbackLabel = fallbackFailure?.status
      ? `${fallbackFailure.status} - ${fallbackFailure.message}`
      : (fallbackFailure?.message ?? "unknown fallback failure");
    const primaryLabel = primaryResult.failure?.status
      ? `${primaryResult.failure.status} - ${primaryResult.failure.message}`
      : (primaryResult.failure?.message ?? "unknown primary failure");

    throw new Error(
      `OpenRouter API error. primary(${primaryModel}): ${primaryLabel}; fallback(${fallbackModel}): ${fallbackLabel}`,
    );
  }

  const primaryFailure = primaryResult.failure;
  if (!primaryFailure) {
    throw new Error("OpenRouter API error: unknown failure");
  }

  if (primaryFailure.status) {
    throw new Error(
      `OpenRouter API error: ${primaryFailure.status} - ${primaryFailure.message}`,
    );
  }

  throw new Error(`OpenRouter API error: ${primaryFailure.message}`);
}
