# verify — このリポジトリの動作確認レシピ

GUI (Vite + React SPA)。Google Maps APIキーなしでもUI検証可能。

## ビルドと起動

```bash
GOOGLE_MAPS_PLATFORM_KEY=test-fake-key npx vite build
npx vite preview --port 4173 --strictPort &
```

`npm run dev` (tsx server.ts) はGemini関連のenvが必要なので、UI検証にはvite build + previewが手軽。

## Playwrightで駆動

- Chromiumは `executablePath: '/opt/pw-browsers/chromium'`（playwright installは不要）。
- オフライン/ダミーキーでは `googleapis.com|gstatic.com|accounts.google.com` へのリクエストを `ctx.route(...).abort()` で殺すとハングしない。地図は空になるがUIは動く。
- 初回アクセスはオンボーディングモーダル「ルート最適化へようこそ」が出る。「スキップして自分で入力」をクリックして閉じる。

## 状態のシード（localStorage）

`page.addInitScript` で注入。注意: addInitScriptはreload毎に再実行されるので、リロード跨ぎの検証では `if (!localStorage.getItem(...))` ガードを入れる。

- `repair_settings` — Settings（homeAddress, endLocation, workDate, startTime）
- `repair_visits` — Visit[]（difficultyはworkMinutes 60なら2）
- `repair_route_session_v1` — ルート計算済み状態を復元して結果タブを直接出せる。
  `visitSignature` / `settingsSignature` が App.tsx の `buildVisitSignature` / `buildRouteSettingsSignature` と一致しないと破棄される。
  plans は `{ id:'A', label, order:[visit], legs:[...], totalDurationMin, totalDistanceKm, endTime }`。
  legs は arrivalTime/endTime (HH:mm) と durationMin が必須（isCompleteLeg）。

## 検証ポイントの例

- 結果画面サイドバー: 「カレンダー登録日」date input (`#calendar-work-date`)、Googleカレンダー登録/ICS書き出しボタン。
- ICS書き出しは `page.waitForEvent('download')` で取得。ファイル名 `route-schedule-<workDate>.ics`。
- 入力タブの「編集」ボタン → 起点・終点・日付時刻モーダル（StartEndModal）。
