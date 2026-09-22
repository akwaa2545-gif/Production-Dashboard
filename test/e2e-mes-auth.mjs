import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import express from 'express';
import { createApp } from '../src/app.js';

// Uses installed Playwright only. Every MES operation below is an in-memory fake.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright-core');
const apiPaths = ['/api/quantity', '/api/chart', '/api/mtd-quantity'];
const authError = () => Object.assign(new Error('Fixture MES credentials expired'), { code: 'ELOGIN' });
const rows = (filters, quantity) => [{ bucketDate: filters.startDate, itemName: 'FIXTURE', processName: 'Fixture process', quantityMoved: quantity }];

async function createFixture() {
  let state = { authenticated: false, failLogin: false, quantity: 456, loginRequests: 0, authenticateCalls: 0, deniedReads: 0 };
  const read = async (filters) => {
    if (!state.authenticated) {
      state = { ...state, deniedReads: state.deniedReads + 1 };
      throw authError();
    }
    return rows(filters, state.quantity);
  };
  const repository = {
    getOptions: async () => ({ product: ['NEO', 'SC'], process: [], serie: ['FIXTURE'], case: [], pn: [] }),
    getPartNumbers: async () => ({ items: [], hasMore: false }),
    getQuantity: read,
    getChartData: read,
    authenticate: async () => {
      state = { ...state, authenticateCalls: state.authenticateCalls + 1 };
      if (state.failLogin) throw authError();
      state = { ...state, authenticated: true };
    }
  };
  const app = createApp({
    environment: {
      SQL_SERVER: 'fixture', SQL_DATABASE: 'fixture', DATE_COLUMN: 'OccuredOn',
      CHART_COLUMN: 'processName', DASHBOARD_DATA_MODE: 'live'
    },
    repository
  });
  const wrapper = express();
  const allowed = new Set(['/api/config', '/api/data-mode', '/api/options', '/api/part-numbers', '/api/auth/login', ...apiPaths]);
  wrapper.use((request, response, next) => {
    if (request.path === '/api/auth/login') state = { ...state, loginRequests: state.loginRequests + 1 };
    if (!request.path.startsWith('/api/') || allowed.has(request.path)) return next();
    return response.json({ success: true, data: [] });
  });
  wrapper.use(app);
  const server = wrapper.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    status: () => ({ ...state }),
    configure: (next) => { state = { ...state, ...next }; },
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

async function applyAndReadFailures(page) {
  const responses = apiPaths.map((path) => page.waitForResponse((response) => new URL(response.url()).pathname === path && response.status() === 401));
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await Promise.all(responses);
  await page.waitForFunction(() => !document.getElementById('apply').disabled);
}

async function scenario(browser, failLogin, repetition) {
  const fixture = await createFixture();
  fixture.configure({ failLogin });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await context.route('**/*', (route) => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort());
  const originalNow = Date.now;
  try {
    const initialFailures = apiPaths.map((path) => page.waitForResponse((response) => new URL(response.url()).pathname === path && response.status() === 401));
    await page.goto(fixture.origin);
    await Promise.all(initialFailures);
    if (failLogin) {
      const retry = page.getByRole('button', { name: 'Sign in to MES', exact: true });
      await retry.waitFor({ state: 'visible' });
      assert.equal(fixture.status().loginRequests, 1, 'failed concurrent requests share one sign-in');
      assert.equal(fixture.status().authenticateCalls, 1);
      await applyAndReadFailures(page);
      assert.equal(fixture.status().loginRequests, 1, 'Apply does not automatically retry failed sign-in');
      fixture.configure({ failLogin: false, quantity: 789 });
      // Advance only this isolated server fixture's cooldown; browser time is unchanged.
      Date.now = () => originalNow() + 31000;
      await retry.click();
      await page.waitForFunction(() => document.getElementById('totalQuantity').textContent === '789');
      assert.equal(fixture.status().loginRequests, 2, 'explicit retry starts one new sign-in');
      assert.equal(fixture.status().authenticateCalls, 2);
      assert.equal(await retry.isVisible(), false);
    } else {
      await page.waitForFunction(() => document.getElementById('totalQuantity').textContent === '456');
      assert.equal(fixture.status().loginRequests, 1, 'concurrent 401 burst issues only one login request');
      assert.equal(fixture.status().authenticateCalls, 1);
      fixture.configure({ quantity: 654 });
      await page.getByRole('button', { name: 'Apply', exact: true }).click();
      await page.waitForFunction(() => document.getElementById('totalQuantity').textContent === '654');
      assert.equal(fixture.status().loginRequests, 1, 'fresh live data needs no extra sign-in');
    }
    assert.ok(fixture.status().deniedReads >= 3, 'quantity, chart and MTD exercise concurrent authentication failures');
    assert.deepEqual(errors, []);
    console.log(`PASS ${repetition}/3: ${failLogin ? 'failed sign-in blocks automatic loops; explicit retry recovers after cooldown' : 'parallel quantity/chart/MTD failures share one sign-in and load fresh live results'}`);
  } finally {
    Date.now = originalNow;
    await context.close();
    await fixture.close();
  }
}

const browser = await chromium.launch({ headless: true });
try {
  for (let repetition = 1; repetition <= 3; repetition += 1) {
    await scenario(browser, false, repetition);
    await scenario(browser, true, repetition);
  }
} finally {
  await browser.close();
}
