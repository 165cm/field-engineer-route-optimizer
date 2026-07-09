import { Visit, RoutePlan, Settings, Leg } from "../types";
import type { DistanceMatrixLike } from "../services/googleMapsService";

type MatrixElementLike = DistanceMatrixLike["rows"][number]["elements"][number];

export function parseTime(timeStr: string): number {
  if (typeof timeStr !== "string") return 0;
  const [h, m] = timeStr.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return h * 60 + m;
}

export function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export const PREP_MIN = 15;
export const CLEANUP_MIN = 15;

// Work durations are always multiples of 20 min, so snapping each work-start up
// to the next 20-min boundary keeps every start/end on a tidy clock time
// (…:00 / :20 / :40) and absorbs travel/prep jitter as a little slack.
export const WORK_START_UNIT_MIN = 20;

export function roundUpToUnit(minutes: number, unit: number = WORK_START_UNIT_MIN): number {
  if (unit <= 0) return minutes;
  return Math.ceil(minutes / unit) * unit;
}

// For N <= this threshold, enumerate all N! permutations (exact optimal).
// 8! = 40,320 — scores in well under a second.
// For N > threshold, use nearest-neighbor seeds + 2-opt local search.
const BRUTE_FORCE_THRESHOLD = 8;

export type Baseline = {
  totalDurationMin: number;
  totalDistanceKm: number;
};

/**
 * Baseline = the user's input order, as if they didn't optimize.
 * Returned alongside the optimized plans so the UI can show "you saved X km / Y min".
 */
export function computeInputOrderBaseline(
  visits: Visit[],
  settings: Settings,
  matrix: DistanceMatrixLike
): Baseline {
  const visitCount = visits.length;
  if (visitCount === 0) return { totalDurationMin: 0, totalDistanceKm: 0 };

  let totalDuration = 0;
  let totalDistance = 0;
  let prev = 0;
  for (let i = 1; i <= visitCount; i++) {
    const el = getMatrixElement(matrix, prev, i);
    totalDuration += getTravelTimeMin(el);
    totalDistance += getTravelDistanceKm(el);
    prev = i;
  }
  let endIdx = prev;
  if (settings.endLocation === 'home') endIdx = 0;
  else if (settings.endLocation === 'custom') endIdx = visitCount + 1;

  if (settings.endLocation !== 'none') {
    const el = getMatrixElement(matrix, prev, endIdx);
    totalDuration += getTravelTimeMin(el);
    totalDistance += getTravelDistanceKm(el);
  }
  return { totalDurationMin: totalDuration, totalDistanceKm: totalDistance };
}

export type PlanId = 'A' | 'B' | 'C' | 'X';

const PLAN_LABELS: Record<PlanId, string> = {
  A: '最短',
  B: '余裕',
  C: '短時間',
  X: 'カスタム',
};

function getMatrixElement(matrix: DistanceMatrixLike, fromIdx: number, toIdx: number): MatrixElementLike {
  return matrix.rows[fromIdx]?.elements?.[toIdx] || {};
}

function getTravelTimeMin(element: MatrixElementLike): number {
  return Math.max(0, Math.ceil((element.duration?.value || 0) / 60));
}

function getTravelDistanceKm(element: MatrixElementLike): number {
  return Math.max(0, (element.distance?.value || 0) / 1000);
}

/**
 * Compute a full RoutePlan (legs, totals, end-of-day time) for a given visit
 * ordering. Exposed so the App can rebuild a "custom" plan when the user
 * manually reorders visits without re-running the full optimization.
 *
 * `orderIndices` is 1-based positions into `visits` (matching the matrix's
 * 1..N visit columns; index 0 is the home/start point).
 */
