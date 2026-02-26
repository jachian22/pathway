import { env } from "@/env";

interface PosthogCaptureParams {
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
}

const defaultHost = env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://app.posthog.com";
const projectKey = env.NEXT_PUBLIC_POSTHOG_KEY;

export async function capturePosthogServer(
  params: PosthogCaptureParams,
): Promise<void> {
  if (!projectKey) return;

  try {
    await fetch(`${defaultHost}/capture/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        api_key: projectKey,
        event: params.event,
        distinct_id: params.distinctId,
        properties: params.properties ?? {},
      }),
      cache: "no-store",
    });
  } catch {
    // PostHog failures must never block response flow.
  }
}
