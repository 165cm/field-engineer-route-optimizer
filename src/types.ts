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
export type VisitMarker = {
  parking?: boolean;   // true = 駐車場あり
  other?: boolean;     // true = the user-defined mark applies (letter comes from Settings)
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
  // Second field marker, configured once and applied to every visit.
  // The parking marker is fixed to "P"; this one is user-defined.
  otherMarkerEnabled?: boolean; // default true
  otherMarkerLetter?: string;   // single A-Z, default "T"
  otherMarkerLabel?: string;    // shown in tooltips, default "三脚"
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
