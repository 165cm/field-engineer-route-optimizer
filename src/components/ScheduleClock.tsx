import { RoutePlan, Visit, TaskType, Difficulty, Leg } from '../types';
import { parseTime, formatTime, PREP_MIN } from '../lib/optimization';
import { difficultyColor, DIFFICULTY_LABEL } from '../lib/visitColors';

type SegmentKind = 'travel' | 'work' | 'prep' | 'lunch';
type SegmentStatus = 'ok' | 'warning' | 'violation';
type ScheduleClockVariant = 'mobile' | 'desktop';

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
// Customer time windows use a dedicated amber so they never collide with the
// semantic difficulty palette (green/yellow/red) used for work arcs.
const WINDOW_COLOR = '#fbbf24'; // amber-400

const STATUS_DOT: Record<SegmentStatus, string | null> = {
  ok: null,
  warning: '#f59e0b',
  violation: '#ef4444',
};

function getHealthCopy(plan: RoutePlan): { label: string; detail: string; color: string } {
  const legs = Array.isArray(plan.legs) ? plan.legs : [];
  const warningCount = legs.filter(leg => leg.status === 'warning').length;
  const violationCount = legs.filter(leg => leg.status === 'violation').length;
  if (violationCount > 0) {
    return { label: '要注意', detail: `超過 ${violationCount}件`, color: '#fb7185' };
  }
  if (warningCount > 0) {
    return { label: '余裕少', detail: `警告 ${warningCount}件`, color: '#fbbf24' };
  }
  return { label: '順調', detail: 'リスクなし', color: '#34d399' };
}

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

function isRenderableLeg(leg: Leg | undefined | null): leg is Leg {
  return Boolean(
    leg &&
    typeof leg.arrivalTime === 'string' &&
    typeof leg.endTime === 'string' &&
    Number.isFinite(leg.durationMin)
  );
}

