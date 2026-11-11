import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

// Real frontend + synthetic read-only API. No MES, database or credentials.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH
  || 'playwright-core');
const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
const artifactDirectory = fileURLToPath(new URL('../artifacts/sc901-series/', import.meta.url));
await mkdir(artifactDirectory, { recursive: true });
const repetitions = Number(process.env.E2E_REPETITIONS || 3);
assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 5);
const sourceHtml = await readFile(path.join(publicDirectory, 'index.html'), 'utf8');
const applicationSource = await readFile(path.join(publicDirectory, 'app.js'), 'utf8');
const startup = 'initializeDashboardDataModeControls().then(initializeDashboardNavigation).catch((error) => setStatus(error.message));';
assert.equal(applicationSource.split(startup).length, 2, 'Only automatic startup is disabled');
const fixtureSource = applicationSource.replace(startup, 'globalThis.__sc901FixtureReady = true;');
const series = ['CAN', 'Element', 'FC', 'FM'];
const savedSeries = [...series, 'Target only'];
const quantities = series.map((itemName, i) => ({ itemName, quantityMoved: (i + 1) * 100, bucketDate: '2026-11-10' }));
const targetSettings = { SC: Object.fromEntries(savedSeries.map((name, i) => [name,
  { periods: { '2026-11': { target: i === 4 ? 500 : (i + 1) * 1000, workingDay: 20 } } }
])) };
const requests = [];
const forbidden = [];
const app = express();
app.use('/api', (request, response) => {
  if (request.method !== 'GET') {
    forbidden.push(`${request.method} ${request.originalUrl}`);
    return response.status(405).json({ success: false, error: 'Read-only browser fixture.' });
  }
  const url = new URL(request.originalUrl, 'http://fixture.invalid');
  requests.push({ path: url.pathname, params: [...url.searchParams] });
  const sc = url.searchParams.get('product') === 'SC';
  const selected = url.searchParams.getAll('serie');
  const allRows = sc ? quantities : [{ itemName: 'FPS', quantityMoved: 700, bucketDate: '2026-11-10' }];
  let data = [];
  if (url.pathname === '/api/data-mode') {
    data = { mode: 'live', requestedMode: 'live', revision: 0, transitioning: false, controlConfigured: false };
  } else if (['/api/quantity', '/api/mtd-quantity'].includes(url.pathname)) {
    data = allRows.filter(row => !selected.length || selected.includes(row.itemName));
  } else if (url.pathname === '/api/options') {
    data = { process: [], serie: sc ? series : ['FPS', 'FPS A2', 'FPS A3'], case: [], pn: [] };
  } else if (url.pathname === '/api/part-numbers') {
    data = { items: [], matches: [], hasMore: false };
  }
  return response.json({ success: true, data });
});
app.get('/', (_request, response) => response.type('html').send(sourceHtml));
app.get('/app.js', (_request, response) => response.type('js').send(fixtureSource));
app.use(express.static(publicDirectory));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const failures = [];
const checks = [];
const coverageRuns = [];
let browser;

class CompletionPage {
  constructor(page) { this.page = page; }
  field() { return this.page.locator('.filter-toolbar .serie-field'); }
  trigger() { return this.page.locator('#serieTrigger'); }
  checkbox(name) { return this.page.locator('#serieMenu').getByRole('checkbox', { name, exact: true }); }
  async open() {
    if (await this.page.locator('#serieMenu').evaluate(menu => menu.hidden)) await this.trigger().click();
    await this.page.waitForFunction(() => !document.getElementById('serieMenu').hidden
      && getComputedStyle(document.getElementById('serieMenu')).opacity === '1');
  }
  async apply() {
    if (!(await this.page.locator('#serieMenu').evaluate(menu => menu.hidden))) {
      await this.page.locator('#serieMenu').press('Escape');
      await this.page.waitForFunction(() => getComputedStyle(document.getElementById('serieMenu')).display === 'none');
    }
    await this.page.locator('#apply').click();
    await this.page.waitForFunction(() => document.getElementById('apply').textContent === 'Apply'
      && document.getElementById('reportPendingNotice').hidden);
    await this.page.waitForFunction(() => getComputedStyle(document.getElementById('serieMenu')).display === 'none');
  }
  async assertOutput(actual, target, included) {
    assert.equal(await this.page.locator('#totalQuantity').textContent(), actual.toLocaleString('en-US'));
    const gauge = this.page.locator('#mtdGauge svg');
    assert.equal(await gauge.getAttribute('aria-label'),
      `Product total MTD result ${actual.toLocaleString('en-US')} against target ${target.toLocaleString('en-US')}`);
    const rows = await this.page.locator('#mtdRows tr').evaluateAll(nodes => nodes.map(n => n.children[1]?.textContent));
    assert.deepEqual(rows.slice().sort(), included.slice().sort());
    const legend = await this.page.locator('#chartLegend').textContent();
    for (const name of series) {
      assert.equal(legend.includes(name), included.includes(name), `Output chart legend: ${name}`);
    }
  }
  async selectAll() {
    await this.open();
    await this.page.locator('#serieMenu').getByRole('button', { name: /select all|include all|all series/i }).click();
  }
}

