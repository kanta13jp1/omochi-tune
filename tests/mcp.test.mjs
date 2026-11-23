import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createOmochiMcpServer, DASHBOARD_URI } from '../mcp/core.mjs';
import { startHttpServer } from '../mcp/http.mjs';
import { createRepoOps } from '../mcp/ops.mjs';
import { getEventSchedule, getFirstThursdayOfMonth } from '../mcp/schedule.mjs';
import {
  validateAllContent,
  validateAvatarString,
  validateColumnHtml,
  validateSafeUrl,
  validateUploadFilename
} from '../mcp/schemas.mjs';
import { createFileRepositoryStore } from '../mcp/store.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const EXPECTED_TOOLS = [
  'get_site_overview',
  'get_event_schedule',
  'draw_tarot_card',
  'get_settings',
  'update_settings',
  'list_columns',
  'get_column',
  'upsert_column',
  'delete_column',
  'list_gallery',
  'upsert_gallery_item',
  'delete_gallery_item',
  'list_tarot_cards',
  'upsert_tarot_card',
  'delete_tarot_card',
  'list_instagram_items',
  'upsert_instagram_item',
  'delete_instagram_item',
  'save_uploaded_image',
  'validate_and_build',
  'get_publish_status',
  'publish_changes',
  'open_dashboard'
];

const EXPECTED_RESOURCES = [
  'ui://omochi-tune/dashboard.html',
  'omochi://site/overview',
  'omochi://content/settings',
  'omochi://content/columns',
  'omochi://content/gallery',
  'omochi://content/tarot',
  'omochi://content/instagram'
];

async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function parseToolPayload(result) {
  assert.ok(Array.isArray(result.content) && result.content.length > 0);
  const textBlock = result.content.find((c) => c.type === 'text');
  assert.ok(textBlock);
  return JSON.parse(textBlock.text);
}

test('schedule: first Thursday calculation matches calendar across months', () => {
  // 2026-10-01 is Thursday -> 1st
  assert.equal(getFirstThursdayOfMonth(2026, 9).dateStr, '2026-10-01');
  // 2026-11-01 is Sunday -> 5th
  assert.equal(getFirstThursdayOfMonth(2026, 10).dateStr, '2026-11-05');
  // 2026-12-01 is Tuesday -> 3rd
  assert.equal(getFirstThursdayOfMonth(2026, 11).dateStr, '2026-12-03');
  // 2026-05-01 is Friday -> 7th
  assert.equal(getFirstThursdayOfMonth(2026, 4).dateStr, '2026-05-07');
});

test('schedule: live hours, pre-open, and 23:00 JST rollover match index.html', () => {
  // Before open on first Thursday (2026-12-03 19:59 JST)
  const beforeOpen = getEventSchedule({ count: 3, now: new Date('2026-12-03T19:59:00+09:00') });
  assert.equal(beforeOpen.nextEvent.dateStr, '2026-12-03');
  assert.equal(beforeOpen.isToday, true);
  assert.equal(beforeOpen.isLiveNow, false);
  assert.equal(beforeOpen.statusLabel, '本日 20:00 OPEN!');

  // Live window start (2026-12-03 20:00 JST)
  const liveStart = getEventSchedule({ count: 3, now: new Date('2026-12-03T20:00:00+09:00') });
  assert.equal(liveStart.nextEvent.dateStr, '2026-12-03');
  assert.equal(liveStart.isToday, true);
  assert.equal(liveStart.isLiveNow, true);
  assert.equal(liveStart.statusLabel, '● 本日 20:00〜23:00 開催中！');

  // Live window end-1m (2026-12-03 22:59 JST)
  const liveEnd = getEventSchedule({ count: 3, now: new Date('2026-12-03T22:59:59+09:00') });
  assert.equal(liveEnd.isLiveNow, true);

  // At 23:00 JST rollover to January 2027 (2027-01-01 is Friday -> Jan 7)
  const afterClose = getEventSchedule({ count: 2, now: new Date('2026-12-03T23:00:00+09:00') });
  assert.equal(afterClose.nextEvent.dateStr, '2027-01-07');
  assert.equal(afterClose.isLiveNow, false);
  assert.equal(afterClose.isToday, false);
  assert.equal(afterClose.upcoming.length, 2);
});

