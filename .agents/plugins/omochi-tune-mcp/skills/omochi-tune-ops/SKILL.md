---
name: omochi-tune-ops
description: >-
  OMOCHI TUNE（おもちちゃん タロット占い）公式サイトのコンテンツ管理・開催日算出・MCP App ダッシュボード・
  ビルド検証・GitHub公開を omochi-tune MCP ツール経由で安全に実行するための運用手順スキル。
---

# OMOCHI TUNE MCP 運用手順

`omochi-tune` MCP サーバーを使ってサイトのコンテンツ参照・編集・公開を行う際は、以下の標準フローを順守してください。

## 1. 事前確認（Read First）
1. ユーザーへ視覚サマリーを提示したい場合やサイドパネル操作時は `open_dashboard`（引数 `{}` または `{ tab: "overview" | "settings" | "content" | "publish" }`）を呼び出す。
2. テキスト処理中心の調査時は `get_site_overview`（または `omochi://site/overview`）で現在の設定・コンテンツ件数・次回開催日・Git 状態を確認し、対象コレクションに応じて `get_settings` / `list_columns` / `list_gallery` / `list_tarot_cards` / `list_instagram_items` を読み取る。

## 2. コンテンツ編集の制約
- **コラム（`upsert_column`）**:
  - `content` は `index.html` の DOMPurify 許可タグ（`p, br, strong, b, em, i, a, ul, ol, li, blockquote, h3, h4`）のみ許可。プレーンテキストを渡すと自動で `<p>` 段落へ変換される。
  - `date` は `YYYY.MM.DD` 形式（省略時は新規作成で本日 JST）。
- **図鑑（`upsert_gallery_item`）**:
  - SVG アバターを使う場合は `avatar:<wings>|<face>|<item>`（例: `avatar:sky|smile|none`）または `avatar:ice` を指定する。
  - 実画像を使う場合は先に `save_uploaded_image`（PNG/JPG/WEBP/GIF、最大 5 MiB、SVG 禁止）で `images/uploads/` に保存し、返却された `relativePath` を設定する。
- **タロット（`upsert_tarot_card` / `delete_tarot_card`）**:
  - 3 枚引き UI のため最低 3 枚を維持する（3 枚以下への削除はブロックされる）。

## 3. ローカル検証ゲート（Build & Test）
- 編集後は必ず `validate_and_build`（`runBuild: true`）を実行し、全 5 JSON の整合性・`dist/feed.xml`・`dist/sitemap.xml`・`dist/robots.txt` 生成、および `dist/mcp` / `dist/.agents` 非混入を確認する。
- UI 表示や導線に影響する変更時は `runE2E: true`（Playwright E2E）も実行する。

## 4. Streamable HTTP 起動（任意・リモート/ローカル HTTP テスト時）
- `npm run mcp:http` または `node mcp/server.mjs --transport http --host 127.0.0.1 --port 8788` で起動する。
- 非ループバックアドレスへバインドする場合は `OMOCHI_TUNE_MCP_HTTP_TOKEN` が必須（未設定時は Fail-Closed 拒否）。

## 5. 公開ゲート（Dry-Run → 明示承認後に反映）
1. `get_publish_status` で公開対象（`content/*.json`, `images/uploads/*`）の変更のみが対象になることを確認する。
2. まず `publish_changes` を **`confirm: false`（既定）** で実行し、ステージ予定ファイルとブランチ／PR 計画の dry-run 結果をユーザーへ提示する。
3. ユーザーの明示的な承認を得た後にのみ `publish_changes` を **`confirm: true`** で実行する（原則 `mode: "pr"` を推奨。`mode: "push_main"` は直押しを明示依頼された場合のみ使用）。
