import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile } from 'node:fs/promises';
import express from 'express';
import { createApp } from '../src/app.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright-core');
const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const startup = 'initializeDashboardDataModeControls().then(initializeDashboardNavigation).catch((error) => setStatus(error.message));';
assert.equal(source.split(startup).length, 2);
let state = 'CONNECTED';
let loginCalls = 0;
let silentCalls = 0;
let rejectLogin = true;
const required = () => Object.assign(new Error('Fixture sign-in required'), { name: 'AuthenticationRequiredError' });
const repository = {
  getAuthenticationStatus: () => ({ state }),
  getPool: async () => { silentCalls++; if (state === 'AUTH_REQUIRED') throw required(); return { connected: true }; },
  authenticate: async () => { loginCalls++; if (rejectLogin) throw required(); state = 'CONNECTED'; },
  getOptions: async () => ({ product: ['NEO'], process: [], serie: [], case: [], pn: [] }),
  getPartNumbers: async () => ({ items: [], hasMore: false }),
  getQuantity: async () => [{ itemName: 'FIXTURE', quantityMoved: 123, bucketDate: '2026-11-24' }],
  getChartData: async () => []
};
const app = createApp({
  environment: { SQL_SERVER: 'fixture', SQL_DATABASE: 'fixture', DATE_COLUMN: 'completedAt', DASHBOARD_DATA_MODE: 'staging' },
  repository, scYieldRepository: repository, taYieldRepository: repository
});
const wrapper = express();
wrapper.get('/app.js', (_request, response) => response.type('js').send(source.replace(startup, 'globalThis.__mesRecoveryFixtureReady = true;')));
wrapper.get('/api/staging-status', (_request, response) => response.json({
  success: true, data: [], checkedAt: new Date().toISOString(), pipelines: { taYield: { status: 'IDLE', logs: [] } }
}));
wrapper.use(app);
const server = wrapper.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = 'http://127.0.0.1:' + server.address().port;
let browser;
const originalNow = Date.now;
try {
  browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(origin);
  await page.waitForFunction(() => globalThis.__mesRecoveryFixtureReady);
  await page.evaluate(() => {
    currentConfig = { dataset: 'closed', dataModels: {}, chartColumn: 'completedAt' };
    document.getElementById('startDate').value = '2026-11-01';
    document.getElementById('endDate').value = '2026-11-24';
    showView('dashboard');
  });
  assert.equal(await page.locator('#mesConnectionStatus').count(), 0);
  assert.equal(await page.locator('#databaseAuthRetry').count(), 0);

  state = 'AUTH_REQUIRED';
  await app.reconnectMesConnections();
  assert.ok(silentCalls > 0);
  assert.equal(loginCalls, 0, 'background recovery never opens a sign-in browser');
  const cached = await page.evaluate(async () => (await fetch('/api/quantity?startDate=2026-11-01&endDate=2026-11-24')).json());
  assert.equal(cached.success, true, 'cached report reads remain successful while MES authentication needs attention');
  await page.evaluate(() => showView('staging'));
  const panel = page.locator('#mesConnectionStatus');
  const signIn = page.locator('#databaseAuthRetry');
  await panel.getByRole('status').filter({ hasText: 'Sign-in required' }).waitFor();
  assert.equal(await signIn.isVisible(), true);
  assert.equal(await signIn.evaluate(button => button.closest('#stagingStatusView') !== null), true);
  assert.equal(loginCalls, 0, 'status polling is side-effect free');

  await page.evaluate(() => showView('dashboard'));
  assert.equal(await panel.isVisible(), false);
  assert.equal(await signIn.isVisible(), false);
  await page.evaluate(() => showView('staging'));
  await signIn.waitFor({ state: 'visible' });
  await signIn.click();
  await page.waitForFunction(() => !document.getElementById('databaseAuthRetry').disabled);
  assert.equal(loginCalls, 1);
  assert.equal(await signIn.isVisible(), true, 'cancelled sign-in retains explicit retry');
  rejectLogin = false;
  Date.now = () => originalNow() + 31000;
  await signIn.click();
  await panel.getByRole('status').filter({ hasText: /^Connected$/ }).waitFor();
  assert.equal(loginCalls, 2);
  assert.equal(await signIn.isVisible(), false);
  await page.getByRole('button', { name: 'Pipeline map', exact: true }).click();
  assert.equal(await panel.isVisible(), true, 'MES status remains visible in both Staging subviews');
  assert.deepEqual(errors, []);
  await mkdir(new URL('../artifacts/mes-reconnect/', import.meta.url), { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL('../artifacts/mes-reconnect/staging-connected.png', import.meta.url)), fullPage: true });
  console.log('PASS: background failure visible with cached 200 reports; silent-only retries; sign-in only in Staging; failed and successful sign-in; map view status. In-memory MES fixture only.');
} finally {
  Date.now = originalNow;
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
