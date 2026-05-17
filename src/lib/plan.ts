export type UserPlan = 'free' | 'pro';

export const PLAN_LIMITS: Record<UserPlan, { maxVisits: number; allowsGpsStart: boolean }> = {
  free: { maxVisits: 3, allowsGpsStart: false },
  pro: { maxVisits: 15, allowsGpsStart: true },
};

const STORAGE_KEY = 'user_plan_v1';

export function getUserPlan(): UserPlan {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === 'pro' ? 'pro' : 'free';
  } catch {
    return 'free';
  }
}

export function setUserPlan(plan: UserPlan): void {
  try {
    localStorage.setItem(STORAGE_KEY, plan);
  } catch {
    // ignore
  }
}

export function getVisitLimit(plan: UserPlan): number {
  return PLAN_LIMITS[plan].maxVisits;
}
