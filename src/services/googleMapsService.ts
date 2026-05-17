import { LunchInfo } from "../types";

// All Google Maps Platform billable calls (Geocoding, Distance Matrix, Places)
// are routed through our own /api/* proxies. This keeps the high-cost key off
// the client bundle and lets the server enforce rate limits.
// The Map JS API key on the client should be a separate, referrer-restricted
// key with only "Maps JavaScript API" enabled.

type MatrixElement = {
  duration?: { value: number };
  distance?: { value: number };
};

export type DistanceMatrixLike = {
  rows: { elements: MatrixElement[] }[];
};

async function postJSON<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`${url} -> ${res.status} ${txt}`);
  }
  return res.json() as Promise<T>;
}

export async function getDistanceMatrix(
  origins: (string | google.maps.LatLngLiteral)[],
  destinations: (string | google.maps.LatLngLiteral)[]
): Promise<DistanceMatrixLike> {
  // The proxy uses a single point list for both origins and destinations,
  // matching how the caller invokes it (getDistanceMatrix(points, points)).
  // If origins and destinations diverge in the future, extend the API instead
  // of duplicating here.
  if (origins.length !== destinations.length) {
    throw new Error("origins and destinations must match (server proxy assumes a single point list)");
  }
  return postJSON<DistanceMatrixLike>("/api/distance-matrix", { points: origins });
}

const GEOCODE_CACHE_KEY = 'geocode_cache_v1';
const GEOCODE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

type GeocodeCacheEntry = { coords: google.maps.LatLngLiteral; ts: number };

function readGeocodeCache(): Record<string, GeocodeCacheEntry> {
  try {
    const raw = localStorage.getItem(GEOCODE_CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeGeocodeCache(cache: Record<string, GeocodeCacheEntry>): void {
  try {
    localStorage.setItem(GEOCODE_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // quota exceeded or unavailable — silently ignore
  }
}

function normalizeAddress(address: string): string {
  return address.trim().replace(/\s+/g, ' ');
}

export async function geocodeAddress(address: string): Promise<google.maps.LatLngLiteral> {
  const key = normalizeAddress(address);
  if (!key) throw new Error('empty address');

  const cache = readGeocodeCache();
  const hit = cache[key];
  if (hit && Date.now() - hit.ts < GEOCODE_CACHE_TTL_MS) {
    return hit.coords;
  }

  const coords = await postJSON<google.maps.LatLngLiteral>("/api/geocode", { address });
  cache[key] = { coords, ts: Date.now() };
  writeGeocodeCache(cache);
  return coords;
}

type PlacesSearchResponse = {
  places: {
    displayName: string;
    formattedAddress: string;
    rating?: number;
    location?: google.maps.LatLngLiteral;
  }[];
};

export async function findLunchSpots(
  location: google.maps.LatLngLiteral,
  query: string,
  limit: number = 5,
  icon: string = '🍔'
): Promise<LunchInfo[]> {
  if (!query) return [];

  try {
    const data = await postJSON<PlacesSearchResponse>("/api/places/search", {
      textQuery: query,
      center: location,
      maxResultCount: limit,
    });
    return (data.places || []).map(p => ({
      name: p.displayName || '昼食',
      address: p.formattedAddress || '',
      rating: p.rating,
      location: p.location,
      type: query,
      icon,
    }));
  } catch (error) {
    console.error("Places API Error:", error);
    return [];
  }
}
