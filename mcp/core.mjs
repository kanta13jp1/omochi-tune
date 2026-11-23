import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE
} from '@modelcontextprotocol/ext-apps/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getEventSchedule } from './schedule.mjs';
import {
  AVATAR_OPTIONS,
  MAX_UPLOAD_BYTES,
  todayJstDot,
  validateAllContent,
  validateColumnItem,
  validateGalleryItem,
  validateInstagramItem,
  validateSettings,
  validateTarotCard
} from './schemas.mjs';

const SITE_URL = 'https://kanta13jp1.github.io/omochi-tune/';
export const DASHBOARD_URI = 'ui://omochi-tune/dashboard.html';
const MAX_APP_HTML_BYTES = 10 * 1024 * 1024;
const APP_AND_MODEL = ['model', 'app'];

export function resolveDefaultDashboardHtml(explicitPath) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    explicitPath,
    process.env.OMOCHI_TUNE_MCP_HTML?.trim(),
    join(scriptDir, 'dashboard.html'),
    resolve(scriptDir, 'dist', 'dashboard.html'),
    resolve(scriptDir, '..', '.agents', 'plugins', 'omochi-tune-mcp', 'bin', 'dashboard.html')
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const buf = readFileSync(candidate);
      if (buf.byteLength === 0 || buf.byteLength >= MAX_APP_HTML_BYTES) {
        throw new Error(`dashboard.html のサイズが範囲外です: ${buf.byteLength} bytes`);
      }
      return buf.toString('utf8');
    }
  }
  throw new Error(
    `dashboard.html が見つかりません（先に npm run mcp:build を実行してください）。検索パス: ${candidates.join(', ')}`
  );
}

function ok(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data
  };
}

function fail(err) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }],
    isError: true
  };
}

