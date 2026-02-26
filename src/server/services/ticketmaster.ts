import { env } from "@/env";

interface EventImage {
  url: string;
  width: number;
  height: number;
  ratio?: string;
}

interface EventVenue {
  id: string;
  name: string;
  city?: { name: string };
  state?: { name: string; stateCode: string };
  country?: { name: string; countryCode: string };
  address?: { line1: string };
  location?: { longitude: string; latitude: string };
}

interface EventDate {
  localDate: string;
  localTime?: string;
  dateTime?: string;
  status?: { code: string };
}

interface Event {
  id: string;
  name: string;
  type: string;
  url: string;
  images: EventImage[];
  dates: {
    start: EventDate;
    end?: EventDate;
    status?: { code: string };
  };
  classifications?: {
    segment?: { id: string; name: string };
    genre?: { id: string; name: string };
    subGenre?: { id: string; name: string };
  }[];
  priceRanges?: {
    type: string;
    currency: string;
    min: number;
    max: number;
  }[];
  _embedded?: {
    venues?: EventVenue[];
  };
}

interface EventSearchResponse {
  _embedded?: {
    events: Event[];
  };
  page: {
    size: number;
    totalElements: number;
    totalPages: number;
    number: number;
  };
}

const BASE_URL = "https://app.ticketmaster.com/discovery/v2";

export async function searchEvents(params: {
  keyword?: string;
  city?: string;
  stateCode?: string;
  latlong?: string;
  radius?: number;
  unit?: "miles" | "km";
  startDateTime?: string;
  endDateTime?: string;
  classificationName?: string;
  size?: number;
  page?: number;
  sort?: string;
}): Promise<EventSearchResponse> {
  const searchParams = new URLSearchParams({
    apikey: env.TICKETMASTER_API_KEY,
    size: String(params.size ?? 20),
    page: String(params.page ?? 0),
  });

  if (params.keyword) searchParams.set("keyword", params.keyword);
  if (params.city) searchParams.set("city", params.city);
  if (params.stateCode) searchParams.set("stateCode", params.stateCode);
  if (params.latlong) searchParams.set("latlong", params.latlong);
  if (params.radius) searchParams.set("radius", String(params.radius));
  if (params.unit) searchParams.set("unit", params.unit);
  if (params.startDateTime)
    searchParams.set("startDateTime", params.startDateTime);
  if (params.endDateTime) searchParams.set("endDateTime", params.endDateTime);
  if (params.classificationName)
    searchParams.set("classificationName", params.classificationName);
  if (params.sort) searchParams.set("sort", params.sort);

  const url = `${BASE_URL}/events.json?${searchParams.toString()}`;

  const response = await fetch(url);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Ticketmaster API error: ${response.status} - ${error}`);
  }

  return response.json() as Promise<EventSearchResponse>;
}

export async function getEventById(eventId: string): Promise<Event> {
  const url = `${BASE_URL}/events/${eventId}.json?apikey=${env.TICKETMASTER_API_KEY}`;

  const response = await fetch(url);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Ticketmaster API error: ${response.status} - ${error}`);
  }

  return response.json() as Promise<Event>;
}

export async function searchVenues(params: {
  keyword?: string;
  city?: string;
  stateCode?: string;
  latlong?: string;
  radius?: number;
  size?: number;
  page?: number;
}): Promise<{
  _embedded?: { venues: EventVenue[] };
  page: EventSearchResponse["page"];
}> {
  const searchParams = new URLSearchParams({
    apikey: env.TICKETMASTER_API_KEY,
    size: String(params.size ?? 20),
    page: String(params.page ?? 0),
  });

  if (params.keyword) searchParams.set("keyword", params.keyword);
  if (params.city) searchParams.set("city", params.city);
  if (params.stateCode) searchParams.set("stateCode", params.stateCode);
  if (params.latlong) searchParams.set("latlong", params.latlong);
  if (params.radius) searchParams.set("radius", String(params.radius));

  const url = `${BASE_URL}/venues.json?${searchParams.toString()}`;

  const response = await fetch(url);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Ticketmaster API error: ${response.status} - ${error}`);
  }

  return response.json() as Promise<{
    _embedded?: { venues: EventVenue[] };
    page: EventSearchResponse["page"];
  }>;
}
