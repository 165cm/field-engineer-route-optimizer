export type Difficulty = 1 | 2 | 3;

export type TimeWindow = {
  start: string; // "HH:mm"
  end: string;   // "HH:mm"
};

export type Visit = {
  id: string;
  address: string;
  phoneNumber?: string;
  modelNumber?: string;
  applianceCategory?: string;
  symptomName?: string;
  taskMajorCategory?: string;
  taskId?: string;
  timeWindow?: TimeWindow;
  workMinutes: number; // default 60
  difficulty: Difficulty; // 1=Easy, 2=Normal, 3=Hard
  coords?: google.maps.LatLngLiteral;
};

// Field notes the engineer toggles on a visit while working through the route.
// Kept outside `Visit` on purpose: plans store snapshots of `Visit`, so markers
// live in their own store keyed by visit id to avoid stale copies.
// Tri-state on purpose: undefined means "まだ聞いていない", which must stay
// distinguishable from "聞いたけど駐車場はなかった" (`'no'`).
export type ParkingState = 'yes' | 'no';

export type VisitMarker = {
  parking?: ParkingState; // 'yes' = 駐車場あり / 'no' = なし / undefined = 未確認
  letter?: string;        // any single A-Z mark for site-specific notes
};

export type Leg = {
  fromName: string;
  toName: string;
  durationMin: number;
  distanceKm: number;
  arrivalTime: string; // "HH:mm"
  workStartTime?: string; // "HH:mm" — after 15min prep, only set on visit legs
  workEndTime?: string;   // "HH:mm" — before 15min cleanup, only set on visit legs
  endTime: string;     // "HH:mm"
  status: 'ok' | 'warning' | 'violation';
  visitId?: string; // null for start/end points
};

export type TaskType = {
  id: string;
  name: string;
  defaultMinutes: number;
  applianceCategory?: string;
  majorCategory?: string;
  source?: 'symptom-master' | 'manual' | 'legacy';
};

export type Settings = {
  homeAddress: string;
  homeCoords?: google.maps.LatLngLiteral;
  workDate?: string; // "YYYY-MM-DD" — used for calendar export
  startTime?: string; // "HH:mm" — departure time from start, default 09:00
  endLocation: 'home' | 'none' | 'custom';
  customEndAddress?: string;
  customEndCoords?: google.maps.LatLngLiteral;
  lunchBreakMinutes?: number; // 0, 15, 30, 45, 60 — inserted around route midpoint
  tasks: TaskType[];
};

export type RoutePlan = {
  id: 'A' | 'B' | 'C' | 'X';
  label: string;
  order: Visit[];
  legs: Leg[];
  totalDurationMin: number;
  totalDistanceKm: number;
  endTime: string;
  lunchBreak?: {
    afterVisitId: string;
    startTime: string;
    endTime: string;
    durationMin: number;
  };
};