function stripTags(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function decodeUploadedImageInput({ filename, base64Data, sourcePath }) {
  if (base64Data && sourcePath) {
    throw new Error('base64Data と sourcePath はどちらか一方のみ指定してください');
  }
  if (!base64Data && !sourcePath) {
    throw new Error('base64Data または sourcePath のいずれかを指定してください');
  }
  if (base64Data) {
    const cleaned = String(base64Data)
      .trim()
      .replace(/^data:image\/(?:png|jpeg|jpg|webp|gif);base64,/i, '')
      .replace(/\s+/g, '');
    if (!cleaned || cleaned.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) {
      throw new Error('base64Data の形式が不正です');
    }
    const buf = Buffer.from(cleaned, 'base64');
    if (buf.length === 0 || buf.length > MAX_UPLOAD_BYTES) {
      throw new Error(`画像サイズが範囲外です（1〜${MAX_UPLOAD_BYTES} bytes）`);
    }
    return buf;
  }
  if (!extname(filename)) {
    throw new Error('filename に拡張子を含めてください');
  }
  return readFile(String(sourcePath));
}

/**
 * Creates a transport-agnostic MCP Server instance for OMOCHI TUNE.
 */
export function createOmochiMcpServer({
  store,
  ops,
  getDashboardHtml = () => resolveDefaultDashboardHtml(),
  now = () => new Date()
}) {
  const server = new McpServer(
    {
      name: 'omochi-tune-mcp',
      version: '1.1.0'
    },
    {
      instructions:
        'OMOCHI TUNE（おもちちゃん タロット占い）公式サイトのコンテンツ（設定・コラム・図鑑・タロット・Instagram）、' +
        '毎月第一木曜日の開催スケジュール、MCP App ダッシュボード (open_dashboard)、ローカルビルド/Playwright検証、' +
        'および承認付きGitHub公開を操作できます。publish_changes は confirm: true を明示しない限り dry-run プレビューのみ返します。'
    }
  );

  async function buildOverviewPayload() {
    const [all, schedule, publishStatus] = await Promise.all([
      store.readAllContent(),
      Promise.resolve(getEventSchedule({ count: 3, now: now() })),
      ops.getPublishStatus()
    ]);

    return {
      site: {
        name: 'OMOCHI TUNE / おもちちゃん タロット占い',
        url: SITE_URL,
        adminUrl: `${SITE_URL}admin/`,
        venue: schedule.nextEvent.venue,
        address: schedule.nextEvent.address
      },
      schedule: {
        isToday: schedule.isToday,
        isLiveNow: schedule.isLiveNow,
        statusLabel: schedule.statusLabel,
        daysUntilNext: schedule.daysUntilNext,
        nextEvent: schedule.nextEvent
      },
      settings: all.settings,
      counts: {
        columns: all.columns.length,
        gallery: all.gallery.length,
        tarot: all.tarot.length,
        instagram: all.instagram.length
      },
      git: publishStatus
    };
  }

  async function buildDashboardSnapshot(tab = 'overview') {
    const [overview, columns, gallery, tarot, instagram] = await Promise.all([
      buildOverviewPayload(),
      store.readJson('columns'),
      store.readJson('gallery'),
      store.readJson('tarot'),
      store.readJson('instagram')
    ]);
    return { tab, overview, columns, gallery, tarot, instagram };
  }

  // ---------------- MCP APP UI RESOURCE ----------------
  registerAppResource(
    server,
    'OMOCHI TUNE Dashboard',
    DASHBOARD_URI,
    {
      title: 'OMOCHI TUNE 管理ダッシュボード',
      description: '開催予定・公開設定・コンテンツ一覧・GitHub dry-run 確認を行う Antigravity MCP App UI',
      _meta: { ui: { prefersBorder: false } }
    },
    async () => ({
      contents: [
        {
          uri: DASHBOARD_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: getDashboardHtml(),
          _meta: { ui: { prefersBorder: false } }
        }
      ]
    })
  );

  // ---------------- JSON RESOURCES ----------------
  server.registerResource(
    'site-overview',
    'omochi://site/overview',
    {
      title: 'OMOCHI TUNE Site Overview',
      description: 'サイト概要、次回開催スケジュール、公開設定、コンテンツ件数、Git状態のスナップショット',
      mimeType: 'application/json'
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(await buildOverviewPayload(), null, 2)
        }
      ]
    })
  );

  for (const [key, title, desc] of [
    ['settings', 'Site Settings', '公開・予約設定 (content/settings.json)'],
    ['columns', 'Columns', 'おもちコラム一覧 (content/columns.json)'],
    ['gallery', 'Gallery', 'おもち図鑑一覧 (content/gallery.json)'],
    ['tarot', 'Tarot Cards', 'タロットカード一覧 (content/tarot.json)'],
    ['instagram', 'Instagram Preview', 'Instagram・世界観プレビュー (content/instagram.json)']
  ]) {
    server.registerResource(
      `content-${key}`,
      `omochi://content/${key}`,
      {
        title,
        description: desc,
        mimeType: 'application/json'
      },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(await store.readJson(key), null, 2)
          }
        ]
      })
    );
  }

  // ---------------- TOOLS ----------------

  // 1. get_site_overview
  server.registerTool(
    'get_site_overview',
    {
      title: 'サイト全体概要を取得',
      description: 'サイト設定、各コンテンツ件数、次回第一木曜日の開催予定、Git変更状態をまとめて取得します。',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async () => {
      try {
        return ok(await buildOverviewPayload());
      } catch (err) {
        return fail(err);
      }
    }
  );

  // 2. get_event_schedule
  server.registerTool(
    'get_event_schedule',
    {
      title: '開催スケジュールを取得',
      description: '毎月第一木曜日（20:00〜23:00 JST / 渋谷・道玄坂教会 天井裏 “M”）の次回開催日・本日開催中判定・今後の予定一覧を算出します。',
      inputSchema: {
        count: z.number().int().min(1).max(12).optional().describe('取得する開催回数（1〜12、既定: 6）'),
        fromDate: z.string().optional().describe('基準日 YYYY-MM-DD（省略時は現在 JST 日時）')
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (args) => {
      try {
        return ok(
          getEventSchedule({
            count: args.count ?? 6,
            fromDate: args.fromDate,
            now: now()
          })
        );
      } catch (err) {
        return fail(err);
      }
    }
  );

  // 3. draw_tarot_card
  server.registerTool(
    'draw_tarot_card',
    {
      title: 'おもちタロットを1枚引く',
      description: '登録済みタロットカードから1枚引き（通常モード / 恋愛モード対応）、メッセージとシェア用テキストを返します。',
      inputSchema: {
        mode: z.enum(['daily', 'love']).optional().describe('daily（通常）または love（恋愛アドバイス付き）。既定: daily'),
        cardName: z.string().optional().describe('特定カードを引く場合の nameEn または nameJp（省略時はランダム）')
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async (args) => {
      try {
        const tarot = await store.readJson('tarot');
        if (!Array.isArray(tarot) || tarot.length === 0) {
          throw new Error('タロットカードが登録されていません');
        }
        const mode = args.mode || 'daily';
        let card;
        if (args.cardName) {
          const needle = args.cardName.trim().toLowerCase();
          card = tarot.find(
            (c) => c.nameEn.toLowerCase() === needle || c.nameJp.toLowerCase() === needle
          );
          if (!card) {
            throw new Error(`指定されたカードが見つかりません: ${args.cardName}`);
          }
        } else {
          card = tarot[Math.floor(Math.random() * tarot.length)];
        }

        const shareText =
          `【OMOCHI TUNE タロット占い結果】\n` +
          `今日の私のカードは：「${card.nameJp}」でした！✨\n\n` +
          `${card.desc}` +
          (mode === 'love' && card.loveAdvice ? `\n\n💖 おもちちゃんの恋愛アドバイス♡\n${card.loveAdvice}` : '') +
          `\n\n#おもちのタロット占い #OMOCHITUNE\n${SITE_URL}`;

        return ok({
          mode,
          card,
          loveAdvice: mode === 'love' ? card.loveAdvice : undefined,
          shareText
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // 4. get_settings
  server.registerTool(
    'get_settings',
    {
      title: 'サイト設定を取得',
      description: 'content/settings.json（セクション表示切替、予約リンク・文言、Instagram、アクセス動画URL）を取得します。',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async () => {
      try {
        return ok({ settings: await store.readJson('settings') });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // 5. update_settings
  server.registerTool(
    'update_settings',
    {
      title: 'サイト設定を更新',
      description: 'content/settings.json を部分更新します。URL フィールドは http(s):// のみ許可します。',
      inputSchema: {
        showTarot: z.boolean().optional().describe('タロット占いセクションを表示するか'),
        showGallery: z.boolean().optional().describe('おもち図鑑セクションを表示するか'),
        showColumn: z.boolean().optional().describe('おもちコラムセクションを表示するか'),
        showSchedule: z.boolean().optional().describe('開催日程セクションを表示するか'),
        reservationUrl: z.string().optional().describe('事前予約リンク URL'),
        reservationLabel: z.string().optional().describe('予約ボタンの表示文言'),
        walkInText: z.string().optional().describe('当日参加の案内文'),
        instagramUrl: z.string().optional().describe('Instagram プロフィール URL'),
        instagramHandle: z.string().optional().describe('Instagram ハンドル（例: @omochitune）'),
        accessVideoUrl: z.string().optional().describe('アクセス動画 URL（空文字でクリア可）')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (args) => {
      try {
        const current = await store.readJson('settings');
        const definedPatch = Object.fromEntries(
          Object.entries(args).filter(([, value]) => value !== undefined)
        );
        if (Object.keys(definedPatch).length === 0) {
          throw new Error('更新する設定項目を1つ以上指定してください');
        }
        const nextSettings = validateSettings({ ...current, ...definedPatch });
        await store.writeJson('settings', nextSettings);
        return ok({ updated: true, settings: nextSettings });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // 6. list_columns
  server.registerTool(
    'list_columns',
    {
      title: 'おもちコラム一覧を取得',
      description: 'content/columns.json からコラム一覧を取得します。タグ・キーワード・件数で絞り込み可能です。',
      inputSchema: {
        tag: z.string().optional().describe('カテゴリタグで絞り込み'),
        query: z.string().optional().describe('タイトル・要約・本文キーワードで検索'),
        limit: z.number().int().min(1).max(100).optional().describe('最大取得件数')
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (args) => {
      try {
        let items = await store.readJson('columns');
        if (args.tag) {
          items = items.filter((c) => c.tag === args.tag.trim());
        }
        if (args.query) {
          const q = args.query.trim().toLowerCase();
          items = items.filter(
            (c) =>
              c.title.toLowerCase().includes(q) ||
              c.summary.toLowerCase().includes(q) ||
              c.content.toLowerCase().includes(q)
          );
        }
        const total = items.length;
        const sliced = args.limit ? items.slice(0, args.limit) : items;
        return ok({ total, returned: sliced.length, items: sliced });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // 7. get_column
  server.registerTool(
    'get_column',
    {
      title: 'コラム記事を1件取得',
      description: '指定した ID のおもちコラム詳細を取得します。',
      inputSchema: {
        id: z.number().int().positive().describe('コラム ID')
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (args) => {
      try {
        const columns = await store.readJson('columns');
        const found = columns.find((c) => c.id === args.id);
        if (!found) {
          throw new Error(`ID=${args.id} のコラムが見つかりません`);
        }
        return ok({ column: found });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // 8. upsert_column
  server.registerTool(
    'upsert_column',
    {
      title: 'おもちコラムを作成・更新',
      description:
        'コラム記事を追加または更新します。id 省略時は max(id)+1 で新規作成。' +
        'content は安全タグ（p, br, strong, b, em, i, a, ul, ol, li, blockquote, h3, h4）のみ許可し、プレーンテキストは自動で <p> 段落化します。',
      inputSchema: {
        id: z.number().int().positive().optional().describe('既存記事を更新する場合の ID（省略時は新規ID自動採番）'),
        title: z.string().min(1).describe('記事タイトル'),
        date: z.string().optional().describe('公開日 YYYY.MM.DD（省略時は更新時既存維持、新規時は本日 JST）'),
        tag: z.string().min(1).describe('カテゴリタグ（例: 自己紹介, 日常, 占い）'),
        readTime: z.string().optional().describe('読了時間（例: 3分。省略時は文字数から自動算出）'),
        summary: z.string().min(1).describe('カード表示用の要約文'),
        content: z.string().min(1).describe('本文（安全HTML または プレーンテキスト）'),
        thumbnail: z.string().optional().describe('サムネイル画像パス/URL（例: images/uploads/thumb.jpg。空可）')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async (args) => {
      try {
        const columns = await store.readJson('columns');
        const idx = args.id !== undefined ? columns.findIndex((c) => c.id === args.id) : -1;
        const existing = idx >= 0 ? columns[idx] : null;
        const nextId =
          args.id !== undefined
            ? args.id
            : columns.length > 0
              ? Math.max(...columns.map((c) => c.id)) + 1
              : 1;

        const approxMinutes = Math.max(1, Math.ceil(stripTags(args.content).length / 400));
        const candidate = validateColumnItem({
          id: nextId,
          title: args.title,
          date: args.date ?? existing?.date ?? todayJstDot(now()),
          tag: args.tag,
          readTime: args.readTime ?? existing?.readTime ?? `${approxMinutes}分`,
          summary: args.summary,
          content: args.content,
          thumbnail: args.thumbnail ?? existing?.thumbnail ?? ''
        });

        const nextColumns = [...columns];
        if (idx >= 0) {
          nextColumns[idx] = candidate;
        } else {
          nextColumns.push(candidate);
        }
        await store.writeJson('columns', nextColumns);
        return ok({
          action: idx >= 0 ? 'updated' : 'created',
          column: candidate,
          total: nextColumns.length
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // 9. delete_column
  server.registerTool(
    'delete_column',
    {
      title: 'おもちコラムを削除',
      description: '指定した ID のコラムを content/columns.json から削除します。',
      inputSchema: {
        id: z.number().int().positive().describe('削除するコラム ID')
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    async (args) => {
      try {
        const columns = await store.readJson('columns');
        const idx = columns.findIndex((c) => c.id === args.id);
        if (idx < 0) {
          throw new Error(`ID=${args.id} のコラムが見つかりません`);
        }
        const [removed] = columns.splice(idx, 1);
        await store.writeJson('columns', columns);
        return ok({ deleted: true, removed, remaining: columns.length });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // 10. list_gallery
  server.registerTool(
    'list_gallery',
    {
      title: 'おもち図鑑一覧を取得',
      description: 'content/gallery.json のキャラクター一覧と利用可能な avatar パーツ選択肢を返します。',
      inputSchema: {
        type: z.string().optional().describe('タイプ文字列で部分一致フィルタ（任意）')
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (args) => {
      try {
        let items = await store.readJson('gallery');
        if (args.type) {
          const needle = args.type.trim().toLowerCase();
          items = items.filter((g) => g.type.toLowerCase().includes(needle));
        }
        return ok({
          total: items.length,
          avatarOptions: AVATAR_OPTIONS,
          items
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // 11. upsert_gallery_item
  server.registerTool(
    'upsert_gallery_item',
    {
      title: 'おもち図鑑キャラを追加・更新',
      description:
        'おもち図鑑キャラクターを追加または更新します。image には "avatar:sky|smile|none" 形式、' +
        '"avatar:ice"、またはアップロード済み画像パス・https:// URL を指定できます。',
      inputSchema: {
        id: z.number().int().positive().optional().describe('更新時の ID（省略時は新規 ID 自動採番）'),
        title: z.string().min(1).describe('キャラクター名'),
        desc: z.string().min(1).describe('紹介文'),
        image: z.string().min(1).describe('avatar:wings|face|item / avatar:ice / 画像パスまたは URL'),
        date: z.string().optional().describe('登録日 YYYY.MM.DD（省略時は更新時既存維持、新規時は本日 JST）'),
        type: z.string().min(1).describe('タイプ（例: 標準・天使型）'),
        features: z.string().min(1).describe('とくちょう説明')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async (args) => {
      try {
        const gallery = await store.readJson('gallery');
        const idx = args.id !== undefined ? gallery.findIndex((g) => g.id === args.id) : -1;
        const existing = idx >= 0 ? gallery[idx] : null;
        const nextId =
          args.id !== undefined
            ? args.id
            : gallery.length > 0
              ? Math.max(...gallery.map((g) => g.id)) + 1
              : 1;

        const candidate = validateGalleryItem({
          id: nextId,
          title: args.title,
          desc: args.desc,
          image: args.image,
          date: args.date ?? existing?.date ?? todayJstDot(now()),
          type: args.type,
          features: args.features
        });

        const nextGallery = [...gallery];
        if (idx >= 0) {
          nextGallery[idx] = candidate;
        } else {
          nextGallery.push(candidate);
        }
        await store.writeJson('gallery', nextGallery);
        return ok({
          action: idx >= 0 ? 'updated' : 'created',
          item: candidate,
          total: nextGallery.length
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // 12. delete_gallery_item
  server.registerTool(
    'delete_gallery_item',
    {
      title: 'おもち図鑑キャラを削除',
      description: '指定した ID のキャラクターを content/gallery.json から削除します。',
      inputSchema: {
        id: z.number().int().positive().describe('削除するキャラクター ID')
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    async (args) => {
      try {
        const gallery = await store.readJson('gallery');
        const idx = gallery.findIndex((g) => g.id === args.id);
        if (idx < 0) {
          throw new Error(`ID=${args.id} のキャラクターが見つかりません`);
        }
        const [removed] = gallery.splice(idx, 1);
        await store.writeJson('gallery', gallery);
        return ok({ deleted: true, removed, remaining: gallery.length });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // 13. list_tarot_cards
  server.registerTool(
    'list_tarot_cards',
    {
      title: 'タロットカード一覧を取得',
      description: 'content/tarot.json のカード一覧を取得します。',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async () => {
      try {
        const cards = await store.readJson('tarot');
        return ok({ total: cards.length, items: cards });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // 14. upsert_tarot_card
  server.registerTool(
    'upsert_tarot_card',
    {
      title: 'タロットカードを追加・更新',
      description: 'nameEn をキー（大文字小文字無視）としてタロットカードを追加または更新します。',
      inputSchema: {
        nameEn: z.string().min(1).describe('英語カード名（一意キー。例: The Star）'),
        nameJp: z.string().min(1).describe('日本語カード名（例: おもちのねがい）'),
        illust: z.string().min(1).describe('イラスト絵文字（例: 🌟）'),
        desc: z.string().min(1).describe('今日のメッセージ'),
        loveAdvice: z.string().optional().describe('恋愛リーディング用アドバイス（省略時は更新時既存維持、新規時は空文字）')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (args) => {
      try {
        const tarot = await store.readJson('tarot');
        const key = args.nameEn.trim().toLowerCase();
        const idx = tarot.findIndex((c) => c.nameEn.trim().toLowerCase() === key);
        const existing = idx >= 0 ? tarot[idx] : null;

        const candidate = validateTarotCard({
          nameEn: args.nameEn,
          nameJp: args.nameJp,
          illust: args.illust,
          desc: args.desc,
          loveAdvice: args.loveAdvice ?? existing?.loveAdvice ?? ''
        });

        const nextTarot = [...tarot];
        if (idx >= 0) {
          nextTarot[idx] = candidate;
        } else {
          nextTarot.push(candidate);
        }
        await store.writeJson('tarot', nextTarot);
        return ok({
          action: idx >= 0 ? 'updated' : 'created',
          card: candidate,
          total: nextTarot.length
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // 15. delete_tarot_card
  server.registerTool(
    'delete_tarot_card',
    {
      title: 'タロットカードを削除',
      description: '指定した nameEn のタロットカードを削除します。3枚引き UI 維持のため残り 3 枚未満になる削除は拒否します。',
      inputSchema: {
        nameEn: z.string().min(1).describe('削除するカードの nameEn')
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    async (args) => {
      try {
        const tarot = await store.readJson('tarot');
        const key = args.nameEn.trim().toLowerCase();
        const idx = tarot.findIndex((c) => c.nameEn.trim().toLowerCase() === key);
        if (idx < 0) {
          throw new Error(`nameEn="${args.nameEn}" のカードが見つかりません`);
        }
        if (tarot.length <= 3) {
          throw new Error('タロット占い（3枚引きUI）には最低 3 枚のカードが必要なため削除できません');
        }
        const [removed] = tarot.splice(idx, 1);
        await store.writeJson('tarot', tarot);
        return ok({ deleted: true, removed, remaining: tarot.length });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // 16. list_instagram_items
  server.registerTool(
    'list_instagram_items',
    {
      title: 'Instagram プレビュー一覧を取得',
      description: 'content/instagram.json の一覧（0始まりの index 付き）を取得します。',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async () => {
      try {
        const items = await store.readJson('instagram');
        return ok({
          total: items.length,
          avatarOptions: AVATAR_OPTIONS,
          items: items.map((item, index) => ({ index, ...item }))
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // 17. upsert_instagram_item
  server.registerTool(
    'upsert_instagram_item',
    {
      title: 'Instagram プレビューを追加・更新',
      description: '0 始まりの index を指定して更新、または省略して末尾に追加します。',
      inputSchema: {
        index: z.number().int().min(0).optional().describe('更新対象の 0 始まりインデックス（省略時は新規追加）'),
        label: z.string().min(1).describe('タイル上の表示ラベル'),
        alt: z.string().min(1).describe('画像 alt 説明'),
        url: z.string().optional().describe('遷移先 URL（省略時は settings.instagramUrl）'),
        image: z.string().optional().describe('画像パスまたは URL（avatar と排他推奨、空文字可）'),
        avatar: z.string().optional().describe('SVG アバター指定（例: sky|smile|none や ice。avatar: プレフィックス不要）'),
        theme: z.enum(['', 'pink', 'night']).optional().describe('表示テーマ（"", "pink", "night"）')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async (args) => {
      try {
        const [items, settings] = await Promise.all([
          store.readJson('instagram'),
          store.readJson('settings')
        ]);

        let existing = null;
        if (args.index !== undefined) {
          if (args.index >= items.length) {
            throw new Error(`index=${args.index} は範囲外です（0〜${Math.max(0, items.length - 1)}）`);
          }
          existing = items[args.index];
        }

        const candidate = validateInstagramItem({
          label: args.label,
          alt: args.alt,
          url: args.url ?? existing?.url ?? settings.instagramUrl,
          image: args.image ?? existing?.image ?? '',
          avatar: args.avatar ?? existing?.avatar ?? '',
          theme: args.theme ?? existing?.theme ?? ''
        });

        const nextItems = [...items];
        let resultIndex;
        if (args.index !== undefined) {
          nextItems[args.index] = candidate;
          resultIndex = args.index;
        } else {
          nextItems.push(candidate);
          resultIndex = nextItems.length - 1;
        }
        await store.writeJson('instagram', nextItems);
        return ok({
          action: args.index !== undefined ? 'updated' : 'created',
          index: resultIndex,
          item: candidate,
          total: nextItems.length
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // 18. delete_instagram_item
  server.registerTool(
    'delete_instagram_item',
    {
      title: 'Instagram プレビューを削除',
      description: '指定した 0 始まり index の Instagram プレビューを削除します。',
      inputSchema: {
        index: z.number().int().min(0).describe('削除対象の 0 始まりインデックス')
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    async (args) => {
      try {
        const items = await store.readJson('instagram');
        if (args.index >= items.length) {
          throw new Error(`index=${args.index} は範囲外です（0〜${Math.max(0, items.length - 1)}）`);
        }
        const [removed] = items.splice(args.index, 1);
        await store.writeJson('instagram', items);
        return ok({ deleted: true, index: args.index, removed, remaining: items.length });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // 19. save_uploaded_image
  server.registerTool(
    'save_uploaded_image',
    {
      title: 'アップロード画像を保存',
      description:
        'images/uploads/ に画像ファイル（png/jpg/jpeg/webp/gif、最大5MiB、SVG不可）を保存し、' +
        'コラムや図鑑で使える相対パスを返します。',
      inputSchema: {
        filename: z.string().min(1).describe('保存ファイル名（英数字・._- のみ、例: flyer-202612.webp）'),
        base64Data: z.string().optional().describe('Base64 エンコード画像データ（data:image/...;base64, 可）'),
        sourcePath: z.string().optional().describe('ローカル画像ファイルの絶対パス（base64Data の代替）')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (args) => {
      try {
        const buffer = await decodeUploadedImageInput(args);
        const saved = await store.saveUploadedImage({
          filename: args.filename,
          buffer
        });
        return ok({
          saved: true,
          filename: saved.filename,
          relativePath: saved.relativePath,
          publicPath: saved.publicPath,
          bytes: saved.bytes
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // 20. validate_and_build
  server.registerTool(
    'validate_and_build',
    {
      title: '全コンテンツ検証とサイトビルド',
      description:
        '全5JSONのスキーマ/整合性チェック、npm run build（dist/, feed.xml, sitemap.xml, robots.txt 生成と漏洩チェック）、' +
        'および任意の Playwright E2E テストを実行します。',
      inputSchema: {
        runBuild: z.boolean().optional().describe('ビルドを実行するか（既定: true）'),
        runE2E: z.boolean().optional().describe('Playwright E2E テストも実行するか（既定: false）')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (args) => {
      try {
        const all = await store.readAllContent();
        const normalized = validateAllContent(all);
        const doBuild = args.runBuild !== false;
        const doE2E = args.runE2E === true;

        const build = doBuild || doE2E ? await ops.runBuild() : null;
        const e2e = doE2E ? await ops.runE2E() : null;

        return ok({
          valid: true,
          counts: {
            columns: normalized.columns.length,
            gallery: normalized.gallery.length,
            tarot: normalized.tarot.length,
            instagram: normalized.instagram.length
          },
          build,
          e2e
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // 21. get_publish_status
  server.registerTool(
    'get_publish_status',
    {
      title: '公開待ちの Git 変更状態を確認',
      description: '現在のブランチ、公開対象（content/*.json, images/uploads/*）の変更一覧、その他の変更一覧、直近コミットを取得します。',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async () => {
      try {
        return ok(await ops.getPublishStatus());
      } catch (err) {
        return fail(err);
      }
    }
  );

  // 22. publish_changes
  server.registerTool(
    'publish_changes',
    {
      title: '変更を検証し GitHub へ反映（PR / Push）',
      description:
        'content/*.json と images/uploads/* のみを選択的にステージ・コミットして GitHub PR 作成または main push を行います。' +
        '既定（confirm: false）では Git 操作を行わない dry-run プレビューのみ返します。',
      inputSchema: {
        mode: z.enum(['pr', 'push_main']).optional().describe('公開方法（pr: 新規ブランチ+PR作成 [既定], push_main: mainへ直接push）'),
        commitMessage: z.string().min(1).describe('1行のコミットメッセージ（120文字以内）'),
        prTitle: z.string().optional().describe('mode="pr" 時の PR タイトル（省略時は commitMessage）'),
        prBody: z.string().optional().describe('mode="pr" 時の PR 本文（省略時は更新ファイル一覧を自動生成）'),
        branchName: z.string().optional().describe('mode="pr" 時の作成ブランチ名（省略時は content/mcp-YYYYMMDD-HHMMSS）'),
        runValidation: z.boolean().optional().describe('コミット前に全JSON検証＋ビルドを実行するか（既定: true）'),
        confirm: z.boolean().optional().describe('true を指定した場合のみ実際に commit/push/PR 作成を実行（既定: false = dry-run）')
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      _meta: { ui: { visibility: [...APP_AND_MODEL] } }
    },
    async (args) => {
      try {
        const result = await ops.publishChanges(args, async () => {
          const all = await store.readAllContent();
          validateAllContent(all);
        });
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // 23. open_dashboard (MCP App UI entrypoint)
  registerAppTool(
    server,
    'open_dashboard',
    {
      title: 'OMOCHI TUNE 管理ダッシュボードを開く',
      description:
        'Antigravity サイドパネル・チャット内に OMOCHI TUNE の対話型管理ダッシュボード（開催予定・設定・コンテンツ一覧・タロット試し引き・dry-run 公開確認）を表示します。',
      inputSchema: {
        tab: z
          .enum(['overview', 'settings', 'content', 'publish'])
          .optional()
          .describe('初期表示タブ（省略時は overview）')
      },
      annotations: {
        title: 'OMOCHI TUNE ダッシュボード',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      _meta: {
        ui: {
          resourceUri: DASHBOARD_URI,
          visibility: [...APP_AND_MODEL]
        },
        'com.google.antigravity/ui': {
          entrypoints: [
            { type: 'aux_pane', title: 'OMOCHI TUNE' },
            { type: 'global', title: 'OMOCHI TUNE' }
          ]
        }
      }
    },
    async (args = {}) => {
      try {
        const tab = args?.tab || 'overview';
        const snapshot = await buildDashboardSnapshot(tab);
        const ov = snapshot.overview;
        const summary = [
          `OMOCHI TUNE ダッシュボード (${tab})`,
          `次回開催: ${ov.schedule.nextEvent.displayDate} ${ov.schedule.nextEvent.startTime}〜${ov.schedule.nextEvent.endTime} (${ov.schedule.statusLabel})`,
          `コンテンツ件数: コラム ${ov.counts.columns} / 図鑑 ${ov.counts.gallery} / タロット ${ov.counts.tarot} / Instagram ${ov.counts.instagram}`,
          `ブランチ: ${ov.git.currentBranch} (公開待ち ${ov.git.allowedContentPaths.length} 件)`
        ].join('\n');
        return {
          content: [{ type: 'text', text: summary }],
          structuredContent: snapshot
        };
      } catch (err) {
        return fail(err);
      }
    }
  );

  return server;
}
