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

このリポジトリには Antigravity からコンテンツ参照・編集・ビルド検証・GitHub 反映（PR / push）までを直接行えるローカル `stdio` MCP サーバー（`mcp/server.mjs`）を同梱しています。

### 登録設定
- **ワークスペース設定**: `.agents/mcp_config.json` に `omochi-tune` サーバーが定義済みです。
- **グローバル登録**（どのワークスペースからでも操作する場合）: `~/.gemini/config/mcp_config.json` の `mcpServers` に `node` ＋ `mcp/server.mjs`（`cwd` に本リポジトリパス）を登録します。

### 提供機能（主な MCP ツール / リソース）
- **参照・算出**: `get_site_overview`, `get_event_schedule`（毎月第一木曜 20:00〜23:00 JST 算出）, `draw_tarot_card`（シェア文言生成付き）
- **CRUD**: `get_settings` / `update_settings`, `list_columns` / `get_column` / `upsert_column` / `delete_column`, `list_gallery` / `upsert_gallery_item` / `delete_gallery_item`, `list_tarot_cards` / `upsert_tarot_card` / `delete_tarot_card`, `list_instagram_items` / `upsert_instagram_item` / `delete_instagram_item`, `save_uploaded_image`
- **検証・公開**: `validate_and_build`（全5JSON検証＋ビルド＋任意E2E）, `get_publish_status`, `publish_changes`
  - `publish_changes` は安全のため `confirm: true` を明示するまで **dry-run（事前プレビュー）** として動作し、`content/*.json` と `images/uploads/*` のみを対象に PR 作成または `main` への反映を行います。
- **MCP リソース**: `omochi://site/overview`, `omochi://content/{settings,columns,gallery,tarot,instagram}`

### MCP 単体・結合テスト

```powershell
npm run test:mcp
```
