// Groups route pins that would visually overlap at the current map zoom so
// the UI can render their number badges side by side instead of stacking
// them on top of each other (e.g. two jobs at the same building).

type LatLng = { lat: number; lng: number };

const WORLD_PX = 256;

// Web-mercator projection to absolute pixel coordinates at the given zoom.
// Matches how Google Maps lays out tiles, so pixel distance between two
// projected points equals their on-screen distance.
export function projectToWorldPx(coords: LatLng, zoom: number): { x: number; y: number } {
  const scale = WORLD_PX * Math.pow(2, zoom);
  const siny = Math.min(Math.max(Math.sin((coords.lat * Math.PI) / 180), -0.9999), 0.9999);
  return {
    x: scale * (0.5 + coords.lng / 360),
    y: scale * (0.5 - Math.log((1 + siny) / (1 - siny)) / (4 * Math.PI)),
  };
}

export type PinCluster<T> = { coords: LatLng; items: T[] };

// Greedy clustering in input order: an item joins the first cluster whose
// anchor lies within thresholdPx on screen, otherwise it starts a new
// cluster. Items without coords are skipped.
export function clusterByPixelDistance<T>(
  items: T[],
  getCoords: (item: T) => LatLng | undefined,
  zoom: number,
  thresholdPx: number
): PinCluster<T>[] {
  const clusters: (PinCluster<T> & { px: { x: number; y: number } })[] = [];
  items.forEach(item => {
    const coords = getCoords(item);
    if (!coords) return;
    const px = projectToWorldPx(coords, zoom);
    const hit = clusters.find(c => Math.hypot(c.px.x - px.x, c.px.y - px.y) < thresholdPx);
    if (hit) {
      hit.items.push(item);
    } else {
      clusters.push({ coords, items: [item], px });
    }
  });
  return clusters.map(({ coords, items: clusterItems }) => ({ coords, items: clusterItems }));
}

const EARTH_RADIUS_M = 6371000;

export function haversineDistanceM(a: LatLng, b: LatLng): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

// Spread of a cluster = distance between its two farthest members. For the
// common 2-visit case this is simply the distance between them.
export function maxPairwiseDistanceM(points: LatLng[]): number {
  let max = 0;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      max = Math.max(max, haversineDistanceM(points[i], points[j]));
    }
  }
  return max;
}

// Label shown inside a grouped pin so the user can judge e.g. whether one
// parking spot between the jobs covers both on foot.
export function formatClusterSpread(distanceM: number): string {
  if (distanceM < 15) return '同一地点';
  if (distanceM < 1000) return `約${Math.round(distanceM / 10) * 10}m`;
  return `約${(distanceM / 1000).toFixed(1)}km`;
}
