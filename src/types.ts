export type Difficulty = 1 | 2 | 3;

export type TimeWindow = {
  start: string; // "HH:mm"
  end: string;   // "HH:mm"
};

export type Visit = {
  id: string;
  address: string;
  customerName?: string;
  taskId?: string;
  memo?: string;
  timeWindow?: TimeWindow;
  workMinutes: number; // default 60
  difficulty: Difficulty; // 1=Easy, 2=Normal, 3=Hard
  coords?: google.maps.LatLngLiteral;
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

export type LunchSpotPreference = {
  id: string;
  name: string;
  query: string;
  icon: string;
};

export type TaskType = {
  id: string;
  name: string;
  defaultMinutes: number;
};

export type Settings = {
  homeAddress: string;
  homeCoords?: google.maps.LatLngLiteral;
  startTime?: string; // "HH:mm" — departure time from start, default 09:00
  endLocation: 'home' | 'none' | 'custom';
  customEndAddress?: string;
  customEndCoords?: google.maps.LatLngLiteral;
  lunchSpotIds?: string[];
  savedLunchSpots: LunchSpotPreference[];
  tasks: TaskType[];
};

export type LunchInfo = {
  name: string;
  address: string;
  rating?: number;
  location?: google.maps.LatLngLiteral;
  type: string;
  icon?: string;
};

export type RoutePlan = {
  id: 'A' | 'B' | 'C' | 'X';
  label: string;
  order: Visit[];
  legs: Leg[];
  totalDurationMin: number;
  totalDistanceKm: number;
  endTime: string;
  lunchCandidates?: LunchInfo[];
};
