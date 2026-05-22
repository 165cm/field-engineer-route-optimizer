// Per-visit identity colors. Each entry pairs a vivid "work" color with a
// lighter "prep/cleanup" variant. The list intentionally avoids hues that
// already carry semantic meaning in the chart:
//   - blue  → travel (between visits)
//   - orange → lunch
//   - yellow → time-window warning
//   - red    → time-window violation
// so a visit's color can never be confused with a status indicator.
//
// We cycle through the list when there are more visits than colors. The
// 15-visit cap means colors repeat at most twice in practice — which is rare,
// and the leg cards still carry the numeric position so identity is preserved.

export type VisitColor = {
  work: string;   // Hex for work arc / map marker / number badge / card stripe
  prep: string;   // Hex for prep & cleanup arc — same hue, lighter shade
};

export const VISIT_COLORS: VisitColor[] = [
  { work: '#22d3ee', prep: '#67e8f9' }, // 1: cyan
  { work: '#a78bfa', prep: '#c4b5fd' }, // 2: violet
  { work: '#f472b6', prep: '#f9a8d4' }, // 3: pink
  { work: '#a3e635', prep: '#bef264' }, // 4: lime
  { work: '#818cf8', prep: '#a5b4fc' }, // 5: indigo
  { work: '#e879f9', prep: '#f0abfc' }, // 6: fuchsia
  { work: '#5eead4', prep: '#99f6e4' }, // 7: teal
];

/** Look up a visit's color by its 1-based position in the route. */
export function visitColor(positionOneBased: number): VisitColor {
  const idx = Math.max(1, positionOneBased) - 1;
  return VISIT_COLORS[idx % VISIT_COLORS.length];
}
