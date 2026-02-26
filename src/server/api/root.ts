import { postRouter } from "@/server/api/routers/post";
import { aiRouter } from "@/server/api/routers/ai";
import { weatherRouter } from "@/server/api/routers/weather";
import { eventsRouter } from "@/server/api/routers/events";
import { placesRouter } from "@/server/api/routers/places";
import { intelligenceRouter } from "@/server/api/routers/intelligence";
import { createCallerFactory, createTRPCRouter } from "@/server/api/trpc";

/**
 * This is the primary router for your server.
 *
 * All routers added in /api/routers should be manually added here.
 */
export const appRouter = createTRPCRouter({
  post: postRouter,
  ai: aiRouter,
  weather: weatherRouter,
  events: eventsRouter,
  places: placesRouter,
  intelligence: intelligenceRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;

/**
 * Create a server-side caller for the tRPC API.
 * @example
 * const trpc = createCaller(createContext);
 * const res = await trpc.post.all();
 *       ^? Post[]
 */
export const createCaller = createCallerFactory(appRouter);
