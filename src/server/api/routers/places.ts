import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "@/server/api/trpc";
import {
  searchPlaces,
  getPlaceDetails,
  getNearbyPlaces,
  getPhotoUrl,
} from "@/server/services/google-places";

export const placesRouter = createTRPCRouter({
  search: publicProcedure
    .input(
      z.object({
        query: z.string(),
        lat: z.number().optional(),
        lon: z.number().optional(),
        radius: z.number().optional(),
        type: z.string().optional(),
        maxResults: z.number().min(1).max(20).default(10),
      })
    )
    .query(async ({ input }) => {
      const location =
        input.lat !== undefined && input.lon !== undefined
          ? { lat: input.lat, lon: input.lon }
          : undefined;

      const places = await searchPlaces({
        query: input.query,
        location,
        radius: input.radius,
        type: input.type,
        maxResults: input.maxResults,
      });

      return places.map((place) => ({
        id: place.id,
        name: place.displayName.text,
        address: place.formattedAddress,
        location: place.location,
        rating: place.rating,
        reviewCount: place.userRatingCount,
        priceLevel: place.priceLevel,
        types: place.types,
        isOpen: place.regularOpeningHours?.openNow,
        photo: place.photos?.[0] ? getPhotoUrl(place.photos[0].name) : null,
        website: place.websiteUri,
        phone: place.nationalPhoneNumber,
      }));
    }),

  nearby: publicProcedure
    .input(
      z.object({
        lat: z.number(),
        lon: z.number(),
        radius: z.number().default(1000),
        type: z.string().optional(),
        maxResults: z.number().min(1).max(20).default(10),
      })
    )
    .query(async ({ input }) => {
      const places = await getNearbyPlaces({
        lat: input.lat,
        lon: input.lon,
        radius: input.radius,
        type: input.type,
        maxResults: input.maxResults,
      });

      return places.map((place) => ({
        id: place.id,
        name: place.displayName.text,
        address: place.formattedAddress,
        location: place.location,
        rating: place.rating,
        reviewCount: place.userRatingCount,
        priceLevel: place.priceLevel,
        types: place.types,
        isOpen: place.regularOpeningHours?.openNow,
        photo: place.photos?.[0] ? getPhotoUrl(place.photos[0].name) : null,
      }));
    }),

  details: publicProcedure
    .input(z.object({ placeId: z.string() }))
    .query(async ({ input }) => {
      const place = await getPlaceDetails(input.placeId);

      return {
        id: place.id,
        name: place.displayName.text,
        address: place.formattedAddress,
        location: place.location,
        rating: place.rating,
        reviewCount: place.userRatingCount,
        priceLevel: place.priceLevel,
        types: place.types,
        isOpen: place.regularOpeningHours?.openNow,
        hours: place.regularOpeningHours?.weekdayDescriptions,
        website: place.websiteUri,
        phone: place.nationalPhoneNumber,
        photos: place.photos?.map((p) => getPhotoUrl(p.name)),
        reviews: place.reviews?.map((review) => ({
          author: review.authorAttribution.displayName,
          authorPhoto: review.authorAttribution.photoUri,
          rating: review.rating,
          text: review.text.text,
          time: review.relativePublishTimeDescription,
          publishedAt: review.publishTime,
        })),
      };
    }),
});
