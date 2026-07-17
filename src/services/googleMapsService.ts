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

// The Distance Matrix service rejects requests whose origins × destinations
// product exceeds 100 elements (MAX_ELEMENTS_EXCEEDED). A full N×N matrix
// therefore breaks at N ≥ 11 — i.e. 10 visits + start point — so the origin
// rows are chunked into multiple requests and the rows reassembled in order.
const MAX_MATRIX_ELEMENTS_PER_REQUEST = 100;

async function getDistanceMatrixViaSdk(
  points: (string | google.maps.LatLngLiteral)[]
): Promise<DistanceMatrixLike> {
  const service = new google.maps.DistanceMatrixService();
  const rowsPerRequest = Math.max(1, Math.floor(MAX_MATRIX_ELEMENTS_PER_REQUEST / points.length));
  const rows: DistanceMatrixLike['rows'] = [];

  for (let i = 0; i < points.length; i += rowsPerRequest) {
    const originChunk = points.slice(i, i + rowsPerRequest);
    const response = await new Promise<google.maps.DistanceMatrixResponse>((resolve, reject) => {
      service.getDistanceMatrix(
        {
          origins: originChunk,
          destinations: points,
          travelMode: google.maps.TravelMode.DRIVING,
        },
        (resp, status) => {
          if (status === google.maps.DistanceMatrixStatus.OK && resp) {
            resolve(resp);
          } else {
            reject(new Error(String(status)));
          }
        }
      );
    });
    // Re-shape into our minimal DistanceMatrixLike (rows/elements/duration/distance).
    rows.push(...response.rows.map((row: any) => ({
      elements: row.elements.map((el: any) => ({
        duration: el.duration ? { value: el.duration.value } : undefined,
        distance: el.distance ? { value: el.distance.value } : undefined,
      })),
    })));
  }

  return { rows };
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
