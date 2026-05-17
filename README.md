# Field Engineer Routing App / ルート最適化アプリ

現場作業員（フィールドエンジニア）向けの巡回ルート最適化アプリです。
複数拠点の訪問ルートをAI（Gemini）とGoogle Maps APIを活用して効率的にスケジュールし、合間に立ち寄れるランチ休憩ポイント（お弁当屋・コンビニ含む）なども自動で提案します。

## 主な機能
- **訪問先の自動パース機能:** テキストから訪問先と作業メモをAIが自動抽出して登録します。
- **ルート最適化:** Google MapsのRoutes APIを使用し、最適な巡回順序と時間を算出します。
- **作業設定:** 作業内容に合わせたデフォルトの所要時間を設定可能です。
- **経由地提案:** ランチ休憩やトイレ休憩に向けたコンビニなどの周辺スポットを自動検索してルートに組み込みます。
- **Google Maps連携:** 作成されたルートをGoogle Maps上で即座に確認可能です。

## 使い方
1. ホーム位置や終了位置を設定します（右上の歯車アイコン）。
2. 作業設定やランチ候補のカスタマイズを行います。
3. クライアントからのテキスト（メールの本文など）を貼り付けて「AIで読み取る」をクリックします（または手動で「訪問先を追加」）。
4. 自動でルート最適化が行われ、ランチ候補とあわせてタイムラインが表示されます。

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
     - 使用 API を限定: Maps JavaScript, Geocoding, Places, Routes (Distance Matrix)
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
