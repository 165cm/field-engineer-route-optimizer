import express, { Request, Response, NextFunction } from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Hard caps to keep per-user API spend predictable.
const MAX_VISITS_PER_PARSE = 5;
const QUOTA_WINDOW_MS = 60 * 60 * 1000;        // 1 hour rolling window
const QUOTA_MAX_REQUESTS_PER_KEY = 30;          // per IP, per window
const QUOTA_MAX_REQUESTS_GLOBAL_PER_MIN = 120;  // crude global cap

type Bucket = { count: number; resetAt: number };
const ipBuckets = new Map<string, Bucket>();
const globalBucket: Bucket = { count: 0, resetAt: Date.now() + 60_000 };

function clientKey(req: Request): string {
  const xff = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim();
  return xff || req.ip || req.socket.remoteAddress || "unknown";
}

function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const now = Date.now();

  // Global cap (process-wide; protects key + Gemini quota from total floods)
  if (now > globalBucket.resetAt) {
    globalBucket.count = 0;
    globalBucket.resetAt = now + 60_000;
  }
  globalBucket.count++;
  if (globalBucket.count > QUOTA_MAX_REQUESTS_GLOBAL_PER_MIN) {
    res.status(429).json({ error: "Server is busy. Please try again in a minute." });
    return;
  }

  // Per-IP cap
  const key = clientKey(req);
  let bucket = ipBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + QUOTA_WINDOW_MS };
    ipBuckets.set(key, bucket);
  }
  bucket.count++;
  if (bucket.count > QUOTA_MAX_REQUESTS_PER_KEY) {
    const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    res.setHeader("Retry-After", String(retryAfterSec));
    res.status(429).json({
      error: `Hourly quota exceeded (${QUOTA_MAX_REQUESTS_PER_KEY} requests/hour). Try again later.`,
      retryAfterSec,
    });
    return;
  }

  next();
}

// Periodically prune stale IP buckets to bound memory.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of ipBuckets) {
    if (now > b.resetAt) ipBuckets.delete(k);
  }
}, QUOTA_WINDOW_MS).unref?.();

async function startServer() {
  const app = express();
  const PORT = 3000;
  app.set("trust proxy", true);

  app.use(express.json({ limit: '10mb' }));

  // Gemini Setup
  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY || "",
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  });

  app.use("/api", rateLimit);

  // API Route: Parse visits from text
  app.post("/api/parse-visits", async (req, res) => {
    try {
      const { text } = req.body;
      if (!text) return res.status(400).json({ error: "Text is required" });

      const prompt = `以下のテキストから、家電修理の訪問先情報を抽出してJSON形式で返してください。
1行に1件とは限りません。住所、顧客名、時間指定（あれば）、作業メモなどを読み取ってください。
最大5件まで。

テキスト:
${text}

出力は以下の配列形式にしてください。
[
  {
    "address": "住所",
    "customerName": "名前(不明なら空)",
    "memo": "用件・メモ",
    "startTime": "HH:mm (例: 09:00, 不明ならnull)",
    "endTime": "HH:mm (例: 12:00, 不明ならnull)",
    "difficulty": 1 | 2 | 3 (1:簡単, 2:普通, 3:難しい。文脈から推測して。デフォルト2)"
  }
]`;

      const result = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                address: { type: Type.STRING },
                customerName: { type: Type.STRING },
                memo: { type: Type.STRING },
                startTime: { type: Type.STRING, nullable: true },
                endTime: { type: Type.STRING, nullable: true },
                difficulty: { type: Type.INTEGER }
              },
              required: ["address", "customerName", "memo", "difficulty"]
            }
          }
        }
      });

      const responseText = result.text;
      const parsed = JSON.parse(responseText || "[]");
      const capped = Array.isArray(parsed) ? parsed.slice(0, MAX_VISITS_PER_PARSE) : parsed;
      res.json(capped);
    } catch (error) {
      console.error("Gemini Error:", error);
      res.status(500).json({ error: "Failed to parse text" });
    }
  });

  // API Route: Parse visits from image
  app.post("/api/parse-image", async (req, res) => {
    try {
      const { image, mimeType } = req.body; // base64 image
      if (!image) return res.status(400).json({ error: "Image is required" });

      const prompt = `この画像（修理伝票やリストのスクリーンショット）から、家電修理の訪問先情報を抽出してJSON形式で返してください。
住所、顧客名、時間指定、作業メモなどを可能な限り読み取ってください。
最大5件まで。

出力は以下の配列形式にしてください。
[
  {
    "address": "住所",
    "customerName": "名前(不明なら空)",
    "memo": "用件・メモ",
    "startTime": "HH:mm (例: 09:00, 不明ならnull)",
    "endTime": "HH:mm (例: 12:00, 不明ならnull)",
    "difficulty": 1 | 2 | 3 (1:簡単, 2:普通, 3:難しい。内容から推測して。デフォルト2)"
  }
]`;

      const result = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              {
                inlineData: {
                  data: image,
                  mimeType: mimeType || "image/jpeg"
                }
              }
            ]
          }
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                address: { type: Type.STRING },
                customerName: { type: Type.STRING },
                memo: { type: Type.STRING },
                startTime: { type: Type.STRING, nullable: true },
                endTime: { type: Type.STRING, nullable: true },
                difficulty: { type: Type.INTEGER }
              },
              required: ["address", "customerName", "memo", "difficulty"]
            }
          }
        }
      });

      const responseText = result.text;
      const parsed = JSON.parse(responseText || "[]");
      const capped = Array.isArray(parsed) ? parsed.slice(0, MAX_VISITS_PER_PARSE) : parsed;
      res.json(capped);
    } catch (error) {
      console.error("Gemini Vision Error:", error);
      res.status(500).json({ error: "Failed to parse image" });
    }
  });

  // Vite integration
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
