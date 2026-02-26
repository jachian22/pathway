import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  /**
   * Specify your server-side environment variables schema here. This way you can ensure the app
   * isn't built with invalid env vars.
   */
  server: {
    DATABASE_URL: z.string().url(),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),

    // AI
    OPENROUTER_API_KEY: z.string(),
    OPENROUTER_MODEL: z.string().default("moonshotai/kimi-k2.5"),
    OPENROUTER_FALLBACK_MODEL: z.string().default("minimax/minimax-m2.5"),
    OPENROUTER_FAST_MODEL: z.string().optional(),
    INTELLIGENCE_AGENT_MODE: z.enum(["off", "on"]).default("off"),
    INTELLIGENCE_TURN_BUDGET_MS: z.coerce.number().int().min(500).default(9000),
    INTELLIGENCE_TURN_BUDGET_FIRST_MS: z.coerce
      .number()
      .int()
      .min(500)
      .default(15000),
    INTELLIGENCE_TURN_BUDGET_FOLLOWUP_MS: z.coerce
      .number()
      .int()
      .min(500)
      .default(9000),
    INTELLIGENCE_TURN_REPAIR_RESERVE_MS: z.coerce
      .number()
      .int()
      .min(0)
      .default(2500),
    INTELLIGENCE_AGENT_MAX_TOKENS_FIRST_TURN: z.coerce
      .number()
      .int()
      .min(128)
      .max(4096)
      .default(700),
    INTELLIGENCE_AGENT_MAX_TOKENS_FOLLOWUP: z.coerce
      .number()
      .int()
      .min(128)
      .max(4096)
      .default(900),
    INTELLIGENCE_AGENT_MAX_TOKENS_REPAIR: z.coerce
      .number()
      .int()
      .min(128)
      .max(4096)
      .default(600),
    INTELLIGENCE_AGENT_MAX_TOKENS_NARRATIVE_CAP: z.coerce
      .number()
      .int()
      .min(128)
      .max(4096)
      .default(420),

    // Data providers
    OPENWEATHER_API_KEY: z.string(),
    TICKETMASTER_API_KEY: z.string(),
    GOOGLE_PLACES_API_KEY: z.string(),
    NYC_DOT_CLOSURES_URL: z.string().url().optional(),
    NYC_OPEN_DATA_APP_TOKEN: z.string().optional(),
  },

  /**
   * Specify your client-side environment variables schema here. This way you can ensure the app
   * isn't built with invalid env vars. To expose them to the client, prefix them with
   * `NEXT_PUBLIC_`.
   */
  client: {
    NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN: z.string().optional(),
    NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: z.string().optional(),
    NEXT_PUBLIC_POSTHOG_KEY: z.string().optional(),
    NEXT_PUBLIC_POSTHOG_HOST: z.string().optional(),
  },

  /**
   * You can't destruct `process.env` as a regular object in the Next.js edge runtimes (e.g.
   * middlewares) or client-side so we need to destruct manually.
   */
  runtimeEnv: {
    DATABASE_URL: process.env.DATABASE_URL,
    NODE_ENV: process.env.NODE_ENV,

    // AI
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    OPENROUTER_MODEL: process.env.OPENROUTER_MODEL,
    OPENROUTER_FALLBACK_MODEL: process.env.OPENROUTER_FALLBACK_MODEL,
    OPENROUTER_FAST_MODEL: process.env.OPENROUTER_FAST_MODEL,
    INTELLIGENCE_AGENT_MODE: process.env.INTELLIGENCE_AGENT_MODE,
    INTELLIGENCE_TURN_BUDGET_MS: process.env.INTELLIGENCE_TURN_BUDGET_MS,
    INTELLIGENCE_TURN_BUDGET_FIRST_MS:
      process.env.INTELLIGENCE_TURN_BUDGET_FIRST_MS,
    INTELLIGENCE_TURN_BUDGET_FOLLOWUP_MS:
      process.env.INTELLIGENCE_TURN_BUDGET_FOLLOWUP_MS,
    INTELLIGENCE_TURN_REPAIR_RESERVE_MS:
      process.env.INTELLIGENCE_TURN_REPAIR_RESERVE_MS,
    INTELLIGENCE_AGENT_MAX_TOKENS_FIRST_TURN:
      process.env.INTELLIGENCE_AGENT_MAX_TOKENS_FIRST_TURN,
    INTELLIGENCE_AGENT_MAX_TOKENS_FOLLOWUP:
      process.env.INTELLIGENCE_AGENT_MAX_TOKENS_FOLLOWUP,
    INTELLIGENCE_AGENT_MAX_TOKENS_REPAIR:
      process.env.INTELLIGENCE_AGENT_MAX_TOKENS_REPAIR,
    INTELLIGENCE_AGENT_MAX_TOKENS_NARRATIVE_CAP:
      process.env.INTELLIGENCE_AGENT_MAX_TOKENS_NARRATIVE_CAP,

    // Data providers
    OPENWEATHER_API_KEY: process.env.OPENWEATHER_API_KEY,
    TICKETMASTER_API_KEY: process.env.TICKETMASTER_API_KEY,
    GOOGLE_PLACES_API_KEY: process.env.GOOGLE_PLACES_API_KEY,
    NYC_DOT_CLOSURES_URL: process.env.NYC_DOT_CLOSURES_URL,
    NYC_OPEN_DATA_APP_TOKEN: process.env.NYC_OPEN_DATA_APP_TOKEN,

    // Client-side
    NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN:
      process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN,
    NEXT_PUBLIC_GOOGLE_MAPS_API_KEY:
      process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY,
    NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
    NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
  },
  /**
   * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially
   * useful for Docker builds.
   */
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  /**
   * Makes it so that empty strings are treated as undefined. `SOME_VAR: z.string()` and
   * `SOME_VAR=''` will throw an error.
   */
  emptyStringAsUndefined: true,
});
