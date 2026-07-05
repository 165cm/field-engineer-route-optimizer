import { TaskType } from '../types';

export const REPAIR_SYMPTOM_TASKS: TaskType[] = [
  { id: 'sym-aircon-temp-humidity-sensor', name: 'エアコン: 温湿度センサー不良', defaultMinutes: 60, applianceCategory: 'エアコン', majorCategory: '発生', source: 'symptom-master' },
  { id: 'sym-aircon-flap-not-moving', name: 'エアコン: フラップが動かない', defaultMinutes: 120, applianceCategory: 'エアコン', majorCategory: '内機・部品交換', source: 'symptom-master' },
  { id: 'sym-aircon-flap-damage', name: 'エアコン: フラップ破損', defaultMinutes: 20, applianceCategory: 'エアコン', majorCategory: '破損・変形', source: 'symptom-master' },
  { id: 'sym-aircon-nozzle-crack', name: 'エアコン: ノズル割れ', defaultMinutes: 120, applianceCategory: 'エアコン', majorCategory: '水漏れ', source: 'symptom-master' },
  { id: 'sym-aircon-pipe-clogged', name: 'エアコン: パイプ詰まり', defaultMinutes: 40, applianceCategory: 'エアコン', majorCategory: '水漏れ', source: 'symptom-master' },
  { id: 'sym-aircon-inspection-estimate', name: 'エアコン: 点検・見積りのみ', defaultMinutes: 20, applianceCategory: 'エアコン', majorCategory: '点検/診断', source: 'symptom-master' },
  { id: 'sym-aircon-board-sensor', name: 'エアコン: 基板・センサー不良', defaultMinutes: 60, applianceCategory: 'エアコン', majorCategory: '電装系不良', source: 'symptom-master' },
  { id: 'sym-aircon-gas-leak', name: 'エアコン: ガス漏れ・冷媒不足', defaultMinutes: 60, applianceCategory: 'エアコン', majorCategory: '冷媒系', source: 'symptom-master' },
  { id: 'sym-aircon-filter-damage', name: 'エアコン: フィルター破損', defaultMinutes: 20, applianceCategory: 'エアコン', majorCategory: '破損・変形', source: 'symptom-master' },
  { id: 'sym-fridge-inspection-estimate', name: '冷蔵庫: 点検・見積りのみ', defaultMinutes: 20, applianceCategory: '冷蔵庫', majorCategory: '点検/診断', source: 'symptom-master' },
  { id: 'sym-fridge-door-not-closing', name: '冷蔵庫: ドア閉まらず', defaultMinutes: 40, applianceCategory: '冷蔵庫', majorCategory: '破損・変形', source: 'symptom-master' },
  { id: 'sym-fridge-heater-plate', name: '冷蔵庫: ヒーター板交換（扉開閉不良）', defaultMinutes: 20, applianceCategory: '冷蔵庫', majorCategory: 'パッキン交換', source: 'symptom-master' },
  { id: 'sym-fridge-packing-replace', name: '冷蔵庫: パッキンー交換', defaultMinutes: 20, applianceCategory: '冷蔵庫', majorCategory: 'パッキン交換', source: 'symptom-master' },
  { id: 'sym-fridge-parts-ended', name: '冷蔵庫: 部品供給終了', defaultMinutes: 20, applianceCategory: '冷蔵庫', majorCategory: '修理不可', source: 'symptom-master' },
];

export function ensureDefaultRepairTasks(tasks: TaskType[] | undefined): TaskType[] {
  const existing = Array.isArray(tasks) ? tasks : [];
  const ids = new Set(existing.map(task => task.id));
  return [
    ...existing.map(task => ({
      ...task,
      source: task.source || (task.id === '1' || task.id === '2' || task.id === '3' ? 'legacy' : 'manual'),
    })),
    ...REPAIR_SYMPTOM_TASKS.filter(task => !ids.has(task.id)),
  ];
}

export function inferApplianceCategoryFromModel(modelNumber?: string | null): string | undefined {
  const normalized = modelNumber?.trim().toUpperCase();
  if (!normalized) return undefined;
  if (normalized.startsWith('MSZ')) return 'エアコン';
  if (normalized.startsWith('MR')) return '冷蔵庫';
  return undefined;
}

function normalizeForMatch(value?: string | null): string {
  return (value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[・:：()（）／/ー\-_\s]/g, '');
}

function keywordScore(query: string, target: string): number {
  if (!query || !target) return 0;
  if (target.includes(query) || query.includes(target)) return 8;
  const chunks = query.match(/[ぁ-んァ-ヶ一-龠a-z0-9]{2,}/g) || [];
  let score = 0;
  chunks.forEach(chunk => {
    if (target.includes(chunk)) score += 2;
  });
  return score;
}

export function selectRepairTask(
  tasks: TaskType[],
  input: { modelNumber?: string | null; applianceCategory?: string | null; symptomName?: string | null }
): TaskType | undefined {
  const category = input.applianceCategory || inferApplianceCategoryFromModel(input.modelNumber);
  const symptom = normalizeForMatch(input.symptomName);
  if (!category || !symptom) return undefined;

  const candidates = tasks.filter(task => task.applianceCategory === category);
  let best: { task: TaskType; score: number } | undefined;

  candidates.forEach(task => {
    const taskSymptom = normalizeForMatch(task.name.replace(`${category}:`, ''));
    const majorCategory = normalizeForMatch(task.majorCategory);
    const score = keywordScore(symptom, taskSymptom) + keywordScore(symptom, majorCategory);
    if (!best || score > best.score) best = { task, score };
  });

  return best && best.score >= 4 ? best.task : undefined;
}