export function calculatePlanForOrder(
  visits: Visit[],
  settings: Settings,
  matrix: DistanceMatrixLike,
  orderIndices: number[],
  planId: PlanId
): RoutePlan {
  const visitCount = visits.length;
  const startMinutes = settings.startTime ? parseTime(settings.startTime) : 9 * 60;
  let currentMinutes = startMinutes;
  let totalDuration = 0;
  let totalDistance = 0;
  const legs: Leg[] = [];
  const orderedVisits: Visit[] = [];

  let prevIdx = 0;
  for (const currIdx of orderIndices) {
    const visit = visits[currIdx - 1];
    if (!visit) continue;
    const distData = getMatrixElement(matrix, prevIdx, currIdx);
    const travelTime = getTravelTimeMin(distData);
    const travelDist = getTravelDistanceKm(distData);

    currentMinutes += travelTime;
    const arrivalTime = formatTime(currentMinutes);

    let status: 'ok' | 'warning' | 'violation' = 'ok';
    if (visit.timeWindow) {
      const hasStart = !!visit.timeWindow.start;
      const hasEnd = !!visit.timeWindow.end;
      const start = hasStart ? parseTime(visit.timeWindow.start) : null;
      const end = hasEnd ? parseTime(visit.timeWindow.end) : null;
      if (end !== null && currentMinutes > end) {
        status = 'violation';
      } else if (
        (end !== null && currentMinutes > end - 30) ||
        (start !== null && currentMinutes < start)
      ) {
        status = 'warning';
      }
      if (start !== null && currentMinutes < start) {
        currentMinutes = start;
      }
    }

    currentMinutes += PREP_MIN;
    // Snap the actual work start up to a clean 20-min boundary.
    currentMinutes = roundUpToUnit(currentMinutes);
    const workStartTime = formatTime(currentMinutes);
    currentMinutes += visit.workMinutes;
    const workEndTime = formatTime(currentMinutes);
    currentMinutes += CLEANUP_MIN;
    const endTime = formatTime(currentMinutes);

    legs.push({
      fromName: prevIdx === 0 ? '起点' : visits[prevIdx - 1].address,
      toName: visit.address,
      durationMin: travelTime,
      distanceKm: travelDist,
      arrivalTime,
      workStartTime,
      workEndTime,
      endTime,
      status,
      visitId: visit.id,
    });

    totalDuration += travelTime;
    totalDistance += travelDist;
    orderedVisits.push(visit);
    prevIdx = currIdx;
  }

  // Final leg back to home / custom end.
  let endIdx = prevIdx;
  if (settings.endLocation === 'home') endIdx = 0;
  else if (settings.endLocation === 'custom') endIdx = visitCount + 1;

  if (settings.endLocation !== 'none' && orderIndices.length > 0) {
    const distData = getMatrixElement(matrix, prevIdx, endIdx);
    const travelTime = getTravelTimeMin(distData);
    const travelDist = getTravelDistanceKm(distData);
    currentMinutes += travelTime;
    totalDuration += travelTime;
    totalDistance += travelDist;
    legs.push({
      fromName: visits[prevIdx - 1].address,
      toName: '終点',
      durationMin: travelTime,
      distanceKm: travelDist,
      arrivalTime: formatTime(currentMinutes - travelTime),
      endTime: formatTime(currentMinutes),
      status: 'ok',
    });
  }

  return {
    id: planId,
    label: PLAN_LABELS[planId],
    order: orderedVisits,
    legs,
    totalDurationMin: totalDuration,
    totalDistanceKm: totalDistance,
    endTime: formatTime(currentMinutes),
  };
}

// ---------------------------------------------------------------------------
// Permutation helpers (brute-force path, N <= BRUTE_FORCE_THRESHOLD)
// ---------------------------------------------------------------------------

function generateAllPermutations(arr: number[]): number[][] {
  const result: number[][] = [];
  const gen = (remaining: number[], current: number[]) => {
    if (remaining.length === 0) { result.push(current); return; }
    for (let i = 0; i < remaining.length; i++) {
      const next = remaining.slice();
      const [item] = next.splice(i, 1);
      gen(next, [...current, item]);
    }
  };
  gen(arr, []);
  return result;
}

// ---------------------------------------------------------------------------
// Heuristic helpers (large-N path, N > BRUTE_FORCE_THRESHOLD)
// ---------------------------------------------------------------------------

function matrixTravelTime(matrix: DistanceMatrixLike, from: number, to: number): number {
  return Math.max(0, Math.ceil((matrix.rows[from]?.elements?.[to]?.duration?.value ?? 0) / 60));
}

function orderTotalTravelTime(order: number[], matrix: DistanceMatrixLike): number {
  let total = 0;
  let prev = 0;
  for (const idx of order) {
    total += matrixTravelTime(matrix, prev, idx);
    prev = idx;
  }
  return total;
}

function nearestNeighborOrder(indices: number[], matrix: DistanceMatrixLike): number[] {
  const remaining = new Set(indices);
  const order: number[] = [];
  let current = 0;
  while (remaining.size > 0) {
    let best = -1;
    let bestTime = Infinity;
    for (const idx of remaining) {
      const t = matrixTravelTime(matrix, current, idx);
      if (t < bestTime) { bestTime = t; best = idx; }
    }
    if (best === -1) break;
    order.push(best);
    remaining.delete(best);
    current = best;
  }
  return order;
}

// 2-opt local search using raw travel time as the cost metric.
// This is fast and sufficient to escape poor orderings, even though the final
// scoring uses time-window penalties — 2-opt on travel time is a good proxy.
function twoOptImprove(order: number[], matrix: DistanceMatrixLike): number[] {
  let best = order.slice();
  let improved = true;
  while (improved) {
    improved = false;
    const n = best.length;
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const candidate = [
          ...best.slice(0, i),
          ...best.slice(i, j + 1).reverse(),
          ...best.slice(j + 1),
        ];
        if (orderTotalTravelTime(candidate, matrix) < orderTotalTravelTime(best, matrix)) {
          best = candidate;
          improved = true;
        }
      }
    }
  }
  return best;
}

/**
 * Generate a diverse set of candidate orderings for large N using several
 * seeding strategies, each followed by 2-opt refinement.
 */
