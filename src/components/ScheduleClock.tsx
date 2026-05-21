import { RoutePlan, Visit } from '../types';
import { parseTime, formatTime, PREP_MIN } from '../lib/optimization';

type SegmentKind = 'travel' | 'work' | 'prep' | 'lunch';
type SegmentStatus = 'ok' | 'warning' | 'violation';

type Segment = {
  kind: SegmentKind;
  startMin: number;
  endMin: number;
  status?: SegmentStatus;
  label?: string;  // visit identifier (work segments only)
  visitIndex?: number; // 1-based, for the small badge
};

// Larger SVG box than the inner ring so the outer visit labels have room.
const SIZE = 300;
const CENTER = SIZE / 2;
const RADIUS = 96;
const STROKE = 18;
const LUNCH_GAP_THRESHOLD_MIN = 30;

const COLORS: Record<SegmentKind, string> = {
  travel: '#3b82f6',
  work: '#22c55e',
  prep: '#86efac',   // lighter green for prep/cleanup
  lunch: '#f97316',
};

const IDLE_TRACK_COLOR = '#475569'; // slate-600 — visible grey for empty time

const STATUS_DOT: Record<SegmentStatus, string | null> = {
  ok: null,
  warning: '#f59e0b',
  violation: '#ef4444',
};

// Build a privacy-safe label for a visit. Customer names are intentionally
// NEVER used (they're considered personal info). Today this returns just the
// town extracted from the address, e.g. "東京都新宿区西新宿2-8-1" → "西新宿".
// Future: append a short task / memo suffix → "西新宿/基盤交換".
function shortLabel(visit: Visit | undefined): string {
  if (!visit) return '';
  const addr = visit.address || '';
  // Extract the town portion: anything after the last 区/市/町/村 up to the
  // first street-number digit (ASCII or full-width / kanji numerals).
  const m = addr.match(/[市区町村]([^0-9０-９一二三四五六七八九十百千]+)/);
  const town = m && m[1] ? m[1].slice(0, 6) : addr.slice(0, 6);
  // Placeholder for the future "/task" suffix — keeping the join logic here
  // so adding a task lookup later is a one-line change:
  // return task ? `${town}/${task.slice(0, 5)}` : town;
  return town;
}

function buildSegments(plan: RoutePlan): Segment[] {
  const segments: Segment[] = [];
  const legs = plan.legs;
  let visitIdx = 0;
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const arrivalMin = parseTime(leg.arrivalTime);
    const travelStart = arrivalMin - leg.durationMin;
    segments.push({
      kind: 'travel',
      startMin: travelStart,
      endMin: arrivalMin,
      status: leg.status,
    });
    if (leg.visitId) {
      const visit = plan.order[visitIdx];
      visitIdx++;
      const label = shortLabel(visit);
      const endMin = parseTime(leg.endTime);
      if (leg.workStartTime && leg.workEndTime) {
        const ws = parseTime(leg.workStartTime);
        const we = parseTime(leg.workEndTime);
        // Prep: the 15min immediately before workStart. Anything earlier
        // (e.g. waiting for a 以降 time window) stays as grey track.
        segments.push({ kind: 'prep', startMin: ws - PREP_MIN, endMin: ws });
        segments.push({ kind: 'work', startMin: ws, endMin: we, status: leg.status, label, visitIndex: visitIdx });
        segments.push({ kind: 'prep', startMin: we, endMin: endMin });
      } else {
        // Legacy data: no prep/cleanup info, draw the whole site time as work.
        segments.push({ kind: 'work', startMin: arrivalMin, endMin: endMin, status: leg.status, label, visitIndex: visitIdx });
      }
    }
    const next = legs[i + 1];
    if (next) {
      const gapStart = parseTime(leg.endTime);
      const gapEnd = parseTime(next.arrivalTime) - next.durationMin;
      if (gapEnd - gapStart >= LUNCH_GAP_THRESHOLD_MIN) {
        segments.push({ kind: 'lunch', startMin: gapStart, endMin: gapEnd });
      }
    }
  }
  return segments;
}

// 12h clock: 12 at top, clockwise. minutes mod 720 -> 0..720 -> -90..270 deg.
function minutesToAngle(minutes: number): number {
  const wrapped = ((minutes % 720) + 720) % 720;
  return (wrapped / 720) * 360 - 90;
}

function polar(angleDeg: number, r: number): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: CENTER + r * Math.cos(rad), y: CENTER + r * Math.sin(rad) };
}

function arcPath(startMin: number, endMin: number): string {
  let sweep = endMin - startMin;
  if (sweep <= 0) return '';
  // Cap a single arc at 359° to avoid drawing a full circle that visually
  // disappears (start point == end point).
  if (sweep > 719) sweep = 719;
  const a0 = minutesToAngle(startMin);
  const a1 = minutesToAngle(startMin + sweep);
  const largeArc = sweep > 360 ? 1 : 0;
  const p0 = polar(a0, RADIUS);
  const p1 = polar(a1, RADIUS);
  return `M ${p0.x.toFixed(2)} ${p0.y.toFixed(2)} A ${RADIUS} ${RADIUS} 0 ${largeArc} 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`;
}

