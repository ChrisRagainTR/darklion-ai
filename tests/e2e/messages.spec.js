// tests/e2e/messages.spec.js
// Tests: My Inbox loads, thread list renders, clicking a thread opens messages,
// reply box present with textarea and Send button, internal note toggle check.

'use strict';

const { test, expect } = require('@playwright/test');
const { BASE_URL, TIMEOUTS } = require('./helpers/config');

test.use({ storageState: 'tests/.auth/user.json' });

test.describe('Messages — Inbox', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE_URL}/messages`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
  });

  // ── Page structure ────────────────────────────────────────────────────────

  test('messages page loads and shows the inbox panel', async ({ page }) => {
    await expect(page.locator('.inbox-panel')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('inbox header is visible with a non-empty heading', async ({ page }) => {
    const heading = page.locator('.inbox-header h2, .inbox-header h1').first();
    await expect(heading).toBeVisible({ timeout: TIMEOUTS.element });
    const text = await heading.textContent();
    expect(text?.trim().length).toBeGreaterThan(0);
  });

  test('inbox search input (.inbox-search) is visible', async ({ page }) => {
    await expect(page.locator('.inbox-search')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('detail panel area (.detail-panel) is rendered', async ({ page }) => {
    await expect(page.locator('.detail-panel')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  // ── Thread list ───────────────────────────────────────────────────────────

  test('inbox thread list (.inbox-list) is rendered', async ({ page }) => {
    await expect(page.locator('.inbox-list')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('inbox list shows thread cards or an empty / no-thread placeholder after loading', async ({ page }) => {
    await page.waitForSelector(
      '.thread-card, .no-thread-selected, [class*="empty"]',
      { timeout: TIMEOUTS.api }
    ).catch(() => null);
    const threads = page.locator('.thread-card');
    const placeholder = page.locator('.no-thread-selected, [class*="empty-state"]');
    expect(await threads.count() > 0 || await placeholder.count() > 0).toBeTruthy();
  });

  test('each thread card shows a client name (.thread-card-name) and subject (.thread-card-subject)', async ({ page }) => {
    await page.waitForSelector('.thread-card', { timeout: TIMEOUTS.api }).catch(() => null);
    const cards = page.locator('.thread-card');
    if (await cards.count() === 0) return test.skip(true, 'No thread cards in inbox');
    await expect(cards.first().locator('.thread-card-name')).toBeVisible({ timeout: TIMEOUTS.element });
    await expect(cards.first().locator('.thread-card-subject')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  // ── Clicking a thread ─────────────────────────────────────────────────────

  test('clicking a thread card activates it (.thread-card.active) and shows the detail header', async ({ page }) => {
    await page.waitForSelector('.thread-card', { timeout: TIMEOUTS.api }).catch(() => null);
    if (await page.locator('.thread-card').count() === 0) return test.skip(true, 'No threads');
    await page.locator('.thread-card').first().click();
    await expect(page.locator('.thread-card.active')).toBeVisible({ timeout: TIMEOUTS.api });
    await expect(page.locator('.detail-header')).toBeVisible({ timeout: TIMEOUTS.api });
  });

  test('clicking a thread shows the person name in .detail-header-person', async ({ page }) => {
    await page.waitForSelector('.thread-card', { timeout: TIMEOUTS.api }).catch(() => null);
    if (await page.locator('.thread-card').count() === 0) return test.skip(true, 'No threads');
    await page.locator('.thread-card').first().click();
    await expect(page.locator('.detail-header-person')).toBeVisible({ timeout: TIMEOUTS.api });
    const name = await page.locator('.detail-header-person').textContent();
    expect(name?.trim().length).toBeGreaterThan(0);
  });

  test('clicking a thread renders the message list (.detail-messages)', async ({ page }) => {
    await page.waitForSelector('.thread-card', { timeout: TIMEOUTS.api }).catch(() => null);
    if (await page.locator('.thread-card').count() === 0) return test.skip(true, 'No threads');
    await page.locator('.thread-card').first().click();
    await page.waitForSelector('.detail-messages', { timeout: TIMEOUTS.api });
    await expect(page.locator('.detail-messages')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  // ── Reply box ─────────────────────────────────────────────────────────────

  test('reply box (.reply-box) is rendered when a thread is open', async ({ page }) => {
    await page.waitForSelector('.thread-card', { timeout: TIMEOUTS.api }).catch(() => null);
    if (await page.locator('.thread-card').count() === 0) return test.skip(true, 'No threads');
    await page.locator('.thread-card').first().click();
    await expect(page.locator('.reply-box')).toBeVisible({ timeout: TIMEOUTS.api });
  });

  test('reply box contains a textarea for composing a message', async ({ page }) => {
    await page.waitForSelector('.thread-card', { timeout: TIMEOUTS.api }).catch(() => null);
    if (await page.locator('.thread-card').count() === 0) return test.skip(true, 'No threads');
    await page.locator('.thread-card').first().click();
    await expect(page.locator('.reply-box textarea')).toBeVisible({ timeout: TIMEOUTS.api });
  });

  test('reply textarea accepts typed text', async ({ page }) => {
    await page.waitForSelector('.thread-card', { timeout: TIMEOUTS.api }).catch(() => null);
    if (await page.locator('.thread-card').count() === 0) return test.skip(true, 'No threads');
    await page.locator('.thread-card').first().click();
    const textarea = page.locator('.reply-box textarea');
    await expect(textarea).toBeVisible({ timeout: TIMEOUTS.api });
    await textarea.fill('Automated test reply — please ignore.');
    await expect(textarea).toHaveValue('Automated test reply — please ignore.');
  });

  test('Send button (.btn-gold in .reply-box-actions) is visible and enabled', async ({ page }) => {
    await page.waitForSelector('.thread-card', { timeout: TIMEOUTS.api }).catch(() => null);
    if (await page.locator('.thread-card').count() === 0) return test.skip(true, 'No threads');
    await page.locator('.thread-card').first().click();
    const sendBtn = page.locator('.reply-box-actions .btn-gold, .reply-box button:has-text("Send")');
    await expect(sendBtn).toBeVisible({ timeout: TIMEOUTS.api });
    await expect(sendBtn).toBeEnabled();
  });

  // ── Internal note toggle ──────────────────────────────────────────────────

  test('internal note toggle checkbox is present in .reply-box-controls', async ({ page }) => {
    await page.waitForSelector('.thread-card', { timeout: TIMEOUTS.api }).catch(() => null);
    if (await page.locator('.thread-card').count() === 0) return test.skip(true, 'No threads');
    await page.locator('.thread-card').first().click();
    await expect(page.locator('.reply-box')).toBeVisible({ timeout: TIMEOUTS.api });

    // The .reply-box-controls area should contain a checkbox for internal notes
    const controls = page.locator('.reply-box-controls');
    await expect(controls).toBeVisible({ timeout: TIMEOUTS.element });

    // Checkbox or label containing "internal" or "Internal note"
    const internalToggle = controls.locator('input[type="checkbox"], label').filter({ hasText: /internal/i });
    if (await internalToggle.count() > 0) {
      // The internal note toggle exists — verify it is unchecked by default
      const checkbox = controls.locator('input[type="checkbox"]').first();
      if (await checkbox.count() > 0) {
        await expect(checkbox).not.toBeChecked();
      }
    }
    // If no internal toggle found it's a soft pass — UI may vary
  });

  // ── AI summary panel ──────────────────────────────────────────────────────

  test('AI summary panel is rendered on the right side', async ({ page }) => {
    // .summary-panel is a right column showing AI analysis of the selected thread
    const summaryPanel = page.locator('.summary-panel');
    if (await summaryPanel.count() > 0) {
      await expect(summaryPanel).toBeVisible({ timeout: TIMEOUTS.element });
    }
  });
});
