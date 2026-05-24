import { RoutePlan, Visit, TaskType, Difficulty } from '../types';
import { parseTime, formatTime, PREP_MIN } from '../lib/optimization';
import { difficultyColor, DIFFICULTY_LABEL } from '../lib/visitColors';

type SegmentKind = 'travel' | 'work' | 'prep' | 'lunch';
type SegmentStatus = 'ok' | 'warning' | 'violation';

type Segment = {
  kind: SegmentKind;
  startMin: number;
  endMin: number;
  status?: SegmentStatus;
  label?: string;  // visit identifier (work segments only)
  visitIndex?: number; // 1-based, for the small badge
  difficulty?: Difficulty; // drives the per-visit color for work/prep arcs
};

// Larger SVG box than the inner ring so the outer visit labels have room.
const SIZE = 300;
const CENTER = SIZE / 2;
const RADIUS = 96;
const STROKE = 18;

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
// NEVER used (they're considered personal info). Returns the town extracted
// from the address (e.g. "東京都新宿区西新宿2-8-1" → "西新宿"), optionally
// suffixed with the chosen task name when the user picked one — e.g.
// "西新宿/修理".
function shortLabel(visit: Visit | undefined, tasks?: TaskType[]): string {
  if (!visit) return '';
  const addr = visit.address || '';
  const m = addr.match(/[市区町村]([^0-9０-９一二三四五六七八九十百千]+)/);
  const town = m && m[1] ? m[1].slice(0, 6) : addr.slice(0, 6);
  const task = visit.taskId && tasks ? tasks.find(t => t.id === visit.taskId) : null;
  if (task?.name) {
    return `${town}/${task.name.slice(0, 5)}`;
  }
  return town;
}

