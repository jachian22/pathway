import { z } from "zod";

import { createTRPCRouter, publicProcedure } from "@/server/api/trpc";
import {
  endChatSession,
  runFirstInsight,
} from "@/server/services/intelligence/orchestrator";

const cardTypeSchema = z.enum(["staffing", "risk", "opportunity"]);

const baselineSchema = z.object({
  locationLabel: z.string(),
  baselineFoh: z.number().int().min(0).max(100).optional(),
  baselineBoh: z.number().int().min(0).max(100).optional(),
});

const firstInsightInputSchema = z.object({
  sessionId: z.string().uuid().optional(),
  distinctId: z.string().optional(),
  cardType: cardTypeSchema,
  locations: z.array(z.string().min(1)).min(1).max(3),
  baselineContext: z.array(baselineSchema).optional(),
  competitorName: z.string().optional(),
});

export const intelligenceRouter = createTRPCRouter({
  firstInsight: publicProcedure
    .input(firstInsightInputSchema)
    .mutation(async ({ ctx, input }) => {
      return runFirstInsight(
        {
          db: ctx.db,
          traceId: ctx.traceId,
          requestId: ctx.requestId,
        },
        input,
      );
    }),

  refineInsight: publicProcedure
    .input(
      firstInsightInputSchema.extend({
        sessionId: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return runFirstInsight(
        {
          db: ctx.db,
          traceId: ctx.traceId,
          requestId: ctx.requestId,
        },
        input,
      );
    }),

  endSession: publicProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        distinctId: z.string().optional(),
        endReason: z
          .enum(["completed", "user_exit", "inactive_timeout", "error"])
          .default("completed"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return endChatSession(
        {
          db: ctx.db,
          traceId: ctx.traceId,
          requestId: ctx.requestId,
        },
        input,
      );
    }),
});
