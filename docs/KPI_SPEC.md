# OMOCHI TUNE 最小KPI計測仕様（Issue #3）

- **関連 Issue**: [#3 引継ぎ: 主導線の最小KPI計測を追加する](https://github.com/kanta13jp1/omochi-tune/issues/3)
- **実装ファイル**: [js/kpi.js](../js/kpi.js), [index.html](../index.html), [scripts/build.mjs](../scripts/build.mjs), [workers/kpi/src/index.mjs](../workers/kpi/src/index.mjs), [workers/kpi/schema.sql](../workers/kpi/schema.sql)
- **集計バックエンド**: Cloudflare Workers (`omochi-tune-kpi`) ＋ Cloudflare D1 (`omochi-tune-kpi-db`, UUID: `faa01ca1-7e5f-4d21-95be-e8c7c59e738e`, APAC)
- **本番エンドポイント**: `https://omochi-tune-kpi.ai-park.workers.dev`
- **現行計測ステータス**: **エンドポイント接続済み（本番公開ページでの実到達確認待ち / `ready_no_events`）** — `index.html` へ接続済み。`main` デプロイ完了後に本番アクセスによる `status: "measuring"` 確認を実施します。

---

## 1. 主導線ファネルと対象 KPI（3 指標 + 補助 1）

OMOCHI TUNE はサーバーレス静的ランディングページであり、主導線は **「サイト訪問 → タロット占い体験 → 事前予約 DM 導線クリック」** です。

| 段階 | イベント名 | 発火条件 | 重複防止（Dedupe） | 許可プロパティ（PII 排除） |
| --- | --- | --- | --- | --- |
| **訪問** | `lp_view` | `index.html` の `loadData()` 完了（`data-content-ready="true"`）時 | 1 ページ表示につき 1 回 | `{}`（なし） |
| **開始/体験** | `tarot_draw` | `.tarot-card` クリックでカードがめくられた時 | 結果表示中（「もう一度占う」押下まで）および `800ms` 以内の連打を除外 | `{ mode: "daily" \| "love" }` |
| **成功（主 CV）** | `booking_dm_click` | 予約 DM CTA（`[data-kpi-booking]`）クリック時 | 同一 `placement` で `1500ms` 以内の連打を除外 | `{ placement: "hero" \| "instagram_card" \| "sticky_mobile" }` |
| **補助（拡散）** | `tarot_share_click` | 占い結果のシェア操作（X / LINE / コピー / Web Share）時 | 同一 `channel` で `1500ms` 以内の連打を除外 | `{ channel: "x" \| "line" \| "copy" \| "native" }` |

### KPI 算出式（分母・分子）
1. **タロット体験率**: $\text{tarot\_draw 件数} \div \text{lp\_view 件数}$
2. **予約 DM クリック率（主目標 CVR）**: $\text{booking\_dm\_click 件数} \div \text{lp\_view 件数}$
3. **シェア反応率（補助）**: $\text{tarot\_share\_click 件数} \div \text{tarot\_draw 件数}$

---

## 2. プライバシー保護・セキュリティ設計

* **PII / 個人情報ゼロ**: 許可リストにないイベント名・キーはすべて破棄します。Cookie・LocalStorage・クエリ文字列・リファラ・カード結果本文・ユーザー入力は一切収集・送信しません。
* **共通ペイロード形式**:
  ```json
  {
    "schemaVersion": 1,
    "event": "booking_dm_click",
    "page": "lp",
    "placement": "hero",
    "ts": "2026-11-24T00:00:00.000Z"
  }
  ```
* **Fail-Open 保証**: 送信先未設定・通信失敗・`navigator.sendBeacon` 例外・`fetch` 失敗のいずれの場合も例外を握りつぶし（`stats.failed` にのみ記録）、タロット表示や Instagram DM 遷移を一切阻害しません。
* **CORS シンプルリクエスト & ローカルホスト保護**: `navigator.sendBeacon` はプリフライト不要な `text/plain;charset=UTF-8` で JSON 文字列を送信し（`fetch` フォールバックは `application/json` + `keepalive: true` + `credentials: 'omit'`）、`localhost` / `127.0.0.1` / `[::1]` での閲覧・Playwright E2E 実行時は `window.__OMOCHI_KPI_CONFIG__` 明示指定を除き送信を抑制して本番集計の汚染を防ぎます。
* **CSP 準拠**: `js/kpi.js` は同一オリジン配信（`script-src 'self'`）。`connect-src` は `'self' https://omochi-tune-kpi.ai-park.workers.dev` の単一オリジンのみを明示許可しています。

---

## 3. 集計バックエンド構成・運用手順

1. **Cloudflare Workers + D1 構成**:
   * `workers/kpi/schema.sql`: `kpi_events` テーブル（厳格 `CHECK` 制約＋インデックス）
   * `workers/kpi/cloudflare.config.ts`: `observability`（Logs/Traces）および D1 バインディング `DB`
   * `POST /`（または `POST /event`）: 許可 Origin (`https://kanta13jp1.github.io`) のみ受理、ボディ上限 2048B、未知キー/PII 拒否、D1 保存後に `202` 返却
   * `GET /health`: D1 クエリ疎通確認（`200`）
   * `GET /summary?days=30`: 非 PII の期間合計・CVR・内訳・JST 日次配列を返却（任意の `OMOCHI_KPI_READ_TOKEN` による SHA-256 定数時間 Bearer 保護に対応）
2. **デプロイ手順（`cf` CLI）**:
   ```powershell
   npm run test:worker
   Push-Location workers/kpi
   node build.mjs
   cf deploy --prebuilt --dry-run
   cf deploy --prebuilt
   Pop-Location
   ```
3. **Antigravity MCP 確認**: `get_kpi_summary`（リソース `omochi://site/kpi`）および `open_dashboard` の概要タブ「主導線 KPI」カードから集計値・体験率・DM CTR・初回/最終到達時刻を参照できます（`OMOCHI_TUNE_KPI_ENDPOINT` / `OMOCHI_TUNE_KPI_READ_TOKEN` による上書きも可能）。

---

## 4. 確認方法・実行環境メモ

* **E2E / Worker / MCP 検証**: `npm test`（`tests/mcp.test.mjs`, [tests/kpi-worker.test.mjs](../tests/kpi-worker.test.mjs), [tests/site.spec.mjs](../tests/site.spec.mjs)）で発火・重複排除・ゼロ PII・CORS/容量ガード・Fail-Open・集計算出を自動検証。
* **実行時資源確認（2026-11-24 時点）**: C ドライブ空き `18.82 GiB`、空き RAM `3.96 GiB / 31.69 GiB`（新規 worktree・バックグラウンドサーバー常駐を増やさず実装）。
