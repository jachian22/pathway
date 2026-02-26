import { z } from "zod";

export const AgentResponseSchema = z.object({
  narrative: z.string().min(1).max(360),
  followUpQuestion: z.string().min(1).max(140).optional(),
});

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
