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
  Crop,
  X,
  Search,
  CalendarDays,
  Settings as SettingsIcon,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  ChevronRight,
  ClipboardList,
  Utensils,
  Layers,
  ArrowUp,
  ArrowDown,
  Phone,
  Copy,
  Pencil,
  Check
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
import { ensureDefaultRepairTasks, inferApplianceCategoryFromModel, selectRepairTask } from './lib/repairTasks';
import {
  GoogleCalendarAuthError,
  GoogleCalendarPartialError,
  GoogleCalendarRouteEventInput,
  isGoogleCalendarConfigured,
  requestGoogleCalendarAccessToken,
  syncRouteEventsToPrimaryCalendar,
} from './services/googleCalendarService';

const API_KEY = process.env.GOOGLE_MAPS_PLATFORM_KEY || '';
const GOOGLE_CALENDAR_CLIENT_ID = process.env.GOOGLE_CALENDAR_CLIENT_ID || '';
const hasValidKey = Boolean(API_KEY) && API_KEY !== 'YOUR_API_KEY';
const CALENDAR_TIME_ZONE = 'Asia/Tokyo';
const APP_VERSION = 'v1.5';

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
const WORK_MINUTE_OPTIONS = [20, 40, 60, 80, 100, 120];
const APPLIANCE_CATEGORIES = ['エアコン', '冷蔵庫'];

function normalizeWorkMinutes(minutes: number): number {
  const value = Number(minutes) || 60;
  return WORK_MINUTE_OPTIONS.find(option => value <= option) || WORK_MINUTE_OPTIONS[WORK_MINUTE_OPTIONS.length - 1];
}

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

function difficultyForWorkMinutes(minutes: number): Difficulty {
  minutes = normalizeWorkMinutes(minutes);
  if (minutes <= 40) return 1;
  if (minutes <= 80) return 2;
  return 3;
}

function difficultyLabel(difficulty: Difficulty): string {
  return difficulty === 1 ? '低' : difficulty === 2 ? '中' : '高';
}

function difficultyBadgeStyle(difficulty: Difficulty): React.CSSProperties {
  const color = difficultyColor(difficulty).work;
  return {
    background: `${color}22`,
    borderColor: `${color}66`,
    color,
  };
}

function displayTaskName(task: Settings['tasks'][number]): string {
  if (!task.applianceCategory) return task.name;
  return task.name.replace(`${task.applianceCategory}:`, '').trim();
}

function taskDetailName(task: Settings['tasks'][number]): string {
  return displayTaskName(task);
}

function taskFullPath(task: Settings['tasks'][number]): string {
  return [task.applianceCategory, task.majorCategory, taskDetailName(task)].filter(Boolean).join(' / ');
}

function categoryForVisit(visit: Pick<Visit, 'modelNumber' | 'applianceCategory'>): string | undefined {
  return visit.applianceCategory || inferApplianceCategoryFromModel(visit.modelNumber);
}

function taskOptionsForVisit(tasks: Settings['tasks'], visit: Pick<Visit, 'modelNumber' | 'applianceCategory'>): Settings['tasks'] {
  const category = categoryForVisit(visit);
  if (!category) return tasks;
  return tasks.filter(task => task.applianceCategory === category);
}

