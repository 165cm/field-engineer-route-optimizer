// Demo-mode AI gate: a soft password barrier plus a daily request counter.
//
// IMPORTANT: this is NOT real security. Both the password literal and the
// Gemini API key live in the static client bundle and can be extracted by
// anyone with DevTools. The intent is to:
//   - keep casual visitors from burning through the demo quota
//   - rate-limit per browser to 10 requests per calendar day
//
// Real protection lives in the GCP/AI Studio side: separate Gemini API key
// with a daily quota cap and a billing budget alert.

const PASSWORD = (process.env.VITE_DEMO_AI_PASSWORD || '').trim();
const DAILY_LIMIT = 10;
const STORAGE_KEY = 'demo_ai_v1';
const UNLOCK_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

type State = {
  unlockedAt: number | null;
  date: string;       // YYYY-MM-DD in local time, used to roll the counter
  count: number;
};

function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function readState(): State {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as State;
      // Auto-reset the counter when the calendar day changes.
      if (parsed.date !== todayStr()) {
        return { unlockedAt: parsed.unlockedAt, date: todayStr(), count: 0 };
      }
      return parsed;
    }
  } catch {
    // fall through
  }
  return { unlockedAt: null, date: todayStr(), count: 0 };
}

function writeState(s: State): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // ignore quota / unavailable
  }
}

export function isAIUnlocked(): boolean {
  const s = readState();
  if (!s.unlockedAt) return false;
  if (Date.now() - s.unlockedAt > UNLOCK_TTL_MS) return false;
  return true;
}

export function tryUnlockAI(pw: string): boolean {
  if (!PASSWORD) return false;
  if (pw !== PASSWORD) return false;
  const s = readState();
  writeState({ ...s, unlockedAt: Date.now() });
  return true;
}

export function lockAI(): void {
  const s = readState();
  writeState({ ...s, unlockedAt: null });
}

export function getDailyLimit(): number {
  return DAILY_LIMIT;
}

export function getDailyUsage(): { used: number; remaining: number; limit: number } {
  const s = readState();
  const used = Math.min(DAILY_LIMIT, s.count);
  return { used, remaining: Math.max(0, DAILY_LIMIT - used), limit: DAILY_LIMIT };
}

/** Increment the counter. Returns false if the daily limit would be exceeded. */
export function consumeAIRequest(): boolean {
  const s = readState();
  if (s.count >= DAILY_LIMIT) return false;
  writeState({ ...s, count: s.count + 1 });
  return true;
}
