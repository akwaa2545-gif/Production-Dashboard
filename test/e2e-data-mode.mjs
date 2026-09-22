import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import express from 'express';
import { createApp } from '../src/app.js';

// Uses an already installed Playwright; never downloads dependencies or browsers.
// E2E_DATA_MODE_BOOTSTRAP=true also checks local auto fill with no configured token.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright-core');
const token = 'fixture-only-data-mode-token-at-least-32-characters';
const bootstrap = process.env.E2E_DATA_MODE_BOOTSTRAP === 'true';
const repetitions = bootstrap ? 1 : 3;
const wrapper = express();
const server = wrapper.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
let liveQuantity = 222;
let directReads = 0;
let stageReads = 0;
let refreshes = 0;
const rows = (quantity, filters) => [{ bucketDate: filters.startDate, itemName: 'FIXTURE', quantityMoved: quantity }];
const repository = (live) => ({
  getOptions: async () => ({ product: ['NEO', 'SC'], process: [], serie: ['FIXTURE'], case: [], pn: [] }),
  getPartNumbers: async () => ({ items: [], hasMore: false }),
  getQuantity: async (filters) => {
    if (live) directReads += 1; else stageReads += 1;
    return rows(live ? liveQuantity : 111, filters);
  },
  getChartData: async (filters) => rows(live ? liveQuantity : 111, filters),
  getActivity: async () => ({ rowCount: 1, processRowCount: 1, lastDataDate: '2026-09-20' })
});
const app = createApp({
  environment: {
    SQL_SERVER: 'fixture', SQL_DATABASE: 'fixture', DATE_COLUMN: 'OccuredOn',
    DASHBOARD_DATA_MODE: 'staging', DASHBOARD_DATA_MODE_LOCAL_AUTOFILL: 'true',
    ...(bootstrap ? {} : { DASHBOARD_DATA_MODE_TOKEN: token }),
    DASHBOARD_DATA_MODE_ALLOWED_ORIGINS: origin,
    DASHBOARD_WIP_REPAIR_TOKEN: token, DASHBOARD_WIP_REPAIR_ALLOWED_ORIGINS: origin,
    DASHBOARD_WIP_STAGING_ENABLED: 'true'
  },
  repository: repository(true),
  staging901Repository: repository(false), stagingWipRepository: repository(false),
  refreshWipStagingOperation: async () => { refreshes += 1; return { rows: 1 }; }
});
const realApis = new Set(['/api/config', '/api/data-mode', '/api/data-mode/local-token', '/api/options', '/api/part-numbers', '/api/quantity', '/api/mtd-quantity', '/api/chart', '/api/staging-status', '/api/staging/wip-repair']);
wrapper.use((request, response, next) => {
  if (!request.path.startsWith('/api/') || realApis.has(request.path)) return next();
  return response.json({ success: true, data: [] });
});
wrapper.use(app);

