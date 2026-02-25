import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "@/server/api/trpc";
import {
  searchEvents,
  getEventById,
  searchVenues,
} from "@/server/services/ticketmaster";

export const eventsRouter = createTRPCRouter({
  search: publicProcedure
    .input(
      z.object({
        keyword: z.string().optional(),
        city: z.string().optional(),
        stateCode: z.string().optional(),
        lat: z.number().optional(),
        lon: z.number().optional(),
        radius: z.number().optional(),
        unit: z.enum(["miles", "km"]).default("miles"),
        startDateTime: z.string().optional(),
        endDateTime: z.string().optional(),
        category: z.string().optional(),
        size: z.number().min(1).max(100).default(20),
        page: z.number().min(0).default(0),
      })
    )
    .query(async ({ input }) => {
      const latlong =
        input.lat !== undefined && input.lon !== undefined
          ? `${input.lat},${input.lon}`
          : undefined;

      const response = await searchEvents({
        keyword: input.keyword,
        city: input.city,
        stateCode: input.stateCode,
        latlong,
        radius: input.radius,
        unit: input.unit,
        startDateTime: input.startDateTime,
        endDateTime: input.endDateTime,
        classificationName: input.category,
        size: input.size,
        page: input.page,
        sort: "date,asc",
      });

      const events =
        response._embedded?.events.map((event) => ({
          id: event.id,
          name: event.name,
          url: event.url,
          image: event.images.find((img) => img.ratio === "16_9")?.url ?? event.images[0]?.url,
          date: event.dates.start.localDate,
          time: event.dates.start.localTime,
          status: event.dates.status?.code,
          venue: event._embedded?.venues?.[0]
            ? {
                name: event._embedded.venues[0].name,
                city: event._embedded.venues[0].city?.name,
                state: event._embedded.venues[0].state?.stateCode,
                address: event._embedded.venues[0].address?.line1,
                location: event._embedded.venues[0].location,
              }
            : null,
          category: event.classifications?.[0]?.segment?.name,
          genre: event.classifications?.[0]?.genre?.name,
          priceRange: event.priceRanges?.[0]
            ? {
                min: event.priceRanges[0].min,
                max: event.priceRanges[0].max,
                currency: event.priceRanges[0].currency,
              }
            : null,
        })) ?? [];

      return {
        events,
        pagination: {
          size: response.page.size,
          totalElements: response.page.totalElements,
          totalPages: response.page.totalPages,
          currentPage: response.page.number,
        },
      };
    }),

  getById: publicProcedure
    .input(z.object({ eventId: z.string() }))
    .query(async ({ input }) => {
      const event = await getEventById(input.eventId);

      return {
        id: event.id,
        name: event.name,
        url: event.url,
        images: event.images,
        date: event.dates.start.localDate,
        time: event.dates.start.localTime,
        status: event.dates.status?.code,
        venue: event._embedded?.venues?.[0]
          ? {
              name: event._embedded.venues[0].name,
              city: event._embedded.venues[0].city?.name,
              state: event._embedded.venues[0].state?.stateCode,
              address: event._embedded.venues[0].address?.line1,
              location: event._embedded.venues[0].location,
            }
          : null,
        classifications: event.classifications,
        priceRanges: event.priceRanges,
      };
    }),

  venues: publicProcedure
    .input(
      z.object({
        keyword: z.string().optional(),
        city: z.string().optional(),
        stateCode: z.string().optional(),
        lat: z.number().optional(),
        lon: z.number().optional(),
        radius: z.number().optional(),
        size: z.number().min(1).max(100).default(20),
        page: z.number().min(0).default(0),
      })
    )
    .query(async ({ input }) => {
      const latlong =
        input.lat !== undefined && input.lon !== undefined
          ? `${input.lat},${input.lon}`
          : undefined;

      const response = await searchVenues({
        keyword: input.keyword,
        city: input.city,
        stateCode: input.stateCode,
        latlong,
        radius: input.radius,
        size: input.size,
        page: input.page,
      });

      const venues =
        response._embedded?.venues.map((venue) => ({
          id: venue.id,
          name: venue.name,
          city: venue.city?.name,
          state: venue.state?.stateCode,
          country: venue.country?.countryCode,
          address: venue.address?.line1,
          location: venue.location,
        })) ?? [];

      return {
        venues,
        pagination: {
          size: response.page.size,
          totalElements: response.page.totalElements,
          totalPages: response.page.totalPages,
          currentPage: response.page.number,
        },
      };
    }),
});
