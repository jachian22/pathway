import { env } from "@/env";

interface WeatherCondition {
  id: number;
  main: string;
  description: string;
  icon: string;
}

interface CurrentWeatherResponse {
  coord: { lon: number; lat: number };
  weather: WeatherCondition[];
  main: {
    temp: number;
    feels_like: number;
    temp_min: number;
    temp_max: number;
    pressure: number;
    humidity: number;
  };
  visibility: number;
  wind: { speed: number; deg: number; gust?: number };
  clouds: { all: number };
  dt: number;
  sys: {
    country: string;
    sunrise: number;
    sunset: number;
  };
  timezone: number;
  name: string;
}

interface ForecastResponse {
  list: {
    dt: number;
    main: {
      temp: number;
      feels_like: number;
      temp_min: number;
      temp_max: number;
      humidity: number;
    };
    weather: WeatherCondition[];
    wind: { speed: number; deg: number };
    pop: number; // probability of precipitation
    dt_txt: string;
  }[];
  city: {
    name: string;
    country: string;
    timezone: number;
  };
}

const BASE_URL = "https://api.openweathermap.org/data/2.5";

export async function getCurrentWeather(
  lat: number,
  lon: number,
  units: "metric" | "imperial" = "imperial",
): Promise<CurrentWeatherResponse> {
  const url = `${BASE_URL}/weather?lat=${lat}&lon=${lon}&units=${units}&appid=${env.OPENWEATHER_API_KEY}`;

  const response = await fetch(url);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenWeather API error: ${response.status} - ${error}`);
  }

  return response.json() as Promise<CurrentWeatherResponse>;
}

export async function getForecast(
  lat: number,
  lon: number,
  units: "metric" | "imperial" = "imperial",
): Promise<ForecastResponse> {
  const url = `${BASE_URL}/forecast?lat=${lat}&lon=${lon}&units=${units}&appid=${env.OPENWEATHER_API_KEY}`;

  const response = await fetch(url);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenWeather API error: ${response.status} - ${error}`);
  }

  return response.json() as Promise<ForecastResponse>;
}

export async function getWeatherByCity(
  city: string,
  units: "metric" | "imperial" = "imperial",
): Promise<CurrentWeatherResponse> {
  const url = `${BASE_URL}/weather?q=${encodeURIComponent(city)}&units=${units}&appid=${env.OPENWEATHER_API_KEY}`;

  const response = await fetch(url);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenWeather API error: ${response.status} - ${error}`);
  }

  return response.json() as Promise<CurrentWeatherResponse>;
}