async function waitMode(page, mode) {
  await page.waitForFunction((expected) => document.getElementById('dashboardDataModeStatus').textContent.startsWith(expected), mode === 'live' ? 'Live MES' : 'Staging', { timeout: 15000 });
  assert.equal(await page.locator('#dashboardDataModeStatus').getAttribute('data-mode'), mode);
  const activeCard = page.locator('[data-dashboard-mode-card][data-active="true"]');
  assert.equal(await activeCard.count(), 1);
  assert.equal(await activeCard.getAttribute('data-dashboard-mode-card'), mode);
  assert.equal(await activeCard.locator('[data-mode-active-label]').getAttribute('hidden'), null);
  await waitSourceIndicator(page, mode);
}
async function waitSourceIndicator(page, mode) {
  await page.waitForFunction((expected) => document.getElementById('dashboardSourceIndicator')?.dataset.mode === expected, mode);
  const indicator = page.locator('#dashboardSourceIndicator');
  assert.equal(await page.locator('#reportControls #dashboardSourceIndicator').count(), 1, 'source indicator belongs to Report controls');
  assert.equal(await indicator.isVisible(), await page.locator('#reportControls').isVisible(), 'source indicator is visible only with Report controls');
  assert.equal(await page.locator('#dashboardSourceLabel').textContent(), mode === 'live' ? 'Live MES' : 'Staging');
  const description = (await page.locator('#dashboardSourceDescription').textContent()).trim();
  assert.ok(description, 'source description explains the active mode');
  assert.equal(await indicator.getAttribute('title'), description, 'source detail is available in the compact indicator tooltip');
  assert.equal(await page.locator('#dashboardSourceDescription').isVisible(), false, 'source description does not expand the compact indicator');
  assert.equal(await indicator.locator('button, input, select, svg').count(), 0, 'source indicator is simple text without controls or an icon');
}
async function switchMode(page, mode, credential) {
  await page.getByRole('button', { name: 'Staging status', exact: true }).click();
  await page.locator('#dashboardDataModeSettings').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Change data mode', exact: true }).click();
  await page.locator('#dashboardDataModeSelection').selectOption(mode);
  let issuedToken;
  if (credential === undefined) {
    if (bootstrap) assert.equal(await page.getByRole('button', { name: 'Apply for all browsers', exact: true }).isDisabled(), true);
    const pendingToken = page.waitForResponse((response) => response.url().endsWith('/api/data-mode/local-token') && response.request().method() === 'POST');
    await page.locator('#dashboardDataModeAutofill').click();
    const tokenResponse = await pendingToken;
    assert.equal(tokenResponse.status(), 200);
    assert.equal(tokenResponse.headers()['cache-control'], 'no-store');
    await page.waitForFunction(() => document.getElementById('dashboardDataModeToken').value.length >= 32);
    issuedToken = await page.getByLabel('Data mode operator token').inputValue();
    assert.notEqual(issuedToken, token, 'auto fill issues a distinct temporary token');
    assert.equal(await page.getByRole('button', { name: 'Apply for all browsers', exact: true }).isEnabled(), true);
    assert.equal(await page.evaluate((temporaryToken) => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, cookies: document.cookie }).includes(temporaryToken), issuedToken), false, 'temporary token is absent from browser storage');
  } else {
    await page.getByLabel('Data mode operator token', { exact: true }).fill(credential);
  }
  const pending = page.waitForResponse((response) => response.url().endsWith('/api/data-mode') && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Apply for all browsers', exact: true }).click();
  const response = await pending;
  assert.equal(await page.getByLabel('Data mode operator token').inputValue(), '');
  if (issuedToken) {
    const replay = await page.context().request.put(`${origin}/api/data-mode`, {
      headers: { Origin: origin, Authorization: `Bearer ${issuedToken}` }, data: { mode }
    });
    assert.equal(replay.status(), 401, 'temporary token is single use');
  }
  await page.getByRole('button', { name: 'Close data mode dialog' }).click();
  return response;
}
async function waitQuantity(page, quantity) {
  await page.waitForFunction((expected) => document.getElementById('totalQuantity').textContent === String(expected), quantity);
}