async function mount(page) {
  await page.goto(origin);
  await page.waitForFunction(() => globalThis.__sc901FixtureReady);
  await page.evaluate(async ({ targets, options }) => {
    byId('dataSource').value = 'closed';
    byId('product').value = 'SC';
    byId('startDate').value = '2026-11-01';
    byId('endDate').value = '2026-11-10';
    syncReportDateRangePicker();
    document.querySelectorAll('.process-option').forEach(button => button.classList.toggle('active', button.dataset.product === 'SC'));
    currentConfig = { dataset: 'closed', chartAxis: 'date', filters: { process: false, serie: true, case: false, pn: true } };
    targetSettings = targets;
    targetStorageRemote = false;
    commentsEnabled = false;
    setFilterAvailability(currentConfig.filters);
    populateOptions({ process: [], serie: options, case: [], pn: [] });
    await loadData();
  }, { targets: targetSettings, options: series });
  const state = await page.evaluate(() => ({ status: byId('status').textContent, chart: byId('chart').innerHTML.slice(0, 300), selected: byId('dataSource').value }));
  assert.equal(state.status, '', JSON.stringify(state));
  await page.locator('#chart svg').waitFor({ state: 'attached', timeout: 5000 });
  return new CompletionPage(page);
}

async function selectedValues(page) {
  return page.locator('#serie').evaluate(select => [...select.selectedOptions].map(option => option.value));
}

async function desktop(context, repetition) {
  const page = await context.newPage();
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const ui = await mount(page);
  assert.equal(await ui.field().isVisible(), true, 'SC Completion series selector must be visible');
  assert.equal(await ui.field().getAttribute('aria-hidden'), 'false');
  assert.deepEqual((await selectedValues(page)).sort(), savedSeries.slice().sort());
  await ui.assertOutput(1000, 5250, savedSeries);
  await ui.open();
  assert.equal(await ui.checkbox('CAN').isChecked(), true);
  await ui.checkbox('CAN').uncheck();
  assert.equal(await page.locator('#reportPendingNotice').isVisible(), true);
  await ui.apply();
  await ui.assertOutput(900, 4750, savedSeries.filter(name => name !== 'CAN'));
  for (const endpoint of ['/api/quantity', '/api/mtd-quantity']) {
    const last = requests.filter(request => request.path === endpoint).at(-1);
    assert.ok(last, `${endpoint} must have been requested`);
    const sent = last.params.filter(([key]) => key === 'serie').map(([, value]) => value);
    assert.deepEqual(sent.sort(), savedSeries.filter(name => name !== 'CAN').sort(), `${endpoint} must exclude CAN`);
  }
  if (repetition === 1) await page.screenshot({ path: path.join(artifactDirectory, 'desktop-can-excluded.png'), fullPage: true });

  await ui.open();
  await ui.checkbox('CAN').check();
  await ui.apply();
  await ui.assertOutput(1000, 5250, savedSeries);

  await ui.open();
  for (const name of savedSeries.filter(name => name !== 'FC')) {
    await ui.checkbox(name).uncheck();
    assert.equal(await page.locator('#serieMenu').isVisible(), true, 'Picker stays open for multiple changes');
  }
  assert.equal(await ui.checkbox('FC').isChecked(), true);
  assert.equal(await ui.checkbox('FC').isDisabled(), true, 'Last included series must be protected');
  await ui.apply();
  await ui.assertOutput(300, 1500, ['FC']);
  await ui.selectAll();
  await ui.apply();
  await ui.assertOutput(1000, 5250, savedSeries);

  // Operate the existing trigger and native checkbox entirely from the keyboard.
  await ui.trigger().focus();
  await page.keyboard.press('Enter');
  assert.equal(await ui.trigger().getAttribute('aria-expanded'), 'true');
  await ui.checkbox('CAN').focus();
  await page.keyboard.press('Space');
  assert.equal(await ui.checkbox('CAN').isChecked(), false);
  assert.equal(await ui.checkbox('CAN').evaluate(node => node === document.activeElement), true, 'Checkbox focus must survive redraw');
  await ui.apply();
  await ui.assertOutput(900, 4750, savedSeries.filter(name => name !== 'CAN'));

  // Product buttons reload results automatically; series changes still use Apply.
  // NEO is a fresh scope, so its real options and quantity requests are observed.
  const optionsResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/options');
  const neoQuantityResponse = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/quantity' && url.searchParams.get('product') === 'NEO';
  });
  await page.getByRole('button', { name: 'NEO', exact: true }).click();
  await Promise.all([optionsResponse, neoQuantityResponse]);
  await page.waitForFunction(() => !document.getElementById('serieTrigger').disabled
    && document.getElementById('apply').textContent === 'Apply'
    && document.getElementById('reportPendingNotice').hidden
    && document.getElementById('totalQuantity').textContent === '700');
  assert.equal(await ui.field().isVisible(), false);
  assert.deepEqual(await selectedValues(page), []);
  assert.equal(await page.locator('#totalQuantity').textContent(), '700');

  // SC may reuse valid cached quantities, but must render them without Apply.
  const scOptionsResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/options');
  await page.getByRole('button', { name: 'SC', exact: true }).click();
  await scOptionsResponse;
  await page.waitForFunction(() => !document.getElementById('serieTrigger').disabled
    && document.getElementById('apply').textContent === 'Apply'
    && document.getElementById('reportPendingNotice').hidden
    && document.getElementById('totalQuantity').textContent === '1,000');
  assert.equal(await ui.field().isVisible(), true);
  assert.deepEqual((await selectedValues(page)).sort(), savedSeries.slice().sort());
  await ui.assertOutput(1000, 5250, savedSeries);
  if (repetition === 1) await page.screenshot({ path: path.join(artifactDirectory, 'desktop-sc-auto-applied.png'), fullPage: true });

  await page.evaluate(() => {
    byId('dataSource').value = 'lot';
    currentConfig = { ...currentConfig, dataset: 'lot' };
    setFilterAvailability(currentConfig.filters);
  });
  assert.equal(await ui.field().isVisible(), false, 'SC WIP must not show the Completion-only selector');
  assert.equal(errors.length, 0, errors.join('\n'));
  coverageRuns.push(...(await page.coverage.stopJSCoverage()).filter(entry => new URL(entry.url).pathname === '/app.js'));
  checks.push({ repetition, desktop: 'passed', keyboard: 'passed', productIsolation: 'passed', productAutoApply: 'passed' });
  await page.close();
}