function safeParseTime(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = parseTime(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildSegments(plan: RoutePlan, tasks?: TaskType[]): Segment[] {
  const segments: Segment[] = [];
  const legs = Array.isArray(plan.legs) ? plan.legs : [];
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (!isRenderableLeg(leg)) continue;
    const arrivalMin = safeParseTime(leg.arrivalTime);
    if (arrivalMin === null) continue;
    const durationMin = Number.isFinite(Number(leg.durationMin)) ? Number(leg.durationMin) : 0;
    const travelStart = arrivalMin - durationMin;
    segments.push({
      kind: 'travel',
      startMin: travelStart,
      endMin: arrivalMin,
      status: leg.status,
    });
    if (leg.visitId) {
      const visit = plan.order.find(v => v.id === leg.visitId);
      const visitIndex = visit ? plan.order.findIndex(v => v.id === visit.id) + 1 : i + 1;
      const label = shortLabel(visit, tasks);
      const difficulty = visit?.difficulty;
      const endMin = safeParseTime(leg.endTime);
      if (endMin === null) continue;
      if (leg.workStartTime && leg.workEndTime) {
        const ws = safeParseTime(leg.workStartTime);
        const we = safeParseTime(leg.workEndTime);
        if (ws === null || we === null) continue;
        // Prep / cleanup arcs share the visit's difficulty color (lighter
        // shade) so the whole on-site block reads as one coloured group.
        segments.push({ kind: 'prep', startMin: ws - PREP_MIN, endMin: ws, visitIndex, difficulty });
        segments.push({ kind: 'work', startMin: ws, endMin: we, status: leg.status, label, visitIndex, difficulty });
        segments.push({ kind: 'prep', startMin: we, endMin: endMin, visitIndex, difficulty });
      } else {
        // Legacy data: no prep/cleanup info, draw the whole site time as work.
        segments.push({ kind: 'work', startMin: arrivalMin, endMin: endMin, status: leg.status, label, visitIndex, difficulty });
      }
    }
  }
  if (plan.lunchBreak) {
    const startMin = safeParseTime(plan.lunchBreak.startTime);
    const endMin = safeParseTime(plan.lunchBreak.endTime);
    if (startMin === null || endMin === null) return segments;
    segments.push({
      kind: 'lunch',
      startMin,
      endMin,
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

// Outer label radii. tier 0 sits closer to the ring; tier 1 is pushed further
// out so neighbouring labels that would otherwise overlap stay readable.
const LABEL_R0 = RADIUS + STROKE / 2 + 16;
const LABEL_R1 = RADIUS + STROKE / 2 + 32;
const WINDOW_R = RADIUS + STROKE / 2 + 7;

type PlacedLabel = { seg: Segment; angle: number; tier: 0 | 1 };

// Assign each work label an angle and a tier. Sorting by angle and bumping a
// label out one tier when it lands within ~16° of its predecessor keeps dense
// clusters from stacking on top of each other.
function placeLabels(segs: Segment[]): PlacedLabel[] {
  const items = segs
    .filter(s => s.label && s.visitIndex)
    .map(s => {
      const raw = minutesToAngle((s.startMin + s.endMin) / 2);
      const angle = ((raw % 360) + 360) % 360;
      return { seg: s, angle };
    })
    .sort((a, b) => a.angle - b.angle);
  let lastAngle = -999;
  let lastTier: 0 | 1 = 1;
  return items.map(it => {
    const tooClose = it.angle - lastAngle < 16;
    const tier: 0 | 1 = tooClose && lastTier === 0 ? 1 : 0;
    lastAngle = it.angle;
    lastTier = tier;
    return { ...it, tier };
  });
}

export function ScheduleClock({
  plan,
  tasks,
  variant = 'desktop',
}: {
  plan: RoutePlan;
  tasks?: TaskType[];
  variant?: ScheduleClockVariant;
}) {
  if (!plan || !Array.isArray(plan.legs) || plan.legs.length === 0) return null;

  let segments: Segment[] = [];
  try {
    segments = buildSegments(plan, tasks);
  } catch (error) {
    console.error('ScheduleClock failed to render', error);
    return null;
  }
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

  const placedLabels = placeLabels(workSegments);
  const health = getHealthCopy(plan);
  const compact = variant === 'mobile';

  return (
    <div className={compact ? "flex flex-col items-center gap-2 py-1" : "flex flex-col items-center gap-2 py-2"}>
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className={compact ? "w-full max-w-[258px] h-auto overflow-visible" : "w-full max-w-[300px] h-auto overflow-visible"}
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
        {/* Tick marks: 60 minute ticks, with the 5-minute marks longer and the
            quarter marks (12/3/6/9) strongest — gives the dial an analog-clock
            rhythm. */}
        {Array.from({ length: 60 }, (_, i) => {
          const major = i % 5 === 0;
          const cardinal = i % 15 === 0;
          const a = (i / 60) * 360 - 90;
          const inner = polar(a, RADIUS - STROKE / 2 - (major ? 5 : 3));
          const outer = polar(a, RADIUS - STROKE / 2 - 1);
          return (
            <line
              key={`tick-${i}`}
              x1={inner.x}
              y1={inner.y}
              x2={outer.x}
              y2={outer.y}
              stroke={major ? '#94a3b8' : '#475569'}
              strokeWidth={cardinal ? 1.5 : major ? 1 : 0.75}
              opacity={major ? 0.9 : 0.5}
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
          const cardinal = hour % 3 === 0;
          return (
            <text
              key={`h-${hour}`}
              x={p.x}
              y={p.y}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={cardinal ? 10 : 8.5}
              fontWeight={700}
              fill={cardinal ? '#cbd5e1' : '#64748b'}
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {hour}
            </text>
          );
        })}
        {/* Outer visit identifier labels. A leader line (tip → elbow → text)
            runs from the arc to the label, and dense clusters are pushed out a
            tier so they don't overlap. The tip dot keeps the difficulty color
            so the arc, label, leg card, and map marker still read as a set. */}
        {placedLabels.map(({ seg, angle, tier }, idx) => {
          const baseR = tier === 0 ? LABEL_R0 : LABEL_R1;
          const tip = polar(angle, RADIUS + STROKE / 2 + 1);
          const elbow = polar(angle, baseR - 6);
          const labelP = polar(angle, baseR);
          const isRight = Math.cos((angle * Math.PI) / 180) >= 0;
          const tx = labelP.x + (isRight ? 3 : -3);
          const color = difficultyColor(seg.difficulty).work;
          if (compact) {
            const badge = polar(angle, RADIUS + STROKE / 2 + 13);
            return (
              <g key={`lbl-${idx}`}>
                <circle cx={tip.x} cy={tip.y} r={2.25} fill={color} />
                <circle cx={badge.x} cy={badge.y} r={7.25} fill="#101827" stroke={color} strokeWidth={1.5} />
                <text
                  x={badge.x}
                  y={badge.y + 0.5}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={7.5}
                  fontWeight={800}
                  fill="#f8fafc"
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {seg.visitIndex}
                </text>
              </g>
            );
          }
          return (
            <g key={`lbl-${idx}`}>
              <polyline
                points={`${tip.x.toFixed(2)},${tip.y.toFixed(2)} ${elbow.x.toFixed(2)},${elbow.y.toFixed(2)} ${tx.toFixed(2)},${labelP.y.toFixed(2)}`}
                fill="none"
                stroke="#334155"
                strokeWidth={1}
                strokeLinecap="round"
              />
              <circle cx={tip.x} cy={tip.y} r={2.5} fill={color} />
              <text
                x={tx}
                y={labelP.y}
                textAnchor={isRight ? 'start' : 'end'}
                dominantBaseline="central"
                fontSize={9}
                fontWeight={700}
                fill="#e2e8f0"
                style={{ paintOrder: 'stroke', stroke: '#0b1220', strokeWidth: 3 }}
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
          const color = WINDOW_COLOR;
          const winRadius = WINDOW_R;
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
        {/* Center stack — the end time is the hero (the number that drives
            field decisions), with 稼働 / 移動 as paired supporting metrics. */}
        <text x={CENTER} y={CENTER - 36} textAnchor="middle" fontSize={9} fontWeight={700} fill={health.color} letterSpacing={1}>
          {health.label}
        </text>
        <text x={CENTER} y={CENTER - 24} textAnchor="middle" fontSize={7.5} fontWeight={600} fill="#94a3b8">
          {health.detail}
        </text>
        <text
          x={CENTER}
          y={CENTER - 3}
          textAnchor="middle"
          fontSize={compact ? 24 : 26}
          fontWeight={800}
          fill="#f8fafc"
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {plan.endTime}
        </text>
        <text x={CENTER} y={CENTER + 12} textAnchor="middle" fontSize={7.5} fontWeight={600} fill="#94a3b8" letterSpacing={1}>
          終了予定
        </text>
        <line x1={CENTER - 40} x2={CENTER + 40} y1={CENTER + 22} y2={CENTER + 22} stroke="#1e293b" strokeWidth={1} />
        <line x1={CENTER} x2={CENTER} y1={CENTER + 27} y2={CENTER + 46} stroke="#1e293b" strokeWidth={1} />
        <text x={CENTER - 26} y={CENTER + 34} textAnchor="middle" fontSize={8.5} fontWeight={600} fill="#94a3b8">
          稼働
        </text>
        <text x={CENTER - 26} y={CENTER + 46} textAnchor="middle" fontSize={12} fontWeight={700} fill="#22c55e" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {fmtDur(totalWork)}
        </text>
        <text x={CENTER + 26} y={CENTER + 34} textAnchor="middle" fontSize={8.5} fontWeight={600} fill="#94a3b8">
          移動
        </text>
        <text x={CENTER + 26} y={CENTER + 46} textAnchor="middle" fontSize={12} fontWeight={700} fill="#60a5fa" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {fmtDur(totalTravel)}
        </text>
      </svg>
      {/* Unified legend pill. Difficulty levels are grouped under a small
          "作業" scale label and only the levels present in the plan are shown,
          keeping the key minimal. The remaining categories and the customer
          time-window marker follow, separated by thin dividers. */}
      <div className={cnLegend(compact)}>
        {workSegments.some(s => s.difficulty) && (
          <span className="text-[9px] uppercase tracking-wider text-slate-500 font-semibold">作業</span>
        )}
        {([1, 2, 3] as Difficulty[])
          .filter(d => workSegments.some(s => s.difficulty === d))
          .map(d => {
            const c = difficultyColor(d).work;
            return (
              <span key={`dk-${d}`} className="flex items-center gap-1 text-slate-300">
                <span
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ background: c, boxShadow: `0 0 0 1.5px ${c}33` }}
                />
                {DIFFICULTY_LABEL[d]}
              </span>
            );
          })}
        <span className="h-3 w-px bg-slate-700" />
        <span className="flex items-center gap-1 text-slate-300">
          <span className="w-2.5 h-2.5 rounded-full bg-blue-500" /> 移動
        </span>
        <span className="flex items-center gap-1 text-slate-300">
          <span className="w-2.5 h-2.5 rounded-full bg-orange-500" /> 昼休憩
        </span>
        <span className="flex items-center gap-1 text-slate-300">
          <span className="w-2.5 h-2.5 rounded-full bg-slate-500" /> 空き
        </span>
        {windowMarkers.length > 0 && (
          <>
            <span className="h-3 w-px bg-slate-700" />
            <span
              className="flex items-center gap-1 text-slate-300"
              title="円の外側に表示される細い線は、お客様の指定時間です。範囲指定なら両端、以前/以降なら片端に短い目印が付きます。"
            >
              <svg width="14" height="10" viewBox="0 0 14 10" aria-hidden>
                <path d="M2 2 V8 M2 5 H12 M12 2 V8" stroke={WINDOW_COLOR} strokeWidth="1.5" strokeLinecap="round" fill="none" />
              </svg>
              指定時間
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function cnLegend(compact: boolean): string {
  return compact
    ? "mt-0 grid grid-cols-3 gap-x-2 gap-y-1 rounded-xl border border-slate-700/60 bg-slate-900/60 px-2.5 py-2 text-[10px] font-bold"
    : "mt-1 inline-flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1.5 rounded-full border border-slate-700/60 bg-slate-900/60 px-3 py-1.5 text-[10px] font-bold";
}