let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    liveQuantity = 222;
    const first = await browser.newContext();
    const second = await browser.newContext();
    const pages = await Promise.all([first.newPage(), second.newPage()]);
    const errors = [];
    for (const page of pages) {
      page.setDefaultTimeout(15000);
      page.on('pageerror', (error) => errors.push(error.message));
      await page.context().route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      await page.goto(origin);
      await waitMode(page, 'staging');
      await waitQuantity(page, 111);
      assert.equal(await page.locator('#dashboardDataModeSettings').isVisible(), false);
      assert.equal(await page.locator('#dashboardDataModeOpen').isVisible(), false);
    }
    if (!bootstrap) assert.equal((await switchMode(pages[0], 'live', 'wrong-token')).status(), 401);
    const initialMode = (await (await first.request.get(`${origin}/api/data-mode`)).json()).data;
    assert.equal(initialMode.mode, 'staging');
    if (bootstrap) {
      assert.equal(initialMode.controlConfigured, false);
      assert.equal(initialMode.localAutofillAvailable, true);
    }
    assert.ok(stageReads > 0);
    const switched = await switchMode(pages[0], 'live');
    assert.ok([200, 202].includes(switched.status()));
    await Promise.all(pages.map((page) => waitMode(page, 'live')));
    await Promise.all(pages.map((page) => waitQuantity(page, 222)));
    await pages[1].getByRole('button', { name: 'Data model', exact: true }).click();
    await waitSourceIndicator(pages[1], 'live');
    const previousReads = directReads;
    liveQuantity = 333;
    await pages[0].getByRole('button', { name: 'Production dashboard', exact: true }).click();
    await waitSourceIndicator(pages[0], 'live');
    if (repetition === repetitions) {
      await mkdir('.restore-points', { recursive: true });
      await pages[0].screenshot({ path: '.restore-points/data-source-indicator-desktop.png' });
    }
    assert.equal(await pages[0].locator('#dashboardDataModeSettings').isVisible(), false);
    await pages[0].getByRole('button', { name: 'Apply', exact: true }).click();
    await waitQuantity(pages[0], 333);
    assert.ok(directReads > previousReads, 'Apply reads fresh MES in live mode');
    for (const name of ['refresh901Staging', 'refreshWipStaging', 'refreshScYieldStaging', 'refreshTaYieldStaging', 'warmCurrentMonthCaches']) {
      assert.deepEqual(await app[name](), { status: 'SKIPPED', reason: 'LIVE_MODE' }, name);
    }
    await pages[0].getByRole('button', { name: 'Staging status', exact: true }).click();
    await waitSourceIndicator(pages[0], 'live');
    const form = pages[0].locator('[data-staging-wip-repair]');
    await form.waitFor({ state: 'visible' });
    assert.equal(await form.getByRole('button').isDisabled(), true);
    const repair = await first.request.post(`${origin}/api/staging/wip-repair`, {
      headers: { Origin: origin, Authorization: `Bearer ${token}` },
      data: { startDate: '2026-09-19', endDate: '2026-09-20' }
    });
    assert.equal(repair.status(), 503);
    assert.equal((await repair.json()).success, false);
    assert.equal(refreshes, 0);
    assert.ok([200, 202].includes((await switchMode(pages[0], 'staging')).status()));
    await Promise.all(pages.map((page) => waitMode(page, 'staging')));
    await Promise.all(pages.map((page) => waitQuantity(page, 111)));
    await pages[0].waitForFunction(() => !document.querySelector('[data-staging-wip-repair] button').disabled);
    assert.deepEqual(errors, []);
    if (repetition === repetitions) {
      await mkdir('.restore-points', { recursive: true });
      await pages[0].screenshot({ path: '.restore-points/data-mode-ui.png' });
      await pages[0].locator('#dashboardDataModeOpen').click();
      assert.equal(await pages[0].getByLabel('Data mode operator token').inputValue(), '');
      await pages[0].screenshot({ path: '.restore-points/data-mode-dialog.png' });
      await pages[0].getByRole('button', { name: 'Close data mode dialog' }).click();
      await pages[0].setViewportSize({ width: 390, height: 844 });
      await pages[0].getByRole('button', { name: 'Production dashboard', exact: true }).click();
      await pageSourceFitsViewport(pages[0]);
      await pages[0].screenshot({ path: '.restore-points/data-source-indicator-mobile.png' });
      await pages[0].getByRole('button', { name: 'Staging status', exact: true }).click();
      await pages[0].locator('#dashboardDataModeSettings').scrollIntoViewIfNeeded();
      const layout = await pages[0].locator('#dashboardDataModeSettings').evaluate((element) => ({
        left: element.getBoundingClientRect().left,
        right: element.getBoundingClientRect().right,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        viewportWidth: window.innerWidth
      }));
      assert.ok(layout.left >= 0 && layout.right <= layout.viewportWidth, 'mode settings fit narrow viewport');
      assert.ok(layout.scrollWidth <= layout.clientWidth + 1, 'mode settings have no horizontal overflow');
      await pages[0].screenshot({ path: '.restore-points/data-mode-ui-narrow.png' });
    }
    console.log(`PASS ${repetition}/${repetitions}${bootstrap ? ' (no configured static token)' : ''}: compact source indicator stays inside Report controls and updates in two browsers; local auto fill issues unstored single-use tokens; global staging/live/staging, fresh Apply, skipped jobs, paused repairs${bootstrap ? '' : ', rejected invalid token'}`);
    await Promise.all([first.close(), second.close()]);
  }
} finally {
  await browser?.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function pageSourceFitsViewport(page) {
  await waitSourceIndicator(page, 'staging');
  await page.locator('#dashboardSourceIndicator').scrollIntoViewIfNeeded();
  const layout = await page.locator('#dashboardSourceIndicator').evaluate((element) => ({
    left: element.getBoundingClientRect().left,
    right: element.getBoundingClientRect().right,
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
    viewportWidth: window.innerWidth
  }));
  assert.ok(layout.left >= 0 && layout.right <= layout.viewportWidth, 'source indicator fits narrow viewport');
  assert.ok(layout.scrollWidth <= layout.clientWidth + 1, 'source indicator has no horizontal overflow');
}
