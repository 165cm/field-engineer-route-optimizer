import { Visit, RoutePlan, Settings, Leg } from "../types";
import type { DistanceMatrixLike } from "../services/googleMapsService";

function parseTime(timeStr: string): number {
  const [h, m] = timeStr.split(":").map(Number);
  return h * 60 + m;
}

function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

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

export function optimizeRoutes(
  visits: Visit[],
  settings: Settings,
  matrix: DistanceMatrixLike
): RoutePlan[] {
  // Start point is always at index 0 in matrix origins
  // Visits are 1 to N
  // Optional end point if custom
  const visitCount = visits.length;
  
  // Create mapping for lookups
  // 0: Start
  // 1..N: Visits
  // N+1: Custom End (if any)
  
  const points: (string | google.maps.LatLngLiteral)[] = [
    settings.homeCoords || settings.homeAddress,
    ...visits.map(v => v.coords || v.address)
  ];
  if (settings.endLocation === 'custom' && settings.customEndAddress) {
    points.push(settings.customEndCoords || settings.customEndAddress);
  }

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

  const startMinutes = 9 * 60; // Assume 9:00 start if not specified

  function calculatePlan(orderIndices: number[], planId: 'A' | 'B' | 'C'): RoutePlan {
    let currentMinutes = startMinutes;
    let totalDuration = 0;
    let totalDistance = 0;
    const legs: Leg[] = [];
    const orderedVisits: Visit[] = [];

    let prevIdx = 0; // Start
    for (const currIdx of orderIndices) {
      const visit = visits[currIdx - 1];
      const distData = matrix.rows[prevIdx].elements[currIdx];
      const travelTime = Math.ceil((distData.duration?.value || 0) / 60);
      const travelDist = (distData.distance?.value || 0) / 1000;

      currentMinutes += travelTime;
      const arrivalTime = formatTime(currentMinutes);
      
      // Check time window
      let status: 'ok' | 'warning' | 'violation' = 'ok';
      if (visit.timeWindow) {
        const start = parseTime(visit.timeWindow.start);
        const end = parseTime(visit.timeWindow.end);
        if (currentMinutes > end) {
          status = 'violation';
        } else if (currentMinutes > end - 30 || currentMinutes < start) {
          status = 'warning';
        }
      }

      currentMinutes += visit.workMinutes;
      const endTime = formatTime(currentMinutes);

      legs.push({
        fromName: prevIdx === 0 ? "起点" : visits[prevIdx - 1].customerName || visits[prevIdx - 1].address,
        toName: visit.customerName || visit.address,
        durationMin: travelTime,
        distanceKm: travelDist,
        arrivalTime,
        endTime,
        status,
        visitId: visit.id
      });

      totalDuration += travelTime;
      totalDistance += travelDist;
      orderedVisits.push(visit);
      prevIdx = currIdx;
    }

    // Final leg back to end point
    let endIdx = prevIdx;
    if (settings.endLocation === 'home') {
      endIdx = 0;
    } else if (settings.endLocation === 'custom') {
      endIdx = visitCount + 1;
    }

    if (settings.endLocation !== 'none') {
      const distData = matrix.rows[prevIdx].elements[endIdx];
      const travelTime = Math.ceil((distData.duration?.value || 0) / 60);
      const travelDist = (distData.distance?.value || 0) / 1000;
      
      currentMinutes += travelTime;
      totalDuration += travelTime;
      totalDistance += travelDist;
      
      legs.push({
        fromName: visits[prevIdx - 1].customerName || visits[prevIdx - 1].address,
        toName: "終点",
        durationMin: travelTime,
        distanceKm: travelDist,
        arrivalTime: formatTime(currentMinutes - travelTime),
        endTime: formatTime(currentMinutes),
        status: 'ok'
      });
    }

    const label = planId === 'A' ? "最短ルート" : planId === 'B' ? "余裕重視" : "確実性優先";

    return {
      id: planId,
      label,
      order: orderedVisits,
      legs,
      totalDurationMin: totalDuration,
      totalDistanceKm: totalDistance,
      endTime: formatTime(currentMinutes)
    };
  }

  const allPlans = permutations.map(p => {
    // We'll score this permutation for all 3 cases
    const plan = calculatePlan(p, 'A'); // Base plan for calculations
    
    // Violation penalty
    const violations = plan.legs.filter(l => l.status === 'violation').length;
    const warnings = plan.legs.filter(l => l.status === 'warning').length;
    const penalty = violations * 10000 + warnings * 30;

    // A Score: Total Distance (or Time)
    const scoreA = plan.totalDurationMin + penalty;

    // B Score: Time Window Centering
    let centeringDiff = 0;
    plan.order.forEach((v, i) => {
      const arrival = parseTime(plan.legs[i].arrivalTime);
      if (v.timeWindow) {
        const center = (parseTime(v.timeWindow.start) + parseTime(v.timeWindow.end)) / 2;
        centeringDiff += Math.abs(arrival - center);
      }
    });
    const scoreB = plan.totalDurationMin * 0.3 + centeringDiff + penalty;

    // C Score: Difficulty Prioritization
    // Hard jobs first, easy jobs before noon
    let difficultyOrderPenalty = 0;
    let easyBeforeNoonBonus = 0;
    plan.order.forEach((v, i) => {
      const rank = i + 1;
      // Harder jobs should be earlier (rank 1 is best for diff 3)
      difficultyOrderPenalty += v.difficulty * rank * 5;
      
      const endTime = parseTime(plan.legs[i].endTime);
      if (v.difficulty === 1 && endTime <= 12 * 60) {
        easyBeforeNoonBonus -= 20;
      }
    });
    const scoreC = plan.totalDurationMin * 0.3 + difficultyOrderPenalty + easyBeforeNoonBonus + penalty;

    return { p, scores: { A: scoreA, B: scoreB, C: scoreC } };
  });

  // Pick best for each
  const bestA = allPlans.sort((a, b) => a.scores.A - b.scores.A)[0].p;
  const bestB = allPlans.sort((a, b) => a.scores.B - b.scores.B)[0].p;
  const bestC = allPlans.sort((a, b) => a.scores.C - b.scores.C)[0].p;

  return [
    calculatePlan(bestA, 'A'),
    calculatePlan(bestB, 'B'),
    calculatePlan(bestC, 'C')
  ];
}
