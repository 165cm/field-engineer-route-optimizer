// Difficulty-based color palette for visit work segments. The chart only ever
// shows three work-arc hues (one per difficulty level), so adjacent visits
// don't drown the user in a 7-colour rainbow.
//
// Hues intentionally sit on the cyan→violet→pink "heat" axis, off the
// chart's semantic colors (blue=travel, orange=lunch, yellow=warning,
// red=violation, green=OK), so a difficulty color can never be confused
// with a status indicator.

import type { Difficulty } from '../types';

export type VisitColor = {
  work: string;   // Hex for work arc / map marker / number badge / card stripe
  prep: string;   // Hex for prep & cleanup arc — same hue, lighter shade
};

const DIFFICULTY_COLORS: Record<Difficulty, VisitColor> = {
  1: { work: '#22d3ee', prep: '#67e8f9' }, // 簡単 — cyan
  2: { work: '#a78bfa', prep: '#c4b5fd' }, // 普通 — violet
  3: { work: '#f472b6', prep: '#f9a8d4' }, // 難しい — pink
};

export function difficultyColor(difficulty: Difficulty | undefined): VisitColor {
  return DIFFICULTY_COLORS[difficulty ?? 2] || DIFFICULTY_COLORS[2];
}

export const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  1: '簡単',
  2: '普通',
  3: '難しい',
};
