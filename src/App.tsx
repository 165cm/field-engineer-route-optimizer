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
  Utensils
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from './lib/utils';
import { Visit, RoutePlan, Settings, Difficulty, LunchSpotPreference, LunchInfo } from './types';
import { geocodeAddress, getDistanceMatrix, findLunchSpots } from './services/googleMapsService';
import { optimizeRoutes, computeInputOrderBaseline, Baseline } from './lib/optimization';
import { getUserPlan, setUserPlan, getVisitLimit, UserPlan } from './lib/plan';

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
    <APIProvider apiKey={API_KEY} version="weekly" language="ja" libraries={['places']}>
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
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  const [activeTab, setActiveTab] = useState<'input' | 'result'>('input');
  const [activePlanIdx, setActivePlanIdx] = useState(0);
  const [selectedLunchCandidates, setSelectedLunchCandidates] = useState<Record<number, number>>({});
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [showLunchSettings, setShowLunchSettings] = useState(false);
  const [showTasksSettings, setShowTasksSettings] = useState(false);
  const [inputText, setInputText] = useState('');
  const [isParsing, setIsParsing] = useState(false);
  const [isParsingImage, setIsParsingImage] = useState(false);

  const [userPlan, setUserPlanState] = useState<UserPlan>(() => getUserPlan());
  const [upgradeReason, setUpgradeReason] = useState<string | null>(null);
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
      { id: 's1', address: '東京都新宿区西新宿2-8-1', customerName: '田中様', memo: '冷蔵庫の冷えが弱い', workMinutes: 60, difficulty: 2 },
      { id: 's2', address: '東京都渋谷区道玄坂1-12-1', customerName: '佐藤様', memo: '洗濯機 異音', workMinutes: 60, difficulty: 2, timeWindow: { start: '11:00', end: '13:00' } },
      { id: 's3', address: '東京都港区六本木6-10-1', customerName: '鈴木様', memo: 'エアコン設置', workMinutes: 90, difficulty: 3 },
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
      customerName: '',
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

  const handleParseText = async () => {
    if (!inputText.trim()) return;
    setIsParsing(true);
    try {
      const response = await fetch("/api/parse-visits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: inputText }),
      });
      const data = await response.json();
      if (Array.isArray(data)) {
        const newVisits = data.map((v: any) => ({
          id: Math.random().toString(36).substr(2, 9),
          address: v.address,
          customerName: v.customerName,
          memo: v.memo,
          workMinutes: 60,
          difficulty: [1, 2, 3].includes(v.difficulty) ? v.difficulty as Difficulty : 2,
          timeWindow: v.startTime && v.endTime ? { start: v.startTime, end: v.endTime } : undefined
        }));
        const merged = [...visits, ...newVisits];
        if (userPlan === 'free' && merged.length > visitLimit) {
          promptUpgrade(`読み取った${newVisits.length}件のうち${visitLimit - visits.length}件のみ登録しました。Proなら${getVisitLimit('pro')}件まで登録できます。`);
        }
        setVisits(merged.slice(0, visitLimit));
        setInputText('');
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
    setIsParsingImage(true);
    try {
      const response = await fetch("/api/parse-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: base64, mimeType }),
      });
      const data = await response.json();
      if (Array.isArray(data)) {
        const newVisits = data.map((v: any) => ({
          id: Math.random().toString(36).substr(2, 9),
          address: v.address,
          customerName: v.customerName,
          memo: v.memo,
          workMinutes: 60,
          difficulty: [1, 2, 3].includes(v.difficulty) ? v.difficulty as Difficulty : 2,
          timeWindow: v.startTime && v.endTime ? { start: v.startTime, end: v.endTime } : undefined
        }));
        const merged = [...visits, ...newVisits];
        if (userPlan === 'free' && merged.length > visitLimit) {
          promptUpgrade(`画像から${newVisits.length}件読み取りましたが、無料プランは${visitLimit}件まで。Proで${getVisitLimit('pro')}件まで登録できます。`);
        }
        setVisits(merged.slice(0, visitLimit));
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
            if (plan.legs[i].endTime) {
              plan.legs[i].endTime = formatTime(parseTime(plan.legs[i].endTime) + LUNCH_MIN);
            }
            if (i - 1 < plan.order.length) {
              const visit = plan.order[i - 1];
              if (visit?.timeWindow) {
                const start = parseTime(visit.timeWindow.start);
                const end = parseTime(visit.timeWindow.end);
                const arr = parseTime(plan.legs[i].arrivalTime);
                if (arr > end) plan.legs[i].status = 'violation';
                else if (arr > end - 30 || arr < start) plan.legs[i].status = 'warning';
              }
            }
          }
          plan.endTime = formatTime(parseTime(plan.endTime) + LUNCH_MIN);
        }
      }

      setPlans(optimizedPlans);
      setActiveTab('result');
      setActivePlanIdx(0);
    } catch (error) {
      console.error(error);
      const { title, detail } = explainError(error, 'ルート計算に失敗しました');
      showNotice({ kind: 'error', title, detail, onRetry: handleOptimize });
    } finally {
      setIsOptimizing(false);
    }
  };

  return (
    <div className="bg-bg text-gray-200 min-h-screen font-sans border-ui overflow-x-hidden pb-20">
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
           {userPlan === 'pro' ? (
             <button
               onClick={downgradeToFree}
               title="開発用: Freeに戻す"
               className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40"
             >
               Pro
             </button>
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
                  <MapPin className="w-4 h-4 text-blue-500" /> 起点・終点
                </div>
              </div>
              <p className="text-sm font-medium">{settings.homeAddress}</p>
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
                            customerName: task?.name || '', // 互換性のための保存
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

            {/* Paste/Voice Input */}
            <div className="bg-card p-4 rounded-xl border border-ui border-bottom mt-4">
              <div className="flex items-center justify-between mb-3">
                 <h3 className="text-xs font-bold text-secondary flex items-center gap-2 uppercase tracking-tight">
                   <ClipboardList className="w-4 h-4 text-blue-400" /> テキスト・音声で一括入力
                 </h3>
                 <div className="flex gap-1">
                   <ImageInput onImage={handleParseImage} disabled={isParsingImage} />
                   <SpeechInput onText={(t) => setInputText(t)} />
                 </div>
              </div>
              <textarea 
                className="w-full bg-[#1A1D23] border border-ui rounded-lg p-3 text-sm mb-3 resize-none h-24 focus:border-blue-500/50"
                placeholder={isParsingImage ? "AIが画像をスキャンしています..." : "住所を貼り付け、または画像から抽出..."}
                value={isParsingImage ? "Analyzing image..." : inputText}
                disabled={isParsingImage}
                onChange={(e) => setInputText(e.target.value)}
              />
              <button 
                onClick={handleParseText}
                disabled={isParsing || !inputText.trim()}
                className="w-full py-3 bg-slate-800 border border-ui rounded-lg text-xs font-bold uppercase tracking-wider hover:bg-slate-700 disabled:opacity-50 transition-colors"
              >
                {isParsing ? "読み取り中..." : "リストに追加"}
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
            {/* Sidebar (Route List) */}
            <aside className="w-full lg:w-[380px] lg:h-full bg-bg lg:border-r border-ui flex flex-col shrink-0 z-10 lg:shadow-2xl">
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
                    案{plan.id}: {plan.id === 'A' ? '最短' : plan.id === 'B' ? '余裕' : '確実'}
                  </button>
                ))}
              </div>

              {/* Path List */}
              <div className="flex-1 lg:overflow-y-auto p-4 space-y-3 custom-scrollbar lg:min-h-0">
                {plans[activePlanIdx].legs.map((leg, idx) => (
                  <div key={idx} className="relative">
                    {leg.visitId ? (
                      <motion.div 
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: idx * 0.05 }}
                        className={cn(
                          "card-bg p-4 rounded-xl border relative overflow-hidden transition-all",
                          leg.status === 'violation' ? "border-red-500/30" : "border-ui"
                        )}
                      >
                        {/* Status bar */}
                        <div className={cn(
                          "absolute left-0 top-0 w-1 h-full",
                          leg.status === 'ok' ? "bg-green-500" : leg.status === 'warning' ? "bg-yellow-500" : "bg-red-500"
                        )} />

                        <div className="flex justify-between items-start mb-2">
                          <div className="flex items-center gap-2">
                             <div className="px-2 py-0.5 bg-slate-800 rounded text-[10px] font-bold num-font">
                               {idx + 1}番 {leg.arrivalTime}着
                             </div>
                             <div className={cn(
                               "status-dot w-2 h-2 rounded-full",
                               leg.status === 'ok' ? "bg-green-400 shadow-[0_0_8px_#4ade80]" : leg.status === 'warning' ? "bg-yellow-400 shadow-[0_0_8px_#fbbf24]" : "bg-red-400 shadow-[0_0_8px_#f87171]"
                             )} />
                          </div>
                          <div className="flex gap-1">
                            <button onClick={() => window.open(`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(plans[activePlanIdx].order[idx].address)}`, '_blank')} className="p-1 hover:bg-blue-500/10 rounded">
                              <Navigation className="w-3.5 h-3.5 text-blue-400" />
                            </button>
                          </div>
                        </div>

                        <h3 className="text-base font-bold mb-0.5">
                          {plans[activePlanIdx].order[idx].customerName || "依頼者不明"}
                        </h3>
                        <p className="text-[10px] text-secondary mb-3 truncate">
                          {plans[activePlanIdx].order[idx].address}
                        </p>

                        <div className="grid grid-cols-2 gap-2 text-[11px]">
                          <div className="bg-slate-800/50 p-2 rounded border border-ui">
                            <span className="text-secondary block text-[9px] uppercase font-bold mb-0.5">指定時間</span>
                            <span className={cn(
                              "font-bold",
                              leg.status === 'ok' ? "text-green-400" : leg.status === 'warning' ? "text-yellow-400" : "text-red-400"
                            )}>
                              {plans[activePlanIdx].order[idx].timeWindow ? `${plans[activePlanIdx].order[idx].timeWindow?.start}-${plans[activePlanIdx].order[idx].timeWindow?.end}` : "指定なし"}
                            </span>
                          </div>
                          <div className="bg-slate-800/50 p-2 rounded border border-ui">
                            <span className="text-secondary block text-[9px] uppercase font-bold mb-0.5">滞在 / 完了</span>
                            <span className="font-bold">{plans[activePlanIdx].order[idx].workMinutes}分 → {leg.endTime}</span>
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
                ))}
              </div>

              {/* Bottom CTA */}
              <div className="p-4 border-t border-ui glass">
                <button 
                  onClick={() => {
                    const plan = plans[activePlanIdx];
                    let ways = [...plan.order.map(v => v.address)];
                    if (plan.lunchCandidates && plan.lunchCandidates.length > 0) {
                      const selectedIdx = selectedLunchCandidates[activePlanIdx] ?? 0;
                      ways.splice(Math.floor(plan.order.length / 2) + 1, 0, plan.lunchCandidates[selectedIdx].address);
                    }
                    const waypoints = ways.map(w => encodeURIComponent(w)).join('/');
                    const dest = settings.endLocation === 'home' ? settings.homeAddress : (settings.endLocation === 'custom' ? settings.customEndAddress : plan.order[plan.order.length - 1].address);
                    window.open(`https://www.google.com/maps/dir/${encodeURIComponent(settings.homeAddress)}/${waypoints}/${encodeURIComponent(dest || '')}`, '_blank');
                  }}
                  className="w-full py-4 bg-blue-600 hover:bg-blue-500 rounded-xl font-bold text-sm shadow-xl shadow-blue-900/30 flex items-center justify-center gap-3 transition-colors"
                >
                  <Navigation className="w-5 h-5" /> 全ルートをMAPで開く
                </button>
                <button onClick={() => setActiveTab('input')} className="w-full mt-3 py-2 text-[10px] text-secondary hover:text-white transition-colors uppercase font-bold tracking-widest">
                  条件編集に戻る
                </button>
              </div>
            </aside>

            {/* Map Section */}
            <section className="w-full h-[450px] lg:h-full lg:flex-1 relative bg-bg overflow-hidden shrink-0 flex-col">
              {/* Interactive Map */}
              <div className="absolute inset-0 z-0 flex">
                <MapComponent plan={plans[activePlanIdx]} settings={settings} selectedLunchIdx={selectedLunchCandidates[activePlanIdx]} />
              </div>

              {/* Floating Stats */}
              <div className="absolute top-6 left-6 z-10 hidden sm:block">
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

              {/* Map Footer Info */}
              <div className="absolute bottom-0 left-0 right-0 h-16 glass border-t border-ui hidden sm:flex items-center px-6 justify-between z-10">
                <div className="flex gap-8">
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full bg-green-400 shadow-[0_0_8px_#4ade80]"></div>
                    <span className="text-xs font-bold text-gray-300">正常</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full bg-yellow-400 shadow-[0_0_8px_#fbbf24]"></div>
                    <span className="text-xs font-bold text-gray-300">余裕少</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full bg-red-400 shadow-[0_0_8px_#f87171]"></div>
                    <span className="text-xs font-bold text-gray-300">遅延懸念</span>
                  </div>
                </div>
                <div className="flex items-center gap-4 text-xs text-secondary italic">
                   ルート案: {plans[activePlanIdx].label}
                </div>
              </div>
            </section>
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
    </div>
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

function MapComponent({ plan, settings, selectedLunchIdx }: { plan: RoutePlan, settings: Settings, selectedLunchIdx: number | undefined }) {
  const map = useMap();
  const routesLib = useMapsLibrary('routes');
  const polylinesRef = useRef<google.maps.Polyline[]>([]);

  useEffect(() => {
    if (!map || !routesLib || !plan) return;

    // Clear previous
    polylinesRef.current.forEach(p => p.setMap(null));
    polylinesRef.current = [];

    const waypoints = plan.order.map(v => v.coords || v.address).filter(Boolean);
    const origin = settings.homeCoords || settings.homeAddress;
    
    let dest = origin;
    if (settings.endLocation === 'custom' && settings.customEndAddress) {
      dest = settings.customEndCoords || settings.customEndAddress;
    } else if (settings.endLocation === 'none') {
      dest = plan.order[plan.order.length - 1].coords || plan.order[plan.order.length - 1].address;
    }

    const intermediate = waypoints.slice(0, settings.endLocation === 'none' ? -1 : undefined);

    // Using traditional DirectionsService because computeRoutes is a bit more complex for multiple stops without a wrapper
    // Actually, Constitution says NEVER use DirectionsService. I must use Route.computeRoutes.
    // Routes API (New) supports up to 10 intermediate waypoints.
    
    const originCoords = settings.homeCoords;
    if (!originCoords) return;

    let destCoords = originCoords;
    if (settings.endLocation === 'custom' && settings.customEndCoords) {
      destCoords = settings.customEndCoords;
    } else if (settings.endLocation === 'none' && plan.order.length > 0) {
      destCoords = plan.order[plan.order.length - 1].coords || originCoords;
    }

    const intermediateWaypoints = intermediate.map(w => {
      const coords = typeof w === 'string' ? null : w;
      return coords ? { location: coords } : null;
    }).filter(Boolean) as google.maps.routes.Waypoint[];

    routesLib.Route.computeRoutes({
      origin: { location: originCoords },
      destination: { location: destCoords },
      intermediates: intermediateWaypoints,
      travelMode: google.maps.TravelMode.DRIVING,
      fields: ['path', 'viewport']
    }).then(({ routes }) => {
      if (routes?.[0]) {
        const polyLines = routes[0].createPolylines();
        polyLines.forEach(p => p.setMap(map));
        polylinesRef.current = polyLines;
        if (routes[0].viewport) map.fitBounds(routes[0].viewport, 40);
      }
    });

    return () => polylinesRef.current.forEach(p => p.setMap(null));
  }, [map, routesLib, plan, settings]);

  return (
    <div className="w-full h-full">
      <Map
        defaultZoom={12}
        defaultCenter={settings.homeCoords || { lat: 35.6895, lng: 139.6917 }}
        mapId="DEMO_MAP_ID"
        colorScheme="DARK"
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
               <div className="bg-blue-600 text-white w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold border-2 border-white shadow-lg">
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
    </div>
  );
}
