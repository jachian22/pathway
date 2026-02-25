import { env } from "@/env";

interface PlaceReview {
  name: string;
  relativePublishTimeDescription: string;
  rating: number;
  text: {
    text: string;
    languageCode: string;
  };
  authorAttribution: {
    displayName: string;
    uri: string;
    photoUri: string;
  };
  publishTime: string;
}

interface Place {
  id: string;
  displayName: { text: string; languageCode: string };
  formattedAddress: string;
  location: { latitude: number; longitude: number };
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string;
  types?: string[];
  regularOpeningHours?: {
    openNow: boolean;
    weekdayDescriptions: string[];
  };
  reviews?: PlaceReview[];
  photos?: { name: string; widthPx: number; heightPx: number }[];
  websiteUri?: string;
  nationalPhoneNumber?: string;
}

interface PlaceSearchResponse {
  places: Place[];
}

const BASE_URL = "https://places.googleapis.com/v1";

export async function searchPlaces(params: {
  query: string;
  location?: { lat: number; lon: number };
  radius?: number;
  type?: string;
  maxResults?: number;
}): Promise<Place[]> {
  const requestBody: Record<string, unknown> = {
    textQuery: params.query,
    maxResultCount: params.maxResults ?? 10,
  };

  if (params.location) {
    requestBody.locationBias = {
      circle: {
        center: {
          latitude: params.location.lat,
          longitude: params.location.lon,
        },
        radius: params.radius ?? 5000,
      },
    };
  }

  if (params.type) {
    requestBody.includedType = params.type;
  }

  const response = await fetch(`${BASE_URL}/places:searchText`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": env.GOOGLE_PLACES_API_KEY,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.priceLevel,places.types,places.regularOpeningHours,places.photos,places.websiteUri,places.nationalPhoneNumber",
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Google Places API error: ${response.status} - ${error}`);
  }

  const data = (await response.json()) as PlaceSearchResponse;
  return data.places ?? [];
}

export async function getPlaceDetails(placeId: string): Promise<Place> {
  const response = await fetch(`${BASE_URL}/places/${placeId}`, {
    method: "GET",
    headers: {
      "X-Goog-Api-Key": env.GOOGLE_PLACES_API_KEY,
      "X-Goog-FieldMask":
        "id,displayName,formattedAddress,location,rating,userRatingCount,priceLevel,types,regularOpeningHours,reviews,photos,websiteUri,nationalPhoneNumber",
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Google Places API error: ${response.status} - ${error}`);
  }

  return response.json() as Promise<Place>;
}

export async function getNearbyPlaces(params: {
  lat: number;
  lon: number;
  radius?: number;
  type?: string;
  maxResults?: number;
}): Promise<Place[]> {
  const requestBody: Record<string, unknown> = {
    locationRestriction: {
      circle: {
        center: {
          latitude: params.lat,
          longitude: params.lon,
        },
        radius: params.radius ?? 1000,
      },
    },
    maxResultCount: params.maxResults ?? 10,
  };

  if (params.type) {
    requestBody.includedTypes = [params.type];
  }

  const response = await fetch(`${BASE_URL}/places:searchNearby`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": env.GOOGLE_PLACES_API_KEY,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.priceLevel,places.types,places.regularOpeningHours,places.photos",
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Google Places API error: ${response.status} - ${error}`);
  }

  const data = (await response.json()) as PlaceSearchResponse;
  return data.places ?? [];
}

export function getPhotoUrl(photoName: string, maxWidth: number = 400): string {
  return `${BASE_URL}/${photoName}/media?maxWidthPx=${maxWidth}&key=${env.GOOGLE_PLACES_API_KEY}`;
}