function buildSegments(plan: RoutePlan, tasks?: TaskType[]): Segment[] {
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
      const label = shortLabel(visit, tasks);
      const difficulty = visit?.difficulty;
      const endMin = parseTime(leg.endTime);
      if (leg.workStartTime && leg.workEndTime) {
        const ws = parseTime(leg.workStartTime);
        const we = parseTime(leg.workEndTime);
        // Prep / cleanup arcs share the visit's difficulty color (lighter
        // shade) so the whole on-site block reads as one coloured group.
        segments.push({ kind: 'prep', startMin: ws - PREP_MIN, endMin: ws, visitIndex: visitIdx, difficulty });
        segments.push({ kind: 'work', startMin: ws, endMin: we, status: leg.status, label, visitIndex: visitIdx, difficulty });
        segments.push({ kind: 'prep', startMin: we, endMin: endMin, visitIndex: visitIdx, difficulty });
      } else {
        // Legacy data: no prep/cleanup info, draw the whole site time as work.
        segments.push({ kind: 'work', startMin: arrivalMin, endMin: endMin, status: leg.status, label, visitIndex: visitIdx, difficulty });
      }
    }
  }
  if (plan.lunchBreak) {
    segments.push({
      kind: 'lunch',
      startMin: parseTime(plan.lunchBreak.startTime),
      endMin: parseTime(plan.lunchBreak.endTime),
    });
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

function arcPath(startMin: number, endMin: number, radius: number = RADIUS): string {
  let sweep = endMin - startMin;
  if (sweep <= 0) return '';
  // Cap a single arc at 359° to avoid drawing a full circle that visually
  // disappears (start point == end point).
  if (sweep > 719) sweep = 719;
  const a0 = minutesToAngle(startMin);
  const a1 = minutesToAngle(startMin + sweep);
  const largeArc = sweep > 360 ? 1 : 0;
  const p0 = polar(a0, radius);
  const p1 = polar(a1, radius);
  return `M ${p0.x.toFixed(2)} ${p0.y.toFixed(2)} A ${radius} ${radius} 0 ${largeArc} 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`;
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

export function ScheduleClock({ plan, tasks }: { plan: RoutePlan; tasks?: TaskType[] }) {
  if (!plan || !plan.legs || plan.legs.length === 0) return null;

  const segments = buildSegments(plan, tasks);
  if (segments.length === 0) return null;

  const totalTravel = segments
    .filter(s => s.kind === 'travel')
    .reduce((sum, s) => sum + (s.endMin - s.startMin), 0);
  const totalWork = segments
    .filter(s => s.kind === 'work' || s.kind === 'prep')
    .reduce((sum, s) => sum + (s.endMin - s.startMin), 0);

  const workSegments = segments.filter(s => s.kind === 'work');

  // Customer time windows ("指定時間"), one per visit that has one set.
  type WindowMarker = {
    visitIndex: number;
    difficulty: Difficulty;
    startMin: number | null;  // 以降 lower bound
    endMin: number | null;    // 以前 upper bound
  };
  const windowMarkers: WindowMarker[] = [];
  plan.order.forEach((v, idx) => {
    if (!v.timeWindow) return;
    const hasStart = !!v.timeWindow.start;
    const hasEnd = !!v.timeWindow.end;
    if (!hasStart && !hasEnd) return;
    windowMarkers.push({
      visitIndex: idx + 1,
      difficulty: v.difficulty,
      startMin: hasStart ? parseTime(v.timeWindow.start) : null,
      endMin: hasEnd ? parseTime(v.timeWindow.end) : null,
    });
  });

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
        {/* Segments. Work / prep arcs use the visit's difficulty color so
            you can see workload distribution at a glance — same coloring
            shows up on the leg cards and the map markers. Travel / lunch /
            idle keep their semantic colors. */}
        {segments.map((seg, idx) => {
          const d = arcPath(seg.startMin, seg.endMin);
          if (!d) return null;
          let stroke = COLORS[seg.kind];
          if (seg.difficulty) {
            const c = difficultyColor(seg.difficulty);
            if (seg.kind === 'work') stroke = c.work;
            else if (seg.kind === 'prep') stroke = c.prep;
          }
          return (
            <path
              key={`seg-${idx}`}
              d={d}
              fill="none"
              stroke={stroke}
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
        {/* Outer visit identifier labels — tick uses the difficulty color so
            the arc, the tick, the card, and the map marker all read as a set. */}
        {workSegments.map((seg, idx) => {
          if (!seg.label || !seg.visitIndex) return null;
          const mid = (seg.startMin + seg.endMin) / 2;
          const angle = minutesToAngle(mid);
          const labelP = polar(angle, RADIUS + STROKE / 2 + 14);
          const tickInner = polar(angle, RADIUS + STROKE / 2);
          const tickOuter = polar(angle, RADIUS + STROKE / 2 + 5);
          const color = difficultyColor(seg.difficulty).work;
          return (
            <g key={`lbl-${idx}`}>
              <line
                x1={tickInner.x}
                y1={tickInner.y}
                x2={tickOuter.x}
                y2={tickOuter.y}
                stroke={color}
                strokeWidth={2}
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
                {seg.visitIndex}.{seg.label}
              </text>
            </g>
          );
        })}
        {/* Customer time-window indicators just outside the labels.
            - 範囲 A〜B: arc from A to B + boundary tick at each end.
            - 以前 X:   90-min "tail" arc backward from X (open-ended on the
                       far side) + boundary tick at X — reads as "must be by X".
            - 以降 X:   90-min arc forward from X + boundary tick at X — reads
                       as "must be from X onwards". */}
        {windowMarkers.map((tw, i) => {
          const color = difficultyColor(tw.difficulty).work;
          const winRadius = RADIUS + STROKE / 2 + 22;
          let arcStart: number;
          let arcEnd: number;
          if (tw.startMin !== null && tw.endMin !== null) {
            arcStart = tw.startMin;
            arcEnd = tw.endMin;
          } else if (tw.endMin !== null) {
            arcEnd = tw.endMin;
            arcStart = tw.endMin - 90;
          } else if (tw.startMin !== null) {
            arcStart = tw.startMin;
            arcEnd = tw.startMin + 90;
          } else {
            return null;
          }
          const d = arcPath(arcStart, arcEnd, winRadius);
          const renderTick = (timeMin: number) => {
            const angle = minutesToAngle(timeMin);
            const inner = polar(angle, winRadius - 5);
            const outer = polar(angle, winRadius + 5);
            return (
              <line
                x1={inner.x}
                y1={inner.y}
                x2={outer.x}
                y2={outer.y}
                stroke={color}
                strokeWidth={2.5}
                strokeLinecap="round"
              />
            );
          };
          const isOpenStart = tw.startMin === null; // 以前: tail fades into earlier times
          const isOpenEnd = tw.endMin === null;     // 以降: tail extends into later times
          // Tangential arrowhead at the OPEN end of a one-sided window so
          // the direction of the allowed region is explicit.
          const renderArrow = (atTimeMin: number, direction: 'forward' | 'backward') => {
            const angle = minutesToAngle(atTimeMin);
            const sign = direction === 'forward' ? 1 : -1;
            const tip = polar(angle + sign * 7, winRadius);
            const baseInner = polar(angle + sign * 2, winRadius - 4);
            const baseOuter = polar(angle + sign * 2, winRadius + 4);
            return (
              <polygon
                points={`${tip.x},${tip.y} ${baseInner.x},${baseInner.y} ${baseOuter.x},${baseOuter.y}`}
                fill={color}
              />
            );
          };
          return (
            <g key={`tw-${i}`} opacity={0.85}>
              <path
                d={d}
                stroke={color}
                strokeWidth={3}
                strokeLinecap={isOpenStart || isOpenEnd ? 'butt' : 'round'}
                strokeDasharray={isOpenStart || isOpenEnd ? '4 3' : undefined}
                fill="none"
              />
              {tw.startMin !== null && renderTick(tw.startMin)}
              {tw.endMin !== null && renderTick(tw.endMin)}
              {/* 以前: arrow at the open (earlier) end pointing further backward. */}
              {isOpenStart && renderArrow(arcStart, 'backward')}
              {/* 以降: arrow at the open (later) end pointing further forward. */}
              {isOpenEnd && renderArrow(arcEnd, 'forward')}
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
      {/* Difficulty legend — only show levels actually present in the plan
          so the key stays minimal. Pairs visually with the leg cards and
          map markers, which share the same colors. */}
      <div className="flex items-center justify-center gap-1.5 flex-wrap text-[10px] font-bold">
        {([1, 2, 3] as Difficulty[])
          .filter(d => workSegments.some(s => s.difficulty === d))
          .map(d => {
            const c = difficultyColor(d).work;
            return (
              <span
                key={`dk-${d}`}
                className="flex items-center gap-1 px-2 py-0.5 rounded-full border"
                style={{ background: `${c}26`, borderColor: `${c}66`, color: c }}
              >
                <span className="w-2 h-2 rounded-full" style={{ background: c }} />
                {DIFFICULTY_LABEL[d]}
              </span>
            );
          })}
      </div>
      {/* Category legend (the things that aren't difficulty-coloured) */}
      <div className="flex items-center justify-center gap-1.5 flex-wrap text-[10px] font-bold opacity-80">
        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-300 border border-blue-500/30">
          <span className="w-2 h-2 rounded-full bg-blue-500" /> 移動
        </span>
        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-orange-500/15 text-orange-300 border border-orange-500/30">
          <span className="w-2 h-2 rounded-full bg-orange-500" /> 昼休憩
        </span>
        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-500/15 text-slate-300 border border-slate-500/30">
          <span className="w-2 h-2 rounded-full bg-slate-500" /> 空き
        </span>
        {windowMarkers.length > 0 && (
          <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-700/40 text-slate-200 border border-slate-500/40" title="円の外側に表示される細い線は、お客様の指定時間です。範囲指定なら両端、以前/以降なら片端に短い目印が付きます。">
            <svg width="14" height="6" viewBox="0 0 14 6">
              <line x1="2" y1="3" x2="12" y2="3" stroke="currentColor" strokeWidth="2" strokeDasharray="3 2" />
              <line x1="11" y1="0" x2="11" y2="6" stroke="currentColor" strokeWidth="2" />
            </svg>
            指定時間
          </span>
        )}
      </div>
    </div>
  );
}
