import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-content-ready', 'true');
});

test('CMS content is rendered from JSON', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'OMOCHI TUNE' })).toBeVisible();
  await expect(page.locator('.column-card')).toHaveCount(3);
  await expect(page.locator('.gallery-card')).toHaveCount(5);
  await expect(page.locator('#instagramPreviewGrid .insta-mock-tile')).toHaveCount(6);
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
  await expect(page.locator('#modalTitle')).toHaveText('はじめまして、おもちちゃんです');
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