test('schemas: URL, HTML, avatar, and upload filename validators enforce security rules', () => {
  // URLs
  assert.equal(validateSafeUrl('https://ig.me/m/omochitune'), 'https://ig.me/m/omochitune');
  assert.throws(() => validateSafeUrl('javascript:alert(1)'));
  assert.throws(() => validateSafeUrl('data:text/html,<script>alert(1)</script>'));
  assert.throws(() => validateSafeUrl('../secret.png', { allowRelativeImage: true }));
  assert.equal(validateSafeUrl('images/uploads/test.webp', { allowRelativeImage: true }), 'images/uploads/test.webp');

  // Column HTML auto-paragraph & whitelist
  assert.equal(
    validateColumnHtml('1行目\n改行付き\n\n2段落目 <テスト>'),
    '<p>1行目<br>改行付き</p><p>2段落目 &lt;テスト&gt;</p>'
  );
  assert.equal(
    validateColumnHtml('<p>こんにちは<br /><a href="https://example.com" target="_blank" rel="noopener">詳細</a></p>'),
    '<p>こんにちは<br /><a href="https://example.com" target="_blank" rel="noopener">詳細</a></p>'
  );
  assert.throws(() => validateColumnHtml('<p>bad</p><script>alert(1)</script>'));
  assert.throws(() => validateColumnHtml('<p onclick="alert(1)">bad</p>'));
  assert.throws(() => validateColumnHtml('<img src="https://example.com/a.png">'));
  assert.throws(() => validateColumnHtml('<p><a href="javascript:alert(1)">x</a></p>'));

  // Avatar strings
  assert.equal(validateAvatarString('avatar:sky|smile|none', { requirePrefix: true }), 'avatar:sky|smile|none');
  assert.equal(validateAvatarString('avatar:ice', { requirePrefix: true }), 'avatar:ice');
  assert.equal(validateAvatarString('gold|wink|star'), 'gold|wink|star');
  assert.throws(() => validateAvatarString('avatar:evil|smile|none', { requirePrefix: true }));
  assert.throws(() => validateAvatarString('sky|smile'));

  // Upload filenames
  assert.equal(validateUploadFilename('omochi-flyer_2026.png'), 'omochi-flyer_2026.png');
  assert.throws(() => validateUploadFilename('xss.svg'));
  assert.throws(() => validateUploadFilename('../escape.png'));
  assert.throws(() => validateUploadFilename('sub/dir.png'));
});

test('schemas: validateAllContent requires at least 3 tarot cards and unique IDs', async () => {
  const [settings, columns, gallery, tarot, instagram] = await Promise.all([
    readFile(join(REPO_ROOT, 'content/settings.json'), 'utf8').then(JSON.parse),
    readFile(join(REPO_ROOT, 'content/columns.json'), 'utf8').then(JSON.parse),
    readFile(join(REPO_ROOT, 'content/gallery.json'), 'utf8').then(JSON.parse),
    readFile(join(REPO_ROOT, 'content/tarot.json'), 'utf8').then(JSON.parse),
    readFile(join(REPO_ROOT, 'content/instagram.json'), 'utf8').then(JSON.parse)
  ]);

  const valid = validateAllContent({ settings, columns, gallery, tarot, instagram });
  assert.equal(valid.columns.length, columns.length);

  assert.throws(() =>
    validateAllContent({ settings, columns, gallery, tarot: tarot.slice(0, 2), instagram })
  );
  assert.throws(() =>
    validateAllContent({ settings, columns: [columns[0], columns[0]], gallery, tarot, instagram })
  );
});

