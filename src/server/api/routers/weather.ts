import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "@/server/api/trpc";
import {
  getCurrentWeather,
  getForecast,
  getWeatherByCity,
} from "@/server/services/weather";

export const weatherRouter = createTRPCRouter({
  current: publicProcedure
    .input(
      z.object({
        lat: z.number(),
        lon: z.number(),
        units: z.enum(["metric", "imperial"]).default("imperial"),
      }),
    )
    .query(async ({ input }) => {
      const weather = await getCurrentWeather(
        input.lat,
        input.lon,
        input.units,
      );

      return {
        location: weather.name,
        country: weather.sys.country,
        temperature: weather.main.temp,
        feelsLike: weather.main.feels_like,
        humidity: weather.main.humidity,
        description: weather.weather[0]?.description ?? "",
        icon: weather.weather[0]?.icon ?? "",
        windSpeed: weather.wind.speed,
        visibility: weather.visibility,
        sunrise: weather.sys.sunrise,
        sunset: weather.sys.sunset,
      };
    }),

  currentByCity: publicProcedure
    .input(
      z.object({
        city: z.string(),
        units: z.enum(["metric", "imperial"]).default("imperial"),
      }),
    )
    .query(async ({ input }) => {
      const weather = await getWeatherByCity(input.city, input.units);

      return {
        location: weather.name,
        country: weather.sys.country,
        coordinates: weather.coord,
        temperature: weather.main.temp,
        feelsLike: weather.main.feels_like,
        humidity: weather.main.humidity,
        description: weather.weather[0]?.description ?? "",
        icon: weather.weather[0]?.icon ?? "",
        windSpeed: weather.wind.speed,
        visibility: weather.visibility,
        sunrise: weather.sys.sunrise,
        sunset: weather.sys.sunset,
      };
    }),

  forecast: publicProcedure
    .input(
      z.object({
        lat: z.number(),
        lon: z.number(),
        units: z.enum(["metric", "imperial"]).default("imperial"),
      }),
    )
    .query(async ({ input }) => {
      const forecast = await getForecast(input.lat, input.lon, input.units);

      return {
        city: forecast.city.name,
        country: forecast.city.country,
        forecasts: forecast.list.map((item) => ({
          dateTime: item.dt_txt,
          timestamp: item.dt,
          temperature: item.main.temp,
          feelsLike: item.main.feels_like,
          humidity: item.main.humidity,
          description: item.weather[0]?.description ?? "",
          icon: item.weather[0]?.icon ?? "",
          windSpeed: item.wind.speed,
          precipitationChance: item.pop,
        })),
      };
    }),
});
