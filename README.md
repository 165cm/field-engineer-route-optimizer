# Field Engineer Routing App / ルート最適化アプリ

現場作業員（フィールドエンジニア）向けの巡回ルート最適化アプリです。
複数拠点の訪問ルートをAI（Gemini）とGoogle Maps APIを活用して効率的にスケジュールし、移動時間・作業時間・休憩時間をまとめて管理できます。

## 主な機能
- **訪問先の自動パース機能:** テキストや画像から住所・時間指定・難易度をAIが自動抽出して登録します。
- **ルート最適化:** Google MapsのDistance Matrix APIを使用し、最適な巡回順序と時間を算出します。
- **作業設定:** 作業内容に合わせたデフォルトの所要時間を設定可能です。
- **休憩時間の挿入:** 15分単位、最大60分までのランチ・休憩時間をルート中盤に挿入できます。
- **Google Maps連携:** 作成されたルートをGoogle Maps上で即座に確認可能です。

## 使い方
1. ホーム位置や終了位置を設定します（右上の歯車アイコン）。
2. 作業設定やランチ・休憩時間を設定します。
3. クライアントからのテキスト（メールの本文など）を貼り付けてAIで読み取ります（または手動で「訪問先を追加」）。
4. ルート最適化を実行し、おすすめ案・スコア・タイムラインを確認します。

## GitHub Pages デモ公開

`main` への push で `.github/workflows/deploy-pages.yml` が走り、デモ版が
`https://<オーナー>.github.io/<リポジトリ名>/` に公開されます。

### 初回セットアップ（リポジトリ管理者が一度だけ）

1. **Pages を有効化**
   Settings → Pages → Source = **GitHub Actions** を選択
2. **Secrets を登録**
   Settings → Secrets and variables → Actions → New repository secret
   - `GOOGLE_MAPS_PLATFORM_KEY` … Maps Platform のAPIキー
   - `GEMINI_API_KEY` … Gemini APIキー（パスワード制のAI解析機能で使用）
3. **APIキーを GCP / AI Studio コンソール側で制限**（露出対策。**必須**）
   - **Maps キー**
     - HTTPリファラ制限: `https://<オーナー>.github.io/<リポジトリ名>/*`
     - 使用 API を限定: Maps JavaScript, Geocoding, Distance Matrix, Directions
     - 各APIに **1日あたりのクォータ上限** (例: 1,000リクエスト/日)
     - Billing → **予算アラート** (例: ¥3,000/月)
   - **Gemini キー**（**本番と別キー必須**）
     - AI Studio で 1日あたりのリクエスト上限 (例: 200/日)
     - Billing → 予算アラート (例: $5/月)

### デモ版の挙動

- `VITE_DEMO_MODE=true` でビルドされ、Pro プランがデフォルト
- ヘッダーのトグルで Free / Pro を切替（課金ゲート挙動の確認用）
- **AI解析（テキスト/画像）はパスワード制**（既定: `setagayass` / 1日10回まで）
  - 解除状態は 30日間ブラウザに保存
  - パスワード文字列もGeminiキーもバンドル内にあるため、これはあくまで
    casual visitorsの抑止用ソフトゲートです。本物の保護はGCP側の
    クォータ上限で行ってください
- Maps関連は Maps JavaScript SDK で直接呼び出し（バックエンド不要）

### 手動デプロイ

Actions タブ → "Deploy demo to GitHub Pages" → Run workflow

---
[開発者向けドキュメントはこちら (DEVELOPER.md)](./DEVELOPER.md)
