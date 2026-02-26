import { z } from "zod";

export const AgentSourceNameSchema = z.enum([
  "weather",
  "events",
  "closures",
  "doe",
  "reviews",
  "system",
]);

export const AgentConfidenceSchema = z.enum(["low", "medium", "high"]);

export const AgentRecommendationSchema = z.object({
  locationLabel: z.string().min(1).max(120),
  action: z.string().min(1).max(180),
  timeWindow: z.string().min(1).max(80),
  confidence: AgentConfidenceSchema,
  sourceName: AgentSourceNameSchema,
  why: z.array(z.string().min(1).max(160)).max(2).default([]),
  deltaReasoning: z.string().min(1).max(240),
  escalationTrigger: z.string().min(1).max(200),
  reviewBacked: z.boolean().default(false),
  citations: z
    .array(
      z.object({
        sourceName: AgentSourceNameSchema,
        freshnessSeconds: z.number().int().nonnegative().optional(),
        note: z.string().max(120).optional(),
      }),
    )
    .max(3)
    .default([]),
  evidence: z
    .object({
      evidenceCount: z.number().int().nonnegative(),
      recencyWindowDays: z.number().int().positive(),
      topRefs: z.array(
        z.object({
          source: z.literal("google_reviews"),
          placeId: z.string(),
          reviewIdOrHash: z.string(),
          publishTime: z.string(),
          rating: z.number().optional(),
          theme: z.enum([
            "wait_time",
            "service_speed",
            "host_queue",
            "kitchen_delay",
            "other",
          ]),
          excerpt: z.string().optional(),
        }),
      ),
    })
    .optional(),
});

export const AgentResponseSchema = z.object({
  narrative: z.string().min(1).max(360),
  recommendations: z.array(AgentRecommendationSchema).min(1).max(3),
  assumptions: z.array(z.string().min(1).max(180)).max(4).default([]),
  followUpQuestion: z.string().min(1).max(140).optional(),
});

export type AgentRecommendation = z.infer<typeof AgentRecommendationSchema>;
export type AgentResponse = z.infer<typeof AgentResponseSchema>;

function extractJsonObject(text: string): string | null {
  const fencedRegex = /```(?:json)?\s*([\s\S]*?)```/i;
  const fenced = fencedRegex.exec(text);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }
  return text.slice(firstBrace, lastBrace + 1);
}

export function parseAgentResponse(content: string): AgentResponse {
  const rawJson = extractJsonObject(content);
  if (!rawJson) {
    throw new Error("AGENT_RESPONSE_NO_JSON");
  }
  const parsed: unknown = JSON.parse(rawJson);
  return AgentResponseSchema.parse(parsed);
}
