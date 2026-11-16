import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import express from 'express';
import { createApp } from '../src/app.js';

// Actual edit UI and API with in-memory storage. Never connects to MES.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright-core');
const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const startup = 'initializeDashboardDataModeControls().then(initializeDashboardNavigation).catch((error) => setStatus(error.message));';
assert.equal(source.split(startup).length, 2);
let stored = {
  id: 124, actionDate: '2026-11-13T00:00:00.000Z', dueDate: '2026-11-20T00:00:00.000Z',
  serie: 'FPS A2', problem: 'Review variation', analysisAction: 'Check settings',
  pic: 'Engineer', progress: 'Investigation started', status: 'IN_PROGRESS'
};
const updates = [];
let failUpdate = false;
const repository = {
  list: async () => [stored],
  getById: async (id) => id === stored.id ? stored : undefined,
  update: async (id, action) => {
    if (failUpdate) throw new Error('Fixture storage unavailable');
    assert.equal(id, 124);
    updates.push({ id, ...action });
    stored = { ...stored, ...action };
    return stored;
  }
};
const app = express();
app.get('/app.js', (_request, response) => response.type('js').send(source.replace(startup, 'globalThis.__actionFixtureReady = true;')));
app.use(createApp({ environment: {}, taYieldActionRepository: repository }));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const page = await browser.newPage();
  await page.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const calls = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/ta-yield-actions')) calls.push({ method: request.method(), url: request.url() });
  });
  await page.goto(origin);
  await page.waitForFunction(() => globalThis.__actionFixtureReady);
  const action = await page.evaluate(async () => (await fetch('/api/ta-yield-actions/124')).json());
  assert.equal(action.success, true);
  await page.evaluate((record) => {
    latestTaYieldActions = [record];
    renderTaYield = () => {};
    document.getElementById('endDate').value = '2026-11-16';
    ensureTaYieldActionsView();
    document.querySelector('[data-edit-ta-action="124"]').click();
  }, action.data);
  assert.equal(await page.locator('#taActionDate').inputValue(), '2026-11-13');
  assert.equal(await page.locator('#taActionDueDate').inputValue(), '2026-11-20');
  await page.locator('#taActionProgress').fill('Settings reviewed');
  await page.locator('#saveTaYieldAction').click();
  await page.waitForFunction(() => document.getElementById('taYieldActionModal').hidden);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].actionDate, '2026-11-13');
  assert.equal(updates[0].dueDate, '2026-11-20');
  assert.equal(updates[0].progress, 'Settings reviewed');
  assert.ok(calls.some((call) => call.method === 'PATCH' && call.url.endsWith('/api/ta-yield-actions/124')));
  assert.ok(calls.some((call) => call.method === 'GET' && call.url.endsWith('/api/ta-yield-actions')));

  failUpdate = true;
  await page.evaluate(() => openTaYieldActionModal(latestTaYieldActions[0]));
  await page.locator('#saveTaYieldAction').click();
  await page.waitForFunction(() => document.getElementById('taActionModalStatus').textContent === 'TA Yield action could not be updated.');
  assert.equal(await page.locator('#taYieldActionModal').evaluate((modal) => modal.hidden), false);
  assert.equal(await page.locator('#saveTaYieldAction').isEnabled(), true);
  await page.locator('[data-close-ta-action]').first().click();
  await page.evaluate(() => openTaYieldActionModal());
  assert.equal(await page.locator('#taActionDate').inputValue(), '2026-11-16');
  assert.equal(await page.locator('#taActionDueDate').inputValue(), '');
  console.log('PASS: read action 124, edit ISO dates, PATCH update, refresh list, retain form on failure, new-action defaults. In-memory storage only.');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
