# Developer Guide / 開発者向けドキュメント

このプロジェクトは、React + Vite + Tailwind CSS を使用して構築された、フィールドエンジニアのルート最適化およびスケジュール管理アプリケーションです。

## 技術スタック
- **フロントエンド:** React (TypeScript), Tailwind CSS
- **アイコン:** lucide-react
- **地図 & ルーティング:** Google Maps Platform (Maps JavaScript API, Geocoding API, Distance Matrix API, Directions API)
- **AI 連携:** @google/genai (Gemini API による自然言語からのデータパース)

## 開発環境のセットアップ
1. リポジトリのクローン後、依存パッケージをインストールします:
   ```bash
   npm install
   ```
2. 環境変数の設定を行います。以下の環境変数が必要です。
   - `GEMINI_API_KEY`: Gemini API を使用するためのキー
   （※ Google Maps API Key はアプリ内の設定画面からユーザーが入力する仕様となっています）
3. 開発サーバーを起動します:
   ```bash
   npm run dev
   ```

## 主要ファイル・ディレクトリ構成
- `src/App.tsx`: メインUIおよび状態管理（Reactコンポーネント）
- `src/services/googleMapsService.ts`: Google Maps (Geocoding, Distance Matrix) との連携処理
- `src/services/geminiClientService.ts`: Gemini モデルを使用したテキスト・画像情報抽出ロジック
- `src/types.ts`: TypeScriptの型定義（Visit, RoutePlan など）
- `src/index.css`: Tailwindのグローバル設定

## アーキテクチャのポイント
- **ランチ・休憩時間:** 店舗検索は行わず、設定した休憩時間（0/15/30/45/60分）をルート中盤に挿入します。Places API はコスト抑制のため使用していません。
- **作業(タスク)管理:** `settings`内に `tasks` の配列を持たせ、各クライアント訪問で必要な分数を作業単位で切り替え・管理できるようにしています。

---
[一般向けReadmeはこちら (README.md)](./README.md)
