# AI開発エージェントガイド

中央マニュアル: https://github.com/165cm/portfolio/tree/main/docs/standards

## このリポジトリの設定

- **Tier:** T2
- **Category:** work
- **固有制約:**
  - Google Maps API（Distance Matrix / Geocoding / Directions / Maps JS SDK）と Gemini API を使用。本番ではサーバーサイドプロキシ（`server.ts`）経由でAPIキーを保護する。
  - GitHub Pages デモモードでは `VITE_DEMO_MODE=true` でクライアントSDK経由に切り替わる。両モードの動作確認を行うこと。
  - **顧客名・個人情報は保存しない設計を維持する。** Geminiプロンプト・型定義・UIを変更するときもこの方針を崩さないこと。
  - Google Mapsへ渡すURLは必ず `api=1` 形式（`buildGoogleMapsDirectionsUrl` 経由）にすること。住所より座標を優先して渡すこと。

## よく使うコマンド

```bash
npm run dev    # 開発サーバ
npm run build  # 本番ビルド
npm run lint   # Lint確認
npm run start  # 本番相当の動作確認
```

## 参照

- [README.md](../README.md) — ユーザー向け説明
- [DEVELOPER.md](../DEVELOPER.md) — 技術詳細・実装上の注意・デプロイ手順
