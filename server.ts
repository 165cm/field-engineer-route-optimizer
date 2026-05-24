import express, { Request, Response, NextFunction } from "express";
import path from "path";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

// Hard caps to keep per-user API spend predictable.
// Server-side hard cap. The client further enforces a per-plan limit
// (Free=3, Pro=15) defined in src/lib/plan.ts. Keep this in sync with
// the Pro plan ceiling so a Pro user can fully use parsing.
const MAX_VISITS_PER_PARSE = 15;

// Pin to a stable, GA model so billing and behavior are predictable.
// Preview model IDs (e.g. gemini-3-flash-preview) can change pricing or be
// retired without notice, which is unacceptable for a paid product.
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
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

      const result = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                address: { type: Type.STRING },
                startTime: { type: Type.STRING, nullable: true },
                endTime: { type: Type.STRING, nullable: true },
                difficulty: { type: Type.INTEGER }
              },
              required: ["address", "difficulty"]
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
ルートと時間管理に必要な住所、時間指定（あれば）、難易度だけを可能な限り読み取ってください。
個人名（顧客名）や作業メモ・用件は抽出しないでください。
最大5件まで。

出力は以下の配列形式にしてください。
[
  {
    "address": "住所",
    "startTime": "HH:mm (例: 09:00, 不明ならnull)",
    "endTime": "HH:mm (例: 12:00, 不明ならnull)",
    "difficulty": 1 | 2 | 3 (1:簡単, 2:普通, 3:難しい。内容から推測して。デフォルト2)"
  }
]`;

      const result = await ai.models.generateContent({
        model: GEMINI_MODEL,
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
                startTime: { type: Type.STRING, nullable: true },
                endTime: { type: Type.STRING, nullable: true },
                difficulty: { type: Type.INTEGER }
              },
              required: ["address", "difficulty"]
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

  const MAPS_KEY = process.env.GOOGLE_MAPS_PLATFORM_KEY || "";

  // ---------------------------------------------------------------------------
  // Maps REST proxies. Keeping these server-side lets us (a) keep the high-spend
  // key off the client bundle, (b) apply the rate limiter above, and (c) add
  // future server-side caching without touching the UI.
  // The Maps JavaScript API key (used for map rendering on the client) should be
  // a separate restricted key with only "Maps JavaScript API" enabled +
  // HTTP-referrer restriction to your domain.
  // ---------------------------------------------------------------------------

  app.post("/api/geocode", async (req, res) => {
    try {
      if (!MAPS_KEY) return res.status(500).json({ error: "Maps key not configured" });
      const { address } = req.body ?? {};
      if (typeof address !== "string" || !address.trim()) {
        return res.status(400).json({ error: "address is required" });
      }
      const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
      url.searchParams.set("address", address);
      url.searchParams.set("key", MAPS_KEY);
      url.searchParams.set("language", "ja");
      const r = await fetch(url);
      const data = await r.json() as any;
      if (data.status !== "OK" || !data.results?.[0]) {
        return res.status(404).json({ error: data.status || "NOT_FOUND" });
      }
      const loc = data.results[0].geometry.location;
      res.json({ lat: loc.lat, lng: loc.lng });
    } catch (error) {
      console.error("Geocode Error:", error);
      res.status(500).json({ error: "Geocoding failed" });
    }
  });

  app.post("/api/distance-matrix", async (req, res) => {
    try {
      if (!MAPS_KEY) return res.status(500).json({ error: "Maps key not configured" });
      const { points } = req.body ?? {};
      if (!Array.isArray(points) || points.length === 0 || points.length > 12) {
        return res.status(400).json({ error: "points must be an array of 1..12 entries" });
      }
      const encode = (p: any): string => {
        if (typeof p === "string") return p;
        if (p && typeof p.lat === "number" && typeof p.lng === "number") return `${p.lat},${p.lng}`;
        throw new Error("invalid point");
      };
      const joined = points.map(encode).join("|");
      const url = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
      url.searchParams.set("origins", joined);
      url.searchParams.set("destinations", joined);
      url.searchParams.set("mode", "driving");
      url.searchParams.set("language", "ja");
      url.searchParams.set("key", MAPS_KEY);
      const r = await fetch(url);
      const data = await r.json() as any;
      if (data.status !== "OK") {
        return res.status(502).json({ error: data.status || "MATRIX_ERROR" });
      }
      // Pass through the rows/elements shape directly — it already matches what
      // optimization.ts reads (duration.value, distance.value).
      res.json({ rows: data.rows });
    } catch (error) {
      console.error("DistanceMatrix Error:", error);
      res.status(500).json({ error: "Distance matrix failed" });
    }
  });

  app.post("/api/places/search", async (req, res) => {
    try {
      if (!MAPS_KEY) return res.status(500).json({ error: "Maps key not configured" });
      const { textQuery, center, maxResultCount } = req.body ?? {};
      if (typeof textQuery !== "string" || !textQuery.trim()) {
        return res.status(400).json({ error: "textQuery is required" });
      }
      if (!center || typeof center.lat !== "number" || typeof center.lng !== "number") {
        return res.status(400).json({ error: "center {lat,lng} is required" });
      }
      const limit = Math.max(1, Math.min(10, Number(maxResultCount) || 5));
      const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": MAPS_KEY,
          "X-Goog-FieldMask":
            "places.displayName,places.location,places.formattedAddress,places.rating",
        },
        body: JSON.stringify({
          textQuery,
          maxResultCount: limit,
          locationBias: {
            rectangle: {
              low: { latitude: center.lat - 0.03, longitude: center.lng - 0.03 },
              high: { latitude: center.lat + 0.03, longitude: center.lng + 0.03 },
            },
          },
          languageCode: "ja",
        }),
      });
      if (!r.ok) {
        const txt = await r.text();
        console.error("Places API non-OK:", r.status, txt);
        return res.status(502).json({ error: "Places search failed" });
      }
      const data = await r.json() as any;
      const places = (data.places || []).map((p: any) => ({
        displayName: p.displayName?.text || "",
        formattedAddress: p.formattedAddress || "",
        rating: typeof p.rating === "number" ? p.rating : undefined,
        location: p.location
          ? { lat: p.location.latitude, lng: p.location.longitude }
          : undefined,
      }));
      res.json({ places });
    } catch (error) {
      console.error("Places Search Error:", error);
      res.status(500).json({ error: "Places search failed" });
    }
  });

  // Vite integration
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
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
