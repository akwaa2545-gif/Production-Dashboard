import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import express from 'express';
import { createApp } from '../src/app.js';

// Run with node test/e2e-wip-repair.mjs. An existing playwright-core installation
// can be selected with PLAYWRIGHT_MODULE_PATH; this script never installs it.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright-core');
const token = 'fixture-only-wip-token-at-least-32-characters';
const range = { startDate: '2026-09-19', endDate: '2026-09-20' };
const wrapper = express();
const server = wrapper.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
let finish;
let operations = [];
let statusReads = 0;
const app = createApp({
  environment: {
    SQL_SERVER: 'fixture', SQL_DATABASE: 'fixture', DATE_COLUMN: 'OccuredOn',
    DASHBOARD_WIP_REPAIR_TOKEN: token, DASHBOARD_WIP_REPAIR_ALLOWED_ORIGINS: origin,
    DASHBOARD_WIP_STAGING_ENABLED: 'true'
  },
  repository: {},
  stagingWipRepository: { getActivity: async () => ({ rowCount: 10, processRowCount: 5, ...range, lastDataDate: range.endDate }) },
  refreshWipStagingOperation: (filters) => {
    operations = [...operations, { startDate: filters.startDate, endDate: filters.endDate }];
    return new Promise((resolve) => { finish = resolve; });
  }
});
wrapper.use((request, response, next) => {
  if (request.path === '/api/staging-status') statusReads += 1;
  if (!request.path.startsWith('/api/') || ['/api/config', '/api/staging-status', '/api/staging/wip-repair'].includes(request.path)) return next();
  const data = request.path === '/api/options' ? { product: ['NEO', 'SC'], process: [], serie: [], case: [], pn: [] } : [];
  return response.json({ success: true, data });
});
wrapper.use(app);
let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (let repetition = 1; repetition <= 3; repetition += 1) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => dialog.accept());
    await context.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(origin);
    await page.getByRole('button', { name: 'Staging status', exact: true }).click();
    const form = page.locator('[data-staging-wip-repair]');
    await form.waitFor({ state: 'visible' });
    await form.getByLabel('From', { exact: true }).fill(range.startDate);
    await form.getByLabel('To', { exact: true }).fill(range.endDate);
    await form.getByLabel('Operator token').fill(token);
    const accepted = page.waitForResponse((response) => response.url().endsWith('/api/staging/wip-repair'));
    await form.getByRole('button', { name: 'Restore / Repair', exact: true }).click();
    assert.equal((await accepted).status(), 202);
    await page.locator('.staging-wip-run .staging-state.running').waitFor();
    assert.equal(await form.getByRole('button').isDisabled(), true);
    assert.equal(await form.getByLabel('Operator token').inputValue(), '');
    assert.deepEqual(operations.at(-1), range);
    const readsBefore = statusReads;
    finish({ rows: 15, ...range });
    await page.locator('.staging-wip-run .staging-state.succeeded').waitFor({ timeout: 15000 });
    assert.ok(statusReads > readsBefore, 'automatic polling observes completion');
    assert.equal(await form.getByRole('button').isEnabled(), true);
    assert.equal(await form.getByLabel('From', { exact: true }).inputValue(), range.startDate);
    assert.equal(await form.getByLabel('To', { exact: true }).inputValue(), range.endDate);
    assert.equal(await form.getByLabel('Operator token').inputValue(), '');
    assert.equal(await form.count(), 1);
    assert.deepEqual(errors, []);
    console.log(`PASS ${repetition}/3: browser repair submits exact range, shows RUNNING, clears token, polls SUCCEEDED, preserves dates`);
    await context.close();
  }
  assert.equal(operations.length, 3);
} finally {
  await browser?.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