test('stdio MCP integration: resources, all 22 tools, CRUD round-trips, build, and dry-run publish', async () => {
  const tmpRepo = await mkdtemp(join(tmpdir(), 'omochi-mcp-test-'));
  let client;

  try {
    // Prepare isolated repository copy (never mutating real workspace content/)
    for (const dir of ['content', 'images', 'admin', 'vendor', 'scripts', 'js']) {
      if (await pathExists(join(REPO_ROOT, dir))) {
        await cp(join(REPO_ROOT, dir), join(tmpRepo, dir), { recursive: true });
      }
    }
    await cp(join(REPO_ROOT, 'index.html'), join(tmpRepo, 'index.html'));
    // Add mcp/ and .agents/ placeholders to verify scripts/build.mjs excludes them from dist/
    await mkdir(join(tmpRepo, 'mcp'), { recursive: true });
    await writeFile(join(tmpRepo, 'mcp', 'dummy.mjs'), '// excluded\n', 'utf8');
    await mkdir(join(tmpRepo, '.agents'), { recursive: true });
    await writeFile(join(tmpRepo, '.agents', 'mcp_config.json'), '{}', 'utf8');

    execFileSync('git', ['init', '-b', 'main'], { cwd: tmpRepo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpRepo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tmpRepo, stdio: 'ignore' });
    execFileSync('git', ['add', '.'], { cwd: tmpRepo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'Initial test snapshot'], { cwd: tmpRepo, stdio: 'ignore' });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(REPO_ROOT, 'mcp', 'server.mjs'), '--repo', tmpRepo],
      cwd: REPO_ROOT,
      stderr: 'pipe'
    });

    client = new Client({ name: 'omochi-test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);

    // 1. Verify tools & resources registration
    const toolsRes = await client.listTools();
    const toolNames = toolsRes.tools.map((t) => t.name);
    assert.equal(toolNames.length, EXPECTED_TOOLS.length);
    for (const expected of EXPECTED_TOOLS) {
      assert.ok(toolNames.includes(expected), `Missing tool: ${expected}`);
    }

    const resourcesRes = await client.listResources();
    const resourceUris = resourcesRes.resources.map((r) => r.uri);
    assert.equal(resourceUris.length, EXPECTED_RESOURCES.length);
    for (const expectedUri of EXPECTED_RESOURCES) {
      assert.ok(resourceUris.includes(expectedUri), `Missing resource: ${expectedUri}`);
    }

    // 2. Read resources (derive baseline counts/IDs dynamically so CMS additions do not break tests)
    const [initialColumns, initialGallery, initialTarot, initialInstagram] = await Promise.all([
      readFile(join(tmpRepo, 'content', 'columns.json'), 'utf8').then(JSON.parse),
      readFile(join(tmpRepo, 'content', 'gallery.json'), 'utf8').then(JSON.parse),
      readFile(join(tmpRepo, 'content', 'tarot.json'), 'utf8').then(JSON.parse),
      readFile(join(tmpRepo, 'content', 'instagram.json'), 'utf8').then(JSON.parse)
    ]);
    const expectedNextColId = Math.max(0, ...initialColumns.map((c) => c.id)) + 1;
    const expectedNoticeCount = initialColumns.filter((c) => c.tag === 'お知らせ').length;
    const expectedNextGalId = Math.max(0, ...initialGallery.map((g) => g.id)) + 1;

    const overviewRes = await client.readResource({ uri: 'omochi://site/overview' });
    const overviewFromResource = JSON.parse(overviewRes.contents[0].text);
    assert.equal(overviewFromResource.counts.columns, initialColumns.length);
    assert.equal(overviewFromResource.counts.tarot, initialTarot.length);

    const settingsResource = await client.readResource({ uri: 'omochi://content/settings' });
    const settingsFromResource = JSON.parse(settingsResource.contents[0].text);
    assert.equal(settingsFromResource.instagramHandle, '@omochitune');

    // 2b. Verify MCP App UI resource & open_dashboard with empty args {}
    const uiResource = await client.readResource({ uri: DASHBOARD_URI });
    assert.equal(uiResource.contents[0].mimeType, 'text/html;profile=mcp-app');
    const uiHtml = uiResource.contents[0].text;
    assert.ok(uiHtml.includes('<!doctype html>') && Buffer.byteLength(uiHtml, 'utf8') < 10 * 1024 * 1024);

    const dashCall = await client.callTool({ name: 'open_dashboard', arguments: {} });
    assert.notEqual(dashCall.isError, true);
    assert.equal(dashCall.structuredContent.tab, 'overview');
    assert.equal(dashCall.structuredContent.overview.counts.columns, initialColumns.length);
    assert.equal(dashCall.structuredContent.tarot.length, initialTarot.length);

    // 3. Overview, schedule, and tarot draw
    const overviewTool = parseToolPayload(await client.callTool({ name: 'get_site_overview', arguments: {} }));
    assert.equal(overviewTool.git.currentBranch, 'main');

    const schedulePayload = parseToolPayload(
      await client.callTool({
        name: 'get_event_schedule',
        arguments: { count: 4, fromDate: '2026-11-23' }
      })
    );
    assert.equal(schedulePayload.upcoming.length, 4);
    assert.equal(schedulePayload.nextEvent.dateStr, '2026-12-03');

    const tarotDraw = parseToolPayload(
      await client.callTool({
        name: 'draw_tarot_card',
        arguments: { mode: 'love', cardName: 'The Star' }
      })
    );
    assert.equal(tarotDraw.card.nameEn, 'The Star');
    assert.ok(tarotDraw.loveAdvice.length > 0);
    assert.ok(tarotDraw.shareText.includes('おもちのねがい'));

    // 4. Settings read/update + negative validation
    const initialSettings = parseToolPayload(await client.callTool({ name: 'get_settings', arguments: {} }));
    assert.equal(initialSettings.settings.showTarot, true);

    const updatedSettings = parseToolPayload(
      await client.callTool({
        name: 'update_settings',
        arguments: { reservationLabel: '✨ ご予約はこちら' }
      })
    );
    assert.equal(updatedSettings.settings.reservationLabel, '✨ ご予約はこちら');

    const badSettings = await client.callTool({
      name: 'update_settings',
      arguments: { reservationUrl: 'javascript:alert(1)' }
    });
    assert.equal(badSettings.isError, true);

    // 5. Columns CRUD + XSS rejection
    const createdCol = parseToolPayload(
      await client.callTool({
        name: 'upsert_column',
        arguments: {
          title: '冬の天井裏ニュース',
          tag: 'お知らせ',
          summary: '12月の特別メッセージです。',
          content: 'あたたかいお茶を用意してお待ちしています。\n\nぜひ遊びに来てください。'
        }
      })
    );
    assert.equal(createdCol.action, 'created');
    assert.equal(createdCol.column.id, expectedNextColId);
    assert.equal(
      createdCol.column.content,
      '<p>あたたかいお茶を用意してお待ちしています。</p><p>ぜひ遊びに来てください。</p>'
    );

    const fetchedCol = parseToolPayload(
      await client.callTool({ name: 'get_column', arguments: { id: expectedNextColId } })
    );
    assert.equal(fetchedCol.column.title, '冬の天井裏ニュース');

    const filteredCols = parseToolPayload(
      await client.callTool({ name: 'list_columns', arguments: { tag: 'お知らせ' } })
    );
    assert.equal(filteredCols.total, expectedNoticeCount + 1);
    assert.ok(filteredCols.items.some((c) => c.id === expectedNextColId));

    const badCol = await client.callTool({
      name: 'upsert_column',
      arguments: {
        title: 'XSS test',
        tag: 'test',
        summary: 'summary',
        content: '<p>hello</p><script>alert(1)</script>'
      }
    });
    assert.equal(badCol.isError, true);

    const deletedCol = parseToolPayload(
      await client.callTool({ name: 'delete_column', arguments: { id: expectedNextColId } })
    );
    assert.equal(deletedCol.deleted, true);
    assert.equal(deletedCol.remaining, initialColumns.length);

    // 6. Gallery CRUD + negative avatar check
    const createdGal = parseToolPayload(
      await client.callTool({
        name: 'upsert_gallery_item',
        arguments: {
          title: 'テストおもち',
          desc: 'テスト用のおもちちゃん',
          image: 'avatar:gold|wink|star',
          type: 'テスト型',
          features: 'きらめく星'
        }
      })
    );
    assert.equal(createdGal.action, 'created');
    assert.equal(createdGal.item.id, expectedNextGalId);

    const listedGal = parseToolPayload(await client.callTool({ name: 'list_gallery', arguments: {} }));
    assert.equal(listedGal.total, initialGallery.length + 1);
    assert.ok(listedGal.avatarOptions.wings.includes('sky'));

    const badGal = await client.callTool({
      name: 'upsert_gallery_item',
      arguments: {
        title: 'Invalid Avatar',
        desc: 'desc',
        image: 'avatar:invalid_wings|smile|none',
        type: 'test',
        features: 'test'
      }
    });
    assert.equal(badGal.isError, true);

    const deletedGal = parseToolPayload(
      await client.callTool({ name: 'delete_gallery_item', arguments: { id: expectedNextGalId } })
    );
    assert.equal(deletedGal.deleted, true);

    // 7. Tarot CRUD + minimum 3 cards guard
    const createdCard = parseToolPayload(
      await client.callTool({
        name: 'upsert_tarot_card',
        arguments: {
          nameEn: 'The Moon',
          nameJp: 'おもちの夜空',
          illust: '🌙',
          desc: '静かな夜に心を整えるカード。'
        }
      })
    );
    assert.equal(createdCard.action, 'created');

    const updatedCard = parseToolPayload(
      await client.callTool({
        name: 'upsert_tarot_card',
        arguments: {
          nameEn: 'the moon',
          nameJp: 'おもちの満月',
          illust: '🌕',
          desc: 'アップデートされたメッセージ。',
          loveAdvice: '夜の散歩が吉♡'
        }
      })
    );
    assert.equal(updatedCard.action, 'updated');
    assert.equal(updatedCard.total, initialTarot.length + 1);

    const listCards = parseToolPayload(await client.callTool({ name: 'list_tarot_cards', arguments: {} }));
    assert.equal(listCards.total, initialTarot.length + 1);

    // Delete cards down to 3, then the next deletion attempt (at 3 cards) must fail
    const orderedNames = [
      'the moon',
      ...listCards.items.map((c) => c.nameEn).filter((n) => n.toLowerCase() !== 'the moon')
    ];
    const toDelete = orderedNames.slice(0, listCards.total - 3);
    for (const name of toDelete) {
      const del = await client.callTool({ name: 'delete_tarot_card', arguments: { nameEn: name } });
      assert.notEqual(del.isError, true);
    }
    const remainingCard = orderedNames[listCards.total - 3];
    const minCardBlock = await client.callTool({
      name: 'delete_tarot_card',
      arguments: { nameEn: remainingCard }
    });
    assert.equal(minCardBlock.isError, true);

    // 8. Instagram CRUD + negative URL
    const createdInsta = parseToolPayload(
      await client.callTool({
        name: 'upsert_instagram_item',
        arguments: {
          label: '冬の特別開催',
          alt: '冬の開催案内',
          avatar: 'sky|relax|candle',
          theme: 'night'
        }
      })
    );
    assert.equal(createdInsta.action, 'created');
    assert.equal(createdInsta.index, initialInstagram.length);

    const listedInsta = parseToolPayload(await client.callTool({ name: 'list_instagram_items', arguments: {} }));
    assert.equal(listedInsta.total, initialInstagram.length + 1);

    const badInsta = await client.callTool({
      name: 'upsert_instagram_item',
      arguments: {
        label: 'bad',
        alt: 'bad',
        url: 'javascript:alert(1)'
      }
    });
    assert.equal(badInsta.isError, true);

    const deletedInsta = parseToolPayload(
      await client.callTool({ name: 'delete_instagram_item', arguments: { index: createdInsta.index } })
    );
    assert.equal(deletedInsta.deleted, true);

    // 9. Image upload (valid PNG + blocked SVG / path traversal)
    const tinyPngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+fX8AAAAASUVORK5CYII=';
    const savedImg = parseToolPayload(
      await client.callTool({
        name: 'save_uploaded_image',
        arguments: {
          filename: 'flyer-test.png',
          base64Data: tinyPngBase64
        }
      })
    );
    assert.equal(savedImg.saved, true);
    assert.equal(savedImg.relativePath, 'images/uploads/flyer-test.png');
    assert.equal(await pathExists(join(tmpRepo, 'images', 'uploads', 'flyer-test.png')), true);

    const svgReject = await client.callTool({
      name: 'save_uploaded_image',
      arguments: { filename: 'bad.svg', base64Data: tinyPngBase64 }
    });
    assert.equal(svgReject.isError, true);

    const traversalReject = await client.callTool({
      name: 'save_uploaded_image',
      arguments: { filename: '../bad.png', base64Data: tinyPngBase64 }
    });
    assert.equal(traversalReject.isError, true);

    // 10. validate_and_build + dist exclusion verification
    const buildPayload = parseToolPayload(
      await client.callTool({
        name: 'validate_and_build',
        arguments: { runBuild: true, runE2E: false }
      })
    );
    assert.equal(buildPayload.valid, true);
    assert.equal(buildPayload.build.ok, true);
    assert.equal(await pathExists(join(tmpRepo, 'dist', 'feed.xml')), true);
    assert.equal(await pathExists(join(tmpRepo, 'dist', 'sitemap.xml')), true);
    assert.equal(await pathExists(join(tmpRepo, 'dist', 'robots.txt')), true);
    assert.equal(await pathExists(join(tmpRepo, 'dist', 'mcp')), false);
    assert.equal(await pathExists(join(tmpRepo, 'dist', '.agents')), false);

    // 11. Publish status & dry-run safeguard (confirm: false)
    await writeFile(join(tmpRepo, 'unrelated-note.txt'), 'do not commit me\n', 'utf8');
    const pubStatus = parseToolPayload(await client.callTool({ name: 'get_publish_status', arguments: {} }));
    assert.ok(pubStatus.allowedContentPaths.includes('content/settings.json'));
    assert.ok(pubStatus.allowedContentPaths.includes('images/uploads/flyer-test.png'));
    assert.ok(pubStatus.otherPaths.includes('unrelated-note.txt'));

    const beforeHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmpRepo, encoding: 'utf8' }).trim();
    const dryRun = parseToolPayload(
      await client.callTool({
        name: 'publish_changes',
        arguments: {
          mode: 'pr',
          commitMessage: 'Update winter settings and flyer',
          confirm: false
        }
      })
    );
    const afterHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmpRepo, encoding: 'utf8' }).trim();
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.published, false);
    assert.ok(dryRun.filesToStage.includes('content/settings.json'));
    assert.ok(dryRun.filesToStage.includes('images/uploads/flyer-test.png'));
    assert.ok(dryRun.ignoredOtherFiles.includes('unrelated-note.txt'));
    assert.equal(afterHead, beforeHead);
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
    await rm(tmpRepo, { recursive: true, force: true }).catch(() => {});
  }
});

