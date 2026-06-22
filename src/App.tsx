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
  ArrowDown,
  Phone,
  Copy
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

async function copyTextToClipboard(value: string): Promise<boolean> {
  const text = value.trim();
  if (!text) return false;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
  } else {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }
  return true;
}

function CopyActionButton({
  value,
  label,
  buttonText,
  className,
  iconClassName,
}: {
  value?: string | null;
  label: string;
  buttonText?: string;
  className?: string;
  iconClassName?: string;
}) {
  const [copied, setCopied] = useState(false);
  const enabled = Boolean(value?.trim());

  const handleCopy = async () => {
    if (!enabled || !value) return;
    const ok = await copyTextToClipboard(value);
    if (!ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      disabled={!enabled}
      className={cn(
        "p-1.5 rounded-md border border-ui bg-slate-900/90 text-secondary hover:text-white hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors",
        className
      )}
      title={copied ? `${label}しました` : label}
      aria-label={label}
    >
      {copied ? (
        <CheckCircle2 className={cn("w-3.5 h-3.5 text-green-300", iconClassName)} />
      ) : (
        <Copy className={cn("w-3.5 h-3.5", iconClassName)} />
      )}
      {buttonText && <span>{copied ? 'コピー済み' : buttonText}</span>}
    </button>
  );
}

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

const PLAN_DISPLAY_ORDER: RoutePlan['id'][] = ['C', 'A', 'B', 'X'];
const ROUTE_SESSION_STORAGE_KEY = 'repair_route_session_v1';

type StoredRouteSession = {
  plans: RoutePlan[];
  baseline: Baseline | null;
  customOrder: string[];
  matrix: DistanceMatrixLike;
  activePlanIdx: number;
  visitSignature: string;
  settingsSignature: string;
};

function orderRoutePlans(plans: RoutePlan[]): RoutePlan[] {
  return plans
    .map(normalizeRoutePlan)
    .slice()
    .sort((a, b) => PLAN_DISPLAY_ORDER.indexOf(a.id) - PLAN_DISPLAY_ORDER.indexOf(b.id));
}

function buildVisitSignature(visits: Visit[]): string {
  return JSON.stringify(visits.map(v => ({
    id: v.id,
    address: v.address,
    phoneNumber: v.phoneNumber || '',
    taskId: v.taskId || '',
    timeWindow: v.timeWindow || null,
    workMinutes: v.workMinutes,
    difficulty: v.difficulty,
  })));
}

function buildRouteSettingsSignature(settings: Settings): string {
  return JSON.stringify({
    homeAddress: settings.homeAddress,
    startTime: settings.startTime || '09:00',
    endLocation: settings.endLocation,
    customEndAddress: settings.customEndAddress || '',
    lunchBreakMinutes: settings.lunchBreakMinutes || 0,
  });
}

function readStoredRouteSession(visits: Visit[], settings: Settings): StoredRouteSession | null {
  try {
    const raw = localStorage.getItem(ROUTE_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredRouteSession;
    if (!Array.isArray(parsed.plans) || parsed.plans.length === 0 || !parsed.matrix) return null;
    if (parsed.visitSignature !== buildVisitSignature(visits)) return null;
    if (parsed.settingsSignature !== buildRouteSettingsSignature(settings)) return null;
    return {
      ...parsed,
      plans: orderRoutePlans(parsed.plans),
      customOrder: Array.isArray(parsed.customOrder) ? parsed.customOrder : [],
      activePlanIdx: Number.isInteger(parsed.activePlanIdx) ? parsed.activePlanIdx : 0,
      baseline: parsed.baseline || null,
    };
  } catch {
    return null;
  }
}

function persistRouteSession({
  plans,
  baseline,
  customOrder,
  matrix,
  visits,
  settings,
  activePlanIdx,
}: {
  plans: RoutePlan[];
  baseline: Baseline | null;
  customOrder: string[];
  matrix: DistanceMatrixLike;
  visits: Visit[];
  settings: Settings;
  activePlanIdx: number;
}) {
  try {
    localStorage.setItem(ROUTE_SESSION_STORAGE_KEY, JSON.stringify({
      plans: orderRoutePlans(plans),
      baseline,
      customOrder,
      matrix,
      activePlanIdx,
      visitSignature: buildVisitSignature(visits),
      settingsSignature: buildRouteSettingsSignature(settings),
    }));
  } catch {}
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

function formatMapsPoint(address?: string, coords?: google.maps.LatLngLiteral): string {
  const lat = Number(coords?.lat);
  const lng = Number(coords?.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return `${lat.toFixed(7)},${lng.toFixed(7)}`;
  }
  return (address || '').trim();
}

function buildGoogleMapsDirectionsUrl({
  origin,
  destination,
  waypoints = [],
}: {
  origin?: string;
  destination: string;
  waypoints?: string[];
}): string {
  const params = new URLSearchParams({
    api: '1',
    destination,
    travelmode: 'driving',
  });
  if (origin) params.set('origin', origin);
  const validWaypoints = waypoints.filter(Boolean);
  if (validWaypoints.length > 0) {
    params.set('waypoints', validWaypoints.join('|'));
  }
  return `https://www.google.com/maps/dir/?${params.toString()}`;
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
        <button onClick={() => setMode('none')} className={cn("flex-1 text-[10px] font-bold border-r border-ui transition-colors", mode === 'none' ? "bg-blue-600 text-white" : "bg-slate-800 text-secondary hover:bg-slate-700")}>なし</button>
        <button onClick={() => setMode('before')} className={cn("flex-1 text-[10px] font-bold border-r border-ui transition-colors", mode === 'before' ? "bg-blue-600 text-white" : "bg-slate-800 text-secondary hover:bg-slate-700")}>以前</button>
        <button onClick={() => setMode('after')} className={cn("flex-1 text-[10px] font-bold border-r border-ui transition-colors", mode === 'after' ? "bg-blue-600 text-white" : "bg-slate-800 text-secondary hover:bg-slate-700")}>以降</button>
        <button onClick={() => setMode('range')} className={cn("flex-1 text-[10px] font-bold transition-colors", mode === 'range' ? "bg-blue-600 text-white" : "bg-slate-800 text-secondary hover:bg-slate-700")}>範囲(〜)</button>
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
      phoneNumber: typeof v.phoneNumber === 'string' ? v.phoneNumber : undefined,
      taskId: v.taskId,
      timeWindow: v.timeWindow,
      workMinutes: Number(v.workMinutes) || 60,
      difficulty: [1, 2, 3].includes(v.difficulty) ? v.difficulty as Difficulty : 2,
      coords: v.coords,
    }));
  });

  const restoredRouteSessionRef = useRef<StoredRouteSession | null>(readStoredRouteSession(visits, settings));
  const [plans, setPlans] = useState<RoutePlan[]>(() => restoredRouteSessionRef.current?.plans || []);
  // Context needed to recompute the custom plan when the user reorders visits.
  const optContextRef = useRef<{
    visits: Visit[];
    settings: Settings;
    matrix: DistanceMatrixLike;
  } | null>(restoredRouteSessionRef.current ? {
    visits,
    settings,
    matrix: restoredRouteSessionRef.current.matrix,
  } : null);
  // Visit IDs in the user-chosen order for the "カスタム" plan.
  const [customOrder, setCustomOrder] = useState<string[]>(() => restoredRouteSessionRef.current?.customOrder || []);
  const [baseline, setBaseline] = useState<Baseline | null>(() => restoredRouteSessionRef.current?.baseline || null);
  const [completedVisitIds, setCompletedVisitIds] = useState<Set<string>>(new Set());
  const toggleCompleted = (id: string) => {
    setCompletedVisitIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const [activeTab, setActiveTab] = useState<'input' | 'result'>(() => restoredRouteSessionRef.current ? 'result' : 'input');
  const [activePlanIdx, setActivePlanIdx] = useState(() => {
    const restoredIdx = restoredRouteSessionRef.current?.activePlanIdx ?? 0;
    const restoredPlans = restoredRouteSessionRef.current?.plans || [];
    return Math.min(Math.max(restoredIdx, 0), Math.max(restoredPlans.length - 1, 0));
  });

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
    setPlans(prev => {
      const nextPlans = orderRoutePlans(prev.map(p => (p.id === 'X' ? next : p)));
      persistRouteSession({
        plans: nextPlans,
        baseline,
        customOrder: nextOrder,
        matrix: ctx.matrix,
        visits: ctx.visits,
        settings: ctx.settings,
        activePlanIdx,
      });
      return nextPlans;
    });
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
      const optimizedPlans = orderRoutePlans(optimizeRoutes(updatedVisits, updatedSettings, matrix).map(plan =>
        insertLunchBreak(plan, updatedSettings.lunchBreakMinutes || 0)
      ));
      const baselineResult = computeInputOrderBaseline(updatedVisits, updatedSettings, matrix);
      setBaseline(baselineResult);
      setPlans(optimizedPlans);
      optContextRef.current = { visits: updatedVisits, settings: updatedSettings, matrix };
      persistRouteSession({
        plans: optimizedPlans,
        baseline: baselineResult,
        customOrder: [],
        matrix,
        visits: updatedVisits,
        settings: updatedSettings,
        activePlanIdx: 0,
      });
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
      phoneNumber: typeof v.phoneNumber === 'string' ? v.phoneNumber : undefined,
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
      const optimizedPlans = orderRoutePlans(optimizeRoutes(updatedVisits, updatedSettings, matrix)
        .map(plan => insertLunchBreak(plan, updatedSettings.lunchBreakMinutes || 0))
        .map(normalizeRoutePlan));
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
      const nextPlans = orderRoutePlans([...optimizedPlans, normalizeRoutePlan(customPlan)]);
      // Persist context for later re-computation when the user reorders.
      optContextRef.current = { visits: updatedVisits, settings: updatedSettings, matrix };
      setCustomOrder(customSeed);
      const baselineResult = computeInputOrderBaseline(updatedVisits, updatedSettings, matrix);
      setBaseline(baselineResult);

      setPlans(nextPlans);
      persistRouteSession({
        plans: nextPlans,
        baseline: baselineResult,
        customOrder: customSeed,
        matrix,
        visits: updatedVisits,
        settings: updatedSettings,
        activePlanIdx: 0,
      });
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

  const displayPlans = orderRoutePlans(plans);
  const activePlan = displayPlans[activePlanIdx] || displayPlans[0];
  const selectPlan = (idx: number) => {
    setActivePlanIdx(idx);
    const ctx = optContextRef.current;
    if (!ctx || displayPlans.length === 0) return;
    persistRouteSession({
      plans: displayPlans,
      baseline,
      customOrder,
      matrix: ctx.matrix,
      visits: ctx.visits,
      settings: ctx.settings,
      activePlanIdx: idx,
    });
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
            className="p-4 space-y-4 max-w-2xl mx-auto"
          >
            {/* Start Point */}
            <div className="bg-card p-4 rounded-xl border border-ui">
              <div className="flex justify-between items-center mb-3">
                <div className="flex items-center gap-2 text-xs text-secondary font-bold uppercase tracking-wider">
                  <MapPin className="w-4 h-4 text-blue-500" /> 起点・終点・出発時刻
                </div>
                <button
                  onClick={() => setShowStartEndSettings(true)}
                  className="text-[10px] bg-slate-800 text-blue-400 hover:text-blue-300 font-bold px-2 py-1 rounded border border-ui"
                >
                  編集
                </button>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-secondary font-bold uppercase tracking-wider w-12 shrink-0">起点</span>
                  <p className="text-sm font-medium truncate">{settings.homeAddress}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-secondary font-bold uppercase tracking-wider w-12 shrink-0">出発</span>
                  <p className="text-sm font-medium num-font">{settings.startTime || '09:00'}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-secondary font-bold uppercase tracking-wider w-12 shrink-0">終点</span>
                  <p className="text-sm font-medium truncate">
                    {settings.endLocation === 'home' && '起点と同じ'}
                    {settings.endLocation === 'none' && '終点なし（最終訪問先で解散）'}
                    {settings.endLocation === 'custom' && (settings.customEndAddress || '未設定')}
                  </p>
                </div>
              </div>
            </div>

            <div className="flex justify-between items-end mt-4 mb-1">
               <div className="flex items-center gap-3">
                 <h2 className="text-sm font-bold text-gray-200">訪問先リスト</h2>
                 <button 
                   onClick={() => setShowTasksSettings(true)}
                   className="text-[10px] bg-slate-800 text-blue-400 hover:text-blue-300 font-bold px-2 py-1 rounded border border-ui"
                 >
                   作業設定
                 </button>
               </div>
               {visits.length > 0 && (
                 <button 
                   onClick={() => setVisits([])}
                   className="text-[10px] text-red-400 hover:text-red-300 flex items-center gap-1 uppercase font-bold tracking-wider"
                 >
                   <Trash2 className="w-3 h-3" /> リセット
                 </button>
               )}
            </div>

            {/* Visit List */}
            <div className="space-y-3">
              {visits.map((visit, idx) => {
                const validation = getVisitValidation(visit);
                const hasErrors = validation.errors.length > 0;
                const hasWarnings = !hasErrors && validation.warnings.length > 0;
                return (
                <div
                  key={visit.id}
                  className={cn(
                    "bg-card p-4 rounded-xl border relative group transition-all hover:border-blue-500/30",
                    hasErrors ? "border-red-500/50" : hasWarnings ? "border-yellow-500/30" : "border-ui"
                  )}
                >
                  <div className="flex justify-between items-start mb-3">
                    <div className="flex items-center gap-2">
                      <span className="w-6 h-6 rounded-md bg-slate-800 border border-ui flex items-center justify-center text-[10px] font-bold text-blue-400">
                        {idx + 1}
                      </span>
                      <select 
                        className="bg-transparent border-none text-sm font-bold focus:ring-0 w-full appearance-none cursor-pointer"
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
                    </div>
                    <div className="flex items-center gap-2">
                      <DifficultySelector 
                        value={visit.difficulty} 
                        onChange={(d) => handleUpdateVisit(visit.id, { difficulty: d })} 
                      />
                      <button onClick={() => handleDeleteVisit(visit.id)} className="p-1 hover:bg-red-500/10 rounded">
                        <Trash2 className="w-4 h-4 text-secondary hover:text-red-400" />
                      </button>
                    </div>
                  </div>
                  
                  <div className="relative mb-3">
                    <textarea
                      className="w-full bg-[#1A1D23] border border-ui rounded-lg p-3 pr-11 text-xs resize-none focus:border-blue-500/50 transition-colors"
                      placeholder="住所を入力..."
                      rows={2}
                      value={visit.address}
                      onChange={(e) => handleUpdateVisit(visit.id, { address: e.target.value })}
                    />
                    <CopyActionButton
                      value={visit.address}
                      label="住所をコピー"
                      className="absolute right-2 top-2"
                    />
                  </div>
                  {(validation.errors.length > 0 || validation.warnings.length > 0) && (
                    <div className="mb-3 space-y-1">
                      {validation.errors.map(message => (
                        <p key={message} className="flex items-center gap-1.5 text-[10px] font-bold text-red-300">
                          <AlertTriangle className="w-3 h-3 shrink-0" />
                          {message}
                        </p>
                      ))}
                      {validation.warnings.map(message => (
                        <p key={message} className="flex items-center gap-1.5 text-[10px] font-bold text-yellow-300">
                          <AlertTriangle className="w-3 h-3 shrink-0" />
                          {message}
                        </p>
                      ))}
                    </div>
                  )}

                  <div className="flex flex-col gap-3 mt-3">
                     <label className="flex flex-col gap-2 bg-slate-800/50 p-2.5 rounded border border-ui">
                        <span className="text-[10px] text-secondary font-bold uppercase tracking-wider flex items-center gap-1">
                          <Phone className="w-3.5 h-3.5" /> 電話番号
                        </span>
                        <div className="relative">
                          <input
                            className="w-full bg-slate-900 border border-ui text-white rounded-md px-3 py-2 pr-11 text-xs font-bold outline-none focus:border-blue-500/50 transition-colors"
                            placeholder="電話番号を入力..."
                            value={visit.phoneNumber || ''}
                            onChange={(e) => handleUpdateVisit(visit.id, { phoneNumber: e.target.value })}
                          />
                          <CopyActionButton
                            value={visit.phoneNumber}
                            label="電話番号をコピー"
                            className="absolute right-1.5 top-1/2 -translate-y-1/2"
                          />
                        </div>
                     </label>

                     <div className="flex flex-col gap-2 bg-slate-800/50 p-2.5 rounded border border-ui">
                        <span className="text-[10px] text-secondary font-bold uppercase tracking-wider flex items-center gap-1">
                          <Clock className="w-3.5 h-3.5" /> 訪問時間
                        </span>
                        <TimeWindowInput visit={visit} onChange={(u) => handleUpdateVisit(visit.id, u)} />
                     </div>

                     <div className="flex items-center gap-3 bg-slate-800/50 p-2.5 rounded border border-ui">
                        <span className="text-[10px] text-secondary font-bold uppercase tracking-wider">
                          滞在予定（作業時間）
                        </span>
                        <select 
                          className="bg-slate-900 border border-ui text-white rounded-md p-1.5 text-xs font-bold flex-1"
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
                     </div>
                  </div>
                </div>
                );
              })}

              {visits.length < visitLimit ? (
                <button
                  onClick={handleAddVisit}
                  className="w-full py-6 border border-dashed border-ui rounded-xl flex flex-col items-center justify-center text-secondary hover:border-blue-500/50 hover:bg-blue-500/5 transition-all"
                >
                  <Plus className="w-6 h-6 mb-1 text-blue-500" />
                  <span className="text-xs font-bold uppercase tracking-widest">
                    訪問先を追加 ({visits.length}/{visitLimit})
                  </span>
                </button>
              ) : userPlan === 'free' ? (
                <button
                  onClick={() => promptUpgrade(`無料プランは1日${visitLimit}件まで。Proなら${getVisitLimit('pro')}件まで登録できます。`)}
                  className="w-full py-6 border border-dashed border-amber-500/40 bg-amber-500/5 rounded-xl flex flex-col items-center justify-center text-amber-300 hover:bg-amber-500/10 transition-all"
                >
                  <span className="text-base mb-1">⚡</span>
                  <span className="text-xs font-bold uppercase tracking-widest">Proで{getVisitLimit('pro')}件まで解放</span>
                  <span className="text-[10px] mt-1 text-amber-300/70">月額¥780</span>
                </button>
              ) : (
                <div className="w-full py-4 text-center text-xs text-secondary">
                  上限 {visitLimit}件に到達しました
                </div>
              )}
            </div>

            {/* Lunch Break Settings */}
            <div className="bg-card p-4 rounded-xl border border-ui mt-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Utensils className="w-4 h-4 text-orange-400" />
                  <h3 className="text-xs font-bold text-secondary uppercase tracking-tight">
                    ランチ・休憩時間
                  </h3>
                </div>
              </div>
              <div className="grid grid-cols-5 gap-2">
                {[0, 15, 30, 45, 60].map(minutes => {
                  const selected = (settings.lunchBreakMinutes || 0) === minutes;
                  return (
                    <button
                      key={minutes}
                      onClick={() => setSettings({ ...settings, lunchBreakMinutes: minutes })}
                      className={cn(
                        "py-2 rounded-lg border text-xs font-bold transition-all",
                        selected
                          ? "bg-orange-500/20 border-orange-500/50 text-orange-200"
                          : "bg-slate-800/50 border-ui text-secondary hover:bg-slate-800 hover:text-white"
                      )}
                    >
                      {minutes === 0 ? 'なし' : `${minutes}分`}
                    </button>
                  );
                })}
              </div>
              <p className="text-[9px] text-slate-500 mt-2 font-medium">
                店舗検索は使わず、ルート中盤に指定した休憩時間だけを挿入します。
              </p>
            </div>

            {/* AI Input — voice/camera/text */}
            <div className="bg-card p-4 rounded-xl border border-ui mt-4">
              <div className="flex items-center justify-between mb-3 gap-2">
                <h3 className="text-xs font-bold text-secondary flex items-center gap-2 uppercase tracking-tight">
                  <ClipboardList className="w-4 h-4 text-blue-400" /> AIで一括入力
                </h3>
                {isDemoMode() && (
                  aiUnlocked ? (
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold text-green-300 bg-green-500/10 border border-green-500/30 px-2 py-0.5 rounded">
                        今日: {aiUsage.used}/{aiUsage.limit}
                      </span>
                      <button
                        onClick={() => { lockAI(); setAIUnlocked(false); }}
                        title="AIアクセスをロック"
                        className="text-[10px] text-slate-500 hover:text-slate-300"
                      >
                        🔒
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setShowAIUnlock(true)}
                      className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/40 hover:bg-amber-500/25"
                    >
                      🔒 パスワード解除
                    </button>
                  )
                )}
              </div>

              {/* Prominent CTA row: camera + voice */}
              <div className="grid grid-cols-2 gap-2 mb-3">
                <CameraCTA onImage={handleParseImage} disabled={isParsingImage} />
                <VoiceCTA onText={(t) => setInputText(t)} />
              </div>

              <div className="relative">
                <textarea
                  className="w-full bg-[#1A1D23] border border-ui rounded-lg p-3 text-sm resize-none h-24 focus:border-blue-500/50"
                  placeholder={isParsingImage
                    ? "AIが画像をスキャンしています..."
                    : "またはメール本文を貼り付け / 音声入力でテキスト化"}
                  value={isParsingImage ? "Analyzing image..." : inputText}
                  disabled={isParsingImage}
                  onChange={(e) => setInputText(e.target.value)}
                />
                {isParsing && (
                  <div className="absolute inset-0 flex items-center justify-center bg-slate-900/60 rounded-lg">
                    <div className="flex items-center gap-2 text-xs text-blue-300">
                      <div className="w-4 h-4 border-2 border-blue-300/30 border-t-blue-300 rounded-full animate-spin" />
                      AIで解析中...
                    </div>
                  </div>
                )}
              </div>
              <button
                onClick={handleParseText}
                disabled={isParsing || !inputText.trim()}
                className="w-full py-3 mt-3 bg-blue-600/20 border border-blue-500/30 hover:bg-blue-600/30 text-blue-200 rounded-lg text-xs font-bold uppercase tracking-wider disabled:opacity-40 transition-colors"
              >
                {isParsing ? "読み取り中..." : "テキストから訪問先を抽出"}
              </button>
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
              {/* Savings Banner */}
              {baseline && (() => {
                const FUEL_KM_PER_L = 12;
                const GAS_YEN_PER_L = 180;
                const planDist = activePlan.totalDistanceKm;
                const planDur = activePlan.totalDurationMin;
                const savedKm = Math.max(0, baseline.totalDistanceKm - planDist);
                const savedMin = Math.max(0, baseline.totalDurationMin - planDur);
                const savedYen = Math.round((savedKm / FUEL_KM_PER_L) * GAS_YEN_PER_L);
                const savedPct = baseline.totalDistanceKm > 0
                  ? Math.round((savedKm / baseline.totalDistanceKm) * 100)
                  : 0;
                if (savedKm < 0.1 && savedMin < 1) return null;
                return (
                  <div className="border-b border-ui bg-gradient-to-br from-green-950/40 to-emerald-950/20 px-4 py-3">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-base">✓</span>
                      <span className="text-[10px] uppercase tracking-wider font-bold text-green-300">入力順巡回比 節約効果</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div>
                        <div className="text-xl font-bold text-green-300 num-font">−{savedKm.toFixed(1)}</div>
                        <div className="text-[9px] text-green-200/70 font-bold uppercase tracking-wider">km短縮</div>
                      </div>
                      <div>
                        <div className="text-xl font-bold text-green-300 num-font">−{savedMin}</div>
                        <div className="text-[9px] text-green-200/70 font-bold uppercase tracking-wider">分節約</div>
                      </div>
                      <div>
                        <div className="text-xl font-bold text-green-300 num-font">¥{savedYen.toLocaleString()}</div>
                        <div className="text-[9px] text-green-200/70 font-bold uppercase tracking-wider">ガソリン代</div>
                      </div>
                    </div>
                    {savedPct > 0 && (
                      <p className="text-[10px] text-green-200/60 mt-2 text-center">
                        距離ベースで <strong className="text-green-300">{savedPct}%</strong> 短縮（燃費12km/L・¥180/L 想定）
                      </p>
                    )}
                  </div>
                );
              })()}

              {/* Recommended Plan */}
              {displayPlans.length > 0 && (() => {
                const scores = computePlanScores(displayPlans);
                const recommended = scores[0];
                if (!recommended) return null;
                const currentScore = scores.find(s => s.idx === activePlanIdx);
                return (
                  <div className="border-b border-ui bg-blue-950/30 px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[10px] uppercase tracking-wider font-bold text-blue-300">おすすめ案</span>
                          {activePlanIdx === recommended.idx && (
                            <span className="text-[9px] font-bold text-green-300 bg-green-500/10 border border-green-500/30 rounded px-1.5 py-0.5">
                              選択中
                            </span>
                          )}
                        </div>
                        <div className="flex items-baseline gap-2">
                          <span className="text-lg font-extrabold text-white">{recommended.plan.label}</span>
                          <span className="text-2xl font-extrabold num-font text-blue-300">{recommended.score}</span>
                          <span className="text-xs font-bold text-blue-200/70">/100点</span>
                        </div>
                        <p className="text-[10px] text-blue-100/65 mt-1 leading-relaxed">
                          移動 {recommended.plan.totalDurationMin}分 ・ 距離 {recommended.plan.totalDistanceKm.toFixed(1)}km ・
                          警告 {recommended.warningCount}件 ・ 超過 {recommended.violationCount}件で評価
                        </p>
                      </div>
                      <button
                        onClick={() => selectPlan(recommended.idx)}
                        className="shrink-0 px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-bold transition-colors disabled:opacity-50"
                        disabled={activePlanIdx === recommended.idx}
                      >
                        表示
                      </button>
                    </div>
                    {currentScore && currentScore.idx !== recommended.idx && (
                      <p className="text-[10px] text-secondary mt-2">
                        現在の案: <span className="font-bold text-white">{currentScore.plan.label}</span> {currentScore.score}/100点
                      </p>
                    )}
                  </div>
                );
              })()}

              {/* Plan Tabs */}
              <div className="p-4 flex gap-2 border-b border-ui bg-bg/50 backdrop-blur-sm">
                {(() => {
                  const scores = computePlanScores(displayPlans);
                  const scoreByIdx = new globalThis.Map(scores.map(score => [score.idx, score]));
                  const recommendedIdx = scores[0]?.idx;
                  return displayPlans.map((plan, idx) => {
                    const score = scoreByIdx.get(idx);
                    return (
                      <button
                        key={plan.id}
                        onClick={() => selectPlan(idx)}
                        className={cn(
                          "flex-1 py-2 text-center text-[10px] font-bold rounded-md transition-all border",
                          activePlanIdx === idx ? "bg-blue-600 border-blue-500 text-white shadow-lg shadow-blue-900/40" : "bg-slate-800 border-ui text-secondary hover:bg-slate-700",
                          idx === recommendedIdx && activePlanIdx !== idx && "border-blue-500/50 text-blue-200"
                        )}
                      >
                        <span className="block">{plan.label}</span>
                        {score && (
                          <span className="block mt-0.5 text-[9px] opacity-80">
                            {score.score}点{idx === recommendedIdx ? '・推奨' : ''}
                          </span>
                        )}
                      </button>
                    );
                  });
                })()}
              </div>

              {/* Schedule Clock */}
              <div className="px-4 pt-4 pb-3 border-b border-ui">
                <ScheduleClock plan={activePlan} tasks={settings.tasks} />
              </div>

              {/* Mobile-only: map directly under the schedule clock.
                  On desktop the map lives in its own right-side section below. */}
              {!isDesktop && (
                <>
                  <div className="h-[360px] relative border-b border-ui bg-bg">
                    <MapComponent plan={activePlan} settings={settings} />
                  </div>
                  <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-ui text-[10px]">
                    <div className="flex items-center gap-3">
                      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-400 shadow-[0_0_6px_#4ade80]" /><span className="font-bold text-gray-300">正常</span></span>
                      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-yellow-400 shadow-[0_0_6px_#fbbf24]" /><span className="font-bold text-gray-300">余裕少</span></span>
                      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-400 shadow-[0_0_6px_#f87171]" /><span className="font-bold text-gray-300">遅延懸念</span></span>
                    </div>
                    <span className="text-secondary italic">案: {activePlan.label}</span>
                  </div>
                </>
              )}

              {/* Path List */}
              <div className="p-4 space-y-3 custom-scrollbar">
                {activePlan.legs.filter(isCompleteLeg).map((leg, idx) => {
                  const lunchBreak = activePlan.lunchBreak;
                  const visit = leg.visitId
                    ? activePlan.order.find(v => v.id === leg.visitId)
                    : null;
                  const visitOrderIndex = visit
                    ? activePlan.order.findIndex(v => v.id === visit.id) + 1
                    : idx + 1;
                  const isCompleted = visit ? completedVisitIds.has(visit.id) : false;
                  const phoneNumber = visit?.phoneNumber?.trim() || '';
                  return (
                  <div key={idx} className="relative">
                    {leg.visitId && visit ? (
                      <motion.div
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: idx * 0.05 }}
                        className={cn(
                          "card-bg p-4 rounded-xl border relative overflow-hidden transition-all",
                          isCompleted ? "border-green-500/40 opacity-65 grayscale-[0.25]" :
                          leg.status === 'violation' ? "border-red-500/30" : "border-ui"
                        )}
                      >
                        {/* Difficulty stripe — same color as the matching
                            clock arc and map marker for fast cross-reference. */}
                        <div
                          className="absolute left-0 top-0 w-1 h-full"
                          style={{ background: difficultyColor(visit.difficulty).work }}
                        />

                        <div className="flex items-start justify-between gap-3 mb-4">
                          <div className="flex items-center gap-2 min-w-0">
                            <button
                              onClick={() => toggleCompleted(visit.id)}
                              title={isCompleted ? '完了を取り消す' : '完了にする'}
                              className={cn(
                                "shrink-0 h-10 px-3 rounded-lg border text-xs font-bold flex items-center gap-1.5 transition-colors",
                                isCompleted
                                  ? "bg-green-500/25 border-green-400/50 text-green-100"
                                  : "bg-slate-800 border-green-500/40 text-green-300 hover:bg-green-500/15"
                              )}
                            >
                              <CheckCircle2 className="w-4 h-4" />
                              {isCompleted ? '完了済み' : '完了'}
                            </button>
                            <div
                              className="shrink-0 px-2 py-1 rounded text-[10px] font-bold num-font text-white"
                              style={{ background: difficultyColor(visit.difficulty).work }}
                            >
                              {visitOrderIndex}番 {leg.arrivalTime}着
                            </div>
                            <div className={cn(
                              "status-dot w-2.5 h-2.5 rounded-full shrink-0",
                              leg.status === 'ok' ? "bg-green-400 shadow-[0_0_8px_#4ade80]" : leg.status === 'warning' ? "bg-yellow-400 shadow-[0_0_8px_#fbbf24]" : "bg-red-400 shadow-[0_0_8px_#f87171]"
                            )} />
                          </div>
                          <div className="flex gap-1 shrink-0">
                            {activePlan.id === 'X' && (
                              <>
                                <button
                                  onClick={() => moveCustomVisit(visit.id, -1)}
                                  disabled={customOrder.indexOf(visit.id) <= 0}
                                  title="上に移動"
                                  className="p-1.5 hover:bg-blue-500/10 disabled:opacity-30 disabled:hover:bg-transparent rounded"
                                >
                                  <ArrowUp className="w-4 h-4 text-blue-400" />
                                </button>
                                <button
                                  onClick={() => moveCustomVisit(visit.id, 1)}
                                  disabled={customOrder.indexOf(visit.id) >= customOrder.length - 1}
                                  title="下に移動"
                                  className="p-1.5 hover:bg-blue-500/10 disabled:opacity-30 disabled:hover:bg-transparent rounded"
                                >
                                  <ArrowDown className="w-4 h-4 text-blue-400" />
                                </button>
                              </>
                            )}
                          </div>
                        </div>

                        <h3 className={cn("text-xl font-bold mb-3 leading-tight", isCompleted && "line-through text-secondary")}>
                          {(() => {
                            const task = settings.tasks.find(t => t.id === visit.taskId);
                            if (task) return task.name;
                            return '訪問先';
                          })()}
                        </h3>

                        <div className="space-y-4">
                          <div className="space-y-2">
                            <p className={cn("text-sm leading-relaxed break-words", isCompleted ? "text-secondary line-through" : "text-gray-200")}>
                              {visit.address}
                            </p>
                            <div className="grid grid-cols-2 gap-2">
                              <button
                                onClick={() => {
                                  const destination = formatMapsPoint(visit.address, visit.coords);
                                  window.open(
                                    buildGoogleMapsDirectionsUrl({ destination }),
                                    '_blank',
                                    'noopener,noreferrer'
                                  );
                                }}
                                title="地図を起動"
                                className="h-10 rounded-lg border border-blue-500/30 bg-blue-500/10 text-blue-200 hover:bg-blue-500/20 text-xs font-bold flex items-center justify-center gap-1.5 transition-colors"
                              >
                                <Navigation className="w-4 h-4" />
                                地図起動
                              </button>
                              <CopyActionButton
                                value={visit.address}
                                label="住所をコピー"
                                buttonText="住所コピー"
                                className="h-10 justify-center gap-1.5 bg-slate-800 border-ui text-gray-200 hover:bg-slate-700 text-xs font-bold flex items-center"
                                iconClassName="w-4 h-4"
                              />
                            </div>
                          </div>

                          {phoneNumber && (
                            <div className="space-y-2">
                              <p className={cn("text-lg flex items-center gap-2 num-font font-bold", isCompleted ? "text-secondary line-through" : "text-green-300")}>
                                <Phone className="w-4 h-4 shrink-0" />
                                {phoneNumber}
                              </p>
                              <div className="grid grid-cols-2 gap-2">
                                <a
                                  href={`tel:${phoneNumber.replace(/[^\d+]/g, '')}`}
                                  title="電話を起動"
                                  aria-label="電話を起動"
                                  className="h-10 rounded-lg border border-green-500/30 bg-green-500/10 text-green-200 hover:bg-green-500/20 text-xs font-bold flex items-center justify-center gap-1.5 transition-colors"
                                >
                                  <Phone className="w-4 h-4" />
                                  電話起動
                                </a>
                                <CopyActionButton
                                  value={phoneNumber}
                                  label="電話番号をコピー"
                                  buttonText="電話番号コピー"
                                  className="h-10 justify-center gap-1.5 bg-slate-800 border-ui text-gray-200 hover:bg-slate-700 text-xs font-bold flex items-center"
                                  iconClassName="w-4 h-4"
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      </motion.div>
                    ) : (
                      <div className="flex flex-col gap-2 relative">
                        <div className="h-4 flex items-center justify-center">
                          <div className="w-px h-full bg-slate-800" />
                        </div>
                        <div className="card-bg p-4 rounded-xl border border-ui relative flex justify-between items-center bg-slate-900/40">
                             <div className="flex flex-col">
                               <div className="flex items-center gap-2 mb-1">
                                 <span className="text-xs font-bold text-secondary uppercase tracking-wider">終点到着 ({leg.arrivalTime})</span>
                               </div>
                               <h3 className="text-sm font-bold">{settings.endLocation === 'home' ? settings.homeAddress : settings.customEndAddress}</h3>
                             </div>
                             <CheckCircle2 className="w-5 h-5 text-secondary" />
                        </div>
                      </div>
                    )}

                    {/* Lunch Break Injection */}
                    {lunchBreak && lunchBreak.afterVisitId === leg.visitId && (
                       <div className="relative mt-3">
                         <div className="h-4 flex items-center justify-center absolute -top-4 left-0 right-0">
                           <div className="w-px h-full bg-slate-800" />
                         </div>
                         <motion.div 
                           initial={{ opacity: 0, y: 10 }}
                           animate={{ opacity: 1, y: 0 }}
                            className="bg-orange-500/10 p-4 rounded-xl border border-orange-500/30"
                         >
                            <div className="flex items-center gap-2 text-orange-400">
                               <Utensils className="w-3.5 h-3.5" />
                               <span className="text-[10px] font-bold uppercase tracking-widest">
                                 昼食・休憩 {lunchBreak.durationMin}分
                               </span>
                            </div>
                            <p className="text-xs font-bold text-orange-100 mt-2 num-font">
                              {lunchBreak.startTime} - {lunchBreak.endTime}
                            </p>
                            <p className="text-[10px] text-orange-200/60 mt-1">
                              店舗検索は使わず、時間だけをスケジュールに挿入しています。
                            </p>
                         </motion.div>
                       </div>
                    )}
                  </div>
                  );
                })}
              </div>

              {/* Bottom CTA */}
              <div className="p-4 border-t border-ui glass space-y-3">
                {activePlan.order.length > 0 && (() => {
                  const total = activePlan.order.length;
                  const done = activePlan.order.filter(v => completedVisitIds.has(v.id)).length;
                  const pct = total > 0 ? (done / total) * 100 : 0;
                  return (
                    <div>
                      <div className="flex justify-between items-baseline mb-1">
                        <span className="text-[10px] uppercase tracking-wider font-bold text-secondary">本日の進捗</span>
                        <span className="text-xs font-bold num-font text-white">{done} / {total} 件完了</span>
                      </div>
                      <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-green-500 to-emerald-400 transition-all duration-300"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })()}

                <button
                  onClick={() => {
                    const plan = activePlan;
                    // Skip already-completed visits in the external map handoff
                    const remaining = plan.order.filter(v => !completedVisitIds.has(v.id));
                    if (remaining.length === 0) {
                      showNotice({ kind: 'success', title: '本日の訪問はすべて完了しました', detail: 'お疲れさまでした！' });
                      return;
                    }
                    const origin = formatMapsPoint(settings.homeAddress, settings.homeCoords);
                    const destinationVisit = remaining[remaining.length - 1];
                    const destination = settings.endLocation === 'home'
                      ? formatMapsPoint(settings.homeAddress, settings.homeCoords)
                      : settings.endLocation === 'custom'
                        ? formatMapsPoint(settings.customEndAddress, settings.customEndCoords)
                        : formatMapsPoint(destinationVisit.address, destinationVisit.coords);
                    const waypointVisits = settings.endLocation === 'none'
                      ? remaining.slice(0, -1)
                      : remaining;
                    const waypoints = waypointVisits.map(v => formatMapsPoint(v.address, v.coords));
                    window.open(
                      buildGoogleMapsDirectionsUrl({ origin, destination, waypoints }),
                      '_blank',
                      'noopener,noreferrer'
                    );
                  }}
                  className="w-full py-4 bg-blue-600 hover:bg-blue-500 rounded-xl font-extrabold text-sm shadow-xl shadow-blue-900/30 flex items-center justify-center gap-3 transition-colors active:scale-[0.98]"
                >
                  <Navigation className="w-5 h-5" /> Google Maps でナビ開始
                </button>
                <button onClick={() => setActiveTab('input')} className="w-full py-2 text-[10px] text-secondary hover:text-white transition-colors uppercase font-bold tracking-widest">
                  条件編集に戻る
                </button>
              </div>
            </aside>

            {/* Desktop-only: large map as the main right-side panel. */}
            {isDesktop && (
              <section className="hidden lg:flex w-full lg:h-full lg:flex-1 relative bg-bg overflow-hidden shrink-0 flex-col">
                <div className="absolute inset-0 z-0 flex">
                  <MapComponent plan={activePlan} settings={settings} />
                </div>

                {/* Floating totals on the map */}
                <div className="absolute top-6 left-6 z-10">
                  <div className="glass p-4 rounded-2xl border border-ui shadow-2xl flex gap-8">
                    <div className="flex flex-col">
                      <span className="text-[10px] uppercase tracking-wider text-secondary font-bold mb-1">総移動時間</span>
                      <span className="text-2xl num-font">{activePlan.totalDurationMin}<span className="text-xs font-normal text-secondary ml-1">min</span></span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[10px] uppercase tracking-wider text-secondary font-bold mb-1">総移動距離</span>
                      <span className="text-2xl num-font">{activePlan.totalDistanceKm.toFixed(1)}<span className="text-xs font-normal text-secondary ml-1">km</span></span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[10px] uppercase tracking-wider text-secondary font-bold mb-1">最終完了予定</span>
                      <span className="text-2xl num-font text-blue-400">{activePlan.endTime}</span>
                    </div>
                  </div>
                </div>

                {/* Footer legend strip */}
                <div className="absolute bottom-0 left-0 right-0 h-14 glass border-t border-ui flex items-center px-6 justify-between z-10">
                  <div className="flex gap-6">
                    <div className="flex items-center gap-2"><div className="w-2.5 h-2.5 rounded-full bg-green-400 shadow-[0_0_8px_#4ade80]" /><span className="text-xs font-bold text-gray-300">正常</span></div>
                    <div className="flex items-center gap-2"><div className="w-2.5 h-2.5 rounded-full bg-yellow-400 shadow-[0_0_8px_#fbbf24]" /><span className="text-xs font-bold text-gray-300">余裕少</span></div>
                    <div className="flex items-center gap-2"><div className="w-2.5 h-2.5 rounded-full bg-red-400 shadow-[0_0_8px_#f87171]" /><span className="text-xs font-bold text-gray-300">遅延懸念</span></div>
                  </div>
                  <div className="text-xs text-secondary italic">案: {activePlan.label}</div>
                </div>
              </section>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Floating Action Button */}
      {activeTab === 'input' && (
        <div className="fixed bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-[#1A1D23] to-transparent z-40">
          <div className="flex gap-2">
            <button
              disabled={visits.length === 0 || isOptimizing}
              onClick={() => handleOptimize()}
              className="flex-[2] py-4 bg-blue-600 disabled:bg-gray-700 disabled:opacity-50 text-white rounded-xl font-extrabold text-lg flex items-center justify-center gap-3 shadow-xl shadow-blue-900/40 active:scale-[0.98] transition-all"
            >
              {isOptimizing ? (
                <div className="w-6 h-6 border-4 border-white/20 border-t-white rounded-full animate-spin" />
              ) : (
                <>
                  <Navigation className="w-6 h-6" />
                  ルートを計算
                </>
              )}
            </button>
            <button
              disabled={visits.length === 0 || isOptimizing}
              onClick={handleOptimizeFromCurrentLocation}
              className={cn(
                "flex-1 py-4 rounded-xl font-bold text-xs flex flex-col items-center justify-center gap-1 active:scale-[0.98] transition-all border",
                userPlan === 'pro'
                  ? "bg-emerald-600 hover:bg-emerald-500 border-emerald-400/40 text-white shadow-xl shadow-emerald-900/40"
                  : "bg-slate-800 border-amber-500/30 text-amber-300 hover:bg-slate-700"
              )}
              title={userPlan === 'pro' ? '現在地から再最適化' : 'Pro機能: 現在地から再最適化'}
            >
              <MapPin className="w-5 h-5" />
              <span>{userPlan === 'pro' ? '現在地から' : '現在地 ⚡Pro'}</span>
            </button>
          </div>
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
            tasks={settings.tasks}
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
  tasks,
  onChange,
  onConfirm,
  onClose,
}: {
  visits: Visit[];
  tasks: Settings['tasks'];
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
            <p className="text-[11px] text-secondary mt-1">作業・住所・電話番号・時間・難易度を確認して追加します。</p>
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

                <label className="mb-3 block">
                  <span className="text-[10px] text-secondary font-bold uppercase tracking-wider flex items-center gap-1 mb-2">
                    <ClipboardList className="w-3.5 h-3.5" /> 作業
                  </span>
                  <select
                    className="w-full bg-[#1A1D23] border border-ui rounded-lg px-3 py-2 text-xs font-bold outline-none transition-colors focus:border-blue-500/50"
                    value={visit.taskId || ''}
                    onChange={(e) => {
                      const taskId = e.target.value;
                      const task = tasks.find(t => t.id === taskId);
                      updateVisit(visit.id, {
                        taskId,
                        workMinutes: task ? task.defaultMinutes : visit.workMinutes,
                      });
                    }}
                  >
                    <option value="" disabled className="text-gray-500">作業を選択...</option>
                    {tasks.map(task => (
                      <option key={task.id} value={task.id} className="bg-[#1A1D23]">
                        {task.name}（{task.defaultMinutes}分）
                      </option>
                    ))}
                  </select>
                </label>

                <div className="relative">
                  <textarea
                    className={cn(
                      "w-full bg-[#1A1D23] border rounded-lg p-3 pr-11 text-xs resize-none outline-none transition-colors",
                      missingAddress ? "border-red-500/60 focus:border-red-400" : "border-ui focus:border-blue-500/50"
                    )}
                    placeholder="住所を確認・修正"
                    rows={2}
                    value={visit.address}
                    onChange={(e) => updateVisit(visit.id, { address: e.target.value })}
                  />
                  <CopyActionButton
                    value={visit.address}
                    label="住所をコピー"
                    className="absolute right-2 top-2"
                  />
                </div>
                {missingAddress && (
                  <p className="flex items-center gap-1.5 text-[10px] font-bold text-red-300 mt-1.5">
                    <AlertTriangle className="w-3 h-3 shrink-0" />
                    住所を入力してください
                  </p>
                )}

                <label className="mt-3 block">
                  <span className="text-[10px] text-secondary font-bold uppercase tracking-wider flex items-center gap-1 mb-2">
                    <Phone className="w-3.5 h-3.5" /> 電話番号
                  </span>
                  <div className="relative">
                    <input
                      className="w-full bg-[#1A1D23] border border-ui rounded-lg px-3 py-2 pr-11 text-xs outline-none transition-colors focus:border-blue-500/50"
                      placeholder="電話番号を確認・修正"
                      value={visit.phoneNumber || ''}
                      onChange={(e) => updateVisit(visit.id, { phoneNumber: e.target.value })}
                    />
                    <CopyActionButton
                      value={visit.phoneNumber}
                      label="電話番号をコピー"
                      className="absolute right-2 top-1/2 -translate-y-1/2"
                    />
                  </div>
                </label>

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
    const typedPassword = (inputRef.current?.value || pw).trim();
    if (tryUnlockAI(typedPassword)) {
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
            className="flex-[1.4] py-3 rounded-lg text-xs font-bold uppercase tracking-wider bg-amber-500 hover:bg-amber-400 text-slate-900"
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
    { v: 1, color: "bg-green-500", label: "低" },
    { v: 2, color: "bg-yellow-500", label: "中" },
    { v: 3, color: "bg-red-500", label: "高" },
  ];
  return (
    <div className="flex gap-1 bg-black/20 p-1 rounded-full border border-ui">
      {options.map((opt) => (
        <button
          key={opt.v}
          onClick={() => onChange(opt.v as Difficulty)}
          className={cn(
            "w-7 h-7 rounded-full flex items-center justify-center transition-all text-xs font-bold leading-none",
            value === opt.v ? `${opt.color} text-white shadow-lg ring-1 ring-white/30 scale-110` : "text-gray-500 bg-transparent hover:bg-white/5"
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
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept="image/*"
        capture="environment"
        onChange={handleFileChange}
      />
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
        capture="environment"
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