function nextVisitForApplianceCategory(
  visit: Visit,
  applianceCategory: string | undefined,
  tasks: Settings['tasks']
): Partial<Visit> {
  const nextOptions = taskOptionsForVisit(tasks, { applianceCategory, modelNumber: undefined });
  const keepsTask = nextOptions.some(task => task.id === visit.taskId);
  return {
    applianceCategory,
    modelNumber: undefined,
    taskId: keepsTask ? visit.taskId : undefined,
    ...(!keepsTask ? { workMinutes: 60 } : {}),
  };
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
const VISIT_HISTORY_STORAGE_KEY = 'repair_visit_history_v1';
type AppTab = 'input' | 'result' | 'history';

type StoredRouteSession = {
  plans: RoutePlan[];
  baseline: Baseline | null;
  customOrder: string[];
  matrix: DistanceMatrixLike;
  activePlanIdx: number;
  visitSignature: string;
  settingsSignature: string;
};

type VisitHistoryEntry = {
  id: string;
  address: string;
  phoneNumber?: string;
  firstSeenAt: string;
  lastSeenAt: string;
};

function orderRoutePlans(plans: RoutePlan[]): RoutePlan[] {
  return plans
    .map(normalizeRoutePlan)
    .slice()
    .sort((a, b) => PLAN_DISPLAY_ORDER.indexOf(a.id) - PLAN_DISPLAY_ORDER.indexOf(b.id));
}

function todayKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatHistoryDate(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return value;
  return `${Number(match[2])}/${Number(match[3])}`;
}

function normalizeHistoryAddress(value: string): string {
  return value.replace(/\s+/g, '').trim().toLowerCase();
}

function readVisitHistory(): VisitHistoryEntry[] {
  try {
    const raw = localStorage.getItem(VISIT_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const entries: VisitHistoryEntry[] = parsed
      .map((item: any): VisitHistoryEntry | null => {
        const address = typeof item.address === 'string' ? item.address.trim() : '';
        if (!address) return null;
        const lastSeenAt = typeof item.lastSeenAt === 'string' ? item.lastSeenAt : todayKey();
        return {
          id: typeof item.id === 'string' ? item.id : Math.random().toString(36).substr(2, 9),
          address,
          phoneNumber: typeof item.phoneNumber === 'string' && item.phoneNumber.trim()
            ? item.phoneNumber.trim()
            : undefined,
          firstSeenAt: typeof item.firstSeenAt === 'string' ? item.firstSeenAt : lastSeenAt,
          lastSeenAt,
        };
      })
      .filter((item): item is VisitHistoryEntry => item !== null);
    return entries.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  } catch {
    return [];
  }
}

function writeVisitHistory(history: VisitHistoryEntry[]) {
  try {
    localStorage.setItem(VISIT_HISTORY_STORAGE_KEY, JSON.stringify(history.slice(0, 300)));
  } catch {}
}

function upsertVisitHistory(history: VisitHistoryEntry[], visits: Visit[]): VisitHistoryEntry[] {
  const today = todayKey();
  const historyPairs: Array<[string, VisitHistoryEntry]> = history.map(item => [
    normalizeHistoryAddress(item.address),
    item,
  ]);
  const byAddress = new globalThis.Map<string, VisitHistoryEntry>(historyPairs);
  let changed = false;

  visits.forEach(visit => {
    const address = visit.address.trim();
    if (!address) return;
    const phoneNumber = visit.phoneNumber?.trim() || undefined;
    const key = normalizeHistoryAddress(address);
    const existing = byAddress.get(key);
    if (!existing) {
      byAddress.set(key, {
        id: Math.random().toString(36).substr(2, 9),
        address,
        phoneNumber,
        firstSeenAt: today,
        lastSeenAt: today,
      });
      changed = true;
      return;
    }
    const nextPhone = phoneNumber || existing.phoneNumber;
    if (existing.address !== address || existing.phoneNumber !== nextPhone || existing.lastSeenAt !== today) {
      byAddress.set(key, {
        ...existing,
        address,
        phoneNumber: nextPhone,
        lastSeenAt: today,
      });
      changed = true;
    }
  });

  if (!changed) return history;
  return Array.from(byAddress.values())
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
    .slice(0, 300);
}

function buildVisitSignature(visits: Visit[]): string {
  return JSON.stringify(visits.map(v => ({
    id: v.id,
    address: v.address,
    phoneNumber: v.phoneNumber || '',
    applianceCategory: v.applianceCategory || '',
    symptomName: v.symptomName || '',
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

function getTodayDateInputValue(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Saved work dates go stale once the day passes; fall back to today so the
// calendar registration date always starts at "today" on launch. Deliberately
// chosen future dates are kept. ISO "YYYY-MM-DD" strings compare correctly
// as plain strings.
function normalizeStoredWorkDate(value: unknown): string {
  const today = getTodayDateInputValue();
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return today;
  return value < today ? today : value;
}

// input[type=date] only opens its calendar from the tiny indicator icon by
// default; open it from anywhere in the field where the browser supports it.
function openNativeDatePicker(input: HTMLInputElement) {
  try {
    (input as HTMLInputElement & { showPicker?: () => void }).showPicker?.();
  } catch {}
}

function parseDateTimeForCalendar(dateValue: string, timeValue: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue) || !/^\d{2}:\d{2}$/.test(timeValue)) return null;
  const [year, month, day] = dateValue.split('-').map(Number);
  const [hour, minute] = timeValue.split(':').map(Number);
  const date = new Date(year, month - 1, day, hour, minute, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addDaysToDateInput(dateValue: string, days: number): string {
  const [year, month, day] = dateValue.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function parseTimeToMinutes(value: string): number | null {
  if (!/^\d{2}:\d{2}$/.test(value)) return null;
  const [hours, minutes] = value.split(':').map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

function formatGoogleCalendarDateTime(dateValue: string, timeValue: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue) || !/^\d{2}:\d{2}$/.test(timeValue)) return null;
  return `${dateValue}T${timeValue}:00`;
}

function formatIcsDateTime(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}T${hh}${mi}${ss}`;
}

function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function downloadTextFile(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function buildCalendarIcs({
  plan,
  settings,
}: {
  plan: RoutePlan;
  settings: Settings;
}): string | null {
  const workDate = settings.workDate || getTodayDateInputValue();
  const generatedAt = new Date();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Route Optimizer//Field Engineer Schedule//JA',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];

  let count = 0;
  plan.legs.filter(isCompleteLeg).forEach((leg) => {
    if (!leg.visitId || !leg.arrivalTime || !leg.endTime) return;
    const visit = plan.order.find(v => v.id === leg.visitId);
    if (!visit) return;

    const start = parseDateTimeForCalendar(workDate, leg.arrivalTime);
    const end = parseDateTimeForCalendar(workDate, leg.endTime);
    if (!start || !end) return;
    if (end <= start) end.setDate(end.getDate() + 1);

    count += 1;
    const task = settings.tasks.find(t => t.id === visit.taskId);
    const summary = `訪問${count}: ${task?.name || '現地作業'}`;
    const description = [
      `現地滞在予定: ${leg.arrivalTime}-${leg.endTime}`,
      leg.workStartTime && leg.workEndTime ? `実作業: ${leg.workStartTime}-${leg.workEndTime}` : '',
      `ルート案: ${plan.label}`,
    ].filter(Boolean).join('\n');

    lines.push(
      'BEGIN:VEVENT',
      `UID:${escapeIcsText(`${workDate}-${plan.id}-${leg.visitId}@field-engineer-route-optimizer`)}`,
      `DTSTAMP:${formatIcsDateTime(generatedAt)}`,
      `DTSTART:${formatIcsDateTime(start)}`,
      `DTEND:${formatIcsDateTime(end)}`,
      `SUMMARY:${escapeIcsText(summary)}`,
      `LOCATION:${escapeIcsText(visit.address)}`,
      `DESCRIPTION:${escapeIcsText(description)}`,
      'END:VEVENT',
    );
  });

  lines.push('END:VCALENDAR');
  return count > 0 ? lines.join('\r\n') : null;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function buildGoogleCalendarRouteEvents({
  plan,
  settings,
}: {
  plan: RoutePlan;
  settings: Settings;
}): { workDate: string; routeRunId: string; events: GoogleCalendarRouteEventInput[] } | null {
  const workDate = settings.workDate || getTodayDateInputValue();
  const visitLegs = plan.legs.filter(isCompleteLeg).filter(leg => leg.visitId);
  const routeRunSource = [
    workDate,
    plan.id,
    ...visitLegs.map(leg => `${leg.visitId}:${leg.arrivalTime}-${leg.endTime}:${leg.workStartTime || ''}-${leg.workEndTime || ''}`),
  ].join('|');
  const routeRunId = `route-${stableHash(routeRunSource)}`;
  const events: GoogleCalendarRouteEventInput[] = [];

  visitLegs.forEach((leg) => {
    if (!leg.visitId) return;
    const visit = plan.order.find(v => v.id === leg.visitId);
    if (!visit) return;

    const startMinutes = parseTimeToMinutes(leg.arrivalTime);
    const endMinutes = parseTimeToMinutes(leg.endTime);
    if (startMinutes === null || endMinutes === null) return;
    const endDate = endMinutes <= startMinutes ? addDaysToDateInput(workDate, 1) : workDate;
    const startDateTime = formatGoogleCalendarDateTime(workDate, leg.arrivalTime);
    const endDateTime = formatGoogleCalendarDateTime(endDate, leg.endTime);
    if (!startDateTime || !endDateTime) return;

    const orderIndex = plan.order.findIndex(v => v.id === visit.id) + 1;
    const task = settings.tasks.find(t => t.id === visit.taskId);
    const description = [
      `現地滞在予定: ${leg.arrivalTime}-${leg.endTime}`,
      leg.workStartTime && leg.workEndTime ? `実作業: ${leg.workStartTime}-${leg.workEndTime}` : '',
      `ルート案: ${plan.label}`,
    ].filter(Boolean).join('\n');

    events.push({
      summary: `訪問${orderIndex}: ${task?.name || '現地作業'}`,
      location: visit.address,
      description,
      startDateTime,
      endDateTime,
      timeZone: CALENDAR_TIME_ZONE,
      metadata: {
        workDate,
        routePlanId: plan.id,
        visitId: visit.id,
        routeRunId,
      },
    });
  });

  return events.length > 0 ? { workDate, routeRunId, events } : null;
}

function formatVisitAddress(address: string): {
  streetLine: string;
  buildingLine: string;
  buildingMapQuery: string;
  copyStreetAddress: string;
} {
  const normalized = address
    .replace(/〒?\d{3}-?\d{4}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const withoutTokyo = normalized.replace(/^東京都\s*/, '').trim();

  // Split after the first street-number style token. The OCR usually inserts
  // a space before building names; this keeps detached houses as one line.
  const match = withoutTokyo.match(/^(.+?[0-9０-９]+(?:[-－ー丁目番地号\s]+[0-9０-９]+){1,3})(?:\s+(.+))?$/);
  const streetLine = (match?.[1] || withoutTokyo).trim();
  const buildingLine = (match?.[2] || '').trim();
  const buildingMapQuery = buildingLine
    .replace(/\s*(?:[0-9０-９]{1,4}\s*)?(?:号室|号|室)\s*$/u, '')
    .replace(/\s+[0-9０-９]{2,4}\s*$/u, '')
    .trim();
  const copyStreetAddress = normalized.startsWith('東京都')
    ? `東京都${streetLine}`
    : streetLine;

  return { streetLine, buildingLine, buildingMapQuery, copyStreetAddress };
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
      workDate: normalizeStoredWorkDate(parsed.workDate),
      startTime: parsed.startTime || '09:00',
      lunchBreakMinutes: [0, 15, 30, 45, 60].includes(parsedLunchBreak) ? parsedLunchBreak : 0,
      tasks: ensureDefaultRepairTasks(parsed.tasks || [
        { id: '1', name: '点検', defaultMinutes: 30 },
        { id: '2', name: '修理', defaultMinutes: 60 },
        { id: '3', name: '設置', defaultMinutes: 90 },
      ]).map(task => ({ ...task, defaultMinutes: normalizeWorkMinutes(task.defaultMinutes) }))
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
      modelNumber: undefined,
      applianceCategory: typeof v.applianceCategory === 'string' ? v.applianceCategory : undefined,
      symptomName: typeof v.symptomName === 'string' ? v.symptomName : undefined,
      taskId: v.taskId,
      timeWindow: v.timeWindow,
      workMinutes: normalizeWorkMinutes(Number(v.workMinutes) || 60),
      difficulty: difficultyForWorkMinutes(Number(v.workMinutes) || 60),
      coords: v.coords,
    }));
  });
  const [visitHistory, setVisitHistory] = useState<VisitHistoryEntry[]>(() => readVisitHistory());

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
  const [activeTab, setActiveTab] = useState<AppTab>(() => restoredRouteSessionRef.current ? 'result' : 'input');
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
  const [showVisitAddSheet, setShowVisitAddSheet] = useState(false);
  const [calendarRegistrationStatus, setCalendarRegistrationStatus] = useState<'idle' | 'auth' | 'registering'>('idle');

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
    kind: 'error' | 'info' | 'success' | 'warning';
    title: string;
    detail?: string;
    onRetry?: () => void;
  };
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showNotice = (n: Notice) => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = null;
    setNotice(n);
    if (n.kind !== 'error') {
      const delay = n.kind === 'success' ? 3000 : 5000;
      noticeTimerRef.current = setTimeout(() => {
        setNotice(null);
        noticeTimerRef.current = null;
      }, delay);
    }
  };
  const clearNotice = () => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = null;
    setNotice(null);
  };

  const handleLoadSampleAndOptimize = () => {
    const sample: Visit[] = [
      { id: 's1', address: '東京都新宿区西新宿2-8-1', taskId: '1', workMinutes: 40, difficulty: difficultyForWorkMinutes(40) },
      { id: 's2', address: '東京都渋谷区道玄坂1-12-1', taskId: '2', workMinutes: 60, difficulty: difficultyForWorkMinutes(60), timeWindow: { start: '11:00', end: '13:00' } },
      { id: 's3', address: '東京都港区六本木6-10-1', taskId: '3', workMinutes: 120, difficulty: difficultyForWorkMinutes(120) },
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

  useEffect(() => {
    setVisitHistory(prev => {
      const next = upsertVisitHistory(prev, visits);
      if (next === prev) return prev;
      writeVisitHistory(next);
      return next;
    });
  }, [visits]);

  const handleAddBlankVisit = () => {
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
      difficulty: difficultyForWorkMinutes(60)
    };
    setVisits([...visits, newVisit]);
    setActiveTab('input');
    setShowVisitAddSheet(false);
  };

  const handleAddVisitFromHistory = (entry: VisitHistoryEntry) => {
    if (visits.length >= visitLimit) {
      if (userPlan === 'free') {
        promptUpgrade(`無料プランは1日${visitLimit}件まで。Proなら${getVisitLimit('pro')}件まで登録できます。`);
      }
      return;
    }
    const newVisit: Visit = {
      id: Math.random().toString(36).substr(2, 9),
      address: entry.address,
      phoneNumber: entry.phoneNumber,
      workMinutes: 60,
      difficulty: difficultyForWorkMinutes(60),
    };
    setVisits([...visits, newVisit]);
    setActiveTab('input');
    setShowVisitAddSheet(false);
    showNotice({ kind: 'success', title: '履歴から訪問先を追加しました', detail: entry.address });
  };

  const handleDeleteVisitHistory = (id: string) => {
    setVisitHistory(prev => {
      const next = prev.filter(item => item.id !== id);
      writeVisitHistory(next);
      return next;
    });
  };

  const handleUpdateVisit = (id: string, updates: Partial<Visit>) => {
    setVisits(visits.map(v => {
      if (v.id !== id) return v;
      const next = { ...v, ...updates };
      if (updates.modelNumber !== undefined && updates.applianceCategory === undefined) {
        next.applianceCategory = inferApplianceCategoryFromModel(updates.modelNumber);
      }
      if (updates.workMinutes !== undefined) {
        next.workMinutes = normalizeWorkMinutes(Number(updates.workMinutes) || 60);
        next.difficulty = difficultyForWorkMinutes(next.workMinutes);
      }
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
    return data.map((v: any) => {
      const modelNumber = typeof v.modelNumber === 'string' && v.modelNumber.trim()
        ? v.modelNumber.trim().toUpperCase()
        : undefined;
      const applianceCategory = (
        typeof v.applianceCategory === 'string' && ['エアコン', '冷蔵庫'].includes(v.applianceCategory)
          ? v.applianceCategory
          : inferApplianceCategoryFromModel(modelNumber)
      );
      const symptomName = typeof v.symptomName === 'string' && v.symptomName.trim()
        ? v.symptomName.trim()
        : undefined;
      const task = selectRepairTask(settings.tasks, { modelNumber, applianceCategory, symptomName });
      const workMinutes = normalizeWorkMinutes(task?.defaultMinutes || 60);

      return {
        id: Math.random().toString(36).substr(2, 9),
        address: typeof v.address === 'string' ? v.address : '',
        phoneNumber: typeof v.phoneNumber === 'string' ? v.phoneNumber : undefined,
        modelNumber: undefined,
        applianceCategory,
        symptomName,
        taskId: task?.id,
        workMinutes,
        difficulty: difficultyForWorkMinutes(workMinutes),
        timeWindow: v.startTime || v.endTime ? { start: v.startTime || '', end: v.endTime || '' } : undefined,
      };
    });
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

  // True when visits or route-relevant settings have changed since the last
  // optimization run, meaning the displayed result no longer matches the input.
  const isRouteStale = plans.length > 0 && optContextRef.current !== null && (
    buildVisitSignature(visits) !== buildVisitSignature(optContextRef.current.visits) ||
    buildRouteSettingsSignature(settings) !== buildRouteSettingsSignature(optContextRef.current.settings)
  );

  const isGoogleCalendarReady = isGoogleCalendarConfigured(GOOGLE_CALENDAR_CLIENT_ID);
  const isRegisteringCalendar = calendarRegistrationStatus !== 'idle';
  const handleExportCalendarIcs = () => {
    if (!activePlan) return;
    const ics = buildCalendarIcs({ plan: activePlan, settings });
    if (!ics) {
      showNotice({
        kind: 'info',
        title: '書き出せる滞在予定がありません',
        detail: '訪問先のあるルート案を計算してから再度お試しください。',
      });
      return;
    }
    const workDate = settings.workDate || getTodayDateInputValue();
    downloadTextFile(`route-schedule-${workDate}.ics`, ics, 'text/calendar;charset=utf-8');
    showNotice({
      kind: 'success',
      title: 'カレンダー用ファイルを書き出しました',
      detail: 'Googleカレンダーのインポート画面で、このICSファイルを選択すると1日分を一括登録できます。',
    });
  };
  const handleRegisterGoogleCalendar = async () => {
    if (!activePlan) return;
    if (!isGoogleCalendarReady) {
      showNotice({
        kind: 'info',
        title: 'Googleカレンダー連携が未設定です',
        detail: '管理者は GOOGLE_CALENDAR_CLIENT_ID を設定してください。今はICS書き出しを利用できます。',
      });
      return;
    }

    const routeCalendarEvents = buildGoogleCalendarRouteEvents({ plan: activePlan, settings });
    if (!routeCalendarEvents) {
      showNotice({
        kind: 'info',
        title: '登録できる滞在予定がありません',
        detail: '訪問先のあるルート案を計算してから再度お試しください。',
      });
      return;
    }

    setCalendarRegistrationStatus('auth');
    try {
      const accessToken = await requestGoogleCalendarAccessToken(GOOGLE_CALENDAR_CLIENT_ID);
      setCalendarRegistrationStatus('registering');
      const result = await syncRouteEventsToPrimaryCalendar({
        accessToken,
        workDate: routeCalendarEvents.workDate,
        events: routeCalendarEvents.events,
      });
      const replacedDetail = result.replacedCount > 0
        ? `前回のアプリ作成済み予定 ${result.replacedCount}件を置き換えました。`
        : '前回分の置き換えはありませんでした。';
      showNotice({
        kind: 'success',
        title: 'Googleカレンダーに登録しました',
        detail: `${result.createdCount}件の現地滞在予定をメイン予定表に登録しました。${replacedDetail}`,
      });
    } catch (error) {
      if (error instanceof GoogleCalendarAuthError) {
        showNotice({
          kind: 'error',
          title: 'Googleカレンダーに接続できませんでした',
          detail: error.message,
        });
      } else if (error instanceof GoogleCalendarPartialError) {
        const cleanupDetail = error.failedCleanupCount > 0
          ? `前回予定の削除失敗: ${error.failedCleanupCount}件。`
          : '前回予定は残しています。';
        showNotice({
          kind: 'warning',
          title: '一部だけ登録されました',
          detail: `${error.createdCount}件の新しい予定を作成しました。${cleanupDetail}カレンダーを確認してください。`,
        });
      } else {
        showNotice({
          kind: 'error',
          title: 'Googleカレンダーへの登録に失敗しました',
          detail: error instanceof Error ? error.message : '時間を置いて再度お試しください。',
        });
      }
    } finally {
      setCalendarRegistrationStatus('idle');
    }
  };
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
            ルート最適化 <span className="text-xs font-normal text-slate-400">{APP_VERSION}</span>
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
               onClick={() => promptUpgrade(`Proにアップグレードすると、最大${getVisitLimit('pro')}件の訪問・GPS現在地起点・月次レポートが使えます。`)}
               className="text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded bg-slate-800 text-blue-300 border border-blue-500/30 hover:bg-blue-500/10"
             >
               Free · アップグレード
             </button>
           )}
        </div>
      </nav>

      <div className="sticky top-16 z-30 bg-[#1A1D23]/95 backdrop-blur-md border-b border-ui px-4 py-2">
        <div className="max-w-2xl lg:max-w-5xl mx-auto grid grid-cols-3 gap-2">
          <button
            onClick={() => setActiveTab('input')}
            className={cn(
              "py-2 rounded-lg border text-[11px] font-bold transition-colors flex items-center justify-center gap-1.5",
              activeTab === 'input'
                ? "bg-blue-500/20 border-blue-500/40 text-blue-200"
                : "bg-slate-800/40 border-ui text-secondary hover:text-white"
            )}
          >
            <ClipboardList className="w-3.5 h-3.5" />
            入力
          </button>
          <button
            onClick={() => activePlan ? setActiveTab('result') : showNotice({ kind: 'info', title: '先にルートを計算してください', detail: '訪問先を入力してからルート計算を実行すると結果を表示できます。' })}
            className={cn(
              "py-2 rounded-lg border text-[11px] font-bold transition-colors flex items-center justify-center gap-1.5",
              activeTab === 'result'
                ? "bg-blue-500/20 border-blue-500/40 text-blue-200"
                : "bg-slate-800/40 border-ui text-secondary hover:text-white"
            )}
          >
            <Navigation className="w-3.5 h-3.5" />
            ルート
          </button>
          <button
            onClick={() => setActiveTab('history')}
            className={cn(
              "py-2 rounded-lg border text-[11px] font-bold transition-colors flex items-center justify-center gap-1.5",
              activeTab === 'history'
                ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-200"
                : "bg-slate-800/40 border-ui text-secondary hover:text-white"
            )}
          >
            <CalendarDays className="w-3.5 h-3.5" />
            履歴
          </button>
        </div>
      </div>

      <AnimatePresence mode="wait">
        {activeTab === 'history' ? (
          <motion.div
            key="history"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="p-4 space-y-4 max-w-5xl mx-auto"
          >
            <VisitHistoryPanel
              history={visitHistory}
              onAdd={handleAddVisitFromHistory}
              onDelete={handleDeleteVisitHistory}
              variant="full"
            />
          </motion.div>
        ) : activeTab === 'input' || !activePlan ? (
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
                  <p className="text-sm font-medium num-font">{settings.workDate || getTodayDateInputValue()} {settings.startTime || '09:00'}</p>
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
                const taskOptions = taskOptionsForVisit(settings.tasks, visit);
                return (
                <div
                  key={visit.id}
                  className={cn(
                    "bg-card p-4 rounded-xl border relative group transition-all hover:border-blue-500/30 overflow-hidden",
                    hasErrors ? "border-red-500/50" : hasWarnings ? "border-yellow-500/30" : "border-ui"
                  )}
                >
                  <div
                    className="absolute left-0 top-0 w-1 h-full"
                    style={{ background: difficultyColor(visit.difficulty).work }}
                  />
                  <div className="flex justify-between items-start mb-3">
                    <div className="min-w-0 flex-1 pr-2">
                      <div className="flex items-center gap-2 mb-2">
                      <span
                        className="w-6 h-6 rounded-md border flex items-center justify-center text-[10px] font-bold text-white"
                        style={{
                          background: difficultyColor(visit.difficulty).work,
                          borderColor: difficultyColor(visit.difficulty).work,
                        }}
                      >
                        {idx + 1}
                      </span>
                        <ApplianceCategoryToggle
                          value={visit.applianceCategory}
                          onChange={(applianceCategory) => handleUpdateVisit(
                            visit.id,
                            nextVisitForApplianceCategory(visit, applianceCategory, settings.tasks)
                          )}
                        />
                      </div>
                      <select 
                        className="bg-transparent border-none text-sm font-bold focus:ring-0 w-full appearance-none cursor-pointer"
                        value={visit.taskId || ''}
                        onChange={(e) => {
                          const tId = e.target.value;
                          const task = settings.tasks.find(t => t.id === tId);
                          const workMinutes = task ? task.defaultMinutes : visit.workMinutes;
                          handleUpdateVisit(visit.id, {
                            taskId: tId,
                            workMinutes,
                            difficulty: difficultyForWorkMinutes(workMinutes)
                          });
                        }}
                      >
                        <option value="" disabled className="text-gray-500">作業を選択...</option>
                        {taskOptions.map(t => (
                          <option key={t.id} value={t.id} className="bg-[#1A1D23]">{t.majorCategory ? `${t.majorCategory} / ${displayTaskName(t)}` : displayTaskName(t)}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex items-center gap-2">
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

                     <div className="flex items-center justify-between gap-3 bg-slate-800/50 p-2.5 rounded border border-ui">
                        <span className="text-[10px] text-secondary font-bold uppercase tracking-wider">
                          滞在予定（作業時間）
                        </span>
                        <span
                          className="text-xs font-bold rounded-full border px-2 py-1"
                          style={difficultyBadgeStyle(visit.difficulty)}
                        >
                          {visit.workMinutes}分 / 難易度{difficultyLabel(visit.difficulty)}
                        </span>
                     </div>
                  </div>
                </div>
                );
              })}

              {visits.length < visitLimit ? (
                <button
                  onClick={() => setShowVisitAddSheet(true)}
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

              {/* Prominent CTA row: camera + library + voice */}
              <div className="grid grid-cols-3 gap-2 mb-3">
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
            className="flex flex-col lg:flex-row w-full lg:h-[calc(100vh-112px)] lg:overflow-hidden overflow-y-auto"
          >
            {/* Sidebar (Route List). Full-width on mobile, fixed 420px on desktop. */}
            <aside className="w-full lg:w-[420px] lg:h-full bg-bg lg:border-r border-ui flex flex-col shrink-0 z-10 lg:shadow-2xl lg:overflow-y-auto custom-scrollbar">
              {/* Stale route warning — shown when input has changed since last optimization */}
              {isRouteStale && (
                <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                    <p className="text-[11px] text-amber-200 font-bold leading-snug">
                      訪問先または設定が変更されました。再計算してください。
                    </p>
                  </div>
                  <button
                    onClick={() => handleOptimize()}
                    disabled={isOptimizing}
                    className="shrink-0 px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-900 text-[11px] font-extrabold transition-colors disabled:opacity-50"
                  >
                    再計算
                  </button>
                </div>
              )}

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
                  const addressParts = visit ? formatVisitAddress(visit.address) : null;
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

                        <div className="flex items-start justify-between gap-2 mb-3">
                          <div className="flex items-center gap-2 min-w-0 flex-1">
                            <button
                              onClick={() => toggleCompleted(visit.id)}
                              title={isCompleted ? '完了を取り消す' : '完了にする'}
                              aria-label={isCompleted ? '完了を取り消す' : '訪問を完了にする'}
                              className={cn(
                                "shrink-0 h-9 w-9 rounded-lg border flex items-center justify-center transition-colors",
                                isCompleted
                                  ? "bg-green-500/25 border-green-400/50 text-green-100"
                                  : "bg-slate-800 border-slate-600 text-slate-400 hover:border-green-500/50 hover:text-green-300 hover:bg-green-500/10"
                              )}
                            >
                              <CheckCircle2 className="w-4 h-4" />
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
                            {isCompleted && (
                              <span className="shrink-0 text-[10px] font-bold text-green-300 bg-green-500/10 border border-green-500/30 rounded px-1.5 py-0.5">
                                完了済み
                              </span>
                            )}
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

                        <h3 className={cn("text-lg font-bold mb-2 leading-tight", isCompleted && "line-through text-secondary")}>
                          {(() => {
                            const task = settings.tasks.find(t => t.id === visit.taskId);
                            if (task) return task.name;
                            return '訪問先';
                          })()}
                        </h3>

                        <div className="space-y-2.5">
                          <div className="flex items-start gap-2 rounded-lg bg-slate-900/45 border border-ui px-2.5 py-2">
                            <div className={cn("flex-1 min-w-0 leading-relaxed break-words", isCompleted ? "text-secondary line-through" : "text-gray-100")}>
                              <p className="text-sm font-semibold">{addressParts?.streetLine || visit.address}</p>
                              {addressParts?.buildingLine && (
                                <p className="text-xs text-slate-300 mt-0.5">{addressParts.buildingLine}</p>
                              )}
                            </div>
                            <div className="flex flex-wrap justify-end gap-1 shrink-0 max-w-[9.5rem]">
                              <button
                                onClick={() => {
                                  const destination = formatMapsPoint(visit.address, visit.coords);
                                  window.open(
                                    buildGoogleMapsDirectionsUrl({ destination }),
                                    '_blank',
                                    'noopener,noreferrer'
                                  );
                                }}
                                title="この住所を地図で開く"
                                aria-label="この住所を地図で開く"
                                className="h-9 px-2 rounded-md border border-blue-500/30 bg-blue-500/10 text-blue-200 hover:bg-blue-500/20 text-[11px] font-bold flex items-center justify-center gap-1 transition-colors"
                              >
                                <Navigation className="w-3.5 h-3.5" />
                                地図
                              </button>
                              <CopyActionButton
                                value={addressParts?.copyStreetAddress || visit.address}
                                label="東京都から番地までをコピー"
                                buttonText="住所"
                                className="h-9 px-2 justify-center gap-1 bg-slate-800 border-ui text-gray-200 hover:bg-slate-700 text-[11px] font-bold flex items-center"
                                iconClassName="w-3.5 h-3.5"
                              />
                              {addressParts?.buildingLine && (
                                <>
                                  {addressParts.buildingMapQuery && (
                                    <button
                                      onClick={() => {
                                        const destination = `${addressParts.copyStreetAddress} ${addressParts.buildingMapQuery}`.trim();
                                        window.open(
                                          buildGoogleMapsDirectionsUrl({ destination }),
                                          '_blank',
                                          'noopener,noreferrer'
                                        );
                                      }}
                                      title="部屋番号を除いた建物名で地図を開く"
                                      aria-label="部屋番号を除いた建物名で地図を開く"
                                      className="h-9 px-2 rounded-md border border-blue-500/30 bg-blue-500/10 text-blue-200 hover:bg-blue-500/20 text-[11px] font-bold flex items-center justify-center gap-1 transition-colors"
                                    >
                                      <Navigation className="w-3.5 h-3.5" />
                                      建物地図
                                    </button>
                                  )}
                                  <CopyActionButton
                                    value={addressParts.buildingLine}
                                    label="建物名・部屋番号をコピー"
                                    buttonText="建物"
                                    className="h-9 px-2 justify-center gap-1 bg-slate-800 border-ui text-gray-200 hover:bg-slate-700 text-[11px] font-bold flex items-center"
                                    iconClassName="w-3.5 h-3.5"
                                  />
                                </>
                              )}
                            </div>
                          </div>

                          {phoneNumber && (
                            <div className="flex items-center gap-2 rounded-lg bg-slate-900/45 border border-ui px-2.5 py-2">
                              <p className={cn("flex-1 min-w-0 text-base flex items-center gap-2 num-font font-bold", isCompleted ? "text-secondary line-through" : "text-green-300")}>
                                <Phone className="w-3.5 h-3.5 shrink-0" />
                                {phoneNumber}
                              </p>
                              <div className="flex gap-1 shrink-0">
                                <a
                                  href={`tel:${phoneNumber.replace(/[^\d+]/g, '')}`}
                                  title="電話をかける"
                                  aria-label="電話をかける"
                                  className="h-9 px-2 rounded-md border border-green-500/30 bg-green-500/10 text-green-200 hover:bg-green-500/20 text-[11px] font-bold flex items-center justify-center gap-1 transition-colors"
                                >
                                  <Phone className="w-3.5 h-3.5" />
                                  電話
                                </a>
                                <CopyActionButton
                                  value={phoneNumber}
                                  label="電話番号をコピー"
                                  buttonText="コピー"
                                  className="h-9 px-2 justify-center gap-1 bg-slate-800 border-ui text-gray-200 hover:bg-slate-700 text-[11px] font-bold flex items-center"
                                  iconClassName="w-3.5 h-3.5"
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
                <div className="flex items-center justify-between gap-3 bg-slate-800/60 border border-ui rounded-xl px-3 py-2.5">
                  <label htmlFor="calendar-work-date" className="text-[10px] text-secondary font-bold uppercase tracking-widest shrink-0">
                    カレンダー登録日
                  </label>
                  <input
                    id="calendar-work-date"
                    type="date"
                    value={settings.workDate || getTodayDateInputValue()}
                    onChange={(e) => {
                      const value = e.target.value;
                      if (value) setSettings(prev => ({ ...prev, workDate: value }));
                    }}
                    onClick={(e) => openNativeDatePicker(e.currentTarget)}
                    className="bg-[#1A1D23] border border-ui rounded-lg px-3 py-1.5 text-sm focus:border-blue-500/50 outline-none num-font"
                  />
                </div>
                <button
                  onClick={handleRegisterGoogleCalendar}
                  disabled={!isGoogleCalendarReady || isRegisteringCalendar}
                  title={isGoogleCalendarReady ? 'Googleカレンダーに一括登録' : 'GOOGLE_CALENDAR_CLIENT_ID が未設定です'}
                  className={cn(
                    "w-full py-3 rounded-xl font-extrabold text-sm border flex items-center justify-center gap-2 transition-colors active:scale-[0.98]",
                    isGoogleCalendarReady
                      ? "bg-emerald-600 hover:bg-emerald-500 border-emerald-400/40 text-white shadow-lg shadow-emerald-900/25"
                      : "bg-slate-800 border-ui text-secondary cursor-not-allowed opacity-60"
                  )}
                >
                  {isRegisteringCalendar ? (
                    <div className="w-4 h-4 border-2 border-white/25 border-t-white rounded-full animate-spin" />
                  ) : (
                    <CalendarDays className="w-4 h-4" />
                  )}
                  {calendarRegistrationStatus === 'auth'
                    ? 'Googleに接続中...'
                    : calendarRegistrationStatus === 'registering'
                      ? '予定を登録中...'
                      : isGoogleCalendarReady
                        ? 'Googleカレンダーに一括登録'
                        : 'Google連携は未設定'}
                </button>
                <button
                  onClick={handleExportCalendarIcs}
                  className="w-full py-3 bg-slate-800 hover:bg-slate-700 rounded-xl font-bold text-xs border border-ui flex items-center justify-center gap-2 transition-colors active:scale-[0.98]"
                >
                  <CalendarDays className="w-4 h-4 text-blue-300" />
                  Googleカレンダー用に1日分を書き出す
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
              notice.kind === 'warning' ? 'bg-amber-950/90 border-amber-500/40' :
              notice.kind === 'success' ? 'bg-green-950/90 border-green-500/40' :
              'bg-slate-900/90 border-ui'
            )}>
              <div className="flex items-start gap-3">
                <span className="text-lg leading-none mt-0.5">
                  {notice.kind === 'error' ? '⚠️' : notice.kind === 'warning' ? '!' : notice.kind === 'success' ? '✓' : 'ℹ️'}
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
              const nextSettings = {
                ...val,
                tasks: val.tasks.map(task => ({
                  ...task,
                  defaultMinutes: normalizeWorkMinutes(task.defaultMinutes),
                })),
              };
              setSettings(nextSettings);
              setVisits(prev => prev.map(visit => {
                const task = nextSettings.tasks.find(item => item.id === visit.taskId);
                if (!task) return visit;
                const workMinutes = task.defaultMinutes;
                return {
                  ...visit,
                  workMinutes,
                  difficulty: difficultyForWorkMinutes(workMinutes),
                };
              }));
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

      {/* Visit Add Sheet */}
      <AnimatePresence>
        {showVisitAddSheet && (
          <VisitAddSheet
            history={visitHistory}
            onBlankAdd={handleAddBlankVisit}
            onAddFromHistory={handleAddVisitFromHistory}
            onDeleteHistory={handleDeleteVisitHistory}
            onClose={() => setShowVisitAddSheet(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function VisitAddSheet({
  history,
  onBlankAdd,
  onAddFromHistory,
  onDeleteHistory,
  onClose,
}: {
  history: VisitHistoryEntry[];
  onBlankAdd: () => void;
  onAddFromHistory: (entry: VisitHistoryEntry) => void;
  onDeleteHistory: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <motion.div
      className="fixed inset-0 z-[70] bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-3"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <motion.div
        className="w-full max-w-2xl max-h-[90vh] bg-card border border-ui rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden flex flex-col"
        initial={{ y: 28, scale: 0.98 }}
        animate={{ y: 0, scale: 1 }}
        exit={{ y: 28, scale: 0.98 }}
      >
        <div className="p-4 border-b border-ui flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Plus className="w-4 h-4 text-blue-300" />
              訪問先を追加
            </h3>
            <p className="text-[11px] text-secondary mt-1">新規入力するか、過去の訪問履歴から選択します。</p>
          </div>
          <button onClick={onClose} className="p-2 text-secondary hover:text-white rounded-lg hover:bg-slate-800">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 overflow-y-auto custom-scrollbar space-y-3">
          <button
            onClick={onBlankAdd}
            className="w-full py-4 rounded-xl border border-blue-500/30 bg-blue-500/10 text-blue-100 hover:bg-blue-500/20 transition-colors flex items-center justify-center gap-2"
          >
            <Plus className="w-5 h-5" />
            <span className="text-xs font-extrabold uppercase tracking-widest">新規で追加</span>
          </button>
          <VisitHistoryPanel
            history={history}
            onAdd={onAddFromHistory}
            onDelete={onDeleteHistory}
            variant="picker"
          />
        </div>
      </motion.div>
    </motion.div>
  );
}

function VisitHistoryPanel({
  history,
  onAdd,
  onDelete,
  variant = 'compact',
}: {
  history: VisitHistoryEntry[];
  onAdd: (entry: VisitHistoryEntry) => void;
  onDelete: (id: string) => void;
  variant?: 'compact' | 'full' | 'picker';
}) {
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();
  const filteredHistory = normalizedQuery
    ? history.filter(item => {
        const haystack = [
          item.address,
          item.phoneNumber || '',
          item.lastSeenAt,
          formatHistoryDate(item.lastSeenAt),
        ].join(' ').toLowerCase();
        return haystack.includes(normalizedQuery);
      })
    : history;
  const grouped = filteredHistory.reduce<Record<string, VisitHistoryEntry[]>>((acc, item) => {
    (acc[item.lastSeenAt] ||= []).push(item);
    return acc;
  }, {});
  const groupedDates = Object.keys(grouped).sort((a, b) => b.localeCompare(a));
  const isFull = variant === 'full';
  const isPicker = variant === 'picker';
  const title = isFull ? '訪問履歴一覧' : isPicker ? '履歴から追加' : '訪問履歴';
  const description = isFull
    ? '過去に取得した住所・電話番号を日付別に遡れます'
    : isPicker
      ? '住所・電話番号・日付で絞り込んで追加できます'
      : '取得済みの住所・電話番号を日付別に保存';

  return (
    <section className={cn(
      isPicker ? "p-0" : "bg-card p-4 rounded-xl border border-ui",
      isFull && "min-h-[calc(100vh-150px)]"
    )}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h3 className={cn(
            "font-bold flex items-center gap-2 uppercase tracking-tight",
            isFull ? "text-sm text-white" : "text-xs text-secondary"
          )}>
            <CalendarDays className="w-4 h-4 text-emerald-400" />
            {title}
          </h3>
          <p className="text-[10px] text-slate-500 mt-1">
            {description}
          </p>
        </div>
        <span className="text-[10px] font-bold text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded">
          {history.length}件
        </span>
      </div>

      <div className="relative mb-3">
        <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
        <input
          className="w-full bg-[#1A1D23] border border-ui rounded-lg pl-9 pr-3 py-2.5 text-xs font-medium outline-none focus:border-emerald-500/50 transition-colors"
          placeholder="住所・電話番号・日付で検索"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {history.length === 0 ? (
        <div className="border border-dashed border-ui rounded-lg p-4 text-center">
          <p className="text-xs font-bold text-slate-300">まだ履歴はありません</p>
          <p className="text-[10px] text-slate-500 mt-1">訪問先に住所を入れると自動で保存されます。</p>
        </div>
      ) : groupedDates.length === 0 ? (
        <div className="border border-dashed border-ui rounded-lg p-4 text-center">
          <p className="text-xs font-bold text-slate-300">該当する履歴がありません</p>
          <p className="text-[10px] text-slate-500 mt-1">検索語を短くすると見つかりやすくなります。</p>
        </div>
      ) : (
        <div className={cn(
          "overflow-y-auto custom-scrollbar space-y-4 pr-1",
          isFull ? "max-h-none" : "max-h-80"
        )}>
          {groupedDates.map(date => (
            <div key={date}>
              <div className="sticky top-0 z-10 bg-card/95 backdrop-blur-sm pb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-extrabold text-white num-font">{formatHistoryDate(date)}</span>
                  <span className="text-[10px] text-slate-500">{date}</span>
                </div>
                <span className="text-[10px] text-slate-500 font-bold">{grouped[date].length}件</span>
              </div>
              <div className={cn(isFull ? "grid gap-2 sm:grid-cols-2 lg:grid-cols-3" : "space-y-2")}>
                {grouped[date].map(item => {
                  const telHref = item.phoneNumber ? `tel:${item.phoneNumber.replace(/[^\d+]/g, '')}` : '';
                  return (
                    <div key={item.id} className="rounded-lg border border-ui bg-slate-800/40 p-3">
                      <div className="flex items-start gap-2">
                        <MapPin className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-bold text-white leading-relaxed break-words">{item.address}</p>
                          {item.phoneNumber ? (
                            <div className="flex items-center gap-1.5 mt-1 text-[11px] text-slate-300">
                              <Phone className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                              <span className="num-font">{item.phoneNumber}</span>
                            </div>
                          ) : (
                            <p className="text-[10px] text-slate-500 mt-1">電話番号なし</p>
                          )}
                        </div>
                      </div>
                      <div className="grid grid-cols-4 gap-2 mt-3">
                        <button
                          onClick={() => onAdd(item)}
                          className="col-span-2 py-2 rounded-md bg-emerald-600/20 border border-emerald-500/30 text-emerald-200 text-[11px] font-bold hover:bg-emerald-600/30 transition-colors"
                        >
                          追加
                        </button>
                        {item.phoneNumber ? (
                          <a
                            href={telHref}
                            className="py-2 rounded-md bg-slate-900 border border-ui text-slate-200 text-[11px] font-bold hover:bg-slate-800 transition-colors text-center"
                          >
                            発信
                          </a>
                        ) : (
                          <button disabled className="py-2 rounded-md bg-slate-900 border border-ui text-slate-600 text-[11px] font-bold">
                            発信
                          </button>
                        )}
                        <button
                          onClick={() => onDelete(item.id)}
                          title="履歴から削除"
                          className="py-2 rounded-md bg-red-500/10 border border-red-500/20 text-red-300 text-[11px] font-bold hover:bg-red-500/20 transition-colors flex items-center justify-center"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
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
      if (updates.modelNumber !== undefined && updates.applianceCategory === undefined) {
        next.applianceCategory = inferApplianceCategoryFromModel(updates.modelNumber);
      }
      if (updates.workMinutes !== undefined) {
        next.workMinutes = normalizeWorkMinutes(Number(updates.workMinutes) || 60);
        next.difficulty = difficultyForWorkMinutes(next.workMinutes);
      }
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
            <p className="text-[11px] text-secondary mt-1">機種・作業・住所・電話番号・時間を確認して追加します。</p>
          </div>
          <button onClick={onClose} className="p-1 text-secondary hover:text-white"><XCircle className="w-5 h-5"/></button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
          {visits.length === 0 ? (
            <div className="py-8 text-center text-sm text-secondary">追加する候補がありません</div>
          ) : visits.map((visit, idx) => {
            const missingAddress = !visit.address.trim();
            const taskOptions = taskOptionsForVisit(tasks, visit);
            return (
              <div key={visit.id} className={cn(
                "rounded-xl border p-3 bg-slate-900/35 relative overflow-hidden",
                missingAddress ? "border-red-500/50" : "border-ui"
              )}>
                <div
                  className="absolute left-0 top-0 w-1 h-full"
                  style={{ background: difficultyColor(visit.difficulty).work }}
                />
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="flex items-center gap-2">
                    <span
                      className="w-6 h-6 rounded-md border flex items-center justify-center text-[10px] font-bold text-white"
                      style={{
                        background: difficultyColor(visit.difficulty).work,
                        borderColor: difficultyColor(visit.difficulty).work,
                      }}
                    >
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

                <div className="mb-3">
                  <span className="text-[10px] text-secondary font-bold uppercase tracking-wider flex items-center gap-1 mb-2">
                    <Layers className="w-3.5 h-3.5" /> 機種
                  </span>
                  <ApplianceCategoryToggle
                    value={visit.applianceCategory}
                    onChange={(applianceCategory) => updateVisit(
                      visit.id,
                      nextVisitForApplianceCategory(visit, applianceCategory, tasks)
                    )}
                  />
                  {!visit.taskId && (
                    <p className="text-[10px] text-yellow-300 font-bold mt-2">作業は手動選択してください</p>
                  )}
                </div>

                <div className="mb-3">
                  <label className="flex-1 block">
                    <span className="text-[10px] text-secondary font-bold uppercase tracking-wider flex items-center gap-1 mb-2">
                      <ClipboardList className="w-3.5 h-3.5" /> 作業
                    </span>
                    <select
                      className="w-full bg-[#1A1D23] border border-ui rounded-lg px-3 py-2 text-xs font-bold outline-none transition-colors focus:border-blue-500/50"
                      value={visit.taskId || ''}
                      onChange={(e) => {
                        const taskId = e.target.value;
                        const task = tasks.find(t => t.id === taskId);
                        const workMinutes = task ? task.defaultMinutes : visit.workMinutes;
                        updateVisit(visit.id, {
                          taskId,
                          workMinutes,
                          difficulty: difficultyForWorkMinutes(workMinutes),
                        });
                      }}
                    >
                      <option value="" disabled className="text-gray-500">作業を選択...</option>
                      {taskOptions.map(task => (
                        <option key={task.id} value={task.id} className="bg-[#1A1D23]">
                          {task.majorCategory ? `${task.majorCategory} / ${displayTaskName(task)}` : displayTaskName(task)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

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
                    <span className="text-[10px] text-secondary font-bold uppercase tracking-wider">予定</span>
                    <span
                      className="text-xs font-bold rounded-full border px-2 py-1"
                      style={difficultyBadgeStyle(visit.difficulty)}
                    >
                      {visit.workMinutes}分 / 難易度{difficultyLabel(visit.difficulty)}
                    </span>
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
          <div className="flex items-center gap-2"><span className="text-green-400">✓</span> 訪問先 1日 <strong className="text-white">{getVisitLimit('pro')}件</strong> まで</div>
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
function ApplianceCategoryToggle({
  value,
  onChange,
  className,
}: {
  value?: string;
  onChange: (value: string | undefined) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      {APPLIANCE_CATEGORIES.map(category => {
        const selected = value === category;
        return (
          <button
            key={category}
            type="button"
            onClick={() => onChange(selected ? undefined : category)}
            className={cn(
              "px-2.5 py-1.5 rounded-full border text-[11px] font-bold transition-colors",
              selected
                ? "bg-blue-500/20 border-blue-400/60 text-blue-100"
                : "bg-slate-900/70 border-ui text-secondary hover:text-white hover:border-blue-500/40"
            )}
          >
            {category}
          </button>
        );
      })}
    </div>
  );
}

function StatusBadge({ status }: { status: 'ok' | 'warning' | 'violation' }) {
  if (status === 'ok') return <Badge variant="success" className="flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> OK</Badge>;
  if (status === 'warning') return <Badge variant="warning" className="flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> ギリギリ</Badge>;
  return <Badge variant="danger" className="flex items-center gap-1"><XCircle className="w-3 h-3" /> 超過</Badge>;
}

function TasksModal({ settings, onSave, onClose }: { settings: Settings, onSave: (s: Settings) => void, onClose: () => void }) {
  type TaskDraft = Settings['tasks'][number];
  const normalizeTaskDraft = (task: TaskDraft): TaskDraft => ({
    ...task,
    name: task.name || '未設定の作業',
    defaultMinutes: normalizeWorkMinutes(task.defaultMinutes),
    applianceCategory: task.applianceCategory || undefined,
    majorCategory: task.majorCategory || undefined,
  });

  const [tasks, setTasks] = useState<TaskDraft[]>((settings.tasks || []).map(normalizeTaskDraft));
  const [newApplianceCategory, setNewApplianceCategory] = useState(APPLIANCE_CATEGORIES[0]);
  const [newMajorCategory, setNewMajorCategory] = useState('');
  const [newName, setNewName] = useState('');
  const [newMinutes, setNewMinutes] = useState('60');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editApplianceCategory, setEditApplianceCategory] = useState('');
  const [editMajorCategory, setEditMajorCategory] = useState('');
  const [editName, setEditName] = useState('');
  const [editMinutes, setEditMinutes] = useState('');

  const groupedTasks = tasks.reduce<Record<string, Record<string, TaskDraft[]>>>((groups, task) => {
    const appliance = task.applianceCategory || '未分類';
    const major = task.majorCategory || '未分類';
    groups[appliance] = groups[appliance] || {};
    groups[appliance][major] = groups[appliance][major] || [];
    groups[appliance][major].push(task);
    return groups;
  }, {});

  const startEdit = (task: TaskDraft) => {
    setEditingId(task.id);
    setEditApplianceCategory(task.applianceCategory || APPLIANCE_CATEGORIES[0]);
    setEditMajorCategory(task.majorCategory || '');
    setEditName(taskDetailName(task));
    setEditMinutes(String(task.defaultMinutes));
  };

  const buildTaskName = (applianceCategory: string, detailName: string) => {
    const detail = detailName.trim();
    const appliance = applianceCategory.trim();
    return appliance && !detail.startsWith(`${appliance}:`) ? `${appliance}: ${detail}` : detail;
  };

  const buildCommittedTasks = () => {
    if (!editingId) return tasks;
    const detailName = editName.trim();
    if (!detailName) return tasks;
    return tasks.map(t =>
      t.id === editingId
        ? normalizeTaskDraft({
            ...t,
            applianceCategory: editApplianceCategory.trim() || undefined,
            majorCategory: editMajorCategory.trim() || undefined,
            name: buildTaskName(editApplianceCategory, detailName),
            defaultMinutes: parseInt(editMinutes) || t.defaultMinutes,
          })
        : t
    );
  };

  const commitEdit = () => {
    if (!editingId) return;
    setTasks(buildCommittedTasks());
    setEditingId(null);
  };

  const handleAdd = () => {
    const detailName = newName.trim();
    if (!detailName || !newMajorCategory.trim()) return;
    const applianceCategory = newApplianceCategory.trim();
    setTasks([
      ...tasks,
      normalizeTaskDraft({
        id: Date.now().toString(),
        applianceCategory,
        majorCategory: newMajorCategory.trim(),
        name: buildTaskName(applianceCategory, detailName),
        defaultMinutes: parseInt(newMinutes) || 60,
        source: 'manual',
      }),
    ]);
    setNewName('');
    setNewMajorCategory('');
    setNewMinutes('60');
  };

  const handleRemove = (id: string) => {
    if (editingId === id) setEditingId(null);
    setTasks(tasks.filter(t => t.id !== id));
  };

  const handleSave = () => {
    const nextTasks = buildCommittedTasks().map(normalizeTaskDraft);
    onSave({ ...settings, tasks: nextTasks });
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
        className="bg-card w-full max-w-3xl flex flex-col max-h-[85vh] rounded-2xl shadow-2xl border border-ui overflow-hidden"
      >
        <div className="p-4 border-b border-ui flex justify-between items-start bg-slate-900">
          <div>
            <h2 className="text-sm font-bold text-white flex items-center gap-2"><Layers className="w-4 h-4 text-blue-400" /> 作業内容・作業時間の設定</h2>
            <p className="text-[11px] text-secondary mt-1">大カテゴリ（機器）→ 中カテゴリ（症状の大分類）→ 小カテゴリ（症状の詳細）＋想定作業時間で管理します。</p>
          </div>
          <button onClick={onClose} className="p-1 text-secondary hover:text-white"><XCircle className="w-5 h-5"/></button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
          {Object.entries(groupedTasks).map(([appliance, majors]) => (
            <section key={appliance} className="rounded-xl border border-ui bg-slate-900/30 overflow-hidden">
              <div className="px-3 py-2 bg-slate-800/70 border-b border-ui flex items-center gap-2">
                <Badge>{appliance}</Badge>
                <span className="text-xs font-bold text-white">大カテゴリ</span>
              </div>
              <div className="p-3 space-y-3">
                {Object.entries(majors).map(([major, majorTasks]) => (
                  <div key={`${appliance}-${major}`} className="rounded-lg border border-ui bg-slate-950/20">
                    <div className="px-3 py-2 border-b border-ui text-xs font-bold text-blue-200">{major}</div>
                    <div className="divide-y divide-slate-800/80">
                      {majorTasks.map(task => (
                        <div key={task.id} className={cn("p-3 transition-colors", editingId === task.id && "bg-blue-500/5")}>
                          {editingId === task.id ? (
                            <div className="grid grid-cols-1 md:grid-cols-[120px_1fr_1fr_96px_auto] gap-2 items-center">
                              <select className="bg-[#1A1D23] border border-blue-500/50 rounded-lg px-2 py-2 text-xs font-bold outline-none" value={editApplianceCategory} onChange={(e) => setEditApplianceCategory(e.target.value)}>
                                {APPLIANCE_CATEGORIES.map(category => <option key={category} value={category} className="bg-[#1A1D23]">{category}</option>)}
                              </select>
                              <input className="bg-[#1A1D23] border border-blue-500/50 rounded-lg px-3 py-2 text-xs font-bold outline-none" value={editMajorCategory} onChange={(e) => setEditMajorCategory(e.target.value)} placeholder="中カテゴリ" />
                              <input autoFocus className="bg-[#1A1D23] border border-blue-500/50 rounded-lg px-3 py-2 text-xs font-bold outline-none" value={editName} onChange={(e) => setEditName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEditingId(null); }} placeholder="小カテゴリ" />
                              <select className="bg-[#1A1D23] border border-blue-500/50 rounded-lg px-2 py-2 text-xs font-bold outline-none" value={editMinutes} onChange={(e) => setEditMinutes(e.target.value)}>
                                {WORK_MINUTE_OPTIONS.map(minutes => <option key={minutes} value={minutes} className="bg-[#1A1D23]">{minutes}分</option>)}
                              </select>
                              <div className="flex gap-1">
                                <button onClick={commitEdit} className="p-2 text-green-400 bg-green-400/10 rounded-lg" title="確定"><Check className="w-4 h-4" /></button>
                                <button onClick={() => setEditingId(null)} className="p-2 text-secondary hover:text-white rounded-lg" title="キャンセル"><X className="w-4 h-4" /></button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex justify-between gap-3 items-center">
                              <div className="min-w-0">
                                <h4 className="text-sm font-bold text-white truncate">{taskDetailName(task)}</h4>
                                <p className="text-[10px] text-secondary mt-1">{taskFullPath(task)} / 想定作業時間: {task.defaultMinutes}分 / 難易度{difficultyLabel(difficultyForWorkMinutes(task.defaultMinutes))}</p>
                              </div>
                              <div className="flex items-center gap-1 shrink-0">
                                <button onClick={() => startEdit(task)} className="p-2 text-blue-400 bg-blue-400/10 rounded-lg" title="編集"><Pencil className="w-4 h-4" /></button>
                                <button onClick={() => handleRemove(task.id)} className="p-2 text-red-400 bg-red-400/10 rounded-lg" title="削除"><Trash2 className="w-4 h-4" /></button>
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}

          <div className="border-t border-ui pt-4">
            <h4 className="text-xs font-bold text-secondary uppercase tracking-widest mb-3">新規追加</h4>
            <div className="grid grid-cols-1 md:grid-cols-[120px_1fr_1fr_96px_auto] gap-2">
              <select className="bg-[#1A1D23] border border-ui rounded-lg px-3 py-2 text-xs font-bold outline-none" value={newApplianceCategory} onChange={(e) => setNewApplianceCategory(e.target.value)}>
                {APPLIANCE_CATEGORIES.map(category => <option key={category} value={category} className="bg-[#1A1D23]">{category}</option>)}
              </select>
              <input className="bg-[#1A1D23] border border-ui rounded-lg px-3 py-2 text-xs font-bold outline-none placeholder:text-slate-600" value={newMajorCategory} onChange={(e) => setNewMajorCategory(e.target.value)} placeholder="中カテゴリ（例: 水漏れ）" />
              <input className="bg-[#1A1D23] border border-ui rounded-lg px-3 py-2 text-xs font-bold outline-none placeholder:text-slate-600" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }} placeholder="小カテゴリ（例: パイプ詰まり）" />
              <select className="bg-[#1A1D23] border border-ui rounded-lg px-3 py-2 text-xs font-bold outline-none" value={newMinutes} onChange={(e) => setNewMinutes(e.target.value)}>
                {WORK_MINUTE_OPTIONS.map(minutes => <option key={minutes} value={minutes} className="bg-[#1A1D23]">{minutes}分</option>)}
              </select>
              <button onClick={handleAdd} disabled={!newName.trim() || !newMajorCategory.trim()} className="px-4 py-2 bg-blue-600 disabled:opacity-50 hover:bg-blue-500 rounded-lg text-xs font-bold transition-colors shadow-lg">追加</button>
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
  const [workDate, setWorkDate] = useState(settings.workDate || getTodayDateInputValue());
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
      workDate,
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
            <MapPin className="w-4 h-4 text-blue-500" /> 起点・終点・日付時刻
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
            <label className="block text-[10px] text-secondary font-bold uppercase tracking-widest mb-1.5">作業日</label>
            <input
              type="date"
              className="bg-[#1A1D23] border border-ui rounded-lg px-3 py-2 text-sm focus:border-blue-500/50 outline-none num-font"
              value={workDate}
              onChange={(e) => setWorkDate(e.target.value)}
              onClick={(e) => openNativeDatePicker(e.currentTarget)}
            />
            <p className="text-[10px] text-secondary mt-1">カレンダー書き出し時に、この日付で現地滞在予定を作成します。</p>
          </div>

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

type PendingImage = {
  dataUrl: string;
  mime: string;
  name: string;
};

type CropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const MIN_CROP_SIZE = 40;

function CameraCTA({ onImage, disabled }: { onImage: (base64: string, mime: string) => void, disabled: boolean }) {
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const libraryInputRef = useRef<HTMLInputElement>(null);
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setPendingImage({
        dataUrl: ev.target?.result as string,
        mime: file.type || 'image/jpeg',
        name: file.name || '伝票画像',
      });
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleImageReady = (dataUrl: string, mime: string) => {
    const base64 = dataUrl.split(',')[1];
    onImage(base64, mime);
    setPendingImage(null);
  };

  return (
    <>
      <input
        ref={cameraInputRef}
        type="file"
        className="hidden"
        accept="image/*"
        capture="environment"
        onChange={handleFileChange}
      />
      <input
        ref={libraryInputRef}
        type="file"
        className="hidden"
        accept="image/*"
        onChange={handleFileChange}
      />
      <button
        onClick={() => cameraInputRef.current?.click()}
        disabled={disabled}
        className={cn(
          "py-3 px-2 rounded-lg flex items-center justify-center gap-1.5 border transition-all",
          "bg-blue-500/10 border-blue-500/30 text-blue-200 hover:bg-blue-500/20 disabled:opacity-50",
          disabled && "animate-pulse"
        )}
      >
        <Camera className="w-5 h-5 shrink-0" />
        <span className="text-[11px] font-bold">伝票を撮影</span>
      </button>
      <button
        onClick={() => libraryInputRef.current?.click()}
        disabled={disabled}
        className={cn(
          "py-3 px-2 rounded-lg flex items-center justify-center gap-1.5 border transition-all",
          "bg-cyan-500/10 border-cyan-500/30 text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-50",
          disabled && "animate-pulse"
        )}
      >
        <ImageIcon className="w-5 h-5 shrink-0" />
        <span className="text-[11px] font-bold">ライブラリ</span>
      </button>
      {pendingImage && (
        <ImageCropModal
          image={pendingImage}
          onClose={() => setPendingImage(null)}
          onConfirm={handleImageReady}
        />
      )}
    </>
  );
}

function ImageCropModal({
  image,
  onClose,
  onConfirm,
}: {
  image: PendingImage;
  onClose: () => void;
  onConfirm: (dataUrl: string, mime: string) => void;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const [crop, setCrop] = useState<CropRect | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);

  const getImagePoint = (clientX: number, clientY: number) => {
    const img = imgRef.current;
    if (!img || !naturalSize.width || !naturalSize.height) return null;
    const rect = img.getBoundingClientRect();
    const x = Math.max(0, Math.min(naturalSize.width, ((clientX - rect.left) / rect.width) * naturalSize.width));
    const y = Math.max(0, Math.min(naturalSize.height, ((clientY - rect.top) / rect.height) * naturalSize.height));
    return { x, y };
  };

  const beginCrop = (event: React.PointerEvent<HTMLDivElement>) => {
    const point = getImagePoint(event.clientX, event.clientY);
    if (!point) return;
    dragStartRef.current = point;
    setCrop({ ...point, width: 1, height: 1 });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const updateCrop = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current;
    if (!start) return;
    const point = getImagePoint(event.clientX, event.clientY);
    if (!point) return;
    setCrop({
      x: Math.min(start.x, point.x),
      y: Math.min(start.y, point.y),
      width: Math.abs(point.x - start.x),
      height: Math.abs(point.y - start.y),
    });
  };

  const endCrop = (event: React.PointerEvent<HTMLDivElement>) => {
    dragStartRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {}
  };

  const cropToDataUrl = (rect: CropRect) => {
    const img = imgRef.current;
    if (!img) return image.dataUrl;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(rect.width));
    canvas.height = Math.max(1, Math.round(rect.height));
    const ctx = canvas.getContext('2d');
    if (!ctx) return image.dataUrl;
    ctx.drawImage(
      img,
      Math.round(rect.x),
      Math.round(rect.y),
      Math.round(rect.width),
      Math.round(rect.height),
      0,
      0,
      canvas.width,
      canvas.height
    );
    return canvas.toDataURL('image/jpeg', 0.92);
  };

  const handleConfirmCrop = () => {
    if (!crop || crop.width < MIN_CROP_SIZE || crop.height < MIN_CROP_SIZE) {
      onConfirm(image.dataUrl, image.mime);
      return;
    }
    onConfirm(cropToDataUrl(crop), 'image/jpeg');
  };

  const cropStyle = crop && naturalSize.width && naturalSize.height
    ? {
        left: `${(crop.x / naturalSize.width) * 100}%`,
        top: `${(crop.y / naturalSize.height) * 100}%`,
        width: `${(crop.width / naturalSize.width) * 100}%`,
        height: `${(crop.height / naturalSize.height) * 100}%`,
      }
    : undefined;
  const canCrop = Boolean(crop && crop.width >= MIN_CROP_SIZE && crop.height >= MIN_CROP_SIZE);

  return (
    <motion.div
      className="fixed inset-0 z-[80] bg-black/80 backdrop-blur-sm flex items-center justify-center p-3"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <motion.div
        className="w-full max-w-3xl max-h-[92vh] bg-card border border-ui rounded-xl shadow-2xl flex flex-col overflow-hidden"
        initial={{ scale: 0.96, y: 18 }}
        animate={{ scale: 1, y: 0 }}
      >
        <div className="p-4 border-b border-ui flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Crop className="w-4 h-4 text-blue-300" />
              読み取り範囲をトリミング
            </h3>
            <p className="text-[11px] text-secondary mt-1">{image.name}</p>
          </div>
          <button onClick={onClose} className="p-2 text-secondary hover:text-white rounded-lg hover:bg-slate-800">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 overflow-y-auto">
          <div
            className="relative mx-auto max-h-[58vh] w-fit select-none touch-none rounded-lg overflow-hidden bg-slate-950 border border-ui"
            onPointerDown={beginCrop}
            onPointerMove={updateCrop}
            onPointerUp={endCrop}
            onPointerCancel={endCrop}
          >
            <img
              ref={imgRef}
              src={image.dataUrl}
              alt="読み取り対象の伝票"
              className="block max-w-full max-h-[58vh] object-contain"
              draggable={false}
              onLoad={(event) => {
                setNaturalSize({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                });
              }}
            />
            {cropStyle && (
              <div
                className="absolute border-2 border-blue-300 bg-blue-400/10 shadow-[0_0_0_9999px_rgba(0,0,0,0.38)] pointer-events-none"
                style={cropStyle}
              />
            )}
          </div>
          <p className="text-[11px] text-slate-400 mt-3 text-center">
            住所・電話番号・訪問時間が写っている範囲をドラッグしてください。未選択なら画像全体を読み取ります。
          </p>
        </div>

        <div className="p-4 border-t border-ui bg-slate-900/80 grid grid-cols-3 gap-2">
          <button
            onClick={() => setCrop(null)}
            disabled={!crop}
            className="py-3 px-3 rounded-lg border border-ui text-secondary text-xs font-bold hover:bg-slate-800 disabled:opacity-40"
          >
            範囲を解除
          </button>
          <button
            onClick={() => onConfirm(image.dataUrl, image.mime)}
            className="py-3 px-3 rounded-lg border border-cyan-500/30 bg-cyan-500/10 text-cyan-200 text-xs font-bold hover:bg-cyan-500/20"
          >
            全体を使う
          </button>
          <button
            onClick={handleConfirmCrop}
            className={cn(
              "py-3 px-3 rounded-lg border text-xs font-bold transition-colors",
              canCrop
                ? "border-blue-500/50 bg-blue-600 text-white hover:bg-blue-500"
                : "border-blue-500/25 bg-blue-600/40 text-blue-100"
            )}
          >
            {canCrop ? "この範囲で読み取り" : "読み取りへ進む"}
          </button>
        </div>
      </motion.div>
    </motion.div>
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

const MAP_MODE_STORAGE_KEY = 'repair_map_mode_v2';

const ADMIN_DISTRICT_MAP_STYLE: google.maps.MapTypeStyle[] = [
  { featureType: 'administrative', elementType: 'geometry.stroke', stylers: [{ color: '#cfd8e3' }, { weight: 1.1 }] },
  { featureType: 'administrative.locality', elementType: 'labels.text.fill', stylers: [{ color: '#a6adb8' }] },
  { featureType: 'administrative.neighborhood', elementType: 'labels.text.fill', stylers: [{ color: '#b4bbc6' }] },
  { featureType: 'landscape', elementType: 'geometry', stylers: [{ color: '#f7f8fa' }] },
  { featureType: 'poi', elementType: 'geometry', stylers: [{ color: '#f4f6f8' }] },
  { featureType: 'poi', elementType: 'labels.text.fill', stylers: [{ color: '#b8bec8' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#ffffff' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#d8dde4' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#d5d8dd' }] },
  { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#c6cbd3' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#a9b0bb' }] },
  { featureType: 'transit', elementType: 'geometry', stylers: [{ color: '#e7eaee' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#dbeafe' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#aab8c8' }] },
];

const MAP_MODE_CONFIG: Record<MapMode, { mapTypeId: string; colorScheme: 'DARK' | 'LIGHT'; label: string; styles?: google.maps.MapTypeStyle[] }> = {
  admin:     { mapTypeId: 'roadmap', colorScheme: 'LIGHT', label: '行政区域', styles: ADMIN_DISTRICT_MAP_STYLE },
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
        styles={modeCfg.styles}
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
