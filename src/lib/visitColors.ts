// Difficulty-based color palette for visit work segments. Mirrors the
// 低/中/高 buttons on the input screen (DifficultySelector) so a "high
// difficulty" job looks the same colour everywhere — input pill, clock
// arc, leg-card stripe, leg-card badge, and map pin.
//
// The 緑/黄/赤 palette overlaps with the status indicator colors (OK /
// warning / violation), which is intentional: a "hard" visit and a
// "late-running" visit both warrant a red signal. The status indicator
// is a separate small dot rendered at distinct positions (card header,
// arc outer edge), so context still disambiguates the two.

import type { Difficulty } from '../types';

export type VisitColor = {
  work: string;   // Hex for work arc / map marker / number badge / card stripe
  prep: string;   // Hex for prep & cleanup arc — same hue, lighter shade
};

const DIFFICULTY_COLORS: Record<Difficulty, VisitColor> = {
  1: { work: '#22c55e', prep: '#86efac' }, // 低 — green-500 / green-300
  2: { work: '#eab308', prep: '#fde047' }, // 中 — yellow-500 / yellow-300
  3: { work: '#ef4444', prep: '#fca5a5' }, // 高 — red-500 / red-300
};

export function difficultyColor(difficulty: Difficulty | undefined): VisitColor {
  return DIFFICULTY_COLORS[difficulty ?? 2] || DIFFICULTY_COLORS[2];
}

export const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  1: '低',
  2: '中',
  3: '高',
};
