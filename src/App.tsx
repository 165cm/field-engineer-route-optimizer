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
import { Visit, RoutePlan, Settings, Difficulty, LunchSpotPreference, LunchInfo } from './types';
import { geocodeAddress, getDistanceMatrix, findLunchSpots } from './services/googleMapsService';
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
    <APIProvider apiKey={API_KEY} version="weekly" language="ja" libraries={['places', 'routes', 'geometry']}>
      <MainApp />
    </APIProvider>
  );
}

function MainApp() {
  const defaultLunchSpots: LunchSpotPreference[] = [
    { id: 'mcdonalds', name: 'マクドナルド', query: 'マクドナルド', icon: '🍔' },
    { id: 'yoshinoya', name: '吉野家', query: '吉野家', icon: '🍚' },
    { id: 'sukiya', name: 'すき家', query: 'すき家', icon: '🐮' },
    { id: 'matsuya', name: '松屋', query: '松屋', icon: '🍛' },
    { id: 'yudetaro', name: 'ゆで太郎', query: 'ゆで太郎', icon: '🍜' },
    { id: 'seven_eleven', name: 'セブン-イレブン', query: 'セブンイレブン', icon: '🏪' },
    { id: 'family_mart', name: 'ファミリーマート', query: 'ファミリーマート', icon: '🏪' },
    { id: 'lawson', name: 'ローソン', query: 'ローソン', icon: '🏪' },
  ];

  const [settings, setSettings] = useState<Settings>(() => {
    const saved = localStorage.getItem('repair_settings');
    const parsed = saved ? JSON.parse(saved) : {};
    let savedSpots: LunchSpotPreference[] = parsed.savedLunchSpots?.length ? parsed.savedLunchSpots : defaultLunchSpots;

    // Filter out 'none' if it exists in saved
    savedSpots = savedSpots.filter(s => s.id !== 'none');

    // Ensure new convenience stores are added to existing saved spots
    const spotIds = new Set(savedSpots.map(s => s.id));
    if (!spotIds.has('seven_eleven') && !spotIds.has('convenience')) {
      savedSpots.push(...defaultLunchSpots.filter(d => ['seven_eleven', 'family_mart', 'lawson'].includes(d.id)));
    }
    // Remove the old 'convenience' if it exists since we replaced it with specific chains
    savedSpots = savedSpots.filter(s => s.id !== 'convenience');

    return {
      homeAddress: '東京都新宿区新宿1-1-1',
      endLocation: 'home',
      ...parsed,
      startTime: parsed.startTime || '09:00',
      lunchSpotIds: parsed.lunchSpotIds || (parsed.lunchSpotId && parsed.lunchSpotId !== 'none' ? [parsed.lunchSpotId] : []),
      savedLunchSpots: savedSpots,
      tasks: parsed.tasks || [
        { id: '1', name: '点検', defaultMinutes: 30 },
        { id: '2', name: '修理', defaultMinutes: 60 },
        { id: '3', name: '設置', defaultMinutes: 90 },
      ]
    };
  });
  
  const [visits, setVisits] = useState<Visit[]>(() => {
    const saved = localStorage.getItem('repair_visits');
    return saved ? JSON.parse(saved) : [];
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
    const next = calculatePlanForOrder(ctx.visits, ctx.settings, ctx.matrix, orderIndices, 'X');
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
  const [selectedLunchCandidates, setSelectedLunchCandidates] = useState<Record<number, number>>({});
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [showLunchSettings, setShowLunchSettings] = useState(false);
  const [showTasksSettings, setShowTasksSettings] = useState(false);
  const [showStartEndSettings, setShowStartEndSettings] = useState(false);
  const [inputText, setInputText] = useState('');
  const [isParsing, setIsParsing] = useState(false);
  const [isParsingImage, setIsParsingImage] = useState(false);

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
      { id: 's1', address: '東京都新宿区西新宿2-8-1', memo: '冷蔵庫の冷えが弱い', workMinutes: 60, difficulty: 2 },
      { id: 's2', address: '東京都渋谷区道玄坂1-12-1', memo: '洗濯機 異音', workMinutes: 60, difficulty: 2, timeWindow: { start: '11:00', end: '13:00' } },
      { id: 's3', address: '東京都港区六本木6-10-1', memo: 'エアコン設置', workMinutes: 90, difficulty: 3 },
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
      const optimizedPlans = optimizeRoutes(updatedVisits, updatedSettings, matrix);
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

  const applyParsedVisits = (data: any[], sourceLabel: 'text' | 'image') => {
    const newVisits = data.map((v: any) => ({
      id: Math.random().toString(36).substr(2, 9),
      address: v.address,
      // customerName intentionally not copied from AI-parsed data (privacy).
      memo: v.memo,
      workMinutes: 60,
      difficulty: [1, 2, 3].includes(v.difficulty) ? v.difficulty as Difficulty : 2,
      timeWindow: v.startTime && v.endTime ? { start: v.startTime, end: v.endTime } : undefined,
    }));
    const merged = [...visits, ...newVisits];
    if (userPlan === 'free' && merged.length > visitLimit) {
      const overflow = newVisits.length - (visitLimit - visits.length);
      const verb = sourceLabel === 'image' ? '画像から' : '読み取った';
      promptUpgrade(`${verb}${newVisits.length}件のうち${overflow}件が無料枠を超えました。Proなら${getVisitLimit('pro')}件まで登録できます。`);
    }
    setVisits(merged.slice(0, visitLimit));
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
        applyParsedVisits(data, 'text');
        setInputText('');
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
        applyParsedVisits(data, 'image');
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
      const optimizedPlans = optimizeRoutes(updatedVisits, updatedSettings, matrix);
      // Seed the manual ("カスタム") plan with the best automatic order so the
      // user has a sensible starting point to nudge from.
      const customSeed = optimizedPlans[0].order.map(v => v.id);
      const customPlan = calculatePlanForOrder(
        updatedVisits,
        updatedSettings,
        matrix,
        customSeed
          .map(id => updatedVisits.findIndex(v => v.id === id) + 1)
          .filter(i => i > 0),
        'X',
      );
      optimizedPlans.push(customPlan);
      // Persist context for later re-computation when the user reorders.
      optContextRef.current = { visits: updatedVisits, settings: updatedSettings, matrix };
      setCustomOrder(customSeed);
      const baselineResult = computeInputOrderBaseline(updatedVisits, updatedSettings, matrix);
      setBaseline(baselineResult);

      // 4. Fetch Lunch Spots if requested
      // Consolidate Places API calls: search ONCE per category at the average midpoint
      // across all plans, then share results across plans. This cuts Places API costs
      // roughly by the number of plans (3x reduction in best case).
      if (updatedSettings.lunchSpotIds && updatedSettings.lunchSpotIds.length > 0) {
        const activeSpots = updatedSettings.savedLunchSpots.filter(s => updatedSettings.lunchSpotIds?.includes(s.id));

        const computeMidpoint = (plan: RoutePlan): google.maps.LatLngLiteral | null => {
          if (plan.order.length === 0) return null;
          const lunchIdx = Math.floor(plan.order.length / 2);
          const v1 = plan.order[lunchIdx];
          let v2Coords = v1?.coords;
          if (lunchIdx + 1 < plan.order.length) {
            v2Coords = plan.order[lunchIdx + 1].coords;
          } else if (updatedSettings.endLocation === 'home') {
            v2Coords = updatedSettings.homeCoords;
          } else if (updatedSettings.endLocation === 'custom') {
            v2Coords = updatedSettings.customEndCoords;
          }
          if (v1?.coords && v2Coords) {
            return {
              lat: (v1.coords.lat + v2Coords.lat) / 2,
              lng: (v1.coords.lng + v2Coords.lng) / 2,
            };
          }
          if (v1?.coords) return v1.coords;
          return updatedSettings.homeCoords || null;
        };

        // Average all plan midpoints into one shared search point.
        const planMidpoints = optimizedPlans.map(computeMidpoint).filter((m): m is google.maps.LatLngLiteral => !!m);
        const sharedMidpoint: google.maps.LatLngLiteral | null = planMidpoints.length > 0
          ? {
              lat: planMidpoints.reduce((s, p) => s + p.lat, 0) / planMidpoints.length,
              lng: planMidpoints.reduce((s, p) => s + p.lng, 0) / planMidpoints.length,
            }
          : null;

        let sharedCandidates: LunchInfo[] = [];
        if (sharedMidpoint) {
          const limitPerCategory = Math.max(1, Math.ceil(5 / Math.max(1, activeSpots.length)));
          for (const spotPref of activeSpots) {
            if (spotPref.query) {
              const infos = await findLunchSpots(sharedMidpoint, spotPref.query, limitPerCategory, spotPref.icon);
              sharedCandidates.push(...infos);
            }
          }
          sharedCandidates = sharedCandidates.slice(0, 5);
        }

        const parseTime = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
        const formatTime = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
        const LUNCH_MIN = 60;

        for (const plan of optimizedPlans) {
          if (plan.order.length === 0 || sharedCandidates.length === 0) continue;
          plan.lunchCandidates = sharedCandidates;
          plan.totalDurationMin += LUNCH_MIN;

          const lunchIdx = Math.floor(plan.order.length / 2);
          for (let i = lunchIdx + 1; i < plan.legs.length; i++) {
            if (plan.legs[i].arrivalTime) {
              plan.legs[i].arrivalTime = formatTime(parseTime(plan.legs[i].arrivalTime) + LUNCH_MIN);
            }
            if (plan.legs[i].workStartTime) {
              plan.legs[i].workStartTime = formatTime(parseTime(plan.legs[i].workStartTime!) + LUNCH_MIN);
            }
            if (plan.legs[i].workEndTime) {
              plan.legs[i].workEndTime = formatTime(parseTime(plan.legs[i].workEndTime!) + LUNCH_MIN);
            }
            if (plan.legs[i].endTime) {
              plan.legs[i].endTime = formatTime(parseTime(plan.legs[i].endTime) + LUNCH_MIN);
            }
            if (i - 1 < plan.order.length) {
              const visit = plan.order[i - 1];
              if (visit?.timeWindow) {
                const hasStart = !!visit.timeWindow.start;
                const hasEnd = !!visit.timeWindow.end;
                const start = hasStart ? parseTime(visit.timeWindow.start) : null;
                const end = hasEnd ? parseTime(visit.timeWindow.end) : null;
                const arr = parseTime(plan.legs[i].arrivalTime);
                if (end !== null && arr > end) plan.legs[i].status = 'violation';
                else if (
                  (end !== null && arr > end - 30) ||
                  (start !== null && arr < start)
                ) plan.legs[i].status = 'warning';
              }
            }
          }
          plan.endTime = formatTime(parseTime(plan.endTime) + LUNCH_MIN);
        }
      }

      setPlans(optimizedPlans);
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
        {activeTab === 'input' ? (
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
              {visits.map((visit, idx) => (
                <div key={visit.id} className="bg-card p-4 rounded-xl border border-ui relative group transition-all hover:border-blue-500/30">
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
                  
                  <textarea 
                    className="w-full bg-[#1A1D23] border border-ui rounded-lg p-3 text-xs mb-3 resize-none focus:border-blue-500/50 transition-colors"
                    placeholder="住所を入力..."
                    rows={2}
                    value={visit.address}
                    onChange={(e) => handleUpdateVisit(visit.id, { address: e.target.value })}
                  />

                  <div className="flex flex-col gap-3 mt-3">
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
              ))}

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

            {/* Lunch Settings */}
            <div className="bg-card p-4 rounded-xl border border-ui mt-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Utensils className="w-4 h-4 text-orange-400" />
                  <h3 className="text-xs font-bold text-secondary uppercase tracking-tight">
                    ランチ・休憩 (訪問後半で立ち寄り)
                  </h3>
                </div>
                <button 
                  onClick={() => setShowLunchSettings(true)}
                  className="text-[10px] bg-slate-800 text-blue-400 hover:text-blue-300 font-bold px-2 py-1 rounded border border-ui"
                >
                  お気に入り編集
                </button>
              </div>
              <div className="flex flex-wrap gap-2 pt-1 pb-1">
                {settings.savedLunchSpots.map(spot => {
                  const isSelected = settings.lunchSpotIds?.includes(spot.id);
                  return (
                    <button
                      key={spot.id}
                      onClick={() => {
                        const current = settings.lunchSpotIds || [];
                        const next = isSelected 
                          ? current.filter(id => id !== spot.id)
                          : [...current, spot.id];
                        setSettings({ ...settings, lunchSpotIds: next });
                      }}
                      className={cn(
                        "flex items-center gap-1.5 px-3 py-1.5 rounded-full border transition-all text-xs font-bold",
                        isSelected 
                          ? "bg-orange-500/20 border-orange-500/50 text-orange-300" 
                          : "bg-slate-800/50 border-ui text-secondary hover:bg-slate-800 hover:text-white"
                      )}
                    >
                      <span className="text-sm drop-shadow-sm">{spot.icon}</span>
                      <span className="truncate">{spot.name}</span>
                    </button>
                  );
                })}
              </div>
              {settings.lunchSpotIds && settings.lunchSpotIds.length > 0 && (
                <p className="text-[9px] text-slate-500 mt-2 font-medium">※ルート後半の移動ルート上で、指定した店舗を提案します。</p>
              )}
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
              {baseline && plans[activePlanIdx] && (() => {
                const FUEL_KM_PER_L = 12;
                const GAS_YEN_PER_L = 180;
                const planDist = plans[activePlanIdx].totalDistanceKm;
                const planDur = plans[activePlanIdx].totalDurationMin;
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

              {/* Plan Tabs */}
              <div className="p-4 flex gap-2 border-b border-ui bg-bg/50 backdrop-blur-sm">
                {plans.map((plan, idx) => (
                  <button 
                    key={plan.id}
                    onClick={() => setActivePlanIdx(idx)}
                    className={cn(
                      "flex-1 py-2 text-center text-[10px] font-bold rounded-md transition-all border",
                      activePlanIdx === idx ? "bg-blue-600 border-blue-500 text-white shadow-lg shadow-blue-900/40" : "bg-slate-800 border-ui text-secondary hover:bg-slate-700"
                    )}
                  >
                    {plan.label}
                  </button>
                ))}
              </div>

              {/* Schedule Clock */}
              <div className="px-4 pt-4 pb-3 border-b border-ui">
                <ScheduleClock plan={plans[activePlanIdx]} tasks={settings.tasks} />
              </div>

              {/* Mobile-only: map directly under the schedule clock.
                  On desktop the map lives in its own right-side section below. */}
              {!isDesktop && (
                <>
                  <div className="h-[360px] relative border-b border-ui bg-bg">
                    <MapComponent plan={plans[activePlanIdx]} settings={settings} selectedLunchIdx={selectedLunchCandidates[activePlanIdx]} />
                  </div>
                  <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-ui text-[10px]">
                    <div className="flex items-center gap-3">
                      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-400 shadow-[0_0_6px_#4ade80]" /><span className="font-bold text-gray-300">正常</span></span>
                      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-yellow-400 shadow-[0_0_6px_#fbbf24]" /><span className="font-bold text-gray-300">余裕少</span></span>
                      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-400 shadow-[0_0_6px_#f87171]" /><span className="font-bold text-gray-300">遅延懸念</span></span>
                    </div>
                    <span className="text-secondary italic">案: {plans[activePlanIdx].label}</span>
                  </div>
                </>
              )}

              {/* Path List */}
              <div className="p-4 space-y-3 custom-scrollbar">
                {plans[activePlanIdx].legs.map((leg, idx) => {
                  const visit = leg.visitId ? plans[activePlanIdx].order[idx] : null;
                  const isCompleted = visit ? completedVisitIds.has(visit.id) : false;
                  return (
                  <div key={idx} className="relative">
                    {leg.visitId && visit ? (
                      <motion.div
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: idx * 0.05 }}
                        className={cn(
                          "card-bg p-4 rounded-xl border relative overflow-hidden transition-all",
                          isCompleted ? "border-green-500/40 opacity-60" :
                          leg.status === 'violation' ? "border-red-500/30" : "border-ui"
                        )}
                      >
                        {/* Difficulty stripe — same color as the matching
                            clock arc and map marker for fast cross-reference. */}
                        <div
                          className="absolute left-0 top-0 w-1 h-full"
                          style={{ background: difficultyColor(visit.difficulty).work }}
                        />

                        <div className="flex justify-between items-start mb-2">
                          <div className="flex items-center gap-2">
                             <div
                               className="px-2 py-0.5 rounded text-[10px] font-bold num-font text-white"
                               style={{ background: difficultyColor(visit.difficulty).work }}
                             >
                               {idx + 1}番 {leg.arrivalTime}着
                             </div>
                             <div className={cn(
                               "status-dot w-2 h-2 rounded-full",
                               leg.status === 'ok' ? "bg-green-400 shadow-[0_0_8px_#4ade80]" : leg.status === 'warning' ? "bg-yellow-400 shadow-[0_0_8px_#fbbf24]" : "bg-red-400 shadow-[0_0_8px_#f87171]"
                             )} />
                          </div>
                          <div className="flex gap-1">
                            {plans[activePlanIdx].id === 'X' && (
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
                            <button
                              onClick={() => toggleCompleted(visit.id)}
                              title={isCompleted ? '完了を取り消す' : '完了にする'}
                              className={cn(
                                "p-1.5 rounded transition-colors",
                                isCompleted ? "bg-green-500/30 text-green-200" : "hover:bg-green-500/10 text-green-400"
                              )}
                            >
                              <CheckCircle2 className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => window.open(`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(visit.address)}`, '_blank')}
                              title="この訪問先にナビ"
                              className="p-1.5 hover:bg-blue-500/10 rounded"
                            >
                              <Navigation className="w-4 h-4 text-blue-400" />
                            </button>
                          </div>
                        </div>

                        <h3 className={cn("text-base font-bold mb-0.5 truncate", isCompleted && "line-through text-secondary")}>
                          {(() => {
                            const task = settings.tasks.find(t => t.id === visit.taskId);
                            if (task) return task.name;
                            return visit.memo?.slice(0, 30) || '訪問先';
                          })()}
                        </h3>
                        <p className={cn("text-[10px] mb-3 truncate", isCompleted ? "text-secondary line-through" : "text-secondary")}>
                          {visit.address}
                        </p>

                        <div className="grid grid-cols-2 gap-2 text-[11px]">
                          <div className="bg-slate-800/50 p-2 rounded border border-ui">
                            <span className="text-secondary block text-[9px] uppercase font-bold mb-0.5">指定時間</span>
                            <span className={cn(
                              "font-bold",
                              leg.status === 'ok' ? "text-green-400" : leg.status === 'warning' ? "text-yellow-400" : "text-red-400"
                            )}>
                              {(() => {
                                const tw = plans[activePlanIdx].order[idx].timeWindow;
                                if (!tw) return "指定なし";
                                if (tw.start && tw.end) return `${tw.start}-${tw.end}`;
                                if (tw.start) return `${tw.start} 以降`;
                                if (tw.end) return `${tw.end} 以前`;
                                return "指定なし";
                              })()}
                            </span>
                          </div>
                          <div className="bg-slate-800/50 p-2 rounded border border-ui">
                            <span className="text-secondary block text-[9px] uppercase font-bold mb-0.5">滞在 / 完了</span>
                            <span className="font-bold">{plans[activePlanIdx].order[idx].workMinutes + 30}分 → {leg.endTime}</span>
                            <span className="block text-[9px] text-secondary font-medium mt-0.5">準備15+作業{plans[activePlanIdx].order[idx].workMinutes}+撤収15</span>
                          </div>
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

                    {/* Lunch Injection */}
                    {plans[activePlanIdx].lunchCandidates && plans[activePlanIdx].lunchCandidates!.length > 0 && idx === Math.floor(plans[activePlanIdx].order.length / 2) && leg.visitId && (
                       <div className="relative mt-3">
                         <div className="h-4 flex items-center justify-center absolute -top-4 left-0 right-0">
                           <div className="w-px h-full bg-slate-800" />
                         </div>
                         <motion.div 
                           initial={{ opacity: 0, y: 10 }}
                           animate={{ opacity: 1, y: 0 }}
                           className="bg-orange-500/10 p-4 rounded-xl border border-orange-500/30"
                         >
                            <div className="flex items-center gap-2 mb-3 text-orange-400">
                               <Utensils className="w-3.5 h-3.5" />
                               <span className="text-[10px] font-bold uppercase tracking-widest">昼食休憩の提案 (約60分) - {plans[activePlanIdx].lunchCandidates!.length}候補</span>
                            </div>
                            <div className="flex flex-col gap-2">
                              {plans[activePlanIdx].lunchCandidates!.map((candidate, i) => {
                                const isSelected = selectedLunchCandidates[activePlanIdx] === i;
                                const hasSelection = selectedLunchCandidates[activePlanIdx] !== undefined;

                                return (
                                  <div 
                                    key={i} 
                                    onClick={() => setSelectedLunchCandidates(prev => ({ ...prev, [activePlanIdx]: isSelected ? undefined : i }))}
                                    className={cn(
                                      "flex justify-between items-center p-2 rounded-lg border relative cursor-pointer outline-none transition-all",
                                      isSelected 
                                        ? "bg-orange-900/40 border-orange-500 shadow-md shadow-orange-900/30 ring-2 ring-orange-500/50" 
                                        : hasSelection 
                                          ? "bg-slate-800/30 border-slate-700/50 opacity-50 grayscale hover:opacity-80" 
                                          : "bg-orange-900/20 border-orange-500/20 hover:bg-orange-900/30"
                                    )}
                                  >
                                    <div className="flex-1 min-w-0 pr-3">
                                      <h3 className="text-sm font-bold text-orange-100 flex items-center gap-2 flex-wrap">
                                        <span className="text-base shrink-0">{candidate.icon || '🍔'}</span>
                                        <span className="truncate">{candidate.name}</span>
                                        {candidate.rating && (
                                          <span className="text-[10px] text-yellow-500 font-bold flex items-center gap-0.5 shrink-0">
                                            ★ {candidate.rating}
                                          </span>
                                        )}
                                      </h3>
                                      <p className="text-[10px] text-orange-200/60 mt-0.5 truncate">{candidate.address}</p>
                                    </div>
                                    <button 
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(candidate.name + ' ' + candidate.address)}`, '_blank');
                                      }}
                                      className="p-2 bg-orange-500/20 hover:bg-orange-500/30 rounded-lg transition-colors text-orange-300 shrink-0 relative z-10"
                                    >
                                      <MapPin className="w-4 h-4" />
                                    </button>
                                  </div>
                                );
                              })}
                            </div>
                         </motion.div>
                       </div>
                    )}
                  </div>
                  );
                })}
              </div>

              {/* Bottom CTA */}
              <div className="p-4 border-t border-ui glass space-y-3">
                {plans[activePlanIdx].order.length > 0 && (() => {
                  const total = plans[activePlanIdx].order.length;
                  const done = plans[activePlanIdx].order.filter(v => completedVisitIds.has(v.id)).length;
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
                    const plan = plans[activePlanIdx];
                    // Skip already-completed visits in the external map handoff
                    const remaining = plan.order.filter(v => !completedVisitIds.has(v.id));
                    if (remaining.length === 0) {
                      showNotice({ kind: 'success', title: '本日の訪問はすべて完了しました', detail: 'お疲れさまでした！' });
                      return;
                    }
                    let ways = [...remaining.map(v => v.address)];
                    if (plan.lunchCandidates && plan.lunchCandidates.length > 0) {
                      const selectedIdx = selectedLunchCandidates[activePlanIdx] ?? 0;
                      ways.splice(Math.floor(remaining.length / 2) + 1, 0, plan.lunchCandidates[selectedIdx].address);
                    }
                    const waypoints = ways.map(w => encodeURIComponent(w)).join('/');
                    const dest = settings.endLocation === 'home' ? settings.homeAddress : (settings.endLocation === 'custom' ? settings.customEndAddress : remaining[remaining.length - 1].address);
                    window.open(`https://www.google.com/maps/dir/${encodeURIComponent(settings.homeAddress)}/${waypoints}/${encodeURIComponent(dest || '')}`, '_blank');
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
                  <MapComponent plan={plans[activePlanIdx]} settings={settings} selectedLunchIdx={selectedLunchCandidates[activePlanIdx]} />
                </div>

                {/* Floating totals on the map */}
                <div className="absolute top-6 left-6 z-10">
                  <div className="glass p-4 rounded-2xl border border-ui shadow-2xl flex gap-8">
                    <div className="flex flex-col">
                      <span className="text-[10px] uppercase tracking-wider text-secondary font-bold mb-1">総移動時間</span>
                      <span className="text-2xl num-font">{plans[activePlanIdx].totalDurationMin}<span className="text-xs font-normal text-secondary ml-1">min</span></span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[10px] uppercase tracking-wider text-secondary font-bold mb-1">総移動距離</span>
                      <span className="text-2xl num-font">{plans[activePlanIdx].totalDistanceKm.toFixed(1)}<span className="text-xs font-normal text-secondary ml-1">km</span></span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[10px] uppercase tracking-wider text-secondary font-bold mb-1">最終完了予定</span>
                      <span className="text-2xl num-font text-blue-400">{plans[activePlanIdx].endTime}</span>
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
                  <div className="text-xs text-secondary italic">案: {plans[activePlanIdx].label}</div>
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

      {/* Lunch Spots Edit Modal */}
      <AnimatePresence>
        {showLunchSettings && (
          <LunchSpotsModal 
            settings={settings}
            onSave={(val) => {
              setSettings(val);
              setShowLunchSettings(false);
            }}
            onClose={() => setShowLunchSettings(false)}
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

function LunchSpotsModal({ settings, onSave, onClose }: { settings: Settings, onSave: (s: Settings) => void, onClose: () => void }) {
  const [spots, setSpots] = useState(settings.savedLunchSpots || []);
  const [newName, setNewName] = useState('');
  const [newIcon, setNewIcon] = useState('🍔');
  const [newQuery, setNewQuery] = useState('');

  const handleAdd = () => {
    if (!newName) return;
    const q = newQuery || newName;
    setSpots([...spots, { id: Date.now().toString(), name: newName, query: q, icon: newIcon }]);
    setNewName('');
    setNewQuery('');
  };

  const handleRemove = (id: string) => {
    if (id === 'none') return;
    setSpots(spots.filter(s => s.id !== id));
  };

  const handleSave = () => {
    let newSpotIds = settings.lunchSpotIds || [];
    newSpotIds = newSpotIds.filter(id => spots.find(s => s.id === id));
    onSave({ ...settings, savedLunchSpots: spots, lunchSpotIds: newSpotIds });
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
          <h2 className="text-sm font-bold text-white flex items-center gap-2"><Utensils className="w-4 h-4"/>お気に入りランチの編集</h2>
          <button onClick={onClose} className="p-1 text-secondary hover:text-white"><XCircle className="w-5 h-5"/></button>
        </div>
        
        <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
           {spots.map(spot => (
             <div key={spot.id} className="flex justify-between items-center bg-slate-800/50 p-3 rounded-xl border border-ui">
                <div className="flex items-center gap-3">
                  <span className="text-2xl drop-shadow-md">{spot.icon}</span>
                  <div>
                    <h4 className="text-sm font-bold text-white">{spot.name}</h4>
                    {spot.id !== 'none' && <p className="text-[10px] text-secondary mt-0.5">検索: {spot.query}</p>}
                  </div>
                </div>
                {spot.id !== 'none' && (
                  <button onClick={() => handleRemove(spot.id)} className="p-2 text-red-400 hover:text-red-300 bg-red-400/10 hover:bg-red-400/20 rounded-lg transition-colors">
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
             </div>
           ))}

           <div className="mt-6 border-t border-ui pt-4">
             <h4 className="text-xs font-bold text-secondary uppercase tracking-widest mb-3">新規追加</h4>
             <div className="flex gap-2 mb-2">
               <input 
                 className="w-16 bg-[#1A1D23] border border-ui rounded-lg px-2 py-2 text-center text-xl focus:border-blue-500/50 outline-none"
                 value={newIcon}
                 onChange={(e) => setNewIcon(e.target.value)}
                 placeholder="🍔"
                 maxLength={2}
               />
               <input 
                 className="flex-1 bg-[#1A1D23] border border-ui rounded-lg px-3 py-2 text-sm focus:border-blue-500/50 outline-none placeholder:text-slate-600 font-bold"
                 value={newName}
                 onChange={(e) => setNewName(e.target.value)}
                 placeholder="お店の名前 (例: ラーメン二郎)"
               />
             </div>
             <div className="flex gap-2">
               <input 
                 className="flex-1 bg-[#1A1D23] border border-ui rounded-lg px-3 py-2 text-xs focus:border-blue-500/50 outline-none placeholder:text-slate-600"
                 value={newQuery}
                 onChange={(e) => setNewQuery(e.target.value)}
                 placeholder="検索用キーワード (任意: デフォルトは '店名')"
               />
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

  const handleSave = () => {
    const next: Settings = {
      ...settings,
      homeAddress: homeAddress.trim() || settings.homeAddress,
      startTime,
      endLocation,
      customEndAddress: endLocation === 'custom' ? customEndAddress.trim() : settings.customEndAddress,
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
              className="w-full bg-[#1A1D23] border border-ui rounded-lg px-3 py-2 text-sm focus:border-blue-500/50 outline-none font-medium"
              value={homeAddress}
              onChange={(e) => setHomeAddress(e.target.value)}
              placeholder="例: 東京都新宿区新宿1-1-1"
            />
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
              <input
                className="mt-2 w-full bg-[#1A1D23] border border-ui rounded-lg px-3 py-2 text-sm focus:border-blue-500/50 outline-none font-medium"
                value={customEndAddress}
                onChange={(e) => setCustomEndAddress(e.target.value)}
                placeholder="終点の住所"
              />
            )}
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

function MapComponent({ plan, settings, selectedLunchIdx }: { plan: RoutePlan, settings: Settings, selectedLunchIdx: number | undefined }) {
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

  // Fit all pins (home, visits, custom end, lunch candidates) with ~1.3x margin.
  useEffect(() => {
    if (!map) return;
    const points: google.maps.LatLngLiteral[] = [];
    if (settings.homeCoords) points.push(settings.homeCoords);
    if (settings.endLocation === 'custom' && settings.customEndCoords) {
      points.push(settings.customEndCoords);
    }
    plan.order.forEach(v => { if (v.coords) points.push(v.coords); });
    plan.lunchCandidates?.forEach(s => { if (s.location) points.push(s.location); });
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
        {plan.lunchCandidates?.map((spot, i) => {
          if (!spot.location) return null;
          const isSelected = selectedLunchIdx === undefined || selectedLunchIdx === i;
          return (
            <AdvancedMarker key={`lunch-${i}`} position={spot.location}>
               <div className={cn("w-8 h-8 rounded-full border-2 border-white flex justify-center items-center text-sm z-50 transition-all", 
                 isSelected ? "bg-orange-500 shadow-[0_0_15px_rgba(249,115,22,0.8)] opacity-100" : "bg-slate-500 shadow-none opacity-40 grayscale"
               )}>
                 {spot.icon || '🍔'}
               </div>
            </AdvancedMarker>
          );
        })}
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
