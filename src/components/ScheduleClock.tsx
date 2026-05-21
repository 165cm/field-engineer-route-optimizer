import { RoutePlan } from '../types';
import { parseTime, formatTime } from '../lib/optimization';

type SegmentKind = 'travel' | 'work' | 'lunch';
type SegmentStatus = 'ok' | 'warning' | 'violation';

type Segment = {
  kind: SegmentKind;
  startMin: number;
  endMin: number;
  status?: SegmentStatus;
};

const SIZE = 240;
const CENTER = SIZE / 2;
const RADIUS = 96;
const STROKE = 18;
const LUNCH_GAP_THRESHOLD_MIN = 30;

const COLORS: Record<SegmentKind, string> = {
  travel: '#3b82f6',
  work: '#22c55e',
  lunch: '#f97316',
};

const STATUS_DOT: Record<SegmentStatus, string | null> = {
  ok: null,
  warning: '#f59e0b',
  violation: '#ef4444',
};

function buildSegments(plan: RoutePlan): Segment[] {
  const segments: Segment[] = [];
  const legs = plan.legs;
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
      segments.push({
        kind: 'work',
        startMin: arrivalMin,
        endMin: parseTime(leg.endTime),
        status: leg.status,
      });
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

export function ScheduleClock({ plan }: { plan: RoutePlan }) {
  if (!plan || !plan.legs || plan.legs.length === 0) return null;

  const segments = buildSegments(plan);
  if (segments.length === 0) return null;

  const totalTravel = segments
    .filter(s => s.kind === 'travel')
    .reduce((sum, s) => sum + (s.endMin - s.startMin), 0);
  const totalWork = segments
    .filter(s => s.kind === 'work')
    .reduce((sum, s) => sum + (s.endMin - s.startMin), 0);

  const hourLabels = [
    { hour: 12, angle: -90 },
    { hour: 3, angle: 0 },
    { hour: 6, angle: 90 },
    { hour: 9, angle: 180 },
  ];

  return (
    <div className="flex flex-col items-center gap-2 py-2">
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="w-full max-w-[260px] h-auto"
        role="img"
        aria-label="本日のスケジュール時計"
      >
        {/* Track */}
        <circle
          cx={CENTER}
          cy={CENTER}
          r={RADIUS}
          fill="none"
          stroke="#1e293b"
          strokeWidth={STROKE}
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
        {/* Hour numbers */}
        {hourLabels.map(({ hour, angle }) => {
          const p = polar(angle, RADIUS - STROKE - 8);
          return (
            <text
              key={`h-${hour}`}
              x={p.x}
              y={p.y}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={10}
              fontWeight={700}
              fill="#64748b"
            >
              {hour}
            </text>
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
      <div className="flex items-center justify-center gap-2 text-[10px] font-bold">
        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-300 border border-blue-500/30">
          <span className="w-2 h-2 rounded-full bg-blue-500" /> 移動
        </span>
        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-500/15 text-green-300 border border-green-500/30">
          <span className="w-2 h-2 rounded-full bg-green-500" /> 作業
        </span>
        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-orange-500/15 text-orange-300 border border-orange-500/30">
          <span className="w-2 h-2 rounded-full bg-orange-500" /> 昼休憩
        </span>
      </div>
    </div>
  );
}
