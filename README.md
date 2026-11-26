# OMOCHI TUNE / おもちちゃん タロット占いサイト

毎月第一木曜日に渋谷・道玄坂の天井裏 “M” でひらかれる、おもちちゃんのタロット占いイベントのランディングページです。

## 特徴
* 🕊️ **おもち天使キャラクター**: 立方体から、ふわふわ丸くて可愛らしい「おもち型」の天使にSVGを完全リニューアル。
* 🔮 **おもちメッセージ占い**: 3つの伏せられたカードから1枚を選んで引くことができるインタラクティブなタロット占いゲーム。
* 📅 **時間連動カレンダー**: 毎月第一木曜日の開催日時を自動計算し、開催時間内（20:00〜23:00）には「本日開催中」バッジを表示。カレンダー上の該当日がハートマークで可愛く強調されます。
* 🎨 **美しい黄昏空のデザイン**: WCAG AA（4.5:1）コントラスト基準を満たした読みやすく親しみやすいカラーパレット。
* 📱 **モバイルフレンドリー設計**: セーフエリア対応、Googleマップ連携、ワンタップでの住所コピー機能を搭載。
* ⚙️ **ブラウザ管理画面**: `/admin/` からコラム、図鑑、タロット、Instagramプレビュー、予約案内を更新できます。
* 🛡️ **安全なコンテンツ表示**: DOMPurifyで記事HTMLを無害化し、a11y-dialogでモーダルのフォーカスを管理します。
* 🧪 **自動ブラウザテスト**: Playwrightで主要操作を確認してからGitHub Pagesへ公開します。

## コンテンツを更新する

1. 公開サイトの `/admin/` を開きます。
2. `Sign In with Token` を選び、このリポジトリだけに書き込みできるfine-grained PATでログインします。
3. 更新対象を選んで保存します。保存するとGitHubへコミットされ、自動テスト後に公開されます。

PATはブラウザのLocal Storageに保存されます。共用PCでは利用せず、作業後は管理画面からサインアウトしてください。

## ローカル検証

```powershell
npm install
npm test
```

`npm run build` は公開用の `dist/` と、RSS・サイトマップ・robots.txtを生成します。

## Antigravity MCP で操作する

このリポジトリには Antigravity からコンテンツ参照・編集・ビルド検証・GitHub 反映（PR / push）までを直接行える MCP サーバー（`stdio` / Streamable HTTP 対応）およびサイドパネル用の対話型 **MCP App UI**（`open_dashboard`）を同梱しています。

### プラグイン構成と登録
- **専用プラグイン**: `.agents/plugins/omochi-tune-mcp/`（`plugin.json`, `mcp_config.json`, `assets/logo.svg`, `skills/omochi-tune-ops/SKILL.md`, `bin/`）としてパッケージ化済みです。
- **グローバル利用**（どのワークスペースからでも操作する場合）: 同プラグインを `~/.gemini/config/plugins/omochi-tune-mcp/` へ配置し、`mcp_config.json` の `env.OMOCHI_TUNE_REPO_ROOT` に本リポジトリパスを指定します（二重登録を防ぐため、`mcp_config.json` 単体と重複させません）。

### Streamable HTTP モードで起動する場合

```powershell
npm run mcp:build
npm run mcp:http
```

- 既定では `http://127.0.0.1:8788/mcp`（ヘルスチェック: `GET /health`）で起動します。
- `OMOCHI_TUNE_MCP_HTTP_TOKEN` を設定すると `Authorization: Bearer <token>` のタイミングセーフ認証を有効化します（非ループバックアドレスへバインドする場合は必須）。

### 提供機能（24 ツール / 8 リソース）
- **MCP App UI**: `open_dashboard`（`ui://omochi-tune/dashboard.html` — 概要・KPI サマリー・設定・コンテンツ一覧・タロット試し引き・dry-run 公開確認。Antigravity の `aux_pane` / `global` エントリポイント対応）
- **参照・算出・KPI**: `get_site_overview`, `get_event_schedule`（毎月第一木曜 20:00〜23:00 JST 算出）, `draw_tarot_card`（シェア文言生成付き）, `get_kpi_summary`（[docs/KPI_SPEC.md](docs/KPI_SPEC.md) 準拠の主導線 KPI 集計 / 未設定時は `not-measured`）
- **CRUD**: `get_settings` / `update_settings`, `list_columns` / `get_column` / `upsert_column` / `delete_column`, `list_gallery` / `upsert_gallery_item` / `delete_gallery_item`, `list_tarot_cards` / `upsert_tarot_card` / `delete_tarot_card`, `list_instagram_items` / `upsert_instagram_item` / `delete_instagram_item`, `save_uploaded_image`
- **検証・公開**: `validate_and_build`（全5JSON検証＋ビルド＋任意E2E）, `get_publish_status`, `publish_changes`
  - `publish_changes` は安全のため `confirm: true` を明示するまで **dry-run（事前プレビュー）** として動作し、`content/*.json` と `images/uploads/*` のみを対象に PR 作成または `main` への反映を行います。
- **MCP リソース**: `ui://omochi-tune/dashboard.html`, `omochi://site/overview`, `omochi://site/kpi`, `omochi://content/{settings,columns,gallery,tarot,instagram}`

### MCP ビルド・単体・結合テスト

```powershell
npm run test:mcp
```
