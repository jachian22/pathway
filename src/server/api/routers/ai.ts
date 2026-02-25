import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "@/server/api/trpc";
import { chatCompletion } from "@/server/services/openrouter";

export const aiRouter = createTRPCRouter({
  chat: publicProcedure
    .input(
      z.object({
        messages: z.array(
          z.object({
            role: z.enum(["system", "user", "assistant"]),
            content: z.string(),
          })
        ),
        temperature: z.number().min(0).max(2).optional(),
        maxTokens: z.number().min(1).max(4096).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const response = await chatCompletion(input.messages, {
        temperature: input.temperature,
        maxTokens: input.maxTokens,
      });

      return { content: response };
    }),

  // Simple single-message prompt
  prompt: publicProcedure
    .input(
      z.object({
        prompt: z.string(),
        systemPrompt: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const messages: { role: "system" | "user"; content: string }[] = [];

      if (input.systemPrompt) {
        messages.push({ role: "system", content: input.systemPrompt });
      }

      messages.push({ role: "user", content: input.prompt });

      const response = await chatCompletion(messages);

      return { content: response };
    }),
});
