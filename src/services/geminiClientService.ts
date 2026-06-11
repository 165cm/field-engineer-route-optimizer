// Client-side Gemini calls used by the GitHub Pages demo. The API key is
// baked into the bundle at build time via vite's define(). This is only
// safe when paired with:
//   - tight per-day quota on the Gemini API key (GCP / AI Studio side)
//   - a billing budget alert
//   - the password gate in demoAI.ts (soft barrier)
//
// In a normal (server-backed) build the App routes through /api/parse-*
// instead — this module is never imported there.

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const MODEL = 'gemini-2.5-flash';

type ParsedVisit = {
  address: string;
  phoneNumber?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  difficulty?: number;
};

// Keep parsing focused on route/time planning. Work details and personal
// identifiers are managed outside this app and should not be returned here.
const RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      address: { type: 'STRING' },
      phoneNumber: { type: 'STRING', nullable: true },
      startTime: { type: 'STRING', nullable: true },
      endTime: { type: 'STRING', nullable: true },
      difficulty: { type: 'INTEGER' },
    },
    required: ['address', 'difficulty'],
  },
};

const TEXT_PROMPT = (text: string) => `以下のテキストから、家電修理の訪問先情報を抽出してJSON形式で返してください。
1行に1件とは限りません。ルートと時間管理に必要な住所、時間指定（あれば）、難易度だけを読み取ってください。
個人名（顧客名）や作業メモ・用件は抽出しないでください。
最大5件まで。

テキスト:
${text}

出力は以下の配列形式にしてください。
[
  {
    "address": "住所",
    "startTime": "HH:mm (例: 09:00, 不明ならnull)",
    "endTime": "HH:mm (例: 12:00, 不明ならnull)",
    "difficulty": 1 | 2 | 3 (1:簡単, 2:普通, 3:難しい。文脈から推測して。デフォルト2)"
  }
]`;

const IMAGE_PROMPT = `この画像（修理伝票やリストのスクリーンショット）から、家電修理の訪問先情報を抽出してJSON形式で返してください。
ルートと時間管理や訪問前連絡に必要な住所、電話番号（あれば）、時間指定（あれば）、難易度だけを可能な限り読み取ってください。
個人名（顧客名）や作業メモ・用件は抽出しないでください。電話番号はハイフン等の表記を画像のまま保ち、不明ならnullにしてください。
最大5件まで。

出力は以下の配列形式にしてください。
[
  {
    "address": "住所",
    "phoneNumber": "電話番号 (例: 090-1234-5678, 不明ならnull)",
    "startTime": "HH:mm (例: 09:00, 不明ならnull)",
    "endTime": "HH:mm (例: 12:00, 不明ならnull)",
    "difficulty": 1 | 2 | 3 (1:簡単, 2:普通, 3:難しい。内容から推測して。デフォルト2)"
  }
]`;

async function callGemini(parts: any[]): Promise<ParsedVisit[]> {
  if (!GEMINI_API_KEY) {
    throw new Error('Gemini API key is not configured (GEMINI_API_KEY secret)');
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': GEMINI_API_KEY,
    },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gemini API ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.slice(0, 5) : [];
  } catch {
    return [];
  }
}

export async function parseVisitsFromTextClient(text: string): Promise<ParsedVisit[]> {
  return callGemini([{ text: TEXT_PROMPT(text) }]);
}

export async function parseVisitsFromImageClient(
  base64: string,
  mimeType: string
): Promise<ParsedVisit[]> {
  return callGemini([
    { text: IMAGE_PROMPT },
    { inlineData: { data: base64, mimeType: mimeType || 'image/jpeg' } },
  ]);
}
