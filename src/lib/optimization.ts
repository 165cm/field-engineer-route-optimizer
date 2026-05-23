import { Visit, RoutePlan, Settings, Leg } from "../types";
import type { DistanceMatrixLike } from "../services/googleMapsService";

export function parseTime(timeStr: string): number {
  const [h, m] = timeStr.split(":").map(Number);
  return h * 60 + m;
}

export function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export const PREP_MIN = 15;
export const CLEANUP_MIN = 15;

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
    const el = matrix.rows[prev]?.elements[i];
    totalDuration += Math.ceil((el?.duration?.value || 0) / 60);
    totalDistance += (el?.distance?.value || 0) / 1000;
    prev = i;
  }
  let endIdx = prev;
  if (settings.endLocation === 'home') endIdx = 0;
  else if (settings.endLocation === 'custom') endIdx = visitCount + 1;

  if (settings.endLocation !== 'none') {
    const el = matrix.rows[prev]?.elements[endIdx];
    totalDuration += Math.ceil((el?.duration?.value || 0) / 60);
    totalDistance += (el?.distance?.value || 0) / 1000;
  }
  return { totalDurationMin: totalDuration, totalDistanceKm: totalDistance };
}

export type PlanId = 'A' | 'B' | 'C' | 'X';

const PLAN_LABELS: Record<PlanId, string> = {
  A: '最短',
  B: '余裕',
  C: '確実',
  X: 'カスタム',
};

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
    const distData = matrix.rows[prevIdx].elements[currIdx];
    const travelTime = Math.ceil((distData.duration?.value || 0) / 60);
    const travelDist = (distData.distance?.value || 0) / 1000;

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
    const distData = matrix.rows[prevIdx].elements[endIdx];
    const travelTime = Math.ceil((distData.duration?.value || 0) / 60);
    const travelDist = (distData.distance?.value || 0) / 1000;
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

export function optimizeRoutes(
  visits: Visit[],
  settings: Settings,
  matrix: DistanceMatrixLike
): RoutePlan[] {
  const visitCount = visits.length;

  // Generate all permutations of indices [1...N]
  const permutations: number[][] = [];
  function generatePermutations(arr: number[], m: number[] = []) {
    if (arr.length === 0) {
      permutations.push(m);
    } else {
      for (let i = 0; i < arr.length; i++) {
        let curr = arr.slice();
        let next = curr.splice(i, 1);
        generatePermutations(curr.slice(), m.concat(next));
      }
    }
  }
  generatePermutations(Array.from({ length: visitCount }, (_, i) => i + 1));

  const allPlans = permutations.map(p => {
    const plan = calculatePlanForOrder(visits, settings, matrix, p, 'A');

    const violations = plan.legs.filter(l => l.status === 'violation').length;
    const warnings = plan.legs.filter(l => l.status === 'warning').length;
    const penalty = violations * 10000 + warnings * 30;

    const scoreA = plan.totalDurationMin + penalty;

    let centeringDiff = 0;
    plan.order.forEach((v, i) => {
      const arrival = parseTime(plan.legs[i].arrivalTime);
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

    let difficultyOrderPenalty = 0;
    let easyBeforeNoonBonus = 0;
    plan.order.forEach((v, i) => {
      const rank = i + 1;
      difficultyOrderPenalty += v.difficulty * rank * 5;
      const endTime = parseTime(plan.legs[i].endTime);
      if (v.difficulty === 1 && endTime <= 12 * 60) {
        easyBeforeNoonBonus -= 20;
      }
    });
    const scoreC = plan.totalDurationMin * 0.3 + difficultyOrderPenalty + easyBeforeNoonBonus + penalty;

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
