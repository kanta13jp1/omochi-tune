import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [columns, gallery, instagram] = await Promise.all([
  readFile(join(repoRoot, 'content', 'columns.json'), 'utf8').then(JSON.parse),
  readFile(join(repoRoot, 'content', 'gallery.json'), 'utf8').then(JSON.parse),
  readFile(join(repoRoot, 'content', 'instagram.json'), 'utf8').then(JSON.parse)
]);

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-content-ready', 'true');
});

test('CMS content is rendered from JSON', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'OMOCHI TUNE' })).toBeVisible();
  await expect(page.locator('.column-card')).toHaveCount(Math.min(columns.length, 6));
  await expect(page.locator('.gallery-card')).toHaveCount(gallery.length);
  await expect(page.locator('#instagramPreviewGrid .insta-mock-tile')).toHaveCount(instagram.length);
  await expect(page.locator('#accessVideoLink')).toHaveAttribute('href', 'https://www.instagram.com/omochitune/');
});

test('the guide mascot opens and closes predictably', async ({ page }) => {
  const mascot = page.locator('#omochiMascot');
  await expect(mascot).toBeVisible();
  await mascot.click();
  await expect(mascot).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#mascotBubble')).toHaveAttribute('aria-hidden', 'false');
  await mascot.click();
  await expect(mascot).toHaveAttribute('aria-expanded', 'false');
});

test('column dialog traps focus and closes with Escape', async ({ page }) => {
  await page.locator('.column-card').first().click();
  const dialog = page.locator('#articleModal');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('role', 'dialog');
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(page.locator('#modalTitle')).toHaveText(columns[0].title);
  await page.keyboard.press('Shift+Tab');
  const focusInside = await page.evaluate(() => document.querySelector('#articleModal')?.contains(document.activeElement));
  expect(focusInside).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveAttribute('aria-hidden', 'true');
});

test('tarot result exposes share actions', async ({ page }) => {
  await page.locator('.tarot-card').first().click();
  await expect(page.locator('#tarotResult')).toBeVisible();
  await expect(page.locator('#resultCardTitle')).not.toBeEmpty();
  await expect(page.locator('#shareXLink')).toHaveAttribute('href', /x\.com\/intent/);
  await expect(page.locator('#shareLineLink')).toHaveAttribute('href', /line\.me/);
});

test('mobile view keeps the booking action available', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.sticky-bottom-cta')).toBeVisible();
  await expect(page.locator('#omochiMascot')).toBeHidden();
  await expect(page.locator('.sticky-cta-btn.primary')).toHaveAttribute('href', 'https://ig.me/m/omochitune');
});

test('admin configuration and generated discovery files are served', async ({ request }) => {
  const config = await request.get('/admin/config.yml');
  expect(config.ok()).toBe(true);
  expect(await config.text()).toContain('repo: kanta13jp1/omochi-tune');

  for (const path of ['/feed.xml', '/sitemap.xml', '/robots.txt']) {
    const response = await request.get(path);
    expect(response.ok()).toBe(true);
  }
});

test('Sveltia admin boots in Japanese without CSP errors', async ({ page }) => {
  const browserErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));

  await page.goto('/admin/', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveTitle('Sveltia CMS', { timeout: 20000 });
  await expect(page.locator('body')).toContainText(/アクセストークン|Access Token/, { timeout: 20000 });
  expect(browserErrors.filter((message) => message.includes('Content Security Policy'))).toEqual([]);
});

