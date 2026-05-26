/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { 
  Map, 
  APIProvider, 
  AdvancedMarker, 
  Pin, 
  useMap,
  useMapsLibrary
} from '@vis.gl/react-google-maps';
import { 
  Plus, 
  MapPin, 
  Clock, 
  Trash2, 
  Navigation, 
  Mic, 
  Camera,
  Image as ImageIcon,
  Settings as SettingsIcon,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Hash,
  ChevronRight,
  ClipboardList,
  Utensils,
  Layers,
  ArrowUp,
  ArrowDown
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from './lib/utils';
import { Visit, RoutePlan, Settings, Difficulty, Leg } from './types';
import { geocodeAddress, getDistanceMatrix } from './services/googleMapsService';
import { optimizeRoutes, computeInputOrderBaseline, calculatePlanForOrder, Baseline } from './lib/optimization';
import type { DistanceMatrixLike } from './services/googleMapsService';
import { getUserPlan, setUserPlan, getVisitLimit, UserPlan } from './lib/plan';
import { isDemoMode } from './lib/demoMode';
import { isAIUnlocked, tryUnlockAI, lockAI, getDailyUsage, consumeAIRequest } from './lib/demoAI';
import { parseVisitsFromTextClient, parseVisitsFromImageClient } from './services/geminiClientService';
import { ScheduleClock } from './components/ScheduleClock';
import { difficultyColor } from './lib/visitColors';

const API_KEY = process.env.GOOGLE_MAPS_PLATFORM_KEY || '';
const hasValidKey = Boolean(API_KEY) && API_KEY !== 'YOUR_API_KEY';

// Components
const IconButton = ({ icon: Icon, onClick, className, disabled }: any) => (
  <button 
    onClick={onClick} 
    disabled={disabled}
    className={cn(
      "p-2 rounded-lg hover:bg-slate-800 border border-ui transition-colors disabled:opacity-50",
      className
    )}
  >
    <Icon className="w-4 h-4 text-gray-300" />
  </button>
);

const Badge = ({ children, variant = 'default', className }: any) => {
  const variants = {
    default: "bg-slate-800 text-gray-300",
    success: "bg-green-500/10 text-green-400 border border-green-500/20",
    warning: "bg-yellow-500/10 text-yellow-400 border border-yellow-500/20",
    danger: "bg-red-500/10 text-red-400 border border-red-500/20",
  };
  return (
    <span className={cn("px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider", variants[variant as keyof typeof variants], className)}>
      {children}
    </span>
  );
};

const TIME_OPTIONS = Array.from({ length: 25 }).map((_, i) => {
  const h = Math.floor(i / 2) + 9; // 9:00 to 21:00
  const m = i % 2 === 0 ? '00' : '30';
  return `${h.toString().padStart(2, '0')}:${m}`;
});

type PlanScore = {
  idx: number;
  plan: RoutePlan;
  score: number;
  warningCount: number;
  violationCount: number;
  durationPenalty: number;
  distancePenalty: number;
  riskPenalty: number;
};

type RouteHealth = {
  label: '順調' | '余裕少' | '要注意';
  detail: string;
  tone: 'good' | 'watch' | 'danger';
  warningCount: number;
  violationCount: number;
};

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function isCompleteLeg(leg: Leg | undefined | null): leg is Leg {
  return Boolean(
    leg &&
    typeof leg.arrivalTime === 'string' &&
    typeof leg.endTime === 'string' &&
    Number.isFinite(leg.durationMin)
  );
}

function normalizeLeg(raw: Partial<Leg> | undefined | null): Leg | null {
  if (!raw || typeof raw.arrivalTime !== 'string' || typeof raw.endTime !== 'string') {
    return null;
  }
  const durationMin = Number(raw.durationMin);
  const distanceKm = Number(raw.distanceKm);
  return {
    fromName: raw.fromName || '',
    toName: raw.toName || '',
    durationMin: Number.isFinite(durationMin) ? durationMin : 0,
    distanceKm: Number.isFinite(distanceKm) ? distanceKm : 0,
    arrivalTime: raw.arrivalTime,
    workStartTime: raw.workStartTime,
    workEndTime: raw.workEndTime,
    endTime: raw.endTime,
    status: raw.status === 'warning' || raw.status === 'violation' ? raw.status : 'ok',
    visitId: raw.visitId,
  };
}

function normalizeRoutePlan(plan: RoutePlan): RoutePlan {
  const totalDurationMin = Number(plan.totalDurationMin);
  const totalDistanceKm = Number(plan.totalDistanceKm);
  const lunchDuration = Number(plan.lunchBreak?.durationMin);
  return {
    ...plan,
    order: Array.isArray(plan.order) ? plan.order : [],
    legs: (Array.isArray(plan.legs) ? plan.legs : [])
      .map(leg => normalizeLeg(leg))
      .filter((leg): leg is Leg => leg !== null),
    totalDurationMin: Number.isFinite(totalDurationMin) ? totalDurationMin : 0,
    totalDistanceKm: Number.isFinite(totalDistanceKm) ? totalDistanceKm : 0,
    lunchBreak: plan.lunchBreak && Number.isFinite(lunchDuration)
      ? { ...plan.lunchBreak, durationMin: lunchDuration }
      : undefined,
  };
}

function computePlanScores(plans: RoutePlan[]): PlanScore[] {
  const automaticPlans = plans
    .map((plan, idx) => ({ plan: normalizeRoutePlan(plan), idx }))
    .filter(({ plan }) => plan.id !== 'X');
  if (automaticPlans.length === 0) return [];

  const minDuration = Math.min(...automaticPlans.map(({ plan }) => plan.totalDurationMin));
  const minDistance = Math.min(...automaticPlans.map(({ plan }) => plan.totalDistanceKm));

  return automaticPlans.map(({ plan, idx }) => {
    const legs = plan.legs.filter(isCompleteLeg);
    const warningCount = legs.filter(leg => leg.status === 'warning').length;
    const violationCount = legs.filter(leg => leg.status === 'violation').length;
    const durationPenalty = minDuration > 0
      ? Math.min(25, ((plan.totalDurationMin - minDuration) / minDuration) * 100)
      : 0;
    const distancePenalty = minDistance > 0
      ? Math.min(20, ((plan.totalDistanceKm - minDistance) / minDistance) * 80)
      : 0;
    const riskPenalty = Math.min(45, warningCount * 8 + violationCount * 25);
    return {
      idx,
      plan,
      score: clampScore(100 - durationPenalty - distancePenalty - riskPenalty),
      warningCount,
      violationCount,
      durationPenalty,
      distancePenalty,
      riskPenalty,
    };
  }).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.violationCount !== b.violationCount) return a.violationCount - b.violationCount;
    if (a.warningCount !== b.warningCount) return a.warningCount - b.warningCount;
    if (a.plan.totalDurationMin !== b.plan.totalDurationMin) return a.plan.totalDurationMin - b.plan.totalDurationMin;
    return a.plan.totalDistanceKm - b.plan.totalDistanceKm;
  });
}

function getRouteHealth(plan: RoutePlan): RouteHealth {
  const legs = plan.legs.filter(isCompleteLeg);
  const warningCount = legs.filter(leg => leg.status === 'warning').length;
  const violationCount = legs.filter(leg => leg.status === 'violation').length;
  if (violationCount > 0) {
    return {
      label: '要注意',
      detail: `指定時間超過 ${violationCount}件`,
      tone: 'danger',
      warningCount,
      violationCount,
    };
  }
  if (warningCount > 0) {
    return {
      label: '余裕少',
      detail: `余裕少 ${warningCount}件`,
      tone: 'watch',
      warningCount,
      violationCount,
    };
  }
  return {
    label: '順調',
    detail: '指定時間リスクなし',
    tone: 'good',
    warningCount,
    violationCount,
  };
}

function formatDurationJp(minutes: number): string {
  const safe = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(safe / 60);
  const m = safe % 60;
  if (h === 0) return `${m}分`;
  if (m === 0) return `${h}時間`;
  return `${h}時間${m}分`;
}

function formatTimeWindowLabel(visit: Visit | null | undefined): string {
  const tw = visit?.timeWindow;
  if (!tw) return '指定なし';
  if (tw.start && tw.end) return `${tw.start}-${tw.end}`;
  if (tw.start) return `${tw.start} 以降`;
  if (tw.end) return `${tw.end} 以前`;
  return '指定なし';
}

function taskNameForVisit(settings: Settings, visit: Visit | null | undefined): string {
  if (!visit) return '訪問先';
  return settings.tasks.find(t => t.id === visit.taskId)?.name || '訪問先';
}

function getLegVisit(plan: RoutePlan, leg: Leg): { visit: Visit | null; visitOrderIndex: number } {
  const visit = leg.visitId ? plan.order.find(v => v.id === leg.visitId) || null : null;
  return {
    visit,
    visitOrderIndex: visit ? plan.order.findIndex(v => v.id === visit.id) + 1 : 0,
  };
}

function getNextVisit(plan: RoutePlan, completedVisitIds: Set<string>): { visit: Visit; leg: Leg; visitOrderIndex: number } | null {
  const nextVisit = plan.order.find(v => !completedVisitIds.has(v.id));
  if (!nextVisit) return null;
  const leg = plan.legs.find(item => item.visitId === nextVisit.id && isCompleteLeg(item));
  if (!leg) return null;
  return {
    visit: nextVisit,
    leg,
    visitOrderIndex: plan.order.findIndex(v => v.id === nextVisit.id) + 1,
  };
}

