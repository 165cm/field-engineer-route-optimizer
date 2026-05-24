# 開発者ドキュメント

このリポジトリは React + Vite + TypeScript + Tailwind CSS で実装された、フィールドエンジニア向けのルート最適化Webアプリです。アプリ概要・使い方は [README.md](./README.md) を参照してください。

## 技術スタック

| 領域 | 採用 |
|---|---|
| ビルド | Vite 6 |
| UI | React 18 + TypeScript |
| スタイル | Tailwind CSS 4（`@tailwindcss/vite`） |
| アニメーション | motion (旧 framer-motion) |
| アイコン | lucide-react |
| 地図 | `@vis.gl/react-google-maps` ＋ Google Maps Platform |
| AI | Google Gemini 2.5 Flash（`@google/genai`、または `generativelanguage.googleapis.com` 直叩き） |
| サーバー（任意） | Express + Vite SSR（`server.ts`） |

## 動作モード

ビルド時の環境変数で2モードを切り替えます。

| モード | `VITE_DEMO_MODE` | 用途 |
|---|---|---|
| **Server-backed** | unset | `server.ts` 経由で `/api/parse-text`, `/api/parse-image`, `/api/distance-matrix`, `/api/geocode` を提供。APIキーはサーバー側のみに常駐 |
| **Demo** (GitHub Pages) | `'true'` | フロントエンドだけで動作。Maps SDK と Gemini を **クライアントから直接呼ぶ**ためAPIキーがバンドル内に露出。GCP側のリファラ制限＋クォータが必須 |

## ディレクトリ構成

```
.
├── server.ts                 # Express + Vite SSR (server-backed モード用)
├── vite.config.ts            # ビルド設定。env を process.env に注入
├── index.html
├── src/
│   ├── App.tsx               # メインUI（単一ファイル、~2,500行）
│   ├── types.ts              # Visit / RoutePlan / Settings 等の型定義
│   ├── components/
│   │   └── ScheduleClock.tsx # アナログ時計型のスケジュール可視化（SVG）
│   ├── lib/
│   │   ├── optimization.ts   # ルート最適化＋プラン計算（calculatePlanForOrder, optimizeRoutes）
│   │   ├── visitColors.ts    # 難易度→色マップ（低/中/高 = 緑/黄/赤）
│   │   ├── plan.ts           # 無料/Pro プランのゲート
│   │   ├── demoMode.ts       # isDemoMode() helper
│   │   ├── demoAI.ts         # デモのAI利用上限・パスワード制
│   │   └── utils.ts          # cn() などのユーティリティ
│   └── services/
│       ├── googleMapsService.ts    # geocode, distanceMatrix, findLunchSpots
│       └── geminiClientService.ts  # デモモード用 Gemini 直叩き
└── .github/workflows/deploy-pages.yml
```

## ローカル開発

```bash
npm install

# (A) サーバー込みで動かす
GEMINI_API_KEY=xxx GOOGLE_MAPS_PLATFORM_KEY=yyy npm run dev

# (B) デモモードのみ（フロントだけ、APIキーはバンドル）
VITE_DEMO_MODE=true GEMINI_API_KEY=xxx GOOGLE_MAPS_PLATFORM_KEY=yyy npm run dev
```

> Vite の `define` で `process.env.GEMINI_API_KEY` と `process.env.GOOGLE_MAPS_PLATFORM_KEY` をビルド時に文字列リテラルに置換します（`vite.config.ts:18-21`）。

## 環境変数

| 変数 | 用途 | 必須 |
|---|---|---|
| `GOOGLE_MAPS_PLATFORM_KEY` | Maps JavaScript / Geocoding / Distance Matrix / Directions / Places (New) | ◯ |
| `GEMINI_API_KEY` | Gemini 2.5 Flash（AI解析） | デモは ◯、Server-backed はサーバー側でのみ |
| `VITE_DEMO_MODE` | `'true'` のとき GitHub Pages 用ビルド | デモ時のみ |
| `VITE_BASE` | GitHub Pages のサブパス（例 `/field-engineer-route-optimizer/`） | デモ時のみ |
| `DISABLE_HMR` | `'true'` でVite HMRを無効化（エージェント編集中のチラつき防止） | 任意 |

## 主要モジュール

### `src/lib/optimization.ts`
- `calculatePlanForOrder(visits, settings, matrix, orderIndices, planId)`
  - 順列を与えると `RoutePlan` を返す純関数。準備15分＋作業＋撤収15分のバッファ、時間窓違反検知、終了時刻計算まで一気通貫。
- `optimizeRoutes(...)`
  - 全順列を生成し、A=最短／B=余裕／C=確実 の3スコアで最良を選出。
  - 訪問数 ≤ 8 想定（8件で 40,320 順列）。9件以上は計算量が爆発するので注意。
- `PREP_MIN`, `CLEANUP_MIN`：各15分。
- `parseTime` / `formatTime`：`"HH:mm"` ↔ 分の相互変換。