function fmtDur(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h${String(m).padStart(2, '0')}m`;
}

// 12 hour labels (12, 1, 2, ..., 11) positioned inside the ring.
const HOUR_LABELS = Array.from({ length: 12 }, (_, i) => ({
  hour: i === 0 ? 12 : i,
  angle: i * 30 - 90,
}));

export function ScheduleClock({ plan }: { plan: RoutePlan }) {
  if (!plan || !plan.legs || plan.legs.length === 0) return null;

  const segments = buildSegments(plan);
  if (segments.length === 0) return null;

  const totalTravel = segments
    .filter(s => s.kind === 'travel')
    .reduce((sum, s) => sum + (s.endMin - s.startMin), 0);
  const totalWork = segments
    .filter(s => s.kind === 'work' || s.kind === 'prep')
    .reduce((sum, s) => sum + (s.endMin - s.startMin), 0);

  const workSegments = segments.filter(s => s.kind === 'work');

  return (
    <div className="flex flex-col items-center gap-2 py-2">
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="w-full max-w-[300px] h-auto"
        role="img"
        aria-label="本日のスケジュール時計"
      >
        {/* Track — visible grey so empty/idle time is obvious */}
        <circle
          cx={CENTER}
          cy={CENTER}
          r={RADIUS}
          fill="none"
          stroke={IDLE_TRACK_COLOR}
          strokeWidth={STROKE}
          opacity={0.55}
        />
        {/* Hour tick marks (every hour) */}
        {Array.from({ length: 12 }, (_, i) => {
          const a = (i / 12) * 360 - 90;
          const inner = polar(a, RADIUS - STROKE / 2 - 4);
          const outer = polar(a, RADIUS - STROKE / 2 - 1);
          return (
            <line
              key={`tick-${i}`}
              x1={inner.x}
              y1={inner.y}
              x2={outer.x}
              y2={outer.y}
              stroke="#475569"
              strokeWidth={1}
            />
          );
        })}
        {/* Segments */}
        {segments.map((seg, idx) => {
          const d = arcPath(seg.startMin, seg.endMin);
          if (!d) return null;
          return (
            <path
              key={`seg-${idx}`}
              d={d}
              fill="none"
              stroke={COLORS[seg.kind]}
              strokeWidth={STROKE}
              strokeLinecap="butt"
              opacity={0.95}
            />
          );
        })}
        {/* Status dots on work segments */}
        {segments.map((seg, idx) => {
          if (seg.kind !== 'work' || !seg.status) return null;
          const color = STATUS_DOT[seg.status];
          if (!color) return null;
          const mid = (seg.startMin + seg.endMin) / 2;
          const p = polar(minutesToAngle(mid), RADIUS + STROKE / 2 + 4);
          return (
            <circle
              key={`dot-${idx}`}
              cx={p.x}
              cy={p.y}
              r={3.5}
              fill={color}
              stroke="#0f172a"
              strokeWidth={1}
            />
          );
        })}
        {/* Inner hour numbers 1..12 (12 at top, clockwise) */}
        {HOUR_LABELS.map(({ hour, angle }) => {
          const p = polar(angle, RADIUS - STROKE - 8);
          return (
            <text
              key={`h-${hour}`}
              x={p.x}
              y={p.y}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={8.5}
              fontWeight={700}
              fill="#64748b"
            >
              {hour}
            </text>
          );
        })}
        {/* Outer visit identifier labels (e.g. customer name or town) */}
        {workSegments.map((seg, idx) => {
          if (!seg.label) return null;
          const mid = (seg.startMin + seg.endMin) / 2;
          const angle = minutesToAngle(mid);
          const labelP = polar(angle, RADIUS + STROKE / 2 + 14);
          const tickInner = polar(angle, RADIUS + STROKE / 2);
          const tickOuter = polar(angle, RADIUS + STROKE / 2 + 4);
          return (
            <g key={`lbl-${idx}`}>
              <line
                x1={tickInner.x}
                y1={tickInner.y}
                x2={tickOuter.x}
                y2={tickOuter.y}
                stroke="#94a3b8"
                strokeWidth={1}
              />
              <text
                x={labelP.x}
                y={labelP.y}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={9}
                fontWeight={700}
                fill="#e2e8f0"
              >
                {seg.visitIndex ? `${seg.visitIndex}.` : ''}{seg.label}
              </text>
            </g>
          );
        })}
        {/* Center stack */}
        <text x={CENTER} y={CENTER - 18} textAnchor="middle" fontSize={9} fontWeight={700} fill="#94a3b8">
          稼働
        </text>
        <text x={CENTER} y={CENTER - 4} textAnchor="middle" fontSize={16} fontWeight={800} fill="#22c55e">
          {fmtDur(totalWork)}
        </text>
        <text x={CENTER} y={CENTER + 12} textAnchor="middle" fontSize={10} fontWeight={600} fill="#60a5fa">
          移動 {fmtDur(totalTravel)}
        </text>
        <text x={CENTER} y={CENTER + 26} textAnchor="middle" fontSize={10} fontWeight={600} fill="#cbd5e1">
          〜 {plan.endTime}
        </text>
      </svg>
      {/* Legend */}
      <div className="flex items-center justify-center gap-1.5 flex-wrap text-[10px] font-bold">
        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-300 border border-blue-500/30">
          <span className="w-2 h-2 rounded-full bg-blue-500" /> 移動
        </span>
        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-500/15 text-green-300 border border-green-500/30">
          <span className="w-2 h-2 rounded-full bg-green-500" /> 作業
        </span>
        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-300/10 text-green-200 border border-green-300/30">
          <span className="w-2 h-2 rounded-full bg-green-300" /> 準備・撤収
        </span>
        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-orange-500/15 text-orange-300 border border-orange-500/30">
          <span className="w-2 h-2 rounded-full bg-orange-500" /> 昼休憩
        </span>
        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-500/15 text-slate-300 border border-slate-500/30">
          <span className="w-2 h-2 rounded-full bg-slate-500" /> 空き
        </span>
      </div>
    </div>
  );
}
