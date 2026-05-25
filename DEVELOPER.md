# Developer Guide / 開発者向けドキュメント

このドキュメントは、開発・保守・デプロイ時の注意事項をまとめたものです。
一般利用者向けの説明は [README.md](./README.md) に分離しています。

## アプリの役割

このアプリは、フィールドエンジニア向けの「ルートと時間管理」に特化しています。

- 訪問先住所
- 時間指定
- 作業種別
- 作業時間
- 休憩時間
- ルート順序

を扱います。

顧客名、個人情報、詳細な作業メモは保存しない方針です。業務用iPadや既存の業務システムで管理する領域と、このアプリの責務を混ぜないでください。

## 技術スタック

- **フロントエンド:** React, TypeScript, Vite
- **スタイル:** Tailwind CSS
- **アイコン:** lucide-react
- **地図:** Google Maps JavaScript API
- **移動時間:** Distance Matrix API
- **住所変換:** Geocoding API
- **道路沿いルート描画:** Directions API
- **AI読み取り:** Gemini API

## 主要ファイル

- `src/App.tsx`
  メインUI、状態管理、ルート計算フロー、Google Maps連携URL生成。

- `src/lib/optimization.ts`
  訪問順の最適化、到着時刻、作業時間、スコア計算の土台。

- `src/components/ScheduleClock.tsx`
  時計型のスケジュール可視化。

- `src/services/googleMapsService.ts`
  Geocoding と Distance Matrix の呼び出し。通常ビルドではサーバー経由、GitHub PagesデモではMaps JS SDK経由。

- `src/services/geminiClientService.ts`
  テキスト・画像からの訪問先候補抽出。

- `server.ts`
  APIプロキシ、レート制限、Gemini API、Maps REST API連携、本番配信。

- `src/types.ts`
  `Visit`, `Leg`, `RoutePlan`, `Settings` などの型定義。

## 開発環境

```bash
npm install
npm run dev
```

本番相当の確認:

```bash
npm run build
npm run start
```

確認コマンド:

```bash
npm run lint
npm run build
```

## 環境変数

- `GOOGLE_MAPS_PLATFORM_KEY`
  Google Maps Platform のAPIキー。

- `GEMINI_API_KEY`
  Gemini APIキー。

- `GEMINI_MODEL`
  Geminiモデルの上書き。未指定時は `gemini-2.5-flash`。

- `VITE_DEMO_MODE`
  GitHub Pagesデモでは `true`。バックエンドなしで動くよう、Maps関連はクライアントSDK経由になります。

- `VITE_BASE`
  GitHub Pagesのプロジェクトパス用。例: `/field-engineer-route-optimizer/`

## デプロイ

`main` へpushすると `.github/workflows/deploy-pages.yml` が動き、GitHub Pagesへデプロイされます。

デモURL:

```text
https://<owner>.github.io/<repository>/
```

GitHub ActionsのSecretsに以下を登録します。

- `GOOGLE_MAPS_PLATFORM_KEY`
- `GEMINI_API_KEY`

MapsキーはGitHub Pages上でクライアントに露出します。必ずGCP側で制限してください。

- HTTPリファラ制限:
  `https://<owner>.github.io/<repository>/*`
- API制限:
  Maps JavaScript API, Geocoding API, Distance Matrix API, Directions API
- 1日あたりのクォータ上限
- 予算アラート

## 実装上の注意事項

### 1. Google Mapsへ渡すURLは必ず `api=1` 形式にする

外部Google Mapsを開くとき、住所をパスに並べる形式は使わないでください。

避ける例:

```text
https://www.google.com/maps/dir/住所A/住所B/住所C
```

日本語住所、郵便番号、丁目、番地が含まれる場合、Google Maps側で住所が分割・省略・誤認識されることがあります。実際に「7丁目」だけが別地点として登録される問題が発生しました。

現在は `src/App.tsx` の `buildGoogleMapsDirectionsUrl` で以下の形式に統一しています。

```text
https://www.google.com/maps/dir/?api=1&origin=...&destination=...&waypoints=...
```

Google Maps連携を変更する場合は、この関数を経由してください。

