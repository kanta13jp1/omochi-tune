# OMOCHI TUNE 最小KPI計測仕様（Issue #3）

- **関連 Issue**: [#3 引継ぎ: 主導線の最小KPI計測を追加する](https://github.com/kanta13jp1/omochi-tune/issues/3)
- **実装ファイル**: [js/kpi.js](../js/kpi.js), [index.html](../index.html), [scripts/build.mjs](../scripts/build.mjs)
- **現行計測ステータス**: **未計測 (`not-measured`)** — 送信先エンドポイント未設定（`<meta name="omochi-kpi-endpoint" content="">` が空のため外部送信せず `skipped_unconfigured` として動作）。

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
* **CSP 準拠**: `js/kpi.js` は同一オリジン配信（`script-src 'self'`）。外部集計エンドポイントを設定するまで `connect-src 'self'` を維持します。

---

## 3. 集計先の接続手順（運用開始時）

1. Cloudflare Workers / 自前集計エンドポイント（HTTPS `POST application/json` で上記ペイロードを受理）を用意する。
2. [index.html](../index.html) の `<meta name="omochi-kpi-endpoint" content="">` に HTTPS URL（または同一オリジンパス）を設定する。
3. 外部オリジンを指定する場合は、同時に [index.html](../index.html) の CSP `connect-src 'self'` へ該当オリジン（例: `https://kpi.example.com`）のみを追記する。
4. 接続前の初期値は **未計測 (`not-measured`)** として扱い、上記設定後に実イベント到達を確認した時点で計測開始日を記録する。

---

## 4. 確認方法・実行環境メモ

* **E2E 検証**: `npm test`（[tests/site.spec.mjs](../tests/site.spec.mjs)）で発火・重複排除・ゼロ PII・Fail-Open（`sendBeacon` 例外および `/__kpi_fail` 失敗時でも主機能動作）を自動検証。
* **実行時資源確認（2026-11-24 時点）**: C ドライブ空き `18.82 GiB`、空き RAM `3.96 GiB / 31.69 GiB`（新規 worktree・バックグラウンドサーバー常駐を増やさず実装）。
