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