test('Streamable HTTP transport: fail-closed auth, host/origin guards, and MCP client calls', async () => {
  const store = createFileRepositoryStore(REPO_ROOT);
  const ops = createRepoOps(REPO_ROOT);
  const token = 'omochi-test-bearer-token';

  // Non-loopback bind without token must fail closed
  await assert.rejects(() =>
    startHttpServer({
      createServer: () => createOmochiMcpServer({ store, ops }),
      host: '0.0.0.0',
      port: 0
    })
  );

  const handle = await startHttpServer({
    createServer: () => createOmochiMcpServer({ store, ops }),
    host: '127.0.0.1',
    port: 0,
    token
  });

  let client;
  try {
    const base = `http://127.0.0.1:${handle.port}`;

    // 1. Health endpoint
    const healthRes = await fetch(`${base}/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = await healthRes.json();
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.authRequired, true);

    // 2. Unauthenticated POST /mcp -> 401
    const unauthRes = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    assert.equal(unauthRes.status, 401);

    // 3. Bad Origin header -> 403
    const badOriginRes = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        Origin: 'https://evil.example'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    });
    assert.equal(badOriginRes.status, 403);

    // 4. Bad Host header -> 403 (via node:http to bypass fetch forbidden Host restriction)
    const badHostStatus = await new Promise((resolveStatus, rejectErr) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: handle.port,
          path: '/mcp',
          method: 'POST',
          headers: {
            Host: 'evil.example',
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        },
        (res) => {
          res.resume();
          res.on('end', () => resolveStatus(res.statusCode));
        }
      );
      req.on('error', rejectErr);
      req.end('{}');
    });
    assert.equal(badHostStatus, 403);

    // 5. GET /mcp -> 405 Method Not Allowed
    const getMcpRes = await fetch(`${base}/mcp`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(getMcpRes.status, 405);

    // 6. Real StreamableHTTPClientTransport end-to-end session
    const transport = new StreamableHTTPClientTransport(new URL(handle.endpointUrl), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    });
    client = new Client({ name: 'omochi-http-test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);

    const tools = await client.listTools();
    assert.equal(tools.tools.length, EXPECTED_TOOLS.length);

    const schedule = parseToolPayload(
      await client.callTool({ name: 'get_event_schedule', arguments: { count: 2 } })
    );
    assert.equal(schedule.upcoming.length, 2);

    const dash = await client.callTool({ name: 'open_dashboard', arguments: {} });
    assert.notEqual(dash.isError, true);
    assert.equal(dash.structuredContent.tab, 'overview');
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
    await handle.close();
  }
});