### `src/components/ScheduleClock.tsx`
- 12時間アナログ時計型 SVG（300×300）。
- 内周に **難易度色＋スタガーレイヤー** で時間窓を描画。指定時間なしは `10:00-17:00` の薄帯デフォルト。
- 1〜12 の時刻ラベル、訪問先ラベル（`{順}.{町名}/{タスク名}`）、中央に稼働／移動／終了時刻。

### `src/lib/visitColors.ts`
- 難易度 1/2/3 を `緑/黄/赤`（Tailwind の `green-500` / `yellow-500` / `red-500`）にマップ。入力画面の `DifficultySelector` と完全に同一の色相を使用。

### `src/services/googleMapsService.ts`
- `geocodeAddress(address)`：localStorage 30日キャッシュ付き。
- `getDistanceMatrix(origins, destinations)`：デモは Maps SDK の `DistanceMatrixService`、本番はサーバー API。
- `findLunchSpots(midpoint, query, limit, icon)`：`Place.searchByText` でルート中盤の店舗検索。

### `src/services/geminiClientService.ts`
- デモモードのみ使用。`x-goog-api-key` ヘッダー方式で `generativelanguage.googleapis.com` を直接叩く。
- **顧客名は抽出しない**（プライバシー保護のためプロンプトとスキーマから除外済み）。

### `src/App.tsx`
- ステート全般（visits, settings, plans, customOrder, …）と入力/結果のUIすべて。
- 約2,500行の単一ファイル。コンポーネント分割は段階的に。

## ルート最適化のロジック

3つのスコアで全順列を評価：

```
penalty   = violations × 10000 + warnings × 30
scoreA    = totalDurationMin + penalty               // 最短
scoreB    = totalDurationMin × 0.3 + centeringDiff + penalty   // 余裕
scoreC    = totalDurationMin × 0.3 + difficultyOrderPenalty + easyBeforeNoonBonus + penalty   // 確実
```

- 全訪問の難易度が同じ＆時間窓なしだと B/C のスコア差が消え、3案とも同じ並びに収束する。差を出したい場合は難易度を散らす・時間窓を入れる。
- 4つ目の「カスタム」は手動順序。`calculatePlanForOrder` をユーザー入れ替え後に走らせるだけ。
- `optContextRef`（App.tsx）に visits / settings / matrix のスナップショットを保持して、再最適化時に Distance Matrix API を再呼び出しせず手元の行列で再計算する。

## ビルドとデプロイ

```bash
# 本番ビルド（server-backed）
npm run build

# GitHub Pages デモビルド
VITE_DEMO_MODE=true VITE_BASE=/field-engineer-route-optimizer/ npx vite build
```

### GitHub Pages 自動デプロイ

`.github/workflows/deploy-pages.yml` が `main` と `claude/**` への push でトリガー。

セットアップ（管理者が一度だけ）：

1. **Settings → Pages → Source = GitHub Actions**
2. **Settings → Secrets and variables → Actions** で2つのシークレットを登録：
   - `GOOGLE_MAPS_PLATFORM_KEY`
   - `GEMINI_API_KEY`
3. **GCP / AI Studio コンソール側でキーを制限**（クライアントに露出するため必須）

#### `GOOGLE_MAPS_PLATFORM_KEY` の最小有効APIセット

このアプリが利用するのは以下5つだけ：

- Maps JavaScript API
- Geocoding API
- Distance Matrix API
- **Directions API**（青いルート線の描画）
- Places API (New)（ランチ候補）

その他は無効化推奨（Routes API は将来用、Place 旧版は不要）。

#### キー制限の推奨設定

- HTTPリファラ制限：`https://<owner>.github.io/<repo>/*`
- API制限：上記5つにチェック
- 日次クォータ上限（例：Geocoding 200/日、Directions 50/日）
- 請求アラート：$5 / $20 / $50

> Gemini キーは Maps とは**別キー必須**。`generativelanguage.googleapis.com` のみ許可した専用キーを作成し、AI Studio 側で日次クォータ（例：200/日）とビリングアラート（例：$5/月）を設定すること。

## API利用料の目安

5訪問1ルート最適化あたりの概算：

| API | 単価 | 1回コスト |
|---|---|---|
| Maps JavaScript | $7 / 1,000 ロード | $0.007 |
| Geocoding | $5 / 1,000 リクエスト | $0.035（キャッシュ後はほぼ0） |
| Distance Matrix | $5 / 1,000 要素 | $0.18 |
| Directions | $5 / 1,000 リクエスト | $0.005 |
| Places (New) | $32 / 1,000 リクエスト | $0.10〜$0.16 |
| Gemini 2.5 Flash | 入力 $0.30 / 出力 $2.50 per 1M tokens | $0.001 程度 |
| **合計** | | **約 $0.33** |

Maps Platform は月 $200 の無料クレジット。月100ルート程度なら実質無料。

## コミット規約

すべて日本語で記述。慣例的な接頭辞（`feat:` / `fix:` / `refactor:` / `chore:` など）は維持。

例：
```
feat: スケジュール時計に指定時間の内周表示を追加
fix: カスタム並び替え時に違反検知が抜けていた問題を修正
refactor: visitColors を難易度ベースに簡素化
```

---

[一般向けREADMEはこちら](./README.md)
