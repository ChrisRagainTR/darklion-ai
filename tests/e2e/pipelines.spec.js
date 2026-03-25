// tests/e2e/pipelines.spec.js
// Tests: pipeline list page, kanban board view, drag-and-drop between stages,
// job detail panel opens on card click.

'use strict';

const { test, expect } = require('@playwright/test');
const { BASE_URL, TIMEOUTS } = require('./helpers/config');

test.use({ storageState: 'tests/.auth/user.json' });

/** Opens the first available pipeline board. Returns false if no pipelines exist. */
async function openFirstBoard(page) {
  await page.goto(`${BASE_URL}/pipelines`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
  await page.waitForSelector('#pipe-tbody tr', { timeout: TIMEOUTS.api }).catch(() => null);

  const pipeLink = page.locator('.pipe-link').first();
  if (await pipeLink.count() === 0) return false;

  await pipeLink.click();
  await page.waitForSelector('#view-board', { timeout: TIMEOUTS.api });
  return true;
}

test.describe('Pipelines — list view', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE_URL}/pipelines`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
  });

  test('pipelines page loads and shows the "Pipelines" heading', async ({ page }) => {
    await expect(page.locator('#list-title, h1').filter({ hasText: 'Pipelines' })).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('"+ New Pipeline" button is visible', async ({ page }) => {
    await expect(page.locator('#new-pipe-btn, button:has-text("+ New Pipeline")')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('"📦 View Archived" toggle button is visible', async ({ page }) => {
    await expect(page.locator('#archived-toggle')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('pipeline table renders with "Name", "Type", "Stages", "Active Jobs" column headers', async ({ page }) => {
    await page.waitForSelector('.pipe-table', { timeout: TIMEOUTS.element });
    await expect(page.locator('.pipe-table th').filter({ hasText: 'Name' })).toBeVisible({ timeout: TIMEOUTS.element });
    await expect(page.locator('.pipe-table th').filter({ hasText: 'Type' })).toBeVisible({ timeout: TIMEOUTS.element });
    await expect(page.locator('.pipe-table th').filter({ hasText: 'Stages' })).toBeVisible({ timeout: TIMEOUTS.element });
    await expect(page.locator('.pipe-table th').filter({ hasText: 'Active Jobs' })).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('pipeline table body loads (pipeline rows or empty message)', async ({ page }) => {
    await page.waitForSelector('#pipe-tbody tr', { timeout: TIMEOUTS.api });
    const rows = page.locator('#pipe-tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('clicking "+ New Pipeline" opens the New Pipeline modal with Name field', async ({ page }) => {
    await page.locator('#new-pipe-btn, button:has-text("+ New Pipeline")').click();
    await expect(page.locator('#new-pipeline-modal')).toHaveClass(/open/, { timeout: TIMEOUTS.element });
    await expect(page.locator('#np-name')).toBeVisible({ timeout: TIMEOUTS.element });
  });
});

test.describe('Pipelines — kanban board view', () => {
  test('clicking a pipeline name opens the kanban board view', async ({ page }) => {
    const found = await openFirstBoard(page);
    if (!found) return test.skip(true, 'No pipelines exist');
    await expect(page.locator('#view-board')).toBeVisible({ timeout: TIMEOUTS.element });
    await expect(page.locator('#board-title')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('kanban board hides the list view (#view-list) when a board is shown', async ({ page }) => {
    const found = await openFirstBoard(page);
    if (!found) return test.skip(true, 'No pipelines exist');
    await expect(page.locator('#view-list')).toBeHidden({ timeout: TIMEOUTS.element });
  });

  test('kanban board shows at least one column (.kanban-col) with a column name (.col-name)', async ({ page }) => {
    const found = await openFirstBoard(page);
    if (!found) return test.skip(true, 'No pipelines exist');
    await page.waitForSelector('.kanban-col', { timeout: TIMEOUTS.api });
    await expect(page.locator('.kanban-col').first()).toBeVisible({ timeout: TIMEOUTS.element });
    await expect(page.locator('.col-head .col-name').first()).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('each kanban column has a card count badge (.col-count)', async ({ page }) => {
    const found = await openFirstBoard(page);
    if (!found) return test.skip(true, 'No pipelines exist');
    await page.waitForSelector('.kanban-col', { timeout: TIMEOUTS.api });
    await expect(page.locator('.col-count').first()).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('board bar shows "+ Add Job" and "⚙ Edit Stages" buttons', async ({ page }) => {
    const found = await openFirstBoard(page);
    if (!found) return test.skip(true, 'No pipelines exist');
    await expect(page.locator('button:has-text("+ Add Job")')).toBeVisible({ timeout: TIMEOUTS.element });
    await expect(page.locator('button:has-text("Edit Stages")')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('board bar back button returns to the list view', async ({ page }) => {
    const found = await openFirstBoard(page);
    if (!found) return test.skip(true, 'No pipelines exist');
    await page.locator('.back-btn').click();
    await expect(page.locator('#view-list')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('clicking a job card opens the job detail panel with a title', async ({ page }) => {
    const found = await openFirstBoard(page);
    if (!found) return test.skip(true, 'No pipelines exist');
    await page.waitForSelector('.job-card', { timeout: TIMEOUTS.api }).catch(() => null);
    const cards = page.locator('.job-card');
    if (await cards.count() === 0) return test.skip(true, 'No job cards in first pipeline');
    await cards.first().click();
    await expect(page.locator('#job-panel')).toHaveClass(/open/, { timeout: TIMEOUTS.element });
    await expect(page.locator('#panel-title')).toBeVisible({ timeout: TIMEOUTS.element });
    const title = await page.locator('#panel-title').textContent();
    expect(title?.trim().length).toBeGreaterThan(0);
  });

  test('job panel close button dismisses the panel', async ({ page }) => {
    const found = await openFirstBoard(page);
    if (!found) return test.skip(true, 'No pipelines exist');
    await page.waitForSelector('.job-card', { timeout: TIMEOUTS.api }).catch(() => null);
    if (await page.locator('.job-card').count() === 0) return test.skip(true, 'No job cards');
    await page.locator('.job-card').first().click();
    await expect(page.locator('#job-panel')).toHaveClass(/open/, { timeout: TIMEOUTS.element });
    await page.locator('#job-panel .panel-close').click();
    await page.waitForTimeout(800);
    await expect(page.locator('#job-panel')).not.toHaveClass(/open/, { timeout: TIMEOUTS.element });
  });

  // ── Drag-and-drop ─────────────────────────────────────────────────────────

  test('drag a job card from column 0 to column 1 and verify it moved', async ({ page }) => {
    const found = await openFirstBoard(page);
    if (!found) return test.skip(true, 'No pipelines exist');

    await page.waitForSelector('.kanban-col', { timeout: TIMEOUTS.api });
    const cols = page.locator('.kanban-col');
    if (await cols.count() < 2) return test.skip(true, 'Need ≥2 columns for drag test');

    const firstColCards = cols.nth(0).locator('.job-card');
    const initialCount = await firstColCards.count();
    if (initialCount === 0) return test.skip(true, 'No cards in column 0 to drag');

    const cardName = await firstColCards.first().locator('.job-name').textContent();
    const targetDropZone = cols.nth(1).locator('.col-cards');

    await firstColCards.first().dragTo(targetDropZone, { timeout: TIMEOUTS.api });
    await page.waitForTimeout(1500);

    // Verify the card moved: either col 1 now contains it or col 0 has fewer cards
    const newFirstColCount = await firstColCards.count();
    const col1Text = await cols.nth(1).textContent();

    const cardInCol1 = (col1Text || '').includes((cardName || '').trim());
    const countDecreased = newFirstColCount < initialCount;

    expect(cardInCol1 || countDecreased).toBeTruthy();
  });
});