async function mobile() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  const ui = await mount(page);
  await ui.open();
  const menu = await page.locator('#serieMenu').boundingBox();
  assert.ok(menu && menu.x >= 0 && menu.x + menu.width <= 391, 'Mobile series menu must fit the viewport');
  assert.equal(await ui.checkbox('CAN').evaluate(node => getComputedStyle(node.closest('label')).display), 'flex');
  await ui.checkbox('CAN').uncheck();
  await ui.apply();
  await ui.assertOutput(900, 4750, savedSeries.filter(name => name !== 'CAN'));
  await ui.open();
  await page.screenshot({ path: path.join(artifactDirectory, 'mobile-series-picker.png'), fullPage: false });
  checks.push({ mobile: 'passed', menuBounds: menu });
  await context.close();
}

function featureCoverage(runs) {
  const names = ['usesScCompletionSeries', 'syncSerieFilterVisibility', 'updateSerieTrigger',
    'seriePickerOption', 'renderSeriePicker', 'selectAllCompletionSeries', 'populateOptions'];
  const functions = names.map(name => {
    const reference = runs[0].functions.find(fn => fn.functionName === name);
    assert.ok(reference, `Missing coverage for ${name}`);
    const { startOffset: start, endOffset: end } = reference.ranges[0];
    let totalCharacters = 0, coveredCharacters = 0;
    for (let offset = start; offset < end; offset += 1) {
      if (/\s/.test(runs[0].source[offset])) continue;
      totalCharacters += 1;
      const covered = runs.some(run => {
        const ranges = run.functions.flatMap(fn => fn.ranges)
          .filter(range => range.startOffset >= start && range.endOffset <= end
            && range.startOffset <= offset && range.endOffset > offset)
          .sort((a, b) => (a.endOffset - a.startOffset) - (b.endOffset - b.startOffset));
        return ranges[0]?.count > 0;
      });
      if (covered) coveredCharacters += 1;
    }
    return { function: name, coveredCharacters, totalCharacters,
      executedCharacterPercent: Number((coveredCharacters / totalCharacters * 100).toFixed(2)) };
  });
  const coveredCharacters = functions.reduce((sum, fn) => sum + fn.coveredCharacters, 0);
  const totalCharacters = functions.reduce((sum, fn) => sum + fn.totalCharacters, 0);
  return { metric: 'V8 most-specific-range coverage of non-whitespace characters within changed helpers; not whole-app or Vitest branch coverage',
    runs: runs.length, functions, coveredCharacters, totalCharacters,
    executedCharacterPercent: Number((coveredCharacters / totalCharacters * 100).toFixed(2)) };
}

try {
  browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    try { await desktop(context, repetition); } finally { await context.close(); }
  }
  await mobile();
  assert.deepEqual(forbidden, [], 'Fixture must never write to an API');
  await writeFile(path.join(artifactDirectory, 'app-coverage.json'), JSON.stringify(coverageRuns));
  const coverage = featureCoverage(coverageRuns);
  await writeFile(path.join(artifactDirectory, 'feature-coverage.json'), JSON.stringify(coverage, null, 2));
  console.log(JSON.stringify({ status: 'passed', checks, forbiddenWrites: forbidden.length,
    featureExecutedCharacterPercent: coverage.executedCharacterPercent, artifacts: artifactDirectory }, null, 2));
} catch (error) {
  failures.push({ message: error.message, stack: error.stack });
  throw error;
} finally {
  await writeFile(path.join(artifactDirectory, 'verification.json'), JSON.stringify({ checks, failures, requestCount: requests.length, forbiddenWrites: forbidden }, null, 2));
  await browser?.close();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
