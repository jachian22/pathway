export const MODEL_ID = "openrouter/haiku";
export const PROMPT_VERSION = "v1.1.0";
export const RULE_VERSION = "v1.1.0";

export const NYC_BOUNDS = {
  minLat: 40.4774,
  maxLat: 40.9176,
  minLon: -74.2591,
  maxLon: -73.7004,
};

export const NYC_BOROUGH_TOKENS = [
  "manhattan",
  "brooklyn",
  "queens",
  "bronx",
  "staten island",
  "new york",
];

export const NYC_ZIP_PREFIXES = ["100", "101", "102", "103", "104", "111", "112", "113", "114", "116"];

export const IMPACT_VENUES = [
  {
    id: "msg",
    name: "Madison Square Garden",
    lat: 40.7505,
    lon: -73.9934,
    impactRadiusMiles: 0.4,
  },
  {
    id: "barclays",
    name: "Barclays Center",
    lat: 40.6826,
    lon: -73.9754,
    impactRadiusMiles: 0.4,
  },
  {
    id: "yankee",
    name: "Yankee Stadium",
    lat: 40.8296,
    lon: -73.9262,
    impactRadiusMiles: 0.3,
  },
  {
    id: "citi",
    name: "Citi Field",
    lat: 40.7571,
    lon: -73.8458,
    impactRadiusMiles: 0.3,
  },
  {
    id: "ubs",
    name: "UBS Arena",
    lat: 40.7118,
    lon: -73.7260,
    impactRadiusMiles: 0.3,
  },
] as const;

export const SOURCE_TIMEOUTS_MS = {
  geocode: 900,
  weather: 1200,
  events: 1500,
  closures: 1600,
  reviews: 800,
  doe: 250,
};

export const REVIEW_RECENCY_WINDOW_DAYS = 90;
export const REVIEW_OLD_THRESHOLD_DAYS = 180;