### 2. 住所より座標を優先してGoogle Mapsへ渡す

`Visit.coords`, `settings.homeCoords`, `settings.customEndCoords` がある場合は、住所文字列ではなく `lat,lng` を渡します。

理由:

- 住所文字列より座標のほうが誤認識されにくい
- 郵便番号や建物名の省略に左右されにくい
- Google Mapsアプリ側で訪問先が崩れにくい

`formatMapsPoint` がこの責務を持っています。

### 3. 終点なしの場合は最後の訪問先を `destination` にする

`endLocation === 'none'` のときは、最後の訪問先を `destination` にします。
その場合、最後の訪問先を `waypoints` にも入れると重複します。

現在のルール:

- 終点が起点: `destination = home`, `waypoints = remaining visits`
- 終点がカスタム: `destination = custom`, `waypoints = remaining visits`
- 終点なし: `destination = last remaining visit`, `waypoints = remaining visits except last`

### 4. `RoutePlan` は表示前に正規化する

ルート計算、ランチ挿入、カスタム順変更、外部APIレスポンスの組み合わせにより、`legs` の一部が欠ける可能性があります。

過去に `durationMin` が存在しない `leg` を表示側が読みに行き、白画面になる問題が起きました。

現在は `src/App.tsx` の `normalizeRoutePlan` で表示前に以下を揃えています。

- `legs` が配列であること
- `durationMin` が数値であること
- `distanceKm` が数値であること
- `totalDurationMin` が数値であること
- `totalDistanceKm` が数値であること
- `lunchBreak.durationMin` が数値であること

結果画面では、生の `plans[activePlanIdx]` ではなく、正規化済みの `activePlan` を参照してください。

### 5. `legs[index]` と `order[index]` が一致する前提を置かない

訪問先の `order` と移動区間の `legs` は、終点や休憩挿入の影響で単純な同じindexとして扱えません。

訪問先と移動区間を対応づける場合は `visitId` を使ってください。

避ける例:

```ts
const visit = plan.order[idx];
```

推奨:

```ts
const visit = plan.order.find(v => v.id === leg.visitId);
```

### 6. 時計表示はアプリ全体を落とさない

`ScheduleClock` は補助的な可視化です。ここで例外が出ても、結果画面全体を白画面にしてはいけません。

`src/components/ScheduleClock.tsx` では、描画前に `legs` を検証し、想定外データでは `null` を返すようにしています。時計表示を拡張するときも、この方針を維持してください。

### 7. ランチは店舗検索しない

コスト抑制のため、ランチ候補店舗の検索は実装しません。

現在の仕様:

- 休憩時間のみを設定
- 0 / 15 / 30 / 45 / 60分
- ルート中盤へ挿入
- Places APIは使わない

`Places API` や店舗検索UIを復活させる場合は、コスト、クォータ、UIの複雑化を再評価してください。

### 8. 顧客名や作業メモを保存しない

個人情報保護の観点から、AI読み取りでも顧客名や詳細メモは抽出・保存しない設計です。

Geminiプロンプト、型定義、UIを変更するときは、この方針を崩さないでください。

## 動作確認チェックリスト

ルートやGoogle Maps連携を変更したら、最低限以下を確認してください。

- `npm run lint`
- `npm run build`
- 訪問先3件以上でルート計算
- 終点: 起点に戻る
- 終点: 終点なし
- 終点: カスタム住所
- 休憩: なし
- 休憩: 30分以上
- Google Mapsでナビ開始
- Google Maps側で訪問先が分割・欠落していないか
- コンソールに `durationMin` 系エラーが出ていないか
- GitHub Pages反映後の公開ページでも同じ確認

## 既知の外部警告

Google Maps JavaScript APIから、Distance Matrixの非推奨警告が表示される場合があります。

```text
google.maps.DistanceMatrix is deprecated...
```

現時点では警告であり、即時停止ではありません。ただし将来的には Routes API / Route Matrix への移行を検討してください。移行時は料金、クォータ、レスポンス形式、GitHub Pagesデモでの動作を必ず再確認してください。

---

[一般利用者向けREADMEはこちら](./README.md)
