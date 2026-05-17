import { LunchInfo } from "../types";
import { isDemoMode } from "../lib/demoMode";

// Maps Platform billable calls route through one of two paths:
//
//   1. Normal build → POST /api/* (our Express proxy). Keeps the high-spend
//      key off the client and applies the server-side rate limiter.
//   2. Demo build (GitHub Pages, no backend) → Maps JavaScript SDK loaded by
//      <APIProvider>. The key is exposed in the bundle, but is mitigated by
//      GCP-side restrictions (HTTP referrer + API restriction + daily quota).
//
// The map UI itself (markers, polylines) always uses the client SDK.

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

// ----------------------------------------------------------------------------
// Distance Matrix
// ----------------------------------------------------------------------------

async function getDistanceMatrixViaSdk(
  points: (string | google.maps.LatLngLiteral)[]
): Promise<DistanceMatrixLike> {
  const service = new google.maps.DistanceMatrixService();
  return new Promise((resolve, reject) => {
    service.getDistanceMatrix(
      {
        origins: points,
        destinations: points,
        travelMode: google.maps.TravelMode.DRIVING,
      },
      (response, status) => {
        if (status === google.maps.DistanceMatrixStatus.OK && response) {
          // Re-shape into our minimal DistanceMatrixLike (rows/elements/duration/distance).
          resolve({
            rows: response.rows.map((row: any) => ({
              elements: row.elements.map((el: any) => ({
                duration: el.duration ? { value: el.duration.value } : undefined,
                distance: el.distance ? { value: el.distance.value } : undefined,
              })),
            })),
          });
        } else {
          reject(new Error(String(status)));
        }
      }
    );
  });
}

export async function getDistanceMatrix(
  origins: (string | google.maps.LatLngLiteral)[],
  destinations: (string | google.maps.LatLngLiteral)[]
): Promise<DistanceMatrixLike> {
  if (origins.length !== destinations.length) {
    throw new Error("origins and destinations must match (caller passes the same point list)");
  }
  if (isDemoMode()) return getDistanceMatrixViaSdk(origins);
  return postJSON<DistanceMatrixLike>("/api/distance-matrix", { points: origins });
}

// ----------------------------------------------------------------------------
// Geocoding (with localStorage cache shared by both paths)
// ----------------------------------------------------------------------------

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

async function geocodeViaSdk(address: string): Promise<google.maps.LatLngLiteral> {
  const geocoder = new google.maps.Geocoder();
  return new Promise((resolve, reject) => {
    geocoder.geocode({ address }, (results, status) => {
      if (status === google.maps.GeocoderStatus.OK && results?.[0]) {
        const loc = results[0].geometry.location;
        resolve({ lat: loc.lat(), lng: loc.lng() });
      } else {
        reject(new Error(String(status)));
      }
    });
  });
}

export async function geocodeAddress(address: string): Promise<google.maps.LatLngLiteral> {
  const key = normalizeAddress(address);
  if (!key) throw new Error('empty address');

  const cache = readGeocodeCache();
  const hit = cache[key];
  if (hit && Date.now() - hit.ts < GEOCODE_CACHE_TTL_MS) {
    return hit.coords;
  }

  const coords = isDemoMode()
    ? await geocodeViaSdk(address)
    : await postJSON<google.maps.LatLngLiteral>("/api/geocode", { address });

  cache[key] = { coords, ts: Date.now() };
  writeGeocodeCache(cache);
  return coords;
}

// ----------------------------------------------------------------------------
// Places — lunch search
// ----------------------------------------------------------------------------

type PlacesSearchResponse = {
  places: {
    displayName: string;
    formattedAddress: string;
    rating?: number;
    location?: google.maps.LatLngLiteral;
  }[];
};

async function findLunchSpotsViaSdk(
  location: google.maps.LatLngLiteral,
  query: string,
  limit: number
): Promise<PlacesSearchResponse['places']> {
  const { Place } = (await google.maps.importLibrary("places")) as any;
  const response = await Place.searchByText({
    textQuery: query,
    fields: ['displayName', 'location', 'formattedAddress', 'rating'],
    locationRestriction: {
      north: location.lat + 0.03,
      south: location.lat - 0.03,
      east: location.lng + 0.03,
      west: location.lng - 0.03,
    },
    maxResultCount: limit,
  });
  if (!response.places) return [];
  return response.places.map((p: any) => ({
    displayName: p.displayName || '',
    formattedAddress: p.formattedAddress || '',
    rating: p.rating ?? undefined,
    location: p.location ? { lat: p.location.lat(), lng: p.location.lng() } : undefined,
  }));
}

export async function findLunchSpots(
  location: google.maps.LatLngLiteral,
  query: string,
  limit: number = 5,
  icon: string = '🍔'
): Promise<LunchInfo[]> {
  if (!query) return [];
  try {
    const places = isDemoMode()
      ? await findLunchSpotsViaSdk(location, query, limit)
      : (await postJSON<PlacesSearchResponse>("/api/places/search", {
          textQuery: query,
          center: location,
          maxResultCount: limit,
        })).places;

    return (places || []).map(p => ({
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