function generateHeuristicCandidates(
  indices: number[],
  matrix: DistanceMatrixLike,
  visits: Visit[]
): number[][] {
  const seen = new Set<string>();
  const candidates: number[][] = [];

  const add = (order: number[]) => {
    const key = order.join(',');
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(order);
  };

  // 1. Nearest-neighbor greedy from home
  const nn = nearestNeighborOrder(indices, matrix);
  add(nn);
  add(twoOptImprove(nn, matrix));

  // 2. Reversed NN (often a different local optimum)
  const nnRev = [...nn].reverse();
  add(nnRev);
  add(twoOptImprove(nnRev, matrix));

  // 3. Short-work-first seed (Plan C strategy: short jobs → long jobs)
  const byShortWork = indices.slice().sort((a, b) =>
    (visits[a - 1]?.workMinutes ?? 60) - (visits[b - 1]?.workMinutes ?? 60)
  );
  add(byShortWork);
  add(twoOptImprove(byShortWork, matrix));

  // 4. Earliest-deadline-first (favours time-window compliance)
  const byDeadline = indices.slice().sort((a, b) => {
    const ea = visits[a - 1]?.timeWindow?.end ? parseTime(visits[a - 1].timeWindow!.end) : 9999;
    const eb = visits[b - 1]?.timeWindow?.end ? parseTime(visits[b - 1].timeWindow!.end) : 9999;
    return ea - eb;
  });
  add(byDeadline);
  add(twoOptImprove(byDeadline, matrix));

  // 5. Furthest-first from home (visit the most distant stops before returning)
  const byFurthest = indices.slice().sort((a, b) =>
    matrixTravelTime(matrix, 0, b) - matrixTravelTime(matrix, 0, a)
  );
  add(byFurthest);
  add(twoOptImprove(byFurthest, matrix));

  return candidates;
}

export function optimizeRoutes(
  visits: Visit[],
  settings: Settings,
  matrix: DistanceMatrixLike
): RoutePlan[] {
  const visitCount = visits.length;
  const indices = Array.from({ length: visitCount }, (_, i) => i + 1);

  // Choose candidate generation strategy based on N.
  const candidateOrders: number[][] =
    visitCount <= BRUTE_FORCE_THRESHOLD
      ? generateAllPermutations(indices)
      : generateHeuristicCandidates(indices, matrix, visits);

  const allPlans = candidateOrders.map(p => {
    const plan = calculatePlanForOrder(visits, settings, matrix, p, 'A');
    const legByVisitId = new Map(plan.legs.filter(l => l.visitId).map(l => [l.visitId, l]));

    const violations = plan.legs.filter(l => l.status === 'violation').length;
    const warnings = plan.legs.filter(l => l.status === 'warning').length;
    const penalty = violations * 10000 + warnings * 30;

    const scoreA = plan.totalDurationMin + penalty;

    let centeringDiff = 0;
    plan.order.forEach(v => {
      const leg = legByVisitId.get(v.id);
      if (!leg) return;
      const arrival = parseTime(leg.arrivalTime);
      if (v.timeWindow) {
        const hasStart = !!v.timeWindow.start;
        const hasEnd = !!v.timeWindow.end;
        if (hasStart && hasEnd) {
          const center = (parseTime(v.timeWindow.start) + parseTime(v.timeWindow.end)) / 2;
          centeringDiff += Math.abs(arrival - center);
        } else if (hasEnd) {
          centeringDiff += Math.max(0, arrival - parseTime(v.timeWindow.end));
        } else if (hasStart) {
          centeringDiff += Math.max(0, parseTime(v.timeWindow.start) - arrival);
        }
      }
    });
    const scoreB = plan.totalDurationMin * 0.3 + centeringDiff + penalty;

    let shortWorkOrderPenalty = 0;
    let shortWorkBeforeNoonBonus = 0;
    plan.order.forEach((v, i) => {
      const remainingRank = visitCount - i;
      shortWorkOrderPenalty += v.workMinutes * remainingRank * 0.4;
      const leg = legByVisitId.get(v.id);
      if (!leg) return;
      const endTime = parseTime(leg.endTime);
      if (v.workMinutes <= 40 && endTime <= 12 * 60) {
        shortWorkBeforeNoonBonus -= 20;
      }
    });
    const scoreC = plan.totalDurationMin * 0.3 + shortWorkOrderPenalty + shortWorkBeforeNoonBonus + penalty;

    return { p, scores: { A: scoreA, B: scoreB, C: scoreC } };
  });

  const bestA = allPlans.slice().sort((a, b) => a.scores.A - b.scores.A)[0].p;
  const bestB = allPlans.slice().sort((a, b) => a.scores.B - b.scores.B)[0].p;
  const bestC = allPlans.slice().sort((a, b) => a.scores.C - b.scores.C)[0].p;

  return [
    calculatePlanForOrder(visits, settings, matrix, bestA, 'A'),
    calculatePlanForOrder(visits, settings, matrix, bestB, 'B'),
    calculatePlanForOrder(visits, settings, matrix, bestC, 'C'),
  ];
}