function shiftTime(value: string | undefined, minutes: number): string | undefined {
  if (!value) return value;
  const [h, m] = value.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return value;
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function insertLunchBreak(rawPlan: RoutePlan, durationMin: number): RoutePlan {
  const plan = normalizeRoutePlan(rawPlan);
  if (durationMin <= 0 || plan.order.length === 0) return plan;

  const safeLegs = plan.legs;
  if (safeLegs.length === 0) return plan;

  const afterLegIdx = Math.min(plan.order.length - 1, Math.floor(plan.order.length / 2));
  const afterLeg = safeLegs[afterLegIdx];
  const afterVisit = plan.order[afterLegIdx];
  if (!afterLeg || !afterVisit) return plan;

  const lunchStart = afterLeg.endTime;
  const lunchEnd = shiftTime(lunchStart, durationMin) || lunchStart;
  const nextPlan: RoutePlan = {
    ...plan,
    legs: safeLegs.map((leg, idx) => idx <= afterLegIdx ? { ...leg } : {
      ...leg,
      arrivalTime: shiftTime(leg.arrivalTime, durationMin) || leg.arrivalTime,
      workStartTime: shiftTime(leg.workStartTime, durationMin),
      workEndTime: shiftTime(leg.workEndTime, durationMin),
      endTime: shiftTime(leg.endTime, durationMin) || leg.endTime,
    }),
    totalDurationMin: plan.totalDurationMin,
    endTime: shiftTime(plan.endTime, durationMin) || plan.endTime,
    lunchBreak: {
      afterVisitId: afterVisit.id,
      startTime: lunchStart,
      endTime: lunchEnd,
      durationMin,
    },
  };

  nextPlan.legs = nextPlan.legs.map((leg, idx) => {
    if (!leg.visitId || idx <= afterLegIdx) return leg;
    const visit = nextPlan.order.find(v => v.id === leg.visitId);
    if (!visit?.timeWindow) return leg;
    const arrivalMin = parseTimeMinutes(leg.arrivalTime);
    const start = visit.timeWindow.start ? parseTimeMinutes(visit.timeWindow.start) : null;
    const end = visit.timeWindow.end ? parseTimeMinutes(visit.timeWindow.end) : null;
    let status: 'ok' | 'warning' | 'violation' = 'ok';
    if (end !== null && arrivalMin > end) status = 'violation';
    else if ((end !== null && arrivalMin > end - 30) || (start !== null && arrivalMin < start)) status = 'warning';
    return { ...leg, status };
  });

  return nextPlan;
}

function parseTimeMinutes(value: string): number {
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
}

function TimeWindowInput({ visit, onChange }: { visit: Visit, onChange: (updates: Partial<Visit>) => void }) {
  const { timeWindow } = visit;
  const hasStart = !!timeWindow?.start;
  const hasEnd = !!timeWindow?.end;

  let mode = 'none';
  if (hasStart && hasEnd) mode = 'range';
  else if (hasStart) mode = 'after';
  else if (hasEnd) mode = 'before';

  const setMode = (newMode: string) => {
    if (newMode === 'none') {
      onChange({ timeWindow: undefined });
    } else if (newMode === 'range') {
      onChange({ timeWindow: { start: timeWindow?.start || '09:00', end: timeWindow?.end || '12:00' } });
    } else if (newMode === 'after') {
      onChange({ timeWindow: { start: timeWindow?.start || '09:00', end: '' } });
    } else if (newMode === 'before') {
      onChange({ timeWindow: { start: '', end: timeWindow?.end || '12:00' } });
    }
  };

  return (
    <div className="flex flex-col gap-2 w-full">
      <div className="flex border border-ui rounded-lg overflow-hidden w-full h-7">
        <button onClick={() => setMode('none')} className={cn("flex-1 text-[10px] font-bold border-r border-ui transition-colors", mode === 'none' ? "bg-amber-500/20 text-amber-100 ring-1 ring-amber-400/45" : "bg-slate-800 text-secondary hover:bg-slate-700")}>なし</button>
        <button onClick={() => setMode('before')} className={cn("flex-1 text-[10px] font-bold border-r border-ui transition-colors", mode === 'before' ? "bg-amber-500/20 text-amber-100 ring-1 ring-amber-400/45" : "bg-slate-800 text-secondary hover:bg-slate-700")}>以前</button>
        <button onClick={() => setMode('after')} className={cn("flex-1 text-[10px] font-bold border-r border-ui transition-colors", mode === 'after' ? "bg-amber-500/20 text-amber-100 ring-1 ring-amber-400/45" : "bg-slate-800 text-secondary hover:bg-slate-700")}>以降</button>
        <button onClick={() => setMode('range')} className={cn("flex-1 text-[10px] font-bold transition-colors", mode === 'range' ? "bg-amber-500/20 text-amber-100 ring-1 ring-amber-400/45" : "bg-slate-800 text-secondary hover:bg-slate-700")}>範囲(〜)</button>
      </div>
      
      {mode !== 'none' && (
        <div className="flex items-center gap-2 justify-center bg-slate-900/80 p-2 rounded-lg border border-ui h-10 shadow-inner">
          {(mode === 'range' || mode === 'after') && (
             <div className="relative flex-1">
               <select
                 className="w-full bg-transparent text-sm font-bold text-center appearance-none focus:outline-none"
                 value={timeWindow?.start || '09:00'}
                 onChange={(e) => onChange({ timeWindow: { ...timeWindow, start: e.target.value } })}
               >
                 {TIME_OPTIONS.map(t => <option key={`s-${t}`} value={t} className="bg-slate-800">{t}</option>)}
               </select>
             </div>
          )}

          {mode === 'range' && <span className="text-secondary font-bold">〜</span>}
          {mode === 'after' && <span className="text-secondary font-bold text-xs uppercase">以降</span>}
          {mode === 'before' && <span className="text-secondary font-bold text-xs uppercase">以前</span>}

          {(mode === 'range' || mode === 'before') && (
             <div className="relative flex-1">
               <select
                 className="w-full bg-transparent text-sm font-bold text-center appearance-none focus:outline-none"
                 value={timeWindow?.end || '12:00'}
                 onChange={(e) => onChange({ timeWindow: { start: timeWindow?.start || '', end: e.target.value } })}
               >
                 {TIME_OPTIONS.map(t => <option key={`e-${t}`} value={t} className="bg-slate-800">{t}</option>)}
               </select>
             </div>
          )}
        </div>
      )}
    </div>
  );
}

function healthToneClasses(tone: RouteHealth['tone']): {
  panel: string;
  text: string;
  chip: string;
  dot: string;
} {
  if (tone === 'danger') {
    return {
      panel: 'border-red-500/35 bg-red-500/10',
      text: 'text-red-200',
      chip: 'bg-red-500/15 text-red-200 border-red-500/35',
      dot: 'bg-red-400 shadow-[0_0_10px_#f87171]',
    };
  }
  if (tone === 'watch') {
    return {
      panel: 'border-amber-500/35 bg-amber-500/10',
      text: 'text-amber-200',
      chip: 'bg-amber-500/15 text-amber-200 border-amber-500/35',
      dot: 'bg-amber-400 shadow-[0_0_10px_#fbbf24]',
    };
  }
  return {
    panel: 'border-emerald-500/30 bg-emerald-500/10',
    text: 'text-emerald-200',
    chip: 'bg-emerald-500/15 text-emerald-200 border-emerald-500/30',
    dot: 'bg-emerald-400 shadow-[0_0_10px_#34d399]',
  };
}

function RouteSummaryPanel({
  activePlan,
  scores,
  activePlanIdx,
  baseline,
  onSelectPlan,
}: {
  activePlan: RoutePlan;
  scores: PlanScore[];
  activePlanIdx: number;
  baseline: Baseline | null;
  onSelectPlan: (idx: number) => void;
}) {
  const recommended = scores[0];
  const currentScore = scores.find(score => score.idx === activePlanIdx);
  const health = getRouteHealth(activePlan);
  const tone = healthToneClasses(health.tone);
  const savedKm = baseline ? Math.max(0, baseline.totalDistanceKm - activePlan.totalDistanceKm) : 0;
  const savedMin = baseline ? Math.max(0, baseline.totalDurationMin - activePlan.totalDurationMin) : 0;

  return (
    <section className={cn("m-3 rounded-xl border p-4 shadow-xl shadow-black/10", tone.panel)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <span className={cn("h-2.5 w-2.5 rounded-full", tone.dot)} />
            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">今日の作戦</span>
            <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-bold", tone.chip)}>
              {health.label}
            </span>
          </div>
          <div className="flex items-end gap-2">
            <span className="text-3xl font-extrabold num-font text-white">{activePlan.endTime}</span>
            <span className="pb-1 text-[11px] font-bold text-slate-400">終了予定</span>
          </div>
          <p className={cn("mt-1 text-xs font-bold", tone.text)}>
            {health.detail} ・ 移動 {formatDurationJp(activePlan.totalDurationMin)}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Score</p>
          <p className="text-2xl font-extrabold num-font text-white">
            {currentScore?.score ?? '--'}<span className="text-xs text-slate-400">点</span>
          </p>
          {recommended && recommended.idx !== activePlanIdx && (
            <button
              onClick={() => onSelectPlan(recommended.idx)}
              className="mt-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] font-bold text-amber-200 hover:bg-amber-500/20"
            >
              推奨案へ
            </button>
          )}
        </div>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <div className="rounded-lg border border-white/10 bg-slate-950/25 p-2">
          <span className="block text-[9px] font-bold uppercase tracking-wider text-slate-500">距離</span>
          <span className="text-sm font-bold num-font text-white">{activePlan.totalDistanceKm.toFixed(1)}km</span>
        </div>
        <div className="rounded-lg border border-white/10 bg-slate-950/25 p-2">
          <span className="block text-[9px] font-bold uppercase tracking-wider text-slate-500">警告</span>
          <span className="text-sm font-bold num-font text-white">{health.warningCount}件</span>
        </div>
        <div className="rounded-lg border border-white/10 bg-slate-950/25 p-2">
          <span className="block text-[9px] font-bold uppercase tracking-wider text-slate-500">超過</span>
          <span className="text-sm font-bold num-font text-white">{health.violationCount}件</span>
        </div>
      </div>
      {baseline && (savedKm >= 0.1 || savedMin >= 1) && (
        <p className="mt-3 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-[11px] font-bold text-emerald-200">
          入力順より {savedKm.toFixed(1)}km / {savedMin}分 短縮
        </p>
      )}
    </section>
  );
}

function PlanTabs({
  plans,
  scores,
  activePlanIdx,
  onSelectPlan,
}: {
  plans: RoutePlan[];
  scores: PlanScore[];
  activePlanIdx: number;
  onSelectPlan: (idx: number) => void;
}) {
  const scoreByIdx = new globalThis.Map(scores.map(score => [score.idx, score]));
  const recommendedIdx = scores[0]?.idx;
  return (
    <div className="border-y border-ui bg-slate-950/25 px-3 py-3">
      <div className="flex gap-2 overflow-x-auto pb-1 custom-scrollbar">
        {plans.map((plan, idx) => {
          const score = scoreByIdx.get(idx);
          const selected = activePlanIdx === idx;
          const recommended = idx === recommendedIdx;
          return (
            <button
              key={plan.id}
              onClick={() => onSelectPlan(idx)}
              className={cn(
                "min-w-[118px] rounded-xl border p-3 text-left transition-all",
                selected
                  ? "border-amber-400/60 bg-amber-500/15 shadow-lg shadow-amber-950/30"
                  : "border-ui bg-slate-900/70 hover:bg-slate-800/80",
                recommended && !selected && "border-emerald-500/40"
              )}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="text-sm font-extrabold text-white">{plan.label}</span>
                {recommended && (
                  <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-bold text-emerald-200">推奨</span>
                )}
              </span>
              <span className="mt-1 block text-[11px] font-bold text-slate-400">
                {score ? `${score.score}点` : '手動'} ・ {formatDurationJp(plan.totalDurationMin)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function NextVisitCard({
  plan,
  settings,
  completedVisitIds,
  onComplete,
  onNavigateVisit,
  onNavigatePlan,
}: {
  plan: RoutePlan;
  settings: Settings;
  completedVisitIds: Set<string>;
  onComplete: (id: string) => void;
  onNavigateVisit: (visit: Visit) => void;
  onNavigatePlan: () => void;
}) {
  const next = getNextVisit(plan, completedVisitIds);
  if (!next) {
    return (
      <section className="mx-3 mb-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-300" />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-extrabold text-emerald-100">本日の訪問はすべて完了</h2>
            <p className="mt-1 text-xs text-emerald-100/70">必要なら帰着ルートをGoogle Mapsで確認できます。</p>
          </div>
          <button
            onClick={onNavigatePlan}
            className="rounded-lg bg-emerald-500/20 px-3 py-2 text-[11px] font-bold text-emerald-100 hover:bg-emerald-500/30"
          >
            ナビ
          </button>
        </div>
      </section>
    );
  }

  const { visit, leg, visitOrderIndex } = next;
  const statusTone = healthToneClasses(leg.status === 'violation' ? 'danger' : leg.status === 'warning' ? 'watch' : 'good');
  return (
    <section className={cn("mx-3 mb-3 rounded-xl border p-4", statusTone.panel)}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">次の訪問</p>
          <h2 className="mt-0.5 text-lg font-extrabold text-white">{visitOrderIndex}. {taskNameForVisit(settings, visit)}</h2>
        </div>
        <div
          className="rounded-lg px-2.5 py-1.5 text-center text-white shadow-lg"
          style={{ background: difficultyColor(visit.difficulty).work }}
        >
          <span className="block text-[9px] font-bold">到着</span>
          <span className="block text-sm font-extrabold num-font">{leg.arrivalTime}</span>
        </div>
      </div>
      <p className="text-xs leading-relaxed text-slate-300">{visit.address}</p>
      <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
        <div className="rounded-lg border border-white/10 bg-slate-950/25 p-2">
          <span className="block text-[9px] font-bold uppercase tracking-wider text-slate-500">指定時間</span>
          <span className={cn("font-bold", statusTone.text)}>{formatTimeWindowLabel(visit)}</span>
        </div>
        <div className="rounded-lg border border-white/10 bg-slate-950/25 p-2">
          <span className="block text-[9px] font-bold uppercase tracking-wider text-slate-500">完了予定</span>
          <span className="font-bold num-font text-white">{leg.endTime}</span>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-[1.4fr_1fr] gap-2">
        <button
          onClick={() => onNavigateVisit(visit)}
          className="flex items-center justify-center gap-2 rounded-xl bg-amber-500 px-3 py-3 text-sm font-extrabold text-slate-950 shadow-lg shadow-amber-950/20 active:scale-[0.98]"
        >
          <Navigation className="h-4 w-4" /> ナビ開始
        </button>
        <button
          onClick={() => onComplete(visit.id)}
          className="flex items-center justify-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/15 px-3 py-3 text-sm font-bold text-emerald-100 hover:bg-emerald-500/25"
        >
          <CheckCircle2 className="h-4 w-4" /> 完了
        </button>
      </div>
    </section>
  );
}

function RouteTimeline({
  plan,
  settings,
  completedVisitIds,
  activePlanId,
  customOrder,
  onMoveCustomVisit,
  onToggleCompleted,
  onNavigateVisit,
}: {
  plan: RoutePlan;
  settings: Settings;
  completedVisitIds: Set<string>;
  activePlanId: RoutePlan['id'];
  customOrder: string[];
  onMoveCustomVisit: (id: string, direction: number) => void;
  onToggleCompleted: (id: string) => void;
  onNavigateVisit: (visit: Visit) => void;
}) {
  return (
    <div className="space-y-3 px-3 pb-3">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-xs font-bold uppercase tracking-widest text-slate-500">本日のタイムライン</h2>
        <span className="text-[11px] font-bold text-slate-400">{plan.order.length}件</span>
      </div>
      {plan.legs.filter(isCompleteLeg).map((leg, idx) => {
        const lunchBreak = plan.lunchBreak;
        const { visit, visitOrderIndex } = getLegVisit(plan, leg);
        const isCompleted = visit ? completedVisitIds.has(visit.id) : false;
        const statusTone = healthToneClasses(leg.status === 'violation' ? 'danger' : leg.status === 'warning' ? 'watch' : 'good');
        const visitColor = visit ? difficultyColor(visit.difficulty).work : '#64748b';
        return (
          <div key={`${leg.visitId || 'end'}-${idx}`} className="relative">
            <div className="absolute bottom-0 left-[17px] top-9 w-px bg-slate-800" />
            <div className="flex gap-3">
              <div
                className="z-10 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 border-slate-950 text-xs font-extrabold text-white shadow-lg"
                style={{ background: visitColor }}
              >
                {visit ? visitOrderIndex : <CheckCircle2 className="h-4 w-4" />}
              </div>
              <div className={cn(
                "min-w-0 flex-1 rounded-xl border bg-slate-900/70 p-3 transition-all",
                visit ? statusTone.panel : "border-ui"
              )}>
                {visit ? (
                  <>
                    <div className="mb-2 flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-md bg-slate-950/40 px-2 py-1 text-[11px] font-extrabold num-font text-white">
                            {leg.arrivalTime}着
                          </span>
                          <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-bold", statusTone.chip)}>
                            {leg.status === 'ok' ? '正常' : leg.status === 'warning' ? '余裕少' : '遅延懸念'}
                          </span>
                        </div>
                        <h3 className={cn("mt-2 truncate text-sm font-extrabold text-white", isCompleted && "line-through text-slate-500")}>
                          {taskNameForVisit(settings, visit)}
                        </h3>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        {activePlanId === 'X' && (
                          <>
                            <button
                              onClick={() => onMoveCustomVisit(visit.id, -1)}
                              disabled={customOrder.indexOf(visit.id) <= 0}
                              title="上に移動"
                              className="rounded-lg p-1.5 text-blue-300 hover:bg-blue-500/10 disabled:opacity-30"
                            >
                              <ArrowUp className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => onMoveCustomVisit(visit.id, 1)}
                              disabled={customOrder.indexOf(visit.id) >= customOrder.length - 1}
                              title="下に移動"
                              className="rounded-lg p-1.5 text-blue-300 hover:bg-blue-500/10 disabled:opacity-30"
                            >
                              <ArrowDown className="h-4 w-4" />
                            </button>
                          </>
                        )}
                        <button
                          onClick={() => onToggleCompleted(visit.id)}
                          title={isCompleted ? '完了を取り消す' : '完了にする'}
                          className={cn(
                            "rounded-lg p-1.5 transition-colors",
                            isCompleted ? "bg-emerald-500/25 text-emerald-100" : "text-emerald-300 hover:bg-emerald-500/10"
                          )}
                        >
                          <CheckCircle2 className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => onNavigateVisit(visit)}
                          title="この訪問先にナビ"
                          className="rounded-lg p-1.5 text-amber-300 hover:bg-amber-500/10"
                        >
                          <Navigation className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                    <p className={cn("truncate text-[11px]", isCompleted ? "text-slate-600 line-through" : "text-slate-400")}>
                      {visit.address}
                    </p>
                    <div className="mt-3 grid grid-cols-3 gap-2 text-[10px]">
                      <div className="rounded-lg border border-white/10 bg-slate-950/25 p-2">
                        <span className="block font-bold uppercase tracking-wider text-slate-500">指定</span>
                        <span className={cn("font-bold", statusTone.text)}>{formatTimeWindowLabel(visit)}</span>
                      </div>
                      <div className="rounded-lg border border-white/10 bg-slate-950/25 p-2">
                        <span className="block font-bold uppercase tracking-wider text-slate-500">作業</span>
                        <span className="font-bold text-white">{visit.workMinutes + 30}分</span>
                      </div>
                      <div className="rounded-lg border border-white/10 bg-slate-950/25 p-2">
                        <span className="block font-bold uppercase tracking-wider text-slate-500">移動</span>
                        <span className="font-bold text-white">{leg.durationMin}分</span>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">終点到着</p>
                      <h3 className="mt-1 truncate text-sm font-bold text-white">
                        {settings.endLocation === 'home' ? settings.homeAddress : settings.customEndAddress}
                      </h3>
                    </div>
                    <span className="shrink-0 rounded-md bg-slate-950/40 px-2 py-1 text-[11px] font-extrabold num-font text-white">
                      {leg.arrivalTime}
                    </span>
                  </div>
                )}
              </div>
            </div>
            {lunchBreak && lunchBreak.afterVisitId === leg.visitId && (
              <div className="ml-12 mt-3 rounded-xl border border-orange-500/30 bg-orange-500/10 p-3">
                <div className="flex items-center gap-2 text-orange-300">
                  <Utensils className="h-4 w-4" />
                  <span className="text-[10px] font-bold uppercase tracking-widest">昼食・休憩</span>
                </div>
                <p className="mt-1 text-xs font-extrabold num-font text-orange-100">
                  {lunchBreak.startTime} - {lunchBreak.endTime} / {lunchBreak.durationMin}分
                </p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function OperationFooter({
  plan,
  completedVisitIds,
  onNavigatePlan,
  onEditConditions,
}: {
  plan: RoutePlan;
  completedVisitIds: Set<string>;
  onNavigatePlan: () => void;
  onEditConditions: () => void;
}) {
  const total = plan.order.length;
  const done = plan.order.filter(v => completedVisitIds.has(v.id)).length;
  const pct = total > 0 ? (done / total) * 100 : 0;
  return (
    <div className="sticky bottom-0 z-20 space-y-3 border-t border-ui bg-slate-950/90 p-3 backdrop-blur-md lg:static lg:bg-slate-950/70">
      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">本日の進捗</span>
          <span className="text-xs font-bold num-font text-white">{done} / {total} 件完了</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
          <div
            className="h-full bg-emerald-400 transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      <button
        onClick={onNavigatePlan}
        className="flex w-full items-center justify-center gap-3 rounded-xl bg-amber-500 py-3.5 text-sm font-extrabold text-slate-950 shadow-xl shadow-amber-950/25 active:scale-[0.98]"
      >
        <Navigation className="h-5 w-5" /> Google Maps でナビ開始
      </button>
      <button
        onClick={onEditConditions}
        className="flex w-full items-center justify-center gap-2 rounded-lg py-2 text-[10px] font-bold uppercase tracking-widest text-slate-400 hover:text-white"
      >
        条件編集に戻る <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export default function App() {
  if (!hasValidKey) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#1A1D23] text-gray-200 font-sans p-6">
        <div className="text-center max-w-lg">
          <h2 className="text-2xl font-bold mb-4">Google Maps API Key Required</h2>
          <p className="mb-6 opacity-80 leading-relaxed">
            このアプリを動作させるには Google Maps API Key が必要です。
          </p>
          <div className="bg-[#252932] p-6 rounded-xl text-left border border-gray-800">
            <h3 className="font-semibold mb-2 flex items-center gap-2">
              <SettingsIcon className="w-4 h-4" /> 設定手順
            </h3>
            <ol className="list-decimal list-inside space-y-3 text-sm opacity-90">
              <li>Open <strong>Settings</strong> (⚙️ gear icon, top-right)</li>
              <li>Select <strong>Secrets</strong></li>
              <li>Add <code>GOOGLE_MAPS_PLATFORM_KEY</code> as key</li>
              <li>Paste your API key as value</li>
            </ol>
          </div>
        </div>
      </div>
    );
  }

  return (
    <APIProvider apiKey={API_KEY} version="weekly" language="ja" libraries={['routes', 'geometry']}>
      <MainApp />
    </APIProvider>
  );
}

function MainApp() {
  const [settings, setSettings] = useState<Settings>(() => {
    const saved = localStorage.getItem('repair_settings');
    const parsed = saved ? JSON.parse(saved) : {};
    const parsedLunchBreak = Number(parsed.lunchBreakMinutes);

    return {
      homeAddress: '東京都新宿区新宿1-1-1',
      endLocation: 'home',
      ...parsed,
      startTime: parsed.startTime || '09:00',
      lunchBreakMinutes: [0, 15, 30, 45, 60].includes(parsedLunchBreak) ? parsedLunchBreak : 0,
      tasks: parsed.tasks || [
        { id: '1', name: '点検', defaultMinutes: 30 },
        { id: '2', name: '修理', defaultMinutes: 60 },
        { id: '3', name: '設置', defaultMinutes: 90 },
      ]
    };
  });
  
  const [visits, setVisits] = useState<Visit[]>(() => {
    const saved = localStorage.getItem('repair_visits');
    const parsed = saved ? JSON.parse(saved) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.map((v: any) => ({
      id: v.id,
      address: v.address || '',
      taskId: v.taskId,
      timeWindow: v.timeWindow,
      workMinutes: Number(v.workMinutes) || 60,
      difficulty: [1, 2, 3].includes(v.difficulty) ? v.difficulty as Difficulty : 2,
      coords: v.coords,
    }));
  });

  const [plans, setPlans] = useState<RoutePlan[]>([]);
  // Context needed to recompute the custom plan when the user reorders visits.
  const optContextRef = useRef<{
    visits: Visit[];
    settings: Settings;
    matrix: DistanceMatrixLike;
  } | null>(null);
  // Visit IDs in the user-chosen order for the "カスタム" plan.
  const [customOrder, setCustomOrder] = useState<string[]>([]);
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  const [completedVisitIds, setCompletedVisitIds] = useState<Set<string>>(new Set());
  const toggleCompleted = (id: string) => {
    setCompletedVisitIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const [activeTab, setActiveTab] = useState<'input' | 'result'>('input');
  const [activePlanIdx, setActivePlanIdx] = useState(0);

  // Matches Tailwind's lg: breakpoint. Used so we can mount the map either
  // inside the sidebar (mobile) OR as the main right-side panel (desktop)
  // without paying for two map instances at once.
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches
  );
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Recompute the custom plan when its order changes. Falls back to a no-op
  // if optimization context hasn't been captured yet.
  const recomputeCustomPlan = (nextOrder: string[]) => {
    const ctx = optContextRef.current;
    if (!ctx) return;
    const orderIndices = nextOrder
      .map(id => ctx.visits.findIndex(v => v.id === id) + 1)
      .filter(i => i > 0);
    const next = insertLunchBreak(
      calculatePlanForOrder(ctx.visits, ctx.settings, ctx.matrix, orderIndices, 'X'),
      ctx.settings.lunchBreakMinutes || 0
    );
    setPlans(prev => prev.map((p, i) => (i === 3 ? next : p)));
  };

  const moveCustomVisit = (visitId: string, direction: -1 | 1) => {
    const idx = customOrder.indexOf(visitId);
    if (idx < 0) return;
    const swapWith = idx + direction;
    if (swapWith < 0 || swapWith >= customOrder.length) return;
    const next = customOrder.slice();
    [next[idx], next[swapWith]] = [next[swapWith], next[idx]];
    setCustomOrder(next);
    recomputeCustomPlan(next);
  };
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [showTasksSettings, setShowTasksSettings] = useState(false);
  const [showStartEndSettings, setShowStartEndSettings] = useState(false);
  const [inputText, setInputText] = useState('');
  const [isParsing, setIsParsing] = useState(false);
  const [isParsingImage, setIsParsingImage] = useState(false);
  const [pendingParsedVisits, setPendingParsedVisits] = useState<Visit[] | null>(null);
  const [pendingParseSource, setPendingParseSource] = useState<'text' | 'image' | null>(null);

  const [userPlan, setUserPlanState] = useState<UserPlan>(() => getUserPlan());
  const [upgradeReason, setUpgradeReason] = useState<string | null>(null);
  const [showAIUnlock, setShowAIUnlock] = useState(false);
  const [aiUnlocked, setAIUnlocked] = useState<boolean>(() => isAIUnlocked());
  const [aiUsage, setAIUsage] = useState(() => getDailyUsage());
  const refreshAIUsage = () => setAIUsage(getDailyUsage());
  const pendingAIActionRef = useRef<(() => void) | null>(null);
  const [showOnboarding, setShowOnboarding] = useState<boolean>(() => {
    try {
      return !localStorage.getItem('repair_onboarded_v1');
    } catch {
      return false;
    }
  });
  const dismissOnboarding = () => {
    try { localStorage.setItem('repair_onboarded_v1', '1'); } catch {}
    setShowOnboarding(false);
  };
  const visitLimit = getVisitLimit(userPlan);

  type Notice = {
    kind: 'error' | 'info' | 'success';
    title: string;
    detail?: string;
    onRetry?: () => void;
  };
  const [notice, setNotice] = useState<Notice | null>(null);
  const showNotice = (n: Notice) => setNotice(n);
  const clearNotice = () => setNotice(null);

  const handleLoadSampleAndOptimize = () => {
    const sample: Visit[] = [
      { id: 's1', address: '東京都新宿区西新宿2-8-1', taskId: '1', workMinutes: 30, difficulty: 2 },
      { id: 's2', address: '東京都渋谷区道玄坂1-12-1', taskId: '2', workMinutes: 60, difficulty: 2, timeWindow: { start: '11:00', end: '13:00' } },
      { id: 's3', address: '東京都港区六本木6-10-1', taskId: '3', workMinutes: 90, difficulty: 3 },
    ];
    setVisits(sample);
    dismissOnboarding();
    // Run after the state settles so handleOptimize sees the new visits.
    setTimeout(() => {
      // handleOptimize closes over `visits` — call it via a fresh closure
      // by triggering through a microtask + state-driven approach.
      // Simpler: replicate handleOptimize but pass the sample directly.
      runOptimizeFor(sample);
    }, 0);
  };

  const runOptimizeFor = async (sampleVisits: Visit[]) => {
    setIsOptimizing(true);
    try {
      const updatedSettings = { ...settings };
      if (!updatedSettings.homeCoords) {
        updatedSettings.homeCoords = await geocodeAddress(updatedSettings.homeAddress);
      }
      const updatedVisits = await Promise.all(sampleVisits.map(async v => {
        if (v.coords) return v;
        const coords = await geocodeAddress(v.address);
        return { ...v, coords };
      }));
      setVisits(updatedVisits);
      setSettings(updatedSettings);
      const points = [updatedSettings.homeCoords || updatedSettings.homeAddress, ...updatedVisits.map(v => v.coords || v.address)];
      const matrix = await getDistanceMatrix(points, points);
      const optimizedPlans = optimizeRoutes(updatedVisits, updatedSettings, matrix).map(plan =>
        insertLunchBreak(plan, updatedSettings.lunchBreakMinutes || 0)
      ).map(normalizeRoutePlan);
      setBaseline(computeInputOrderBaseline(updatedVisits, updatedSettings, matrix));
      setPlans(optimizedPlans);
      setActiveTab('result');
      setActivePlanIdx(0);
    } catch (error) {
      const { title, detail } = explainError(error, 'サンプルの計算に失敗しました');
      showNotice({ kind: 'error', title, detail });
    } finally {
      setIsOptimizing(false);
    }
  };

  const handleOptimizeFromCurrentLocation = () => {
    if (!validateBeforeOptimize(true)) return;
    if (userPlan === 'free') {
      promptUpgrade('現在地起点での再最適化はPro機能です。外出先からの再計画が一発で完了します。');
      return;
    }
    if (!('geolocation' in navigator)) {
      showNotice({ kind: 'error', title: '位置情報を取得できません', detail: 'お使いの端末では位置情報サービスが利用できません。' });
      return;
    }
    setIsOptimizing(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        handleOptimize({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      (err) => {
        setIsOptimizing(false);
        showNotice({
          kind: 'error',
          title: '現在地を取得できませんでした',
          detail: err.code === err.PERMISSION_DENIED
            ? '位置情報の利用が許可されていません。ブラウザの権限を確認してください。'
            : '位置情報の取得に失敗しました。GPS信号の良い場所で再度お試しください。',
        });
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  };

  // Map raw errors (network, HTTP, API status strings) to a user-friendly notice.
  const explainError = (e: unknown, fallbackTitle: string): { title: string; detail: string } => {
    const msg = e instanceof Error ? e.message : String(e);
    if (/Gemini API 403|API_KEY_HTTP_REFERRER_BLOCKED|are blocked/i.test(msg)) {
      return {
        title: 'AI解析サービスにアクセスできません',
        detail: 'Gemini APIキーの参照元(HTTPリファラー)制限によりブロックされました。管理者はGoogle AI Studio / GCPコンソールでこのサイトのURLを許可リストに追加するか、リファラー制限を解除してください。',
      };
    }
    if (/Gemini API (401|400)/i.test(msg)) {
      return { title: 'AI解析サービスにアクセスできません', detail: 'Gemini APIキーが未設定または無効です。管理者にお問い合わせください。' };
    }
    if (/429/.test(msg)) {
      return { title: 'API利用上限に達しました', detail: '1時間あたりの利用回数を超えています。少し時間を置いてからお試しください。' };
    }
    if (/ZERO_RESULTS|NOT_FOUND/i.test(msg)) {
      return { title: '住所が見つかりませんでした', detail: '番地まで含めて入力されているか確認してください。例: 東京都新宿区新宿1-1-1' };
    }
    if (/OVER_QUERY_LIMIT|OVER_DAILY_LIMIT/i.test(msg)) {
      return { title: 'Maps APIの上限超過', detail: '時間を置いて再度お試しください。' };
    }
    if (/Failed to fetch|NetworkError|ERR_NETWORK/i.test(msg)) {
      return { title: 'ネットワークに接続できません', detail: '電波・Wi-Fiを確認してから再試行してください。' };
    }
    return { title: fallbackTitle, detail: msg.slice(0, 200) };
  };

  const promptUpgrade = (reason: string) => setUpgradeReason(reason);
  const upgradeToPro = () => {
    setUserPlan('pro');
    setUserPlanState('pro');
    setUpgradeReason(null);
  };
  const downgradeToFree = () => {
    setUserPlan('free');
    setUserPlanState('free');
  };

  useEffect(() => {
    localStorage.setItem('repair_settings', JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    localStorage.setItem('repair_visits', JSON.stringify(visits));
  }, [visits]);

  const handleAddVisit = () => {
    if (visits.length >= visitLimit) {
      if (userPlan === 'free') {
        promptUpgrade(`無料プランは1日${visitLimit}件まで。Proなら${getVisitLimit('pro')}件まで登録できます。`);
      }
      return;
    }
    const newVisit: Visit = {
      id: Math.random().toString(36).substr(2, 9),
      address: '',
      workMinutes: 60,
      difficulty: 2
    };
    setVisits([...visits, newVisit]);
  };

  const handleUpdateVisit = (id: string, updates: Partial<Visit>) => {
    setVisits(visits.map(v => {
      if (v.id !== id) return v;
      const next = { ...v, ...updates };
      // Invalidate cached coords when the address changes so the next
      // optimization re-geocodes (via the address-keyed cache, this stays cheap).
      if (updates.address !== undefined && updates.address !== v.address) {
        next.coords = undefined;
      }
      return next;
    }));
  };

  const handleDeleteVisit = (id: string) => {
    setVisits(visits.filter(v => v.id !== id));
  };

  const parseHHMM = (value?: string): number | null => {
    if (!value) return null;
    const match = value.match(/^(\d{2}):(\d{2})$/);
    if (!match) return null;
    const h = Number(match[1]);
    const m = Number(match[2]);
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;
    return h * 60 + m;
  };

  const getVisitValidation = (visit: Visit): { errors: string[]; warnings: string[] } => {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (!visit.address.trim()) {
      errors.push('住所を入力してください');
    }
    if (visit.timeWindow?.start && visit.timeWindow?.end) {
      const start = parseHHMM(visit.timeWindow.start);
      const end = parseHHMM(visit.timeWindow.end);
      if (start !== null && end !== null && start >= end) {
        errors.push('訪問時間は開始を終了より前にしてください');
      }
    }
    if (!visit.taskId) {
      warnings.push('作業未選択です。滞在予定を確認してください');
    }
    return { errors, warnings };
  };

  const validateBeforeOptimize = (usesCurrentLocation = false): boolean => {
    if (!usesCurrentLocation && !settings.homeAddress.trim()) {
      showNotice({
        kind: 'error',
        title: '起点を確認してください',
        detail: '起点住所を入力してください。',
      });
      return false;
    }
    if (settings.endLocation === 'custom' && !settings.customEndAddress?.trim()) {
      showNotice({
        kind: 'error',
        title: '終点を確認してください',
        detail: '別の終点を使う場合は、終点住所を入力してください。',
      });
      return false;
    }
    const firstInvalid = visits
      .map((visit, idx) => ({ idx, validation: getVisitValidation(visit) }))
      .find(item => item.validation.errors.length > 0);
    if (!firstInvalid) return true;
    showNotice({
      kind: 'error',
      title: '入力を確認してください',
      detail: `訪問先${firstInvalid.idx + 1}: ${firstInvalid.validation.errors[0]}`,
    });
    return false;
  };

  const normalizeParsedVisits = (data: any[]): Visit[] => {
    return data.map((v: any) => ({
      id: Math.random().toString(36).substr(2, 9),
      address: typeof v.address === 'string' ? v.address : '',
      workMinutes: 60,
      difficulty: [1, 2, 3].includes(v.difficulty) ? v.difficulty as Difficulty : 2,
      timeWindow: v.startTime || v.endTime ? { start: v.startTime || '', end: v.endTime || '' } : undefined,
    }));
  };

  const stageParsedVisits = (data: any[], sourceLabel: 'text' | 'image') => {
    const newVisits = normalizeParsedVisits(data);
    setPendingParsedVisits(newVisits);
    setPendingParseSource(sourceLabel);
  };

  const confirmParsedVisits = (approvedVisits: Visit[]) => {
    const validVisits = approvedVisits.filter(v => v.address.trim());
    if (validVisits.length === 0) {
      showNotice({ kind: 'info', title: '追加できる訪問先がありません', detail: '住所が入っている候補を1件以上残してください。' });
      return;
    }
    const merged = [...visits, ...validVisits];
    if (userPlan === 'free' && merged.length > visitLimit) {
      const overflow = validVisits.length - (visitLimit - visits.length);
      const verb = pendingParseSource === 'image' ? '画像から' : '読み取った';
      promptUpgrade(`${verb}${validVisits.length}件のうち${overflow}件が無料枠を超えました。Proなら${getVisitLimit('pro')}件まで登録できます。`);
    }
    setVisits(merged.slice(0, visitLimit));
    if (pendingParseSource === 'text') setInputText('');
    setPendingParsedVisits(null);
    setPendingParseSource(null);
  };

  const requireAIAccess = (retry: () => void): boolean => {
    if (!isDemoMode()) return true;
    if (!aiUnlocked) {
      pendingAIActionRef.current = retry;
      setShowAIUnlock(true);
      return false;
    }
    if (getDailyUsage().remaining <= 0) {
      showNotice({
        kind: 'info',
        title: '本日のAI解析の上限に達しました',
        detail: 'デモ版は1日10回までご利用いただけます。明日0時にリセットされます。',
      });
      return false;
    }
    return true;
  };

  const handleParseText = async () => {
    if (!inputText.trim()) return;
    if (!requireAIAccess(handleParseText)) return;
    setIsParsing(true);
    try {
      let data: any[];
      if (isDemoMode()) {
        data = await parseVisitsFromTextClient(inputText);
        consumeAIRequest();
        refreshAIUsage();
      } else {
        const response = await fetch("/api/parse-visits", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: inputText }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        data = await response.json();
      }
      if (Array.isArray(data) && data.length > 0) {
        stageParsedVisits(data, 'text');
      } else {
        showNotice({ kind: 'info', title: 'テキストから訪問先を抽出できませんでした', detail: '住所が含まれているかご確認ください。' });
      }
    } catch (error) {
      console.error(error);
      const { title, detail } = explainError(error, 'テキストの読み取りに失敗しました');
      showNotice({ kind: 'error', title, detail, onRetry: handleParseText });
    } finally {
      setIsParsing(false);
    }
  };

  const handleParseImage = async (base64: string, mimeType: string) => {
    if (!requireAIAccess(() => handleParseImage(base64, mimeType))) return;
    setIsParsingImage(true);
    try {
      let data: any[];
      if (isDemoMode()) {
        data = await parseVisitsFromImageClient(base64, mimeType);
        consumeAIRequest();
        refreshAIUsage();
      } else {
        const response = await fetch("/api/parse-image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: base64, mimeType }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        data = await response.json();
      }
      if (Array.isArray(data) && data.length > 0) {
        stageParsedVisits(data, 'image');
      } else {
        showNotice({ kind: 'info', title: '画像から訪問先を抽出できませんでした', detail: '別の角度で撮影、または明るい場所で撮り直してみてください。' });
      }
    } catch (error) {
      console.error(error);
      const { title, detail } = explainError(error, '画像の解析に失敗しました');
      showNotice({ kind: 'error', title, detail });
    } finally {
      setIsParsingImage(false);
    }
  };

  const handleOptimize = async (startOverride?: google.maps.LatLngLiteral) => {
    if (visits.length === 0) return;
    if (!validateBeforeOptimize(Boolean(startOverride))) return;
    setIsOptimizing(true);
    try {
      // 1. Geocode all addresses (if not cached/done)
      const updatedSettings = { ...settings };
      if (startOverride) {
        updatedSettings.homeCoords = startOverride;
        updatedSettings.homeAddress = `現在地 (${startOverride.lat.toFixed(4)}, ${startOverride.lng.toFixed(4)})`;
      } else if (!updatedSettings.homeCoords) {
        updatedSettings.homeCoords = await geocodeAddress(updatedSettings.homeAddress);
      }
      if (updatedSettings.endLocation === 'custom' && updatedSettings.customEndAddress && !updatedSettings.customEndCoords) {
        updatedSettings.customEndCoords = await geocodeAddress(updatedSettings.customEndAddress);
      }
      setSettings(updatedSettings);

      // Reuse cached coords as long as the address hasn't changed.
      // geocodeAddress also has its own localStorage TTL cache,
      // so repeated optimizations on the same set incur zero network cost.
      const updatedVisits = await Promise.all(visits.map(async v => {
        if (v.coords && v.address) {
          return v;
        }
        if (!v.address) return v;
        const coords = await geocodeAddress(v.address);
        return { ...v, coords };
      }));
      setVisits(updatedVisits);

      // 2. Distance Matrix
      const points = [
        updatedSettings.homeCoords || updatedSettings.homeAddress,
        ...updatedVisits.map(v => v.coords || v.address)
      ];
      if (updatedSettings.endLocation === 'custom' && updatedSettings.customEndAddress) {
        points.push(updatedSettings.customEndCoords || updatedSettings.customEndAddress);
      }

      const matrix = await getDistanceMatrix(points, points);

      // 3. Optimize + compute baseline (input order) for savings display
      const optimizedPlans = optimizeRoutes(updatedVisits, updatedSettings, matrix)
        .map(plan => insertLunchBreak(plan, updatedSettings.lunchBreakMinutes || 0))
        .map(normalizeRoutePlan);
      // Seed the manual ("カスタム") plan with the best automatic order so the
      // user has a sensible starting point to nudge from.
      const customSeed = optimizedPlans[0]?.order.map(v => v.id) || [];
      const customPlan = insertLunchBreak(
        calculatePlanForOrder(
          updatedVisits,
          updatedSettings,
          matrix,
          customSeed
            .map(id => updatedVisits.findIndex(v => v.id === id) + 1)
            .filter(i => i > 0),
          'X',
        ),
        updatedSettings.lunchBreakMinutes || 0
      );
      optimizedPlans.push(normalizeRoutePlan(customPlan));
      // Persist context for later re-computation when the user reorders.
      optContextRef.current = { visits: updatedVisits, settings: updatedSettings, matrix };
      setCustomOrder(customSeed);
      const baselineResult = computeInputOrderBaseline(updatedVisits, updatedSettings, matrix);
      setBaseline(baselineResult);

      setPlans(optimizedPlans.map(normalizeRoutePlan));
      setCompletedVisitIds(new Set());
      setActiveTab('result');
      setActivePlanIdx(0);
    } catch (error) {
      console.error(error);
      const { title, detail } = explainError(error, 'ルート計算に失敗しました');
      showNotice({ kind: 'error', title, detail, onRetry: () => handleOptimize() });
    } finally {
      setIsOptimizing(false);
    }
  };

  const displayPlans = plans.map(normalizeRoutePlan);
  const activePlan = displayPlans[activePlanIdx];
  const planScores = computePlanScores(displayPlans);
  const [showMobileMap, setShowMobileMap] = useState(false);

  const openVisitNavigation = (visit: Visit) => {
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(visit.address)}`, '_blank');
  };

  const openPlanNavigation = () => {
    const plan = activePlan;
    const remaining = plan.order.filter(v => !completedVisitIds.has(v.id));
    if (remaining.length === 0) {
      showNotice({ kind: 'success', title: '本日の訪問はすべて完了しました', detail: 'お疲れさまでした！' });
      return;
    }
    const waypoints = remaining.map(v => encodeURIComponent(v.address)).join('/');
    const dest = settings.endLocation === 'home'
      ? settings.homeAddress
      : (settings.endLocation === 'custom' ? settings.customEndAddress : remaining[remaining.length - 1].address);
    window.open(`https://www.google.com/maps/dir/${encodeURIComponent(settings.homeAddress)}/${waypoints}/${encodeURIComponent(dest || '')}`, '_blank');
  };

  return (
    <div className="bg-bg text-gray-200 min-h-screen font-sans border-ui overflow-x-hidden pb-20">
      {/* Demo banner */}
      {isDemoMode() && (
        <div className="bg-amber-500/15 border-b border-amber-500/30 text-amber-200 text-[11px] py-1.5 px-4 text-center">
          <span className="font-bold">DEMO</span> · プレビュー版 · AI解析はパスワード制（1日10回）
        </div>
      )}

      {/* Header */}
      <nav className="sticky top-0 z-40 h-16 border-b border-ui flex items-center justify-between px-6 bg-slate-900/50 backdrop-blur-md">
        <div>
          <h1 className="text-lg font-bold tracking-tight flex items-center gap-2">
            <span className="w-8 h-8 bg-blue-500 rounded flex items-center justify-center text-white text-sm">R</span>
            ルート最適化 <span className="text-xs font-normal text-slate-400">v1.2</span>
          </h1>
        </div>
        <div className="flex items-center gap-3">
           {activeTab === 'result' && (
             <div className="hidden sm:flex flex-col items-end text-xs mr-2">
                <span className="text-secondary">起点</span>
                <span className="font-medium truncate max-w-[150px]">{settings.homeAddress}</span>
             </div>
           )}
           {isDemoMode() ? (
             // Demo build: simple two-state toggle so reviewers can flip
             // between Free / Pro without the upsell modal in the way.
             <div className="flex items-center gap-2">
               <span className="text-[9px] uppercase tracking-wider text-slate-500 font-bold hidden sm:inline">Plan</span>
               <button
                 onClick={() => (userPlan === 'pro' ? downgradeToFree() : upgradeToPro())}
                 className={cn(
                   "relative inline-flex items-center h-6 w-[88px] rounded-full border transition-colors",
                   userPlan === 'pro'
                     ? "bg-amber-500/20 border-amber-500/40"
                     : "bg-slate-800 border-ui"
                 )}
                 title="クリックで Free / Pro を切り替え (デモ用)"
               >
                 <span className={cn(
                   "absolute text-[10px] font-bold uppercase tracking-wider transition-all",
                   userPlan === 'pro' ? "left-2 text-amber-300" : "left-2 text-slate-500"
                 )}>
                   {userPlan === 'pro' ? 'Pro' : 'Free'}
                 </span>
                 <span className={cn(
                   "absolute w-5 h-5 rounded-full bg-white/90 shadow-md transition-transform",
                   userPlan === 'pro' ? "translate-x-[60px]" : "translate-x-0.5"
                 )} />
               </button>
             </div>
           ) : userPlan === 'pro' ? (
             <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40">
               Pro
             </span>
           ) : (
             <button
               onClick={() => promptUpgrade('Proにアップグレードすると、最大15件の訪問・GPS現在地起点・月次レポートが使えます。')}
               className="text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded bg-slate-800 text-blue-300 border border-blue-500/30 hover:bg-blue-500/10"
             >
               Free · アップグレード
             </button>
           )}
        </div>
      </nav>

      <AnimatePresence mode="wait">
        {activeTab === 'input' || !activePlan ? (
          <motion.div 
            key="input"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="mx-auto w-full max-w-[1320px] px-3 pb-28 pt-4 sm:px-5 lg:pb-6"
          >
            <div className="overflow-hidden rounded-[22px] border border-slate-700/70 bg-slate-950/45 shadow-2xl shadow-black/30">
              <div className="border-b border-ui bg-slate-950/55 px-4 py-4 backdrop-blur-md sm:px-5">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500 text-sm font-extrabold text-white shadow-lg shadow-blue-950/40">
                      R
                    </span>
                    <div>
                      <h2 className="text-base font-extrabold tracking-tight text-white">ルート最適化 <span className="text-[11px] font-medium text-slate-400">v1.2</span></h2>
                      <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Field operations setup</p>
                    </div>
                  </div>
                  <button
                    onClick={() => (userPlan === 'pro' ? downgradeToFree() : upgradeToPro())}
                    className="rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-[11px] font-bold text-slate-200 hover:bg-slate-800"
                  >
                    プラン{userPlan === 'pro' ? 'A' : 'Free'}
                  </button>
                </div>
              </div>

              <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_300px] lg:p-5">
                <div className="space-y-4">
                  <div className="flex items-center gap-3">
                    <h1 className="text-2xl font-extrabold tracking-tight text-white">今日の準備</h1>
                    <span className="rounded-md border border-amber-400/50 bg-amber-500/10 px-2 py-1 text-[11px] font-bold text-amber-300">
                      入力中
                    </span>
                  </div>

                  <section className="rounded-xl border border-slate-700/70 bg-slate-900/60 p-4 shadow-inner shadow-white/[0.02]">
                    <div className="mb-3 flex items-center justify-between">
                      <h2 className="text-sm font-extrabold text-white">ルートの基本設定</h2>
                      <button
                        onClick={() => setShowStartEndSettings(true)}
                        title="起点・終点・出発時刻を編集"
                        className="rounded-lg border border-slate-700 bg-slate-950/50 p-2 text-slate-300 hover:border-amber-400/40 hover:text-amber-200"
                      >
                        <SettingsIcon className="h-4 w-4" />
                      </button>
                    </div>
                    <div className="grid grid-cols-3 divide-x divide-slate-700 rounded-lg border border-slate-700/70 bg-slate-950/30">
                      <div className="min-w-0 p-3 text-center">
                        <span className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-slate-500">起点</span>
                        <p className="truncate text-sm font-extrabold text-white">
                          <MapPin className="mr-1 inline h-4 w-4 text-emerald-400" />
                          {settings.homeAddress ? '現在地' : '未設定'}
                        </p>
                      </div>
                      <div className="p-3 text-center">
                        <span className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-slate-500">出発</span>
                        <p className="text-2xl font-extrabold num-font text-white">{settings.startTime || '09:00'}</p>
                      </div>
                      <div className="min-w-0 p-3 text-center">
                        <span className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-slate-500">終点</span>
                        <p className="truncate text-sm font-extrabold text-white">
                          <MapPin className="mr-1 inline h-4 w-4 text-blue-400" />
                          {settings.endLocation === 'home' && '本社'}
                          {settings.endLocation === 'none' && '解散'}
                          {settings.endLocation === 'custom' && (settings.customEndAddress || '未設定')}
                        </p>
                      </div>
                    </div>
                  </section>

                  <section className="rounded-xl border border-slate-700/70 bg-slate-900/60 p-3 sm:p-4">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <h2 className="text-base font-extrabold text-white">訪問先リスト</h2>
                        <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-300">
                          {visits.length}件入力済み
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setShowTasksSettings(true)}
                          className="rounded-lg border border-slate-700 bg-slate-950/45 px-2.5 py-1.5 text-[10px] font-bold text-blue-300 hover:bg-blue-500/10"
                        >
                          作業設定
                        </button>
                        {visits.length > 0 && (
                          <button
                            onClick={() => setVisits([])}
                            className="rounded-lg px-2 py-1.5 text-red-300 hover:bg-red-500/10"
                            title="訪問先をリセット"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="hidden rounded-lg border border-slate-700/70 bg-slate-950/25 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-500 lg:grid lg:grid-cols-[32px_72px_minmax(170px,1fr)_150px_132px_82px_32px] lg:gap-3">
                      <span>#</span>
                      <span>作業種別</span>
                      <span>住所</span>
                      <span>作業設定</span>
                      <span>訪問時間</span>
                      <span>滞在予定</span>
                      <span />
                    </div>

                    <div className="mt-2 space-y-2">
                      {visits.map((visit, idx) => {
                        const validation = getVisitValidation(visit);
                        const hasErrors = validation.errors.length > 0;
                        const hasWarnings = !hasErrors && validation.warnings.length > 0;
                        return (
                          <div
                            key={visit.id}
                            className={cn(
                              "rounded-xl border bg-slate-950/25 p-3 transition-all lg:grid lg:grid-cols-[32px_72px_minmax(170px,1fr)_150px_132px_82px_32px] lg:items-center lg:gap-3",
                              hasErrors ? "border-red-500/50" : hasWarnings ? "border-yellow-500/35" : "border-slate-700/70"
                            )}
                          >
                            <div className="mb-3 flex items-center justify-between lg:mb-0">
                              <span
                                className="flex h-7 w-7 items-center justify-center rounded-md text-xs font-extrabold text-white shadow-md"
                                style={{ background: difficultyColor(visit.difficulty).work }}
                              >
                                {idx + 1}
                              </span>
                              <button
                                onClick={() => handleDeleteVisit(visit.id)}
                                className="rounded-lg p-1.5 text-slate-500 hover:bg-red-500/10 hover:text-red-300 lg:hidden"
                                title="削除"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                            <select
                              className="mb-2 w-full rounded-lg border border-slate-700 bg-slate-950/50 px-2 py-2 text-sm font-extrabold text-white outline-none focus:border-amber-400/50 lg:mb-0 lg:border-transparent lg:bg-transparent lg:px-0"
                              value={visit.taskId || ''}
                              onChange={(e) => {
                                const tId = e.target.value;
                                const task = settings.tasks.find(t => t.id === tId);
                                handleUpdateVisit(visit.id, {
                                  taskId: tId,
                                  workMinutes: task ? task.defaultMinutes : visit.workMinutes
                                });
                              }}
                            >
                              <option value="" disabled className="text-gray-500">作業を選択...</option>
                              {settings.tasks.map(t => (
                                <option key={t.id} value={t.id} className="bg-[#1A1D23]">{t.name}</option>
                              ))}
                            </select>
                            <textarea
                              className="mb-2 min-h-[44px] w-full resize-none rounded-lg border border-slate-700 bg-slate-950/45 px-3 py-2 text-xs leading-relaxed text-slate-100 outline-none focus:border-amber-400/50 lg:mb-0"
                              placeholder="住所"
                              rows={2}
                              value={visit.address}
                              onChange={(e) => handleUpdateVisit(visit.id, { address: e.target.value })}
                            />
                            <div className="mb-2 lg:mb-0">
                              <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-500 lg:hidden">難易度</span>
                              <DifficultySelector
                                value={visit.difficulty}
                                onChange={(d) => handleUpdateVisit(visit.id, { difficulty: d })}
                              />
                            </div>
                            <div className="mb-2 lg:mb-0">
                              <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-500 lg:hidden">訪問時間</span>
                              <TimeWindowInput visit={visit} onChange={(u) => handleUpdateVisit(visit.id, u)} />
                            </div>
                            <select
                              className="w-full rounded-lg border border-slate-700 bg-slate-950/50 px-2 py-2 text-xs font-extrabold text-white outline-none focus:border-amber-400/50"
                              value={visit.workMinutes}
                              onChange={(e) => handleUpdateVisit(visit.id, { workMinutes: Number(e.target.value) })}
                            >
                              <option value={30}>30分</option>
                              <option value={60}>60分</option>
                              <option value={90}>90分</option>
                              <option value={120}>120分</option>
                              <option value={150}>150分</option>
                              <option value={180}>180分</option>
                            </select>
                            <button
                              onClick={() => handleDeleteVisit(visit.id)}
                              className="hidden rounded-lg p-2 text-slate-500 hover:bg-red-500/10 hover:text-red-300 lg:block"
                              title="削除"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                            {(validation.errors.length > 0 || validation.warnings.length > 0) && (
                              <div className="mt-2 space-y-1 lg:col-span-7">
                                {validation.errors.map(message => (
                                  <p key={message} className="flex items-center gap-1.5 text-[10px] font-bold text-red-300">
                                    <AlertTriangle className="h-3 w-3 shrink-0" />
                                    {message}
                                  </p>
                                ))}
                                {validation.warnings.map(message => (
                                  <p key={message} className="flex items-center gap-1.5 text-[10px] font-bold text-yellow-300">
                                    <AlertTriangle className="h-3 w-3 shrink-0" />
                                    {message}
                                  </p>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}

                      {visits.length < visitLimit ? (
                        <button
                          onClick={handleAddVisit}
                          className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-slate-600 bg-slate-950/20 px-4 py-3 text-sm font-bold text-slate-300 transition-all hover:border-amber-400/50 hover:bg-amber-500/5 hover:text-amber-200"
                        >
                          <Plus className="h-4 w-4" />
                          訪問先を追加
                        </button>
                      ) : userPlan === 'free' ? (
                        <button
                          onClick={() => promptUpgrade(`無料プランは1日${visitLimit}件まで。Proなら${getVisitLimit('pro')}件まで登録できます。`)}
                          className="flex w-full items-center justify-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm font-bold text-amber-300 hover:bg-amber-500/10"
                        >
                          Proで{getVisitLimit('pro')}件まで解放
                        </button>
                      ) : (
                        <div className="w-full rounded-lg border border-slate-700 py-3 text-center text-xs text-secondary">
                          上限 {visitLimit}件に到達しました
                        </div>
                      )}
                    </div>
                  </section>
                </div>

                <aside className="space-y-4">
                  <section className="rounded-xl border border-slate-700/70 bg-slate-900/60 p-4">
                    <div className="mb-3 flex items-center gap-2">
                      <Utensils className="h-4 w-4 text-orange-300" />
                      <h2 className="text-sm font-extrabold text-white">ランチ・休憩時間</h2>
                    </div>
                    <div className="grid grid-cols-5 gap-1 overflow-hidden rounded-lg border border-slate-700 bg-slate-950/35 p-1">
                      {[0, 15, 30, 45, 60].map(minutes => {
                        const selected = (settings.lunchBreakMinutes || 0) === minutes;
                        return (
                          <button
                            key={minutes}
                            onClick={() => setSettings({ ...settings, lunchBreakMinutes: minutes })}
                            className={cn(
                              "rounded-md py-2 text-[11px] font-extrabold transition-all",
                              selected
                                ? "bg-amber-500/20 text-amber-200 ring-1 ring-amber-400/50"
                                : "text-slate-400 hover:bg-slate-800 hover:text-white"
                            )}
                          >
                            {minutes === 0 ? 'なし' : `${minutes}分`}
                          </button>
                        );
                      })}
                    </div>
                    <p className="mt-2 text-[10px] leading-relaxed text-slate-500">移動時間に含めず休憩時間を確保します</p>
                  </section>

                  <section className="rounded-xl border border-slate-700/70 bg-slate-900/60 p-4">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <h2 className="flex items-center gap-2 text-sm font-extrabold text-white">
                        <ClipboardList className="h-4 w-4 text-blue-300" /> AIで一括入力
                      </h2>
                      {isDemoMode() && (
                        aiUnlocked ? (
                          <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-300">
                            今日: {aiUsage.used}/{aiUsage.limit}
                          </span>
                        ) : (
                          <button
                            onClick={() => setShowAIUnlock(true)}
                            className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] font-bold text-amber-300"
                          >
                            解除
                          </button>
                        )
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <CameraCTA onImage={handleParseImage} disabled={isParsingImage} />
                      <VoiceCTA onText={(t) => setInputText(t)} />
                    </div>
                    <div className="relative mt-3">
                      <textarea
                        className="h-28 w-full resize-none rounded-lg border border-slate-700 bg-slate-950/45 p-3 text-sm text-white outline-none placeholder:text-slate-600 focus:border-amber-400/50"
                        placeholder={isParsingImage ? "AIが画像をスキャンしています..." : "メールやメモを貼り付ける"}
                        value={isParsingImage ? "Analyzing image..." : inputText}
                        disabled={isParsingImage}
                        onChange={(e) => setInputText(e.target.value)}
                      />
                      {isParsing && (
                        <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-slate-950/70">
                          <div className="flex items-center gap-2 text-xs text-amber-200">
                            <div className="h-4 w-4 animate-spin rounded-full border-2 border-amber-300/25 border-t-amber-300" />
                            AIで解析中...
                          </div>
                        </div>
                      )}
                    </div>
                    <button
                      onClick={handleParseText}
                      disabled={isParsing || !inputText.trim()}
                      className="mt-3 w-full rounded-lg border border-slate-700 bg-slate-950/45 py-2.5 text-xs font-bold text-slate-300 transition-colors hover:bg-slate-800 disabled:opacity-40"
                    >
                      テキストから訪問先を抽出
                    </button>
                  </section>

                  <section className="rounded-xl border border-slate-700/70 bg-slate-900/60 p-4">
                    <h2 className="mb-3 flex items-center gap-2 text-sm font-extrabold text-white">
                      <CheckCircle2 className="h-4 w-4 text-slate-400" /> 入力のヒント
                    </h2>
                    <div className="space-y-2 text-[11px] font-medium text-slate-400">
                      <p className="flex items-center gap-2"><CheckCircle2 className="h-3.5 w-3.5 text-slate-500" />住所は部分入力でも検索できます</p>
                      <p className="flex items-center gap-2"><CheckCircle2 className="h-3.5 w-3.5 text-slate-500" />訪問時間は「範囲」が最も柔軟です</p>
                      <p className="flex items-center gap-2"><CheckCircle2 className="h-3.5 w-3.5 text-slate-500" />滞在予定は移動時間に影響します</p>
                    </div>
                  </section>
                </aside>
              </div>

              <div className="hidden border-t border-ui bg-slate-950/70 p-4 lg:grid lg:grid-cols-[170px_1fr] lg:gap-4">
                <button
                  disabled={visits.length === 0 || isOptimizing}
                  onClick={handleOptimizeFromCurrentLocation}
                  className={cn(
                    "flex items-center justify-center gap-2 rounded-lg border py-3 text-sm font-extrabold transition-all disabled:opacity-40",
                    userPlan === 'pro'
                      ? "border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800"
                      : "border-amber-500/30 bg-slate-900 text-amber-300"
                  )}
                >
                  <Navigation className="h-5 w-5" /> 現在地から
                </button>
                <button
                  disabled={visits.length === 0 || isOptimizing}
                  onClick={() => handleOptimize()}
                  className="flex items-center justify-center gap-3 rounded-lg bg-amber-500 py-3 text-base font-extrabold text-slate-950 shadow-lg shadow-amber-950/30 transition-all hover:bg-amber-400 disabled:bg-slate-700 disabled:text-slate-500"
                >
                  {isOptimizing ? (
                    <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-950/20 border-t-slate-950" />
                  ) : (
                    <Navigation className="h-5 w-5" />
                  )}
                  ルートを計算
                </button>
              </div>
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="result"
            initial={{ opacity: 0, x: 50 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -50 }}
            className="flex flex-col lg:flex-row w-full lg:h-[calc(100vh-64px)] lg:overflow-hidden overflow-y-auto"
          >
            {/* Sidebar (Route List). Full-width on mobile, fixed 420px on desktop. */}
            <aside className="w-full lg:w-[420px] lg:h-full bg-bg lg:border-r border-ui flex flex-col shrink-0 z-10 lg:shadow-2xl lg:overflow-y-auto custom-scrollbar">
              <RouteSummaryPanel
                activePlan={activePlan}
                scores={planScores}
                activePlanIdx={activePlanIdx}
                baseline={baseline}
                onSelectPlan={setActivePlanIdx}
              />

              <PlanTabs
                plans={displayPlans}
                scores={planScores}
                activePlanIdx={activePlanIdx}
                onSelectPlan={setActivePlanIdx}
              />

              <div className="border-b border-ui px-4 pb-3 pt-4">
                <ScheduleClock plan={activePlan} tasks={settings.tasks} variant={isDesktop ? 'desktop' : 'mobile'} />
              </div>

              <NextVisitCard
                plan={activePlan}
                settings={settings}
                completedVisitIds={completedVisitIds}
                onComplete={toggleCompleted}
                onNavigateVisit={openVisitNavigation}
                onNavigatePlan={openPlanNavigation}
              />

              {!isDesktop && (
                <div className="mx-3 mb-3 overflow-hidden rounded-xl border border-ui bg-slate-900/60">
                  <button
                    onClick={() => setShowMobileMap(open => !open)}
                    className="flex w-full items-center justify-between px-4 py-3 text-left text-xs font-bold uppercase tracking-widest text-slate-300"
                  >
                    <span className="flex items-center gap-2">
                      <Layers className="h-4 w-4 text-amber-300" /> 地図を見る
                    </span>
                    <ChevronRight className={cn("h-4 w-4 transition-transform", showMobileMap && "rotate-90")} />
                  </button>
                  {showMobileMap && (
                    <div className="h-[340px] border-t border-ui bg-bg">
                      <MapComponent plan={activePlan} settings={settings} />
                    </div>
                  )}
                </div>
              )}

              <RouteTimeline
                plan={activePlan}
                settings={settings}
                completedVisitIds={completedVisitIds}
                activePlanId={activePlan.id}
                customOrder={customOrder}
                onMoveCustomVisit={moveCustomVisit}
                onToggleCompleted={toggleCompleted}
                onNavigateVisit={openVisitNavigation}
              />

              <OperationFooter
                plan={activePlan}
                completedVisitIds={completedVisitIds}
                onNavigatePlan={openPlanNavigation}
                onEditConditions={() => setActiveTab('input')}
              />
            </aside>

            {/* Desktop-only: large map as the main right-side panel. */}
            {isDesktop && (
              <section className="hidden lg:flex w-full lg:h-full lg:flex-1 relative bg-bg overflow-hidden shrink-0 flex-col">
                <div className="absolute inset-0 z-0 flex">
                  <MapComponent plan={activePlan} settings={settings} />
                </div>

                {(() => {
                  const health = getRouteHealth(activePlan);
                  const tone = healthToneClasses(health.tone);
                  const activeScore = planScores.find(score => score.idx === activePlanIdx);
                  return (
                    <div className="absolute left-6 right-6 top-6 z-10">
                      <div className="flex items-center justify-between gap-4 rounded-xl border border-ui bg-slate-950/82 p-4 shadow-2xl backdrop-blur-md">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className={cn("h-2.5 w-2.5 rounded-full", tone.dot)} />
                            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">運行ステータス</span>
                            <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-bold", tone.chip)}>{health.label}</span>
                          </div>
                          <p className="mt-1 text-sm font-bold text-white">{activePlan.label} ・ {health.detail}</p>
                        </div>
                        <div className="grid grid-cols-4 gap-5 text-right">
                          <div>
                            <span className="block text-[10px] font-bold uppercase tracking-wider text-slate-500">終了</span>
                            <span className="text-2xl font-extrabold num-font text-amber-200">{activePlan.endTime}</span>
                          </div>
                          <div>
                            <span className="block text-[10px] font-bold uppercase tracking-wider text-slate-500">移動</span>
                            <span className="text-2xl font-extrabold num-font text-white">{activePlan.totalDurationMin}<span className="text-xs text-slate-400">分</span></span>
                          </div>
                          <div>
                            <span className="block text-[10px] font-bold uppercase tracking-wider text-slate-500">距離</span>
                            <span className="text-2xl font-extrabold num-font text-white">{activePlan.totalDistanceKm.toFixed(1)}<span className="text-xs text-slate-400">km</span></span>
                          </div>
                          <div>
                            <span className="block text-[10px] font-bold uppercase tracking-wider text-slate-500">Score</span>
                            <span className="text-2xl font-extrabold num-font text-white">{activeScore?.score ?? '--'}<span className="text-xs text-slate-400">点</span></span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })()}

                <div className="absolute bottom-0 left-0 right-0 z-10 flex h-14 items-center justify-between border-t border-ui bg-slate-950/82 px-6 backdrop-blur-md">
                  <div className="flex gap-6">
                    <div className="flex items-center gap-2"><div className="h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]" /><span className="text-xs font-bold text-gray-300">正常</span></div>
                    <div className="flex items-center gap-2"><div className="h-2.5 w-2.5 rounded-full bg-amber-400 shadow-[0_0_8px_#fbbf24]" /><span className="text-xs font-bold text-gray-300">余裕少</span></div>
                    <div className="flex items-center gap-2"><div className="h-2.5 w-2.5 rounded-full bg-red-400 shadow-[0_0_8px_#f87171]" /><span className="text-xs font-bold text-gray-300">遅延懸念</span></div>
                  </div>
                  <div className="text-xs font-bold text-slate-400">案: {activePlan.label}</div>
                </div>
              </section>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Floating Action Button */}
      {activeTab === 'input' && (
        <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-ui bg-slate-950/90 p-3 backdrop-blur-md lg:hidden">
          <div className="mx-auto flex max-w-[1320px] gap-2">
            <button
              disabled={visits.length === 0 || isOptimizing}
              onClick={handleOptimizeFromCurrentLocation}
              className={cn(
                "flex-[0.9] rounded-xl border py-3 text-xs font-bold flex flex-col items-center justify-center gap-1 active:scale-[0.98] transition-all",
                userPlan === 'pro'
                  ? "bg-slate-900 hover:bg-slate-800 border-slate-700 text-slate-200"
                  : "bg-slate-900 border-amber-500/30 text-amber-300 hover:bg-slate-800"
              )}
              title={userPlan === 'pro' ? '現在地から再最適化' : 'Pro機能: 現在地から再最適化'}
            >
              <MapPin className="w-5 h-5" />
              <span>{userPlan === 'pro' ? '現在地から' : '現在地 ⚡Pro'}</span>
            </button>
            <button
              disabled={visits.length === 0 || isOptimizing}
              onClick={() => handleOptimize()}
              className="flex-[1.6] rounded-xl bg-amber-500 py-3 text-slate-950 disabled:bg-gray-700 disabled:text-slate-500 disabled:opacity-70 font-extrabold text-base flex items-center justify-center gap-3 shadow-xl shadow-amber-950/30 active:scale-[0.98] transition-all"
            >
              {isOptimizing ? (
                <div className="w-5 h-5 border-2 border-slate-950/20 border-t-slate-950 rounded-full animate-spin" />
              ) : (
                <Navigation className="w-5 h-5" />
              )}
              <span>ルートを計算</span>
            </button>
          </div>
          <p className="mx-auto mt-2 max-w-[1320px] text-center text-[10px] font-bold text-slate-500">{visits.length}件入力済み</p>
        </div>
      )}

      {/* Toast / Notice */}
      <AnimatePresence>
        {notice && (
          <motion.div
            key="notice"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="fixed top-20 left-1/2 -translate-x-1/2 z-50 w-[calc(100%-2rem)] max-w-md"
          >
            <div className={cn(
              "rounded-xl border p-4 shadow-2xl backdrop-blur-md",
              notice.kind === 'error' ? 'bg-red-950/90 border-red-500/40' :
              notice.kind === 'success' ? 'bg-green-950/90 border-green-500/40' :
              'bg-slate-900/90 border-ui'
            )}>
              <div className="flex items-start gap-3">
                <span className="text-lg leading-none mt-0.5">
                  {notice.kind === 'error' ? '⚠️' : notice.kind === 'success' ? '✓' : 'ℹ️'}
                </span>
                <div className="flex-1 min-w-0">
                  <h4 className="text-sm font-bold mb-0.5">{notice.title}</h4>
                  {notice.detail && (
                    <p className="text-[11px] text-gray-300 leading-relaxed break-words">{notice.detail}</p>
                  )}
                  <div className="flex gap-2 mt-2">
                    {notice.onRetry && (
                      <button
                        onClick={() => { const r = notice.onRetry; clearNotice(); r?.(); }}
                        className="text-[10px] font-bold uppercase tracking-wider px-3 py-1 rounded bg-white/10 hover:bg-white/20 border border-white/20"
                      >
                        再試行
                      </button>
                    )}
                    <button
                      onClick={clearNotice}
                      className="text-[10px] font-bold uppercase tracking-wider px-3 py-1 rounded hover:bg-white/10 text-gray-400"
                    >
                      閉じる
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* AI Parsed Visits Review Modal */}
      <AnimatePresence>
        {pendingParsedVisits && (
          <ParsedVisitsReviewModal
            visits={pendingParsedVisits}
            onChange={setPendingParsedVisits}
            onConfirm={confirmParsedVisits}
            onClose={() => {
              setPendingParsedVisits(null);
              setPendingParseSource(null);
            }}
          />
        )}
      </AnimatePresence>

      {/* AI Unlock Modal (demo only) */}
      <AnimatePresence>
        {showAIUnlock && (
          <AIUnlockModal
            onClose={() => {
              setShowAIUnlock(false);
              pendingAIActionRef.current = null;
            }}
            onUnlock={() => {
              setAIUnlocked(true);
              refreshAIUsage();
              setShowAIUnlock(false);
              const cb = pendingAIActionRef.current;
              pendingAIActionRef.current = null;
              cb?.();
            }}
          />
        )}
      </AnimatePresence>

      {/* Upgrade Modal */}
      <AnimatePresence>
        {upgradeReason && (
          <UpgradeModal
            reason={upgradeReason}
            onClose={() => setUpgradeReason(null)}
            onUpgrade={upgradeToPro}
          />
        )}
      </AnimatePresence>

      {/* Onboarding Modal — shown on first run */}
      <AnimatePresence>
        {showOnboarding && visits.length === 0 && (
          <OnboardingModal
            onTrySample={handleLoadSampleAndOptimize}
            onClose={dismissOnboarding}
          />
        )}
      </AnimatePresence>

      {/* Tasks Edit Modal */}
      <AnimatePresence>
        {showTasksSettings && (
          <TasksModal
            settings={settings}
            onSave={(val) => {
              setSettings(val);
              setShowTasksSettings(false);
            }}
            onClose={() => setShowTasksSettings(false)}
          />
        )}
      </AnimatePresence>

      {/* Start/End/Departure Modal */}
      <AnimatePresence>
        {showStartEndSettings && (
          <StartEndModal
            settings={settings}
            onSave={(val) => {
              setSettings(val);
              setShowStartEndSettings(false);
            }}
            onClose={() => setShowStartEndSettings(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function ParsedVisitsReviewModal({
  visits,
  onChange,
  onConfirm,
  onClose,
}: {
  visits: Visit[];
  onChange: (visits: Visit[]) => void;
  onConfirm: (visits: Visit[]) => void;
  onClose: () => void;
}) {
  const updateVisit = (id: string, updates: Partial<Visit>) => {
    onChange(visits.map(v => {
      if (v.id !== id) return v;
      const next = { ...v, ...updates };
      if (updates.address !== undefined && updates.address !== v.address) {
        next.coords = undefined;
      }
      return next;
    }));
  };
  const removeVisit = (id: string) => onChange(visits.filter(v => v.id !== id));
  const validCount = visits.filter(v => v.address.trim()).length;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        className="bg-card w-full max-w-lg flex flex-col max-h-[88vh] rounded-2xl shadow-2xl border border-ui overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-ui flex justify-between items-start bg-slate-900">
          <div>
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <ClipboardList className="w-4 h-4 text-blue-400" /> 読み取り結果の確認
            </h2>
            <p className="text-[11px] text-secondary mt-1">住所・時間・難易度だけを確認して追加します。</p>
          </div>
          <button onClick={onClose} className="p-1 text-secondary hover:text-white"><XCircle className="w-5 h-5"/></button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
          {visits.length === 0 ? (
            <div className="py-8 text-center text-sm text-secondary">追加する候補がありません</div>
          ) : visits.map((visit, idx) => {
            const missingAddress = !visit.address.trim();
            return (
              <div key={visit.id} className={cn(
                "rounded-xl border p-3 bg-slate-900/35",
                missingAddress ? "border-red-500/50" : "border-ui"
              )}>
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="flex items-center gap-2">
                    <span className="w-6 h-6 rounded-md bg-slate-800 border border-ui flex items-center justify-center text-[10px] font-bold text-blue-400">
                      {idx + 1}
                    </span>
                    <span className="text-xs font-bold text-gray-200">訪問先候補</span>
                  </div>
                  <button
                    onClick={() => removeVisit(visit.id)}
                    className="p-1.5 text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded"
                    title="候補から外す"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                <textarea
                  className={cn(
                    "w-full bg-[#1A1D23] border rounded-lg p-3 text-xs resize-none outline-none transition-colors",
                    missingAddress ? "border-red-500/60 focus:border-red-400" : "border-ui focus:border-blue-500/50"
                  )}
                  placeholder="住所を確認・修正"
                  rows={2}
                  value={visit.address}
                  onChange={(e) => updateVisit(visit.id, { address: e.target.value })}
                />
                {missingAddress && (
                  <p className="flex items-center gap-1.5 text-[10px] font-bold text-red-300 mt-1.5">
                    <AlertTriangle className="w-3 h-3 shrink-0" />
                    住所を入力してください
                  </p>
                )}

                <div className="mt-3 grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3">
                  <div className="bg-slate-800/50 p-2.5 rounded border border-ui">
                    <span className="text-[10px] text-secondary font-bold uppercase tracking-wider flex items-center gap-1 mb-2">
                      <Clock className="w-3.5 h-3.5" /> 訪問時間
                    </span>
                    <TimeWindowInput visit={visit} onChange={(u) => updateVisit(visit.id, u)} />
                  </div>
                  <div className="bg-slate-800/50 p-2.5 rounded border border-ui flex flex-col gap-2 justify-between">
                    <span className="text-[10px] text-secondary font-bold uppercase tracking-wider">難易度</span>
                    <DifficultySelector value={visit.difficulty} onChange={(d) => updateVisit(visit.id, { difficulty: d })} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="p-4 border-t border-ui bg-slate-900/80 flex gap-3">
          <button onClick={onClose} className="flex-1 py-3 text-secondary text-xs font-bold uppercase tracking-widest hover:text-white transition-colors">
            キャンセル
          </button>
          <button
            onClick={() => onConfirm(visits)}
            disabled={validCount === 0}
            className="flex-[1.6] py-3 px-6 bg-blue-600 rounded-xl font-bold text-sm transition-all shadow-lg shadow-blue-900/30 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {validCount}件を追加
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function AIUnlockModal({ onUnlock, onClose }: { onUnlock: () => void; onClose: () => void }) {
  const [pw, setPw] = useState('');
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const submit = () => {
    if (tryUnlockAI(pw)) {
      onUnlock();
    } else {
      setError('パスワードが違います');
      setPw('');
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  };
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.92, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.92, opacity: 0 }}
        className="bg-slate-900 border border-amber-500/40 rounded-2xl max-w-sm w-full p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center text-xl">🔒</div>
          <div>
            <h2 className="text-lg font-bold text-white">AI解析を解除</h2>
            <p className="text-[11px] text-secondary">パスワードを入力（1日10回まで）</p>
          </div>
        </div>
        <input
          ref={inputRef}
          type="password"
          value={pw}
          onChange={(e) => { setPw(e.target.value); setError(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          placeholder="パスワード"
          className={cn(
            "w-full px-4 py-3 rounded-lg bg-slate-800 border text-white text-sm mb-2 focus:outline-none",
            error ? "border-red-500/60" : "border-ui focus:border-amber-500/60"
          )}
        />
        {error && <p className="text-[11px] text-red-400 mb-2">{error}</p>}
        <div className="flex gap-2 mt-3">
          <button
            onClick={onClose}
            className="flex-1 py-3 rounded-lg text-xs font-bold uppercase tracking-wider bg-slate-800 hover:bg-slate-700 border border-ui"
          >
            キャンセル
          </button>
          <button
            onClick={submit}
            disabled={!pw}
            className="flex-[1.4] py-3 rounded-lg text-xs font-bold uppercase tracking-wider bg-amber-500 hover:bg-amber-400 text-slate-900 disabled:opacity-40"
          >
            解除
          </button>
        </div>
        <p className="text-[10px] text-secondary text-center mt-3 leading-relaxed">
          このゲートは簡易的なものです。30日間ブラウザに保存されます。
        </p>
      </motion.div>
    </motion.div>
  );
}

function OnboardingModal({ onTrySample, onClose }: { onTrySample: () => void; onClose: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
    >
      <motion.div
        initial={{ scale: 0.92, y: 20, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        exit={{ scale: 0.92, opacity: 0 }}
        className="bg-slate-900 border border-blue-500/40 rounded-2xl max-w-md w-full p-6 shadow-2xl"
      >
        <div className="text-center mb-5">
          <div className="w-14 h-14 rounded-full bg-blue-500/20 mx-auto flex items-center justify-center text-2xl mb-3">🚗</div>
          <h2 className="text-xl font-bold text-white mb-1">ルート最適化へようこそ</h2>
          <p className="text-xs text-secondary">30秒でどれくらい時間とガソリン代が節約できるか体験できます</p>
        </div>
        <div className="bg-slate-800/50 rounded-lg border border-ui p-4 mb-5">
          <p className="text-[11px] text-secondary mb-2 font-bold uppercase tracking-wider">サンプルの内容</p>
          <ul className="text-xs space-y-1.5 text-gray-300">
            <li>• 新宿区・渋谷区・港区の訪問3件</li>
            <li>• AIが最短ルートを自動計算</li>
            <li>• 入力順巡回比の節約km/分/¥が見られます</li>
          </ul>
        </div>
        <button
          onClick={onTrySample}
          className="w-full py-3 rounded-lg text-sm font-bold bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-900/30 mb-2"
        >
          サンプルで試す（30秒）
        </button>
        <button
          onClick={onClose}
          className="w-full py-2 rounded-lg text-[11px] font-bold uppercase tracking-wider text-secondary hover:text-white"
        >
          スキップして自分で入力
        </button>
      </motion.div>
    </motion.div>
  );
}

function UpgradeModal({ reason, onClose, onUpgrade }: { reason: string; onClose: () => void; onUpgrade: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.92, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.92, opacity: 0 }}
        className="bg-slate-900 border border-amber-500/40 rounded-2xl max-w-md w-full p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center text-xl">⚡</div>
          <div>
            <h2 className="text-lg font-bold text-amber-200">Proにアップグレード</h2>
            <p className="text-[11px] text-amber-300/80">月額 ¥780 / 解約はいつでも</p>
          </div>
        </div>
        <p className="text-sm text-gray-300 mb-5">{reason}</p>
        <div className="bg-slate-800/50 rounded-lg p-4 border border-ui mb-5 space-y-2 text-xs">
          <div className="flex items-center gap-2"><span className="text-green-400">✓</span> 訪問先 1日 <strong className="text-white">15件</strong> まで</div>
          <div className="flex items-center gap-2"><span className="text-green-400">✓</span> GPS現在地から再最適化</div>
          <div className="flex items-center gap-2"><span className="text-green-400">✓</span> 月次節約レポート</div>
          <div className="flex items-center gap-2"><span className="text-green-400">✓</span> マルチデバイス同期（近日対応）</div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 py-3 rounded-lg text-xs font-bold uppercase tracking-wider bg-slate-800 hover:bg-slate-700 border border-ui"
          >
            あとで
          </button>
          <button
            onClick={onUpgrade}
            className="flex-[1.4] py-3 rounded-lg text-xs font-bold uppercase tracking-wider bg-amber-500 hover:bg-amber-400 text-slate-900"
          >
            Proを試す
          </button>
        </div>
        <p className="text-[10px] text-secondary text-center mt-3">
          （現在はデモ。決済連携は今後対応予定）
        </p>
      </motion.div>
    </motion.div>
  );
}

// Sub-components
function DifficultySelector({ value, onChange }: { value: Difficulty, onChange: (d: Difficulty) => void }) {
  const options = [
    { v: 1, active: "bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-400/45", label: "低" },
    { v: 2, active: "bg-amber-500/20 text-amber-200 ring-1 ring-amber-400/55", label: "中" },
    { v: 3, active: "bg-red-500/20 text-red-200 ring-1 ring-red-400/50", label: "高" },
  ];
  return (
    <div className="grid grid-cols-3 overflow-hidden rounded-lg border border-slate-700 bg-slate-950/35 p-1">
      {options.map((opt) => (
        <button
          key={opt.v}
          onClick={() => onChange(opt.v as Difficulty)}
          className={cn(
            "min-w-10 rounded-md px-2 py-1.5 text-[11px] font-extrabold leading-none transition-all",
            value === opt.v ? opt.active : "text-slate-500 hover:bg-white/5 hover:text-slate-300"
          )}
          title={`優先度: ${opt.label}`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function StatusBadge({ status }: { status: 'ok' | 'warning' | 'violation' }) {
  if (status === 'ok') return <Badge variant="success" className="flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> OK</Badge>;
  if (status === 'warning') return <Badge variant="warning" className="flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> ギリギリ</Badge>;
  return <Badge variant="danger" className="flex items-center gap-1"><XCircle className="w-3 h-3" /> 超過</Badge>;
}

function TasksModal({ settings, onSave, onClose }: { settings: Settings, onSave: (s: Settings) => void, onClose: () => void }) {
  const [tasks, setTasks] = useState(settings.tasks || []);
  const [newName, setNewName] = useState('');
  const [newMinutes, setNewMinutes] = useState('60');

  const handleAdd = () => {
    if (!newName) return;
    setTasks([...tasks, { id: Date.now().toString(), name: newName, defaultMinutes: parseInt(newMinutes) || 60 }]);
    setNewName('');
    setNewMinutes('60');
  };

  const handleRemove = (id: string) => {
    setTasks(tasks.filter(t => t.id !== id));
  };

  const handleSave = () => {
    onSave({ ...settings, tasks });
  };

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
    >
      <motion.div 
        initial={{ scale: 0.95 }}
        animate={{ scale: 1 }}
        exit={{ scale: 0.95 }}
        className="bg-card w-full max-w-md flex flex-col max-h-[85vh] rounded-2xl shadow-2xl border border-ui overflow-hidden"
      >
        <div className="p-4 border-b border-ui flex justify-between items-center bg-slate-900">
          <h2 className="text-sm font-bold text-white flex items-center gap-2">作業名の設定</h2>
          <button onClick={onClose} className="p-1 text-secondary hover:text-white"><XCircle className="w-5 h-5"/></button>
        </div>
        
        <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
           {tasks.map(task => (
             <div key={task.id} className="flex justify-between items-center bg-slate-800/50 p-3 rounded-xl border border-ui">
                <div>
                  <h4 className="text-sm font-bold text-white">{task.name}</h4>
                  <p className="text-[10px] text-secondary mt-0.5">デフォルト: {task.defaultMinutes}分</p>
                </div>
                <button onClick={() => handleRemove(task.id)} className="p-2 text-red-400 hover:text-red-300 bg-red-400/10 hover:bg-red-400/20 rounded-lg transition-colors">
                  <Trash2 className="w-4 h-4" />
                </button>
             </div>
           ))}

           <div className="mt-6 border-t border-ui pt-4">
             <h4 className="text-xs font-bold text-secondary uppercase tracking-widest mb-3">新規追加</h4>
             <div className="flex gap-2">
               <input 
                 className="flex-1 bg-[#1A1D23] border border-ui rounded-lg px-3 py-2 text-sm focus:border-blue-500/50 outline-none placeholder:text-slate-600 font-bold"
                 value={newName}
                 onChange={(e) => setNewName(e.target.value)}
                 placeholder="作業名 (例: 点検)"
               />
               <input 
                 type="number"
                 className="w-20 bg-[#1A1D23] border border-ui rounded-lg px-3 py-2 text-sm focus:border-blue-500/50 outline-none text-right"
                 value={newMinutes}
                 onChange={(e) => setNewMinutes(e.target.value)}
                 placeholder="分"
                 min="1"
               />
               <span className="flex items-center text-sm text-secondary -ml-1">分</span>
               <button 
                 onClick={handleAdd}
                 disabled={!newName}
                 className="px-4 py-2 bg-blue-600 disabled:opacity-50 hover:bg-blue-500 rounded-lg text-xs font-bold transition-colors shadow-lg"
               >
                 追加
               </button>
             </div>
           </div>
        </div>

        <div className="p-4 border-t border-ui bg-slate-900/80 flex gap-3">
           <button onClick={onClose} className="flex-1 py-3 text-secondary text-xs font-bold uppercase tracking-widest hover:text-white transition-colors">キャンセル</button>
           <button onClick={handleSave} className="flex-2 py-3 px-6 bg-blue-600 rounded-xl font-bold text-sm transition-all shadow-lg shadow-blue-900/30">設定を反映</button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function StartEndModal({ settings, onSave, onClose }: { settings: Settings, onSave: (s: Settings) => void, onClose: () => void }) {
  const [homeAddress, setHomeAddress] = useState(settings.homeAddress);
  const [startTime, setStartTime] = useState(settings.startTime || '09:00');
  const [endLocation, setEndLocation] = useState<'home' | 'none' | 'custom'>(settings.endLocation);
  const [customEndAddress, setCustomEndAddress] = useState(settings.customEndAddress || '');
  const trimmedHomeAddress = homeAddress.trim();
  const trimmedCustomEndAddress = customEndAddress.trim();
  const homeAddressError = !trimmedHomeAddress ? '起点住所を入力してください。' : '';
  const customEndAddressError = endLocation === 'custom' && !trimmedCustomEndAddress ? '終点住所を入力してください。' : '';
  const canSave = !homeAddressError && !customEndAddressError;

  const handleSave = () => {
    if (!canSave) return;
    const next: Settings = {
      ...settings,
      homeAddress: trimmedHomeAddress,
      startTime,
      endLocation,
      customEndAddress: endLocation === 'custom' ? trimmedCustomEndAddress : settings.customEndAddress,
    };
    // Invalidate cached coords if the home address changed so the next
    // optimization re-geocodes.
    if (next.homeAddress !== settings.homeAddress) {
      next.homeCoords = undefined;
    }
    if (endLocation === 'custom' && customEndAddress.trim() !== (settings.customEndAddress || '')) {
      next.customEndCoords = undefined;
    }
    onSave(next);
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
    >
      <motion.div
        initial={{ scale: 0.95 }}
        animate={{ scale: 1 }}
        exit={{ scale: 0.95 }}
        className="bg-card w-full max-w-md flex flex-col max-h-[85vh] rounded-2xl shadow-2xl border border-ui overflow-hidden"
      >
        <div className="p-4 border-b border-ui flex justify-between items-center bg-slate-900">
          <h2 className="text-sm font-bold text-white flex items-center gap-2">
            <MapPin className="w-4 h-4 text-blue-500" /> 起点・終点・出発時刻
          </h2>
          <button onClick={onClose} className="p-1 text-secondary hover:text-white"><XCircle className="w-5 h-5"/></button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-5 custom-scrollbar">
          {/* Start address */}
          <div>
            <label className="block text-[10px] text-secondary font-bold uppercase tracking-widest mb-1.5">起点（出発地）住所</label>
            <input
              className={cn(
                "w-full bg-[#1A1D23] border rounded-lg px-3 py-2 text-sm outline-none font-medium",
                homeAddressError ? "border-red-500/60 focus:border-red-400" : "border-ui focus:border-blue-500/50"
              )}
              value={homeAddress}
              onChange={(e) => setHomeAddress(e.target.value)}
              placeholder="例: 東京都新宿区新宿1-1-1"
            />
            {homeAddressError && <p className="text-[10px] text-red-400 mt-1">{homeAddressError}</p>}
          </div>

          {/* Departure time */}
          <div>
            <label className="block text-[10px] text-secondary font-bold uppercase tracking-widest mb-1.5">出発時刻</label>
            <input
              type="time"
              className="bg-[#1A1D23] border border-ui rounded-lg px-3 py-2 text-sm focus:border-blue-500/50 outline-none num-font"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
            />
            <p className="text-[10px] text-secondary mt-1">この時刻に起点を出発するものとして、各訪問先の到着時刻を計算します。</p>
          </div>

          {/* End location */}
          <div>
            <label className="block text-[10px] text-secondary font-bold uppercase tracking-widest mb-1.5">終点</label>
            <div className="space-y-2">
              {([
                { v: 'home', label: '起点と同じ場所に戻る' },
                { v: 'custom', label: '別の住所を指定' },
                { v: 'none', label: '終点なし（最終訪問先で解散）' },
              ] as { v: 'home' | 'none' | 'custom', label: string }[]).map(opt => (
                <label key={opt.v} className={cn(
                  'flex items-center gap-2 p-2.5 rounded-lg border cursor-pointer transition-colors',
                  endLocation === opt.v ? 'bg-blue-500/10 border-blue-500/40' : 'bg-slate-800/40 border-ui hover:bg-slate-800/70'
                )}>
                  <input
                    type="radio"
                    name="endLocation"
                    value={opt.v}
                    checked={endLocation === opt.v}
                    onChange={() => setEndLocation(opt.v)}
                    className="accent-blue-500"
                  />
                  <span className="text-sm font-medium">{opt.label}</span>
                </label>
              ))}
            </div>
            {endLocation === 'custom' && (
              <>
                <input
                  className={cn(
                    "mt-2 w-full bg-[#1A1D23] border rounded-lg px-3 py-2 text-sm outline-none font-medium",
                    customEndAddressError ? "border-red-500/60 focus:border-red-400" : "border-ui focus:border-blue-500/50"
                  )}
                  value={customEndAddress}
                  onChange={(e) => setCustomEndAddress(e.target.value)}
                  placeholder="終点の住所"
                />
                {customEndAddressError && <p className="text-[10px] text-red-400 mt-1">{customEndAddressError}</p>}
              </>
            )}
          </div>
        </div>

        <div className="p-4 border-t border-ui bg-slate-900/80 flex gap-3">
           <button onClick={onClose} className="flex-1 py-3 text-secondary text-xs font-bold uppercase tracking-widest hover:text-white transition-colors">キャンセル</button>
           <button
             onClick={handleSave}
             disabled={!canSave}
             className="flex-2 py-3 px-6 bg-blue-600 rounded-xl font-bold text-sm transition-all shadow-lg shadow-blue-900/30 disabled:opacity-40 disabled:cursor-not-allowed"
           >
             設定を反映
           </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function CameraCTA({ onImage, disabled }: { onImage: (base64: string, mime: string) => void, disabled: boolean }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const base64 = (ev.target?.result as string).split(',')[1];
      onImage(base64, file.type);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };
  return (
    <>
      <input ref={fileInputRef} type="file" className="hidden" accept="image/*" onChange={handleFileChange} />
      <button
        onClick={() => fileInputRef.current?.click()}
        disabled={disabled}
        className={cn(
          "py-3 px-3 rounded-lg flex items-center justify-center gap-2 border transition-all",
          "bg-blue-500/10 border-blue-500/30 text-blue-200 hover:bg-blue-500/20 disabled:opacity-50",
          disabled && "animate-pulse"
        )}
      >
        <Camera className="w-5 h-5" />
        <span className="text-xs font-bold">伝票を撮影</span>
      </button>
    </>
  );
}

function VoiceCTA({ onText }: { onText: (t: string) => void }) {
  const [isListening, setIsListening] = useState(false);
  const start = () => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert("お使いのブラウザは音声入力をサポートしていません");
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = 'ja-JP';
    recognition.onstart = () => setIsListening(true);
    recognition.onresult = (event: any) => onText(event.results[0][0].transcript);
    recognition.onend = () => setIsListening(false);
    recognition.start();
  };
  return (
    <button
      onClick={start}
      className={cn(
        "py-3 px-3 rounded-lg flex items-center justify-center gap-2 border transition-all",
        isListening
          ? "bg-red-500/20 border-red-500/40 text-red-300 animate-pulse"
          : "bg-purple-500/10 border-purple-500/30 text-purple-200 hover:bg-purple-500/20"
      )}
    >
      <Mic className="w-5 h-5" />
      <span className="text-xs font-bold">{isListening ? "聞き取り中" : "音声で入力"}</span>
    </button>
  );
}

function ImageInput({ onImage, disabled }: { onImage: (base64: string, mime: string) => void, disabled: boolean }) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const result = event.target?.result as string;
      const base64 = result.split(',')[1];
      onImage(base64, file.type);
      if (fileInputRef.current) fileInputRef.current.value = '';
    };
    reader.readAsDataURL(file);
  };

  return (
    <>
      <input 
        type="file" 
        ref={fileInputRef} 
        className="hidden" 
        accept="image/*" 
        onChange={handleFileChange} 
      />
      <IconButton 
        icon={Camera} 
        disabled={disabled}
        onClick={() => fileInputRef.current?.click()} 
        className={cn(disabled && "animate-pulse")}
      />
    </>
  );
}

function SpeechInput({ onText }: { onText: (t: string) => void }) {
  const [isListening, setIsListening] = useState(false);
  
  const start = () => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert("お使いのブラウザは音声入力をサポートしていません");
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = 'ja-JP';
    recognition.onstart = () => setIsListening(true);
    recognition.onresult = (event: any) => onText(event.results[0][0].transcript);
    recognition.onend = () => setIsListening(false);
    recognition.start();
  };

  return (
    <IconButton 
      icon={Mic} 
      onClick={start} 
      className={cn(isListening && "bg-red-900/50 text-red-500 animate-pulse")} 
    />
  );
}

type MapMode = 'admin' | 'standard' | 'satellite';

const MAP_MODE_STORAGE_KEY = 'repair_map_mode';

const MAP_MODE_CONFIG: Record<MapMode, { mapTypeId: string; colorScheme: 'DARK' | 'LIGHT'; label: string }> = {
  admin:     { mapTypeId: 'roadmap', colorScheme: 'LIGHT', label: '行政区域' },
  standard:  { mapTypeId: 'roadmap', colorScheme: 'DARK',  label: '標準' },
  satellite: { mapTypeId: 'hybrid',  colorScheme: 'DARK',  label: '航空写真' },
};

function MapComponent({ plan, settings }: { plan: RoutePlan, settings: Settings }) {
  const map = useMap();
  const routesLib = useMapsLibrary('routes');
  const [mapMode, setMapMode] = useState<MapMode>(() => {
    try {
      const saved = localStorage.getItem(MAP_MODE_STORAGE_KEY);
      if (saved === 'admin' || saved === 'standard' || saved === 'satellite') return saved;
    } catch {}
    return 'admin';
  });

  useEffect(() => {
    try { localStorage.setItem(MAP_MODE_STORAGE_KEY, mapMode); } catch {}
  }, [mapMode]);

  const modeCfg = MAP_MODE_CONFIG[mapMode];
  const polylinesRef = useRef<google.maps.Polyline[]>([]);

  // Draw the route polyline.
  useEffect(() => {
    if (!map || !plan) return;

    polylinesRef.current.forEach(p => p.setMap(null));
    polylinesRef.current = [];

    const originCoords = settings.homeCoords;
    if (!originCoords) return;

    let destCoords = originCoords;
    if (settings.endLocation === 'custom' && settings.customEndCoords) {
      destCoords = settings.customEndCoords;
    } else if (settings.endLocation === 'none' && plan.order.length > 0) {
      destCoords = plan.order[plan.order.length - 1].coords || originCoords;
    }

    // Build the ordered list of pin coordinates we want to connect.
    const orderedCoords: google.maps.LatLngLiteral[] = [originCoords];
    const visitsForRoute = plan.order.slice(
      0,
      settings.endLocation === 'none' ? -1 : undefined
    );
    visitsForRoute.forEach(v => { if (v.coords) orderedCoords.push(v.coords); });
    if (settings.endLocation !== 'none') orderedCoords.push(destCoords);

    const renderPolyline = (path: google.maps.LatLngLiteral[] | google.maps.LatLng[], isFallback: boolean) => {
      // White halo underneath for legibility on dark/satellite/light maps.
      const halo = new google.maps.Polyline({
        path,
        geodesic: true,
        strokeColor: '#ffffff',
        strokeOpacity: 0.85,
        strokeWeight: 10,
        zIndex: 1,
      });
      // Main line + repeating forward arrows so the direction of travel is
      // unmistakable on a sinuous route.
      const arrow: google.maps.IconSequence = {
        icon: {
          path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
          scale: 3,
          strokeColor: '#ffffff',
          strokeWeight: 1.5,
          fillColor: '#1d4ed8',
          fillOpacity: 1,
        },
        offset: '0',
        repeat: '90px',
      };
      const line = new google.maps.Polyline({
        path,
        geodesic: true,
        strokeColor: '#1d4ed8',
        strokeOpacity: isFallback ? 0.85 : 1,
        strokeWeight: 6,
        zIndex: 2,
        icons: [arrow],
        ...(isFallback ? { } : {}),
      });
      halo.setMap(map);
      line.setMap(map);
      polylinesRef.current.push(halo, line);
    };

    // Immediate fallback: draw straight segments through pins so the user
    // always sees direction & sequence even if Routes API is slow / fails.
    if (orderedCoords.length >= 2) {
      renderPolyline(orderedCoords, true);
    }

    if (!routesLib) return;

    // Use DirectionsService (Directions API) for the road-following path.
    // The new Route.computeRoutes (Routes API) returned 403 PERMISSION_DENIED
    // unless that specific API was enabled in GCP; DirectionsService uses the
    // long-standing Directions API which is the more commonly enabled one and
    // gives us the same shape (overview_path: LatLng[]).
    const waypoints: google.maps.DirectionsWaypoint[] = visitsForRoute
      .map(v => (v.coords ? { location: v.coords, stopover: true } : null))
      .filter(Boolean) as google.maps.DirectionsWaypoint[];

    let cancelled = false;
    const directions = new google.maps.DirectionsService();
    directions.route({
      origin: originCoords,
      destination: destCoords,
      waypoints,
      optimizeWaypoints: false, // visit order is already optimized upstream
      travelMode: google.maps.TravelMode.DRIVING,
    }).then(result => {
      if (cancelled) return;
      const path = result.routes?.[0]?.overview_path;
      if (!path || path.length === 0) {
        console.warn('DirectionsService returned no path; keeping straight-line fallback', result);
        return;
      }
      polylinesRef.current.forEach(p => p.setMap(null));
      polylinesRef.current = [];
      renderPolyline(path, false);
    }).catch(err => {
      console.error('DirectionsService failed; keeping straight-line fallback', err);
    });

    return () => {
      cancelled = true;
      polylinesRef.current.forEach(p => p.setMap(null));
      polylinesRef.current = [];
    };
  }, [map, routesLib, plan, settings]);

  // Fit all pins (home, visits, custom end) with ~1.3x margin.
  useEffect(() => {
    if (!map) return;
    const points: google.maps.LatLngLiteral[] = [];
    if (settings.homeCoords) points.push(settings.homeCoords);
    if (settings.endLocation === 'custom' && settings.customEndCoords) {
      points.push(settings.customEndCoords);
    }
    plan.order.forEach(v => { if (v.coords) points.push(v.coords); });
    if (points.length === 0) return;

    const bounds = new google.maps.LatLngBounds();
    points.forEach(p => bounds.extend(p));

    if (points.length === 1) {
      map.setCenter(points[0]);
      map.setZoom(14);
      return;
    }

    // 1.3x viewport: 30% wider, 15% on each side.
    const ne = bounds.getNorthEast();
    const sw = bounds.getSouthWest();
    const latPad = Math.max((ne.lat() - sw.lat()) * 0.15, 0.002);
    const lngPad = Math.max((ne.lng() - sw.lng()) * 0.15, 0.002);
    const padded = new google.maps.LatLngBounds(
      { lat: sw.lat() - latPad, lng: sw.lng() - lngPad },
      { lat: ne.lat() + latPad, lng: ne.lng() + lngPad },
    );
    map.fitBounds(padded);
  }, [map, plan, settings]);

  return (
    <div className="w-full h-full relative">
      <Map
        key={modeCfg.colorScheme}
        defaultZoom={12}
        defaultCenter={settings.homeCoords || { lat: 35.6895, lng: 139.6917 }}
        mapId="DEMO_MAP_ID"
        mapTypeId={modeCfg.mapTypeId}
        colorScheme={modeCfg.colorScheme}
        disableDefaultUI
        internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
        className="w-full h-full"
      >
        <AdvancedMarker position={settings.homeCoords || { lat: 0, lng: 0 }}>
          <Pin background="#3b82f6" glyphColor="#fff" />
        </AdvancedMarker>
        {plan.order.map((v, i) => (
          v.coords && (
            <AdvancedMarker key={v.id} position={v.coords}>
               <div
                 className="text-white w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border-2 border-white shadow-lg"
                 style={{ background: difficultyColor(v.difficulty).work }}
               >
                 {i + 1}
               </div>
            </AdvancedMarker>
          )
        ))}
      </Map>
      {/* Map mode toggle */}
      <div className="absolute top-3 right-3 z-10 flex items-center bg-slate-900/85 backdrop-blur-sm border border-ui rounded-lg overflow-hidden shadow-xl">
        <div className="px-2 py-1.5 text-secondary border-r border-ui">
          <Layers className="w-3.5 h-3.5" />
        </div>
        {(Object.keys(MAP_MODE_CONFIG) as MapMode[]).map((m, i) => (
          <button
            key={m}
            onClick={() => setMapMode(m)}
            className={cn(
              'px-2.5 py-1.5 text-[11px] font-bold transition-colors',
              i > 0 && 'border-l border-ui',
              mapMode === m
                ? 'bg-blue-600 text-white'
                : 'bg-transparent text-secondary hover:bg-slate-800'
            )}
          >
            {MAP_MODE_CONFIG[m].label}
          </button>
        ))}
      </div>
    </div>
  );
}
