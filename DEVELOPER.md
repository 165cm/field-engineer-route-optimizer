# Developer Guide / 開発者向けドキュメント

このプロジェクトは、React + Vite + Tailwind CSS を使用して構築された、フィールドエンジニアのルート最適化およびスケジュール管理アプリケーションです。

## 技術スタック
- **フロントエンド:** React (TypeScript), Tailwind CSS
- **アイコン:** lucide-react
- **地図 & ルーティング:** Google Maps Platform (Maps JavaScript API, Places API, Routes API)
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
- `src/services/googleMapsService.ts`: Google Maps (Places, Routes) との連携処理
- `src/services/geminiService.ts`: Gemini モデルを使用したテキスト情報抽出ロジック
- `src/types.ts`: TypeScriptの型定義（Visit, RoutePlan など）
- `src/index.css`: Tailwindのグローバル設定

## アーキテクチャのポイント
- **ランチ候補の取得:** `googleMapsService.ts` にて、`Place.searchByText` を用いた地点周辺検索（`locationRestriction`でバウンディングボックス指定）を行っています。ランチ候補はルートの後半（訪問の合間の座標をもとに中間点を算出）で提案される仕組みです。
- **作業(タスク)管理:** `settings`内に `tasks` の配列を持たせ、各クライアント訪問で必要な分数を作業単位で切り替え・管理できるようにしています。

---
[一般向けReadmeはこちら (README.md)](./README.md)