test('minimal KPI funnel records lp_view, tarot_draw, booking_dm_click without PII and deduplicates', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  // 1. lp_view fired once on content ready with skipped_unconfigured status
  const initialEvents = await page.evaluate(() => window.__omochiKpi.getEvents());
  expect(initialEvents).toHaveLength(1);
  expect(initialEvents[0].event).toBe('lp_view');
  expect(Object.keys(initialEvents[0]).sort()).toEqual(['event', 'page', 'schemaVersion', 'ts']);

  // Calling lp_view again must deduplicate
  const duplicateLp = await page.evaluate(() => window.__omochiKpi.track('lp_view'));
  expect(duplicateLp).toBe(false);

  // Unknown events / disallowed props are rejected or stripped
  const unknownEvent = await page.evaluate(() => window.__omochiKpi.track('evil_event', { email: 'test@example.com' }));
  expect(unknownEvent).toBe(false);

  // 2. tarot_draw in love mode + reset allows another draw
  await page.locator('#btnTarotLove').click();
  await page.locator('.tarot-card').first().click();
  await expect(page.locator('#tarotResult')).toBeVisible();

  const afterDraw = await page.evaluate(() => window.__omochiKpi.getEvents());
  const drawEvents = afterDraw.filter((e) => e.event === 'tarot_draw');
  expect(drawEvents).toHaveLength(1);
  expect(drawEvents[0].mode).toBe('love');
  expect(Object.keys(drawEvents[0]).sort()).toEqual(['event', 'mode', 'page', 'schemaVersion', 'ts']);

  // Second click before reset + direct duplicate track call are deduplicated
  await page.locator('.tarot-card').first().click({ force: true });
  const duplicateDraw = await page.evaluate(() => window.__omochiKpi.track('tarot_draw', { mode: 'daily' }));
  expect(duplicateDraw).toBe(false);
  const afterSecondClick = await page.evaluate(() => window.__omochiKpi.getEvents().filter((e) => e.event === 'tarot_draw'));
  expect(afterSecondClick).toHaveLength(1);

  // Resetting allows a new tarot draw event in daily mode
  await page.locator('#resetTarotBtn').click();
  await page.locator('#btnTarotDaily').click();
  await page.locator('.tarot-card').nth(1).click();
  await expect(page.locator('#tarotResult')).toBeVisible();
  const afterResetDraw = await page.evaluate(() => window.__omochiKpi.getEvents().filter((e) => e.event === 'tarot_draw'));
  expect(afterResetDraw).toHaveLength(2);
  expect(afterResetDraw[1].mode).toBe('daily');

  // 3. booking_dm_click fires on hero CTA and deduplicates rapid double-click (prevent navigation in test)
  await page.evaluate(() => {
    document.querySelector('[data-kpi-booking="hero"]')?.addEventListener('click', (e) => e.preventDefault());
  });
  await page.locator('[data-kpi-booking="hero"]').click();
  await page.locator('[data-kpi-booking="hero"]').click();

  const bookingEvents = await page.evaluate(() => window.__omochiKpi.getEvents().filter((e) => e.event === 'booking_dm_click'));
  expect(bookingEvents).toHaveLength(1);
  expect(bookingEvents[0].placement).toBe('hero');

  const stats = await page.evaluate(() => window.__omochiKpi.getStats());
  expect(stats.skippedUnconfigured).toBe(4);
  expect(stats.deduplicated).toBeGreaterThanOrEqual(3);
  expect(pageErrors).toEqual([]);
});

test('minimal KPI fails open when sendBeacon throws and fallback endpoint fails', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.route('**/__kpi_fail', (route) => route.fulfill({ status: 500, body: 'error' }));
  await page.evaluate(() => {
    window.__OMOCHI_KPI_CONFIG__ = { endpoint: '/__kpi_fail' };
    navigator.sendBeacon = () => {
      throw new Error('beacon blocked');
    };
  });

  await page.locator('.tarot-card').first().click();
  await expect(page.locator('#tarotResult')).toBeVisible();
  await expect(page.locator('[data-kpi-booking="hero"]')).toHaveAttribute('href', 'https://ig.me/m/omochitune');

  await expect
    .poll(async () => page.evaluate(() => window.__omochiKpi.getStats().failed))
    .toBeGreaterThanOrEqual(1);
  expect(pageErrors).toEqual([]);
});
