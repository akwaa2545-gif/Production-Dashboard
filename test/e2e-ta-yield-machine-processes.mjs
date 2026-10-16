import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createApp } from '../src/app.js';

// Uses an existing browser installation; never installs packages or opens a real database.
// node test/e2e-ta-yield-machine-processes.mjs (PLAYWRIGHT_MODULE_PATH selects playwright-core).
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright-core');
const repetitions = Number(process.env.E2E_REPETITIONS || 3);
assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 5, 'E2E_REPETITIONS must be from 1 through 5');
const machineGraphLimitOnly = process.env.E2E_MACHINE_LIMIT_ONLY === 'true';
const range = { startDate: '2026-09-01', endDate: '2026-10-16' };
const serie = 'Ta NEO Capacitor FPS series B3 case';
const pn = 'TEFPS';
const lot = (lotNo, extra = {}) => ({
  lotNo, tapingDate: '2026-09-15', line: serie, itemName: pn,
  modes: [{ mode: '1304_Welding_Def', category: 'Inproc Dw', quantity: 12 }], ...extra
});
const lots = [lot('6J15N00001'), lot('6J15N00002', { line: 'Other series' }),
  lot('6J15N00003', { itemName: 'OTHER' }), lot('6H15N00004', { tapingDate: '2026-08-15' })];
const event = (lotNo, operationName, machineName) => ({
  lotNo, operationName, machineName, occuredOn: '2026-09-15T03:00:00Z'
});
const events = [event(lots[0].lotNo, 'Pressing', 'PRESS-01'),
  event(lots[0].lotNo, 'Resin_coating', 'RESIN-01'),
  event(lots[0].lotNo, 'ResinXcoating', 'WRONG-PROCESS'),
  event(lots[1].lotNo, 'Resin_coating', 'OTHER-SERIES'),
  event(lots[2].lotNo, 'Resin_coating', 'OTHER-PART'),
  event(lots[3].lotNo, 'Resin_coating', 'OLD-LOT'),
  event('NON-STANDARD-EXCLUDED', 'Excluded-only', 'EXCLUDED-MACHINE'),
  event('NON-STANDARD-EXCLUDED', 'Resin_coating', 'EXCLUDED-MACHINE')];
let lotReads = [];
let eventReads = [];
let requests = [];
let machineAnalysisGate;
let machineAnalysisFailure = false;
const wrapper = express();
wrapper.use(async (request, response, next) => {
  if (!request.path.startsWith('/api/')) return next();
  requests = [...requests, { path: request.path, query: { ...request.query } }];
  if (request.method !== 'GET') return response.status(405).json({ success: false, error: 'Fixture is read-only.' });
  if (request.path === '/api/ta-yield-machine') {
    if (machineAnalysisGate) await machineAnalysisGate;
    if (machineAnalysisFailure) return response.status(503).json({ success: false, error: 'Fixture Machine analysis temporarily unavailable.' });
  }
  if (['/api/config', '/api/data-mode'].includes(request.path) || request.path.startsWith('/api/ta-yield-machine')) return next();
  const fullMonth = request.query.comparisonMode === 'full-month';
  const lastDay = new Date(`${request.query.compareMonth}-01T00:00:00Z`);
  lastDay.setUTCMonth(lastDay.getUTCMonth() + 1, 0);
  const comparisonRange = {
    startDate: `${request.query.compareMonth}-${fullMonth ? '01' : request.query.startDate?.slice(-2)}`,
    endDate: fullMonth && Number.isFinite(lastDay.getTime()) ? lastDay.toISOString().slice(0, 10)
      : `${request.query.compareMonth}-${request.query.endDate?.slice(-2)}`
  };
  if (request.path === '/api/ta-yield-compare') return response.json({ success: true, data: {
    currentRange: { startDate: request.query.startDate, endDate: request.query.endDate },
    compareMonth: request.query.compareMonth,
    compareRange: comparisonRange,
    rows: [{ label: 'Total', kind: 'total', currentYield: 92,
      compareYield: request.query.compareMonth === '2026-08' ? 94 : 91,
      delta: request.query.compareMonth === '2026-08' ? -2 : 1 }]
  } });
  if (request.path === '/api/ta-yield-compare-details') return response.json({ success: true, data: {
    currentRange: { startDate: request.query.startDate, endDate: request.query.endDate },
    compareRange: comparisonRange,
    selection: { label: 'Total', kind: 'total', key: 'Total' },
    groups: [{ group: 'Welding', currentQty: 100, compareQty: 200, currentRate: 1, compareRate: 2, deltaRate: -1 }],
    lots: { current: { rows: [], total: 0 }, compare: { rows: [], total: 0 } }
  } });
  if (request.path === '/api/export/ta-yield-compare') return response
    .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .send(Buffer.from('Read-only browser fixture: export parameters verified independently.'));
  if (request.path === '/api/part-numbers') return response.json({ success: true, data: {
    matches: [{ value: pn, serie }], items: [pn], hasMore: false
  } });
  const data = request.path === '/api/options'
    ? { product: ['NEO'], process: [], serie: [serie, 'Other series'], case: [], pn: [pn, 'OTHER'] }
    : [];
  return response.json({ success: true, data });
});
wrapper.use(createApp({
  environment: { SQL_SERVER: 'fixture', SQL_DATABASE: 'fixture', DATE_COLUMN: 'OccuredOn',
    DASHBOARD_TA_YIELD_STAGING_ENABLED: 'true' },
  repository: {},
  taYieldRepository: {},
  taYieldStagingRepository: {
    getMachineLots: async (filters) => {
      lotReads = [...lotReads, { ...filters }];
      return lots.filter((row) => row.tapingDate >= filters.startDate && row.tapingDate <= filters.endDate
        && (!filters.serie || row.line === filters.serie) && (!filters.pn || row.itemName === filters.pn));
    },
    // Deliberately return unrelated events to exercise the API's eligible-lot/process boundary.
    getMachineEvents: async (filters, selection) => {
      eventReads = [...eventReads, { filters: { ...filters }, selection: { ...selection } }];
      return events;
    }
  },
  yieldDefectSettingRepository: { list: async () => [] }
}));
const server = wrapper.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const artifacts = await mkdtemp(path.join(os.tmpdir(), 'ta-machine-process-e2e-'));

class MachinePage {
  constructor(page) { this.page = page; }
  control(id) { return this.page.locator(`#${id}`); }
  async ready() {
    await this.page.waitForFunction(() => {
      const select = document.getElementById('taMachineProcess');
      return select && !select.disabled && [...select.options].some((option) => option.value === 'Pressing');
    });
  }
  async setDate(id, value) {
    await this.control(id).fill(value);
    await this.control(id).dispatchEvent('change');
    await this.ready();
  }
  async selectProcess(value) {
    await this.control('taMachineProcess').selectOption(value);
    await this.page.waitForFunction(() => !document.getElementById('taMachineDefect').disabled);
  }
  async analyze() {
    await this.control('taMachineDefect').selectOption('category|Inproc Dw');
    const response = this.page.waitForResponse((item) => new URL(item.url()).pathname === '/api/ta-yield-machine');
    await this.control('taMachineApply').click();
    const result = await response;
    assert.equal(result.status(), 200);
    await this.control('taMachineChart').getByRole('img', { name: 'TA Yield machine defect-share trend', exact: true }).waitFor();
    return result.json();
  }
}

async function machineSvgGeometry(host) {
  return host.locator('svg').evaluate((svg) => [...svg.querySelectorAll('polyline, circle, text, title')].map((node) => ({
    tag: node.tagName, points: node.getAttribute('points'), cx: node.getAttribute('cx'), cy: node.getAttribute('cy'),
    fill: node.getAttribute('fill'), stroke: node.getAttribute('stroke'), text: node.textContent
  })));
}

class IndependentMachineGraph {
  constructor(page, id) { this.page = page; this.id = id; this.card = page.locator(`[data-machine-graph-id="${id}"]`); }
  field(name) { return this.card.locator(`[data-machine-filter="${name}"]`); }
  get chart() { return this.card.locator('.ta-machine-comparison-chart'); }
  get analyze() { return this.card.locator('.ta-machine-comparison-analyze'); }
  async ready() {
    await this.page.waitForFunction((id) => {
      const card = document.querySelector(`[data-machine-graph-id="${id}"]`);
      const process = card?.querySelector('[data-machine-filter="process"]');
      return process && !process.disabled && [...process.options].some((option) => option.value === 'Pressing');
    }, this.id);
  }
  async seedReady() {
    await this.ready();
    await this.page.waitForFunction((id) => {
      const card = document.querySelector(`[data-machine-graph-id="${id}"]`);
      return card.querySelector('[data-machine-filter="defect"]').value === 'category|Inproc Dw'
        && !card.querySelector('.ta-machine-comparison-analyze').disabled;
    }, this.id);
  }
  async selectProcess(value) {
    await this.field('process').selectOption(value);
    await this.page.waitForFunction((id) => !document.querySelector(`[data-machine-graph-id="${id}"] [data-machine-filter="defect"]`).disabled, this.id);
    await this.field('defect').selectOption('category|Inproc Dw');
  }
  async setDate(name, value) {
    await this.field(name).fill(value);
    await this.field(name).dispatchEvent('change');
    await this.ready();
  }
  async apply() {
    const result = this.page.waitForResponse((item) => new URL(item.url()).pathname === '/api/ta-yield-machine');
    await this.analyze.click();
    const response = await result;
    assert.equal(response.status(), 200);
    await this.chart.getByRole('img', { name: 'TA Yield machine defect-share trend', exact: true }).waitFor();
    return response.json();
  }
}

async function verifyMachineGraphLayout(page, machine, first, repetition) {
  const add = page.locator('#taMachineAddGraph');
  const lastBounds = await page.locator('.ta-machine-comparison-card').last().boundingBox();
  const addBounds = await add.boundingBox();
  assert.ok(addBounds.y >= lastBounds.y + lastBounds.height - 1, 'Large Add graph action follows the latest graph');
  assert.ok(addBounds.height >= 96, 'Add graph is a large action');
  assert.match(await add.textContent(), /\+/);
  assert.equal(await page.locator('.ta-machine-comparison-scope').count(), 0, 'Repeated scope paragraphs are removed');
  const duplicateIds = await page.locator('[id]').evaluateAll((elements) => {
    const ids = elements.map((element) => element.id);
    return ids.filter((id, index) => ids.indexOf(id) !== index);
  });
  assert.deepEqual(duplicateIds, []);
  await first.card.screenshot({ path: path.join(artifacts, `machine-independent-filters-desktop-${repetition}.png`) });
  await page.locator('.ta-machine-comparisons').screenshot({ path: path.join(artifacts, `machine-added-graph-cards-${repetition}.png`) });
  await page.screenshot({ path: path.join(artifacts, `machine-added-graphs-desktop-${repetition}.png`), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await add.scrollIntoViewIfNeeded();
  const narrowAdd = await add.boundingBox();
  assert.ok(narrowAdd.x >= 0 && narrowAdd.x + narrowAdd.width <= 390);
  await page.screenshot({ path: path.join(artifacts, `machine-add-action-narrow-${repetition}.png`) });
  for (const name of ['startDate', 'endDate', 'serie', 'process', 'pn', 'defect', 'groupBy', 'order']) {
    const bounds = await first.field(name).boundingBox();
    assert.ok(bounds.width >= 130, `Mobile ${name} control remains readable`);
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390, `Mobile ${name} stays within viewport`);
  }
  await first.card.screenshot({ path: path.join(artifacts, `machine-independent-filters-narrow-${repetition}.png`) });
  await page.screenshot({ path: path.join(artifacts, `machine-added-graphs-narrow-${repetition}.png`), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function verifyMachineGraphLimit(page, machine, repetition) {
  const add = page.locator('#taMachineAddGraph');
  const cards = page.locator('.ta-machine-comparison-card');
  const belowLastGraph = async () => {
    const last = cards.last();
    const graph = await last.boundingBox();
    const button = await add.boundingBox();
    assert.ok(button.y >= graph.y + graph.height - 1, 'Add graph follows the latest added graph');
  };
  for (let count = 1; count <= 4; count += 1) {
    assert.equal(await add.isEnabled(), true);
    await add.click();
    assert.equal(await cards.count(), count);
    const graph = new IndependentMachineGraph(page, await cards.last().getAttribute('data-machine-graph-id'));
    await graph.seedReady();
    await belowLastGraph();
    if (count <= 2) {
      await page.setViewportSize({ width: 390, height: 844 });
      await add.scrollIntoViewIfNeeded();
      await belowLastGraph();
      await page.setViewportSize({ width: 1280, height: 900 });
    }
  }
  assert.equal(await add.isDisabled(), true, 'Four added graphs is the maximum; the main graph is excluded');
  assert.match(await add.getAttribute('title'), /4/);
  await add.dispatchEvent('click');
  assert.equal(await cards.count(), 4, 'An attempted fifth graph cannot exceed the cap');
  await cards.first().locator('.ta-machine-comparison-remove').click();
  assert.equal(await cards.count(), 3);
  assert.equal(await add.isEnabled(), true, 'Removing a graph allows another one');
  await add.click();
  assert.equal(await cards.count(), 4);
  await new IndependentMachineGraph(page, await cards.last().getAttribute('data-machine-graph-id')).seedReady();
  assert.equal(await add.isDisabled(), true);
  await belowLastGraph();
  await machine.setDate('taMachineEndDate', range.endDate);
  assert.equal(await cards.count(), 4, 'Date rerenders preserve the graph count');
  assert.equal(await page.locator('[id="taMachineAddGraph"]').count(), 1);
  assert.equal(await add.isDisabled(), true);
  await page.getByRole('button', { name: 'Production dashboard', exact: true }).click();
  await page.getByRole('button', { name: 'Machine', exact: true }).click();
  await machine.ready();
  assert.equal(await cards.count(), 4, 'Tab rerenders preserve the cap');
  assert.equal(await page.locator('[id="taMachineAddGraph"]').count(), 1);
  assert.equal(await add.isDisabled(), true);
  await add.scrollIntoViewIfNeeded();
  await belowLastGraph();
  await page.screenshot({ path: path.join(artifacts, `machine-graph-limit-desktop-${repetition}.png`) });
  await page.setViewportSize({ width: 390, height: 844 });
  await add.scrollIntoViewIfNeeded();
  await belowLastGraph();
  const mobileButton = await add.boundingBox();
  assert.ok(mobileButton.x >= 0 && mobileButton.x + mobileButton.width <= 390);
  await page.screenshot({ path: path.join(artifacts, `machine-graph-limit-narrow-${repetition}.png`) });
  console.log(`CHECK ${repetition}/${repetitions}: Add graph follows the latest graph; cap4, blocked fifth, remove/re-add, one button across date/tab rerenders, desktop+narrow passed`);
}

async function verifyMachineGraphRequestGuards(page, machine, first, second, originalGeometry) {
  const add = page.locator('#taMachineAddGraph');
  const cards = page.locator('.ta-machine-comparison-card');
  await machine.selectProcess('Pressing');
  await add.click();
  const removed = new IndependentMachineGraph(page, await cards.last().getAttribute('data-machine-graph-id'));
  await removed.seedReady();
  assert.equal(await removed.field('process').inputValue(), 'Resin_coating', 'New graph seeds the applied chart rather than pending main filters');
  await removed.selectProcess('Pressing');
  let release;
  machineAnalysisGate = new Promise((resolve) => { release = resolve; });
  const pending = page.waitForResponse((item) => new URL(item.url()).pathname === '/api/ta-yield-machine');
  try {
    await removed.analyze.click();
    await page.waitForFunction((id) => document.querySelector(`[data-machine-graph-id="${id}"] .ta-machine-comparison-analyze`).disabled, removed.id);
    await removed.card.locator('.ta-machine-comparison-remove').click();
  } finally {
    release();
    machineAnalysisGate = undefined;
  }
  assert.equal((await pending).status(), 200);
  assert.equal(await cards.count(), 2, 'A response cannot restore a removed graph');
  assert.deepEqual(await machineSvgGeometry(second.chart), originalGeometry);
  await machine.control('taMachineDefect').selectOption('category|Inproc Dw');
  machineAnalysisFailure = true;
  const failed = page.waitForResponse((item) => new URL(item.url()).pathname === '/api/ta-yield-machine');
  await machine.control('taMachineApply').click();
  assert.equal((await failed).status(), 503);
  await machine.control('taMachineChart').filter({ hasText: 'Fixture Machine analysis temporarily unavailable.' }).waitFor();
  assert.equal(await add.isDisabled(), true, 'Failed main analysis cannot seed another graph');
  machineAnalysisFailure = false;
  await machine.analyze();
  const firstGeometry = await machineSvgGeometry(first.chart);
  await page.getByRole('button', { name: 'Production dashboard', exact: true }).click();
  await page.getByRole('button', { name: 'Machine', exact: true }).click();
  await add.waitFor();
  assert.equal(await cards.count(), 2, 'Independent graphs survive tab rerenders');
  assert.equal(await first.field('startDate').inputValue(), '2026-09-03');
  assert.equal(await first.field('process').inputValue(), 'Pressing');
  assert.deepEqual(await machineSvgGeometry(first.chart), firstGeometry);
  assert.deepEqual(await machineSvgGeometry(second.chart), originalGeometry);
  assert.equal(await add.isDisabled(), true);
}

async function verifyMachineGraphSnapshots(page, machine, repetition) {
  const add = page.locator('#taMachineAddGraph');
  const cards = page.locator('.ta-machine-comparison-card');
  const originalGeometry = await machineSvgGeometry(machine.control('taMachineChart'));
  assert.equal(await add.isEnabled(), true);
  await add.click();
  const first = new IndependentMachineGraph(page, await cards.first().getAttribute('data-machine-graph-id'));
  await first.seedReady();
  await add.click();
  const second = new IndependentMachineGraph(page, await cards.last().getAttribute('data-machine-graph-id'));
  await second.seedReady();
  assert.notEqual(first.id, second.id);
  assert.deepEqual(await machineSvgGeometry(first.chart), originalGeometry);
  assert.deepEqual(await machineSvgGeometry(second.chart), originalGeometry);
  for (const [name, value] of Object.entries({ ...range, serie, pn, process: 'Resin_coating', defect: 'category|Inproc Dw' })) {
    assert.equal(await first.field(name).inputValue(), value, `New graph seeds ${name}`);
  }
  await first.setDate('startDate', '2026-09-03');
  await first.setDate('endDate', '2026-09-20');
  await first.selectProcess('Pressing');
  await first.field('serie').selectOption('Other series');
  await page.waitForFunction((id) => {
    const process = document.querySelector(`[data-machine-graph-id="${id}"] [data-machine-filter="process"]`);
    return !process.disabled && [...process.options].some((option) => option.value === 'Resin_coating')
      && ![...process.options].some((option) => option.value === 'Pressing');
  }, first.id);
  assert.equal(await first.field('process').inputValue(), '', 'Changed eligibility clears a stale process');
  assert.equal(await first.field('defect').inputValue(), '');
  assert.equal(await first.analyze.isDisabled(), true);
  const catalogQuery = requests.filter((row) => row.path === '/api/ta-yield-machine-processes').at(-1).query;
  assert.deepEqual({ startDate: catalogQuery.startDate, endDate: catalogQuery.endDate, serie: catalogQuery.serie, pn: catalogQuery.pn }, {
    startDate: '2026-09-03', endDate: '2026-09-20', serie: 'Other series', pn
  });
  await first.field('serie').selectOption(serie);
  await first.ready();
  await first.selectProcess('Pressing');
  await first.field('pn').selectOption('OTHER');
  await page.waitForFunction((id) => {
    const process = document.querySelector(`[data-machine-graph-id="${id}"] [data-machine-filter="process"]`);
    return !process.disabled && [...process.options].some((option) => option.value === 'Resin_coating')
      && ![...process.options].some((option) => option.value === 'Pressing');
  }, first.id);
  assert.equal(await first.field('process').inputValue(), '', 'Card part-number changes clear an ineligible process');
  assert.equal(await first.field('defect').inputValue(), '');
  const pnCatalog = requests.filter((row) => row.path === '/api/ta-yield-machine-processes').at(-1).query;
  assert.equal(pnCatalog.pn, 'OTHER');
  assert.equal(pnCatalog.serie, serie);
  await first.field('pn').selectOption(pn);
  await first.ready();
  await first.selectProcess('Pressing');
  await first.field('groupBy').selectOption('week');
  await first.field('order').selectOption('date-machine');
  const result = await first.apply();
  assert.deepEqual(result.data.rows.map((row) => row.machineName), ['PRESS-01']);
  assert.equal(result.data.rows[0].quantity, 12);
  const analysis = requests.filter((row) => row.path === '/api/ta-yield-machine').at(-1).query;
  assert.deepEqual({ startDate: analysis.startDate, endDate: analysis.endDate, serie: analysis.serie, pn: analysis.pn,
    process: analysis.process, defectType: analysis.defectType, defect: analysis.defect }, {
    startDate: '2026-09-03', endDate: '2026-09-20', serie, pn, process: 'Pressing', defectType: 'category', defect: 'Inproc Dw'
  });
  assert.deepEqual(await machineSvgGeometry(machine.control('taMachineChart')), originalGeometry, 'A card analysis leaves the main chart unchanged');
  assert.deepEqual(await machineSvgGeometry(second.chart), originalGeometry, 'A card analysis leaves another graph unchanged');
  assert.equal(await machine.control('taMachineStartDate').inputValue(), range.startDate);
  assert.equal(await machine.control('taMachineEndDate').inputValue(), range.endDate);
  assert.equal(await machine.control('taMachineProcess').inputValue(), 'Resin_coating');
  assert.equal(await second.field('startDate').inputValue(), range.startDate);
  assert.match(await first.chart.textContent(), /PRESS-01/);
  assert.match(await first.chart.textContent(), /12\s*total defects/);
  const picker = first.card.locator('details.ta-machine-picker');
  const analysisCount = requests.filter((row) => row.path === '/api/ta-yield-machine').length;
  assert.doesNotMatch(await picker.locator('summary').textContent(), /PRESS-01/, 'Machine picker uses a compact count');
  await picker.locator('summary').click();
  const machineChoice = picker.locator('input[data-machine-name="PRESS-01"]');
  assert.equal(await machineChoice.count(), 1);
  await machineChoice.uncheck();
  await machineChoice.check();
  await first.chart.getByRole('img', { name: 'TA Yield machine defect-share trend', exact: true }).waitFor();
  await picker.locator('summary').click();
  await first.field('order').selectOption('machine-date');
  assert.equal(requests.filter((row) => row.path === '/api/ta-yield-machine').length, analysisCount, 'Machine selection and ordering stay local to the graph');
  assert.deepEqual(await machineSvgGeometry(machine.control('taMachineChart')), originalGeometry);
  assert.deepEqual(await machineSvgGeometry(second.chart), originalGeometry);
  await verifyMachineGraphLayout(page, machine, first, repetition);
  await verifyMachineGraphRequestGuards(page, machine, first, second, originalGeometry);
  console.log(`CHECK ${repetition}/${repetitions}: independent Machine graph filters/requests, main+other isolation, dynamic eligibility, stale clearing, removal, tab persistence, large Add below chart and mobile controls passed`);
}

class ComparePage {
  constructor(page, panel) { this.page = page; this.panel = panel; }
  control(name) { return this.panel.locator(`[data-compare-${name}]`); }
  async loaded() { await this.control('status').filter({ hasText: 'Compare loaded:' }).waitFor(); }
  async apply(month, mode) {
    await this.control('month').fill(month);
    await this.control('mode').selectOption(mode);
    const response = this.page.waitForResponse((item) => {
      const url = new URL(item.url());
      return url.pathname === '/api/ta-yield-compare' && url.searchParams.get('compareMonth') === month
        && url.searchParams.get('comparisonMode') === mode;
    });
    await this.control('apply').click();
    assert.equal((await response).status(), 200);
    await this.loaded();
  }
  async dragTo(x, y) {
    const header = await this.control('drag').boundingBox();
    assert.ok(header, 'Compare drag header is visible');
    await this.page.mouse.move(header.x + 35, header.y + 22);
    await this.page.mouse.down();
    await this.page.mouse.move(x + 35, y + 22, { steps: 5 });
    await this.page.mouse.up();
  }
  async resizeTo(width) {
    const handle = this.panel.locator('[data-resize-direction="e"]');
    await handle.focus();
    for (let steps = 0; steps < 30; steps += 1) {
      const bounds = await this.panel.boundingBox();
      const difference = bounds.width - width;
      if (Math.abs(difference) < 10) return;
      await handle.press(`${Math.abs(difference) >= 50 ? 'Shift+' : ''}${difference > 0 ? 'ArrowLeft' : 'ArrowRight'}`);
    }
    assert.fail('Compare panel did not reach the requested width using its keyboard resize control');
  }
  async resizeHeightTo(height) {
    const handle = this.panel.locator('[data-resize-direction="s"]');
    await handle.focus();
    for (let steps = 0; steps < 30; steps += 1) {
      const bounds = await this.panel.boundingBox();
      const difference = bounds.height - height;
      if (Math.abs(difference) < 10) return;
      await handle.press(`${Math.abs(difference) >= 50 ? 'Shift+' : ''}${difference > 0 ? 'ArrowUp' : 'ArrowDown'}`);
    }
    assert.fail('Compare panel did not reach the requested height using its keyboard resize control');
  }
  async export() {
    const response = this.page.waitForResponse((item) => new URL(item.url()).pathname === '/api/export/ta-yield-compare');
    const downloading = this.page.waitForEvent('download');
    await this.control('export').click();
    assert.equal((await response).status(), 200);
    const download = await downloading;
    assert.equal(await download.failure(), null);
    await this.control('export-status').filter({ hasText: 'Excel download ready.' }).waitFor();
    return download.suggestedFilename();
  }
}

async function verifyUniqueCompareReferences(page) {
  const issues = await page.locator('.ta-yield-compare-panel').evaluateAll((panels) => {
    const elements = panels.flatMap((panel) => [panel, ...panel.querySelectorAll('*')]);
    const ids = elements.filter((element) => element.id).map((element) => element.id);
    const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
    const invalidReferences = panels.flatMap((panel) => [panel, ...panel.querySelectorAll('[aria-controls], [aria-labelledby], [aria-describedby], label[for]')]
      .flatMap((element) => ['aria-controls', 'aria-labelledby', 'aria-describedby', 'for']
        .flatMap((attribute) => (element.getAttribute(attribute) || '').split(/\s+/).filter(Boolean)
          .filter((id) => ![panel, ...panel.querySelectorAll('[id]')].some((target) => target.id === id)))));
    return { duplicateIds, invalidReferences };
  });
  assert.deepEqual(issues, { duplicateIds: [], invalidReferences: [] }, 'Every Compare panel has independent valid DOM/ARIA references');
}

async function verifyMultipleCompareGraphs(page, primary, repetition) {
  const main = new ComparePage(page, primary);
  await main.apply('2026-08', 'full-month');
  const mainChart = await main.control('chart').innerHTML();
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === '/api/ta-yield-compare');
  await main.control('add-graph').click();
  assert.equal((await response).status(), 200);
  const firstChildId = await page.locator('.ta-yield-compare-panel').last().getAttribute('id');
  assert.match(firstChildId, /^taYieldComparePanel-\d+$/);
  const childPanel = page.locator(`#${firstChildId}`);
  const child = new ComparePage(page, childPanel);
  await child.loaded();
  assert.notEqual(firstChildId, 'taYieldComparePanel');
  assert.equal(await page.locator('.ta-yield-compare-panel:visible').count(), 2);
  await child.apply('2026-07', 'same-dates');
  assert.equal(await main.control('month').inputValue(), '2026-08');
  assert.equal(await main.control('mode').inputValue(), 'full-month');
  assert.equal(await main.control('chart').innerHTML(), mainChart, 'Applying a child does not redraw or replace the original graph');
  assert.match(await main.control('scope').textContent(), /2026-08-01 to 2026-08-31/);
  assert.match(await child.control('scope').textContent(), /2026-07-03 to 2026-07-10/);
  await verifyUniqueCompareReferences(page);

  const details = page.waitForResponse((item) => new URL(item.url()).pathname === '/api/ta-yield-compare-details');
  await child.control('summary').getByRole('button', { name: 'LOOKUP Total', exact: true }).click();
  assert.equal((await details).status(), 200);
  await child.control('status').filter({ hasText: 'LOOKUP loaded for Total.' }).waitFor();
  assert.equal(await child.control('detail').isVisible(), true);
  assert.equal(await main.control('detail').isVisible(), false);
  assert.equal(await main.control('chart').innerHTML(), mainChart);
  assert.match(await child.export(), /-vs-2026-07\.xlsx$/);
  const childExport = requests.filter((row) => row.path === '/api/export/ta-yield-compare').at(-1).query;
  assert.equal(childExport.compareMonth, '2026-07');
  assert.equal(childExport.comparisonMode, 'same-dates');
  assert.equal(childExport.kind, 'total', 'Only this graph exports its open LOOKUP');

  await child.control('detail-close').click();
  await child.resizeTo(600);
  await child.dragTo(664, 16);
  await child.resizeHeightTo(820);
  await main.resizeTo(600);
  await main.dragTo(16, 16);
  await main.resizeHeightTo(820);
  assert.match(await main.export(), /-vs-2026-08\.xlsx$/);
  const mainExport = requests.filter((row) => row.path === '/api/export/ta-yield-compare').at(-1).query;
  assert.equal(mainExport.compareMonth, '2026-08');
  assert.equal(mainExport.comparisonMode, 'full-month');
  assert.equal(mainExport.kind, undefined, 'Original graph exports without the child LOOKUP');
  await child.control('month').focus();
  await main.control('month').focus();
  await page.screenshot({ path: path.join(artifacts, `compare-multiple-desktop-${repetition}.png`), fullPage: true });
  console.log(`CHECK ${repetition}/${repetitions}: independent graphs, LOOKUP and exports passed at desktop width`);

  await child.control('close').click();
  await childPanel.waitFor({ state: 'detached' });
  assert.equal(await primary.isVisible(), true);
  const newResponse = page.waitForResponse((item) => new URL(item.url()).pathname === '/api/ta-yield-compare');
  await main.control('add-graph').click();
  assert.equal((await newResponse).status(), 200);
  const nextChildPanel = page.locator('.ta-yield-compare-panel').last();
  const nextChild = new ComparePage(page, nextChildPanel);
  await nextChild.loaded();
  assert.notEqual(await nextChildPanel.getAttribute('id'), firstChildId, 'Removed instance IDs are never reused');
  await verifyUniqueCompareReferences(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction((id) => {
    const bounds = document.getElementById(id).getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= window.innerWidth;
  }, await nextChildPanel.getAttribute('id'));
  assert.equal(await nextChild.control('add-graph').isVisible(), true, 'Add graph remains visible on a narrow viewport');
  const narrowBounds = await nextChildPanel.boundingBox();
  assert.ok(narrowBounds.x >= 0 && narrowBounds.x + narrowBounds.width <= 390, 'Narrow Compare panel stays within viewport');
  for (const name of ['month', 'mode']) {
    const bounds = await nextChild.control(name).boundingBox();
    assert.ok(bounds.width >= 130, `Narrow ${name} control has enough width to read its value`);
  }
  await nextChild.apply('2026-06', 'full-month');
  assert.equal(await main.control('month').inputValue(), '2026-08', 'Narrow-screen graph controls remain independent');
  await page.screenshot({ path: path.join(artifacts, `compare-multiple-narrow-${repetition}.png`) });
  console.log(`CHECK ${repetition}/${repetitions}: narrow Add graph and independent period controls passed`);
  await page.setViewportSize({ width: 1280, height: 900 });
  // The dashboard toggle is outside these floating panels after restoring the desktop viewport.
  await nextChild.control('minimize').click();
  await main.control('minimize').click();
  await page.getByRole('button', { name: 'Compare: On', exact: true }).click();
  assert.equal(await page.locator('.ta-yield-compare-panel:visible').count(), 0);
  assert.equal(await page.locator('.ta-yield-compare-panel').count(), 1, 'Compare Off disposes extra graphs');

  const reopenResponse = page.waitForResponse((item) => new URL(item.url()).pathname === '/api/ta-yield-compare');
  await page.getByRole('button', { name: 'Compare: Off', exact: true }).click();
  assert.equal((await reopenResponse).status(), 200);
  if (await main.control('minimize').getAttribute('aria-expanded') === 'false') await main.control('minimize').click();
  await main.loaded();
  const thirdResponse = page.waitForResponse((item) => new URL(item.url()).pathname === '/api/ta-yield-compare');
  await main.control('add-graph').click();
  assert.equal((await thirdResponse).status(), 200);
  await page.locator('.ta-yield-compare-panel').last().locator('[data-compare-status]').filter({ hasText: 'Compare loaded:' }).waitFor();
  await page.locator('#dataSource').selectOption('yield');
  await page.waitForFunction(() => document.querySelectorAll('.ta-yield-compare-panel').length === 1
    && document.getElementById('taYieldComparePanel').hidden);
  assert.equal(await page.locator('.ta-yield-compare-panel:visible').count(), 0, 'Changing dashboard source closes all Compare windows and disposes extras');
  assert.equal(await page.locator('.ta-machine-comparison-card').count(), 0, 'Changing dashboard source clears saved Machine graphs');
}

async function verifyRestoredDashboardControls(page, firstRequest, repetition) {
  const compareRequests = () => requests.slice(firstRequest).filter((row) => row.path === '/api/ta-yield-compare');
  assert.equal(compareRequests().length, 0, 'Compare never fetches while closed, including startup');
  assert.equal(requests.slice(firstRequest).filter((row) => row.path === '/api/daily-output').length, 0,
    'Daily output does not fetch automatically');
  await page.getByRole('button', { name: 'Production dashboard', exact: true }).click();
  const compare = page.getByRole('button', { name: 'Compare: Off', exact: true });
  await compare.waitFor();
  assert.equal(await page.getByRole('button', { name: 'Daily output: Off', exact: true }).getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('#dailyOutputPanel').isVisible(), false, 'No Daily output overlay opens automatically');
  await page.locator('#reportDateRangeTrigger').click();
  await page.locator('[data-date-range-date="2026-10-03"]').click();
  await page.locator('[data-date-range-date="2026-10-10"]').click();
  // TA's main report hides Series and disables PN; Machine's separate scope is checked above.
  assert.equal(await page.locator('#serieTrigger').isVisible(), false);
  assert.equal(await page.locator('#pn').isDisabled(), true);
  const reportResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/ta-yield');
  await page.locator('#apply').click();
  assert.equal((await reportResponse).status(), 200);
  await page.waitForFunction(() => document.getElementById('apply').textContent === 'Apply'
    && !document.getElementById('apply').disabled);
  assert.equal(compareRequests().length, 0, 'Applying a report keeps closed Compare idle');
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === '/api/ta-yield-compare');
  await compare.click();
  assert.equal((await response).status(), 200);
  const panel = page.locator('#taYieldComparePanel');
  await panel.locator('[data-compare-status]').filter({ hasText: 'Compare loaded:' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Compare: On', exact: true }).getAttribute('aria-expanded'), 'true');
  assert.equal(await panel.isVisible(), true);
  assert.equal(await panel.getByRole('group', { name: 'Compare: accumulated yield change by series and case size, in percentage points', exact: true }).isVisible(), true);
  const query = compareRequests().at(-1).query;
  assert.deepEqual({ startDate: query.startDate, endDate: query.endDate, product: query.product }, {
    startDate: '2026-10-03', endDate: '2026-10-10', product: 'NEO'
  });
  assert.equal(query.serie, undefined);
  assert.equal(query.pn, undefined);
  await verifyMultipleCompareGraphs(page, panel, repetition);
  assert.equal(await panel.isVisible(), false);
  assert.equal(await page.locator('#taYieldCompareToggle').getAttribute('aria-expanded'), 'false');
}

let browser;
try {
  browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL,
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH });
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    const firstRequest = requests.length;
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => sessionStorage.setItem('onemes-dashboard-navigation-v1', JSON.stringify({
      dataset: 'ta-yield', view: 'ta-yield-machine', product: 'NEO'
    })));
    await context.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const machine = new MachinePage(page);
    try {
      await page.goto(origin);
      await page.getByRole('button', { name: 'Machine', exact: true }).waitFor();
      // The fixture month is earlier than the app's default report month.
      await page.locator('#taMachineStartDate').waitFor();
      assert.equal(await page.locator('#taMachineAddGraph').isDisabled(), true, 'Add graph starts disabled before analysis');
      await machine.setDate('taMachineStartDate', range.startDate);
      await machine.setDate('taMachineEndDate', range.endDate);
      await machine.control('taMachineSerie').selectOption(serie);
      await machine.ready();
      await machine.control('taMachinePartNumber').selectOption(pn);
      await machine.ready();
      const values = await machine.control('taMachineProcess').locator('option').evaluateAll((options) => options.map((option) => option.value));
      assert.deepEqual(values, ['', 'Pressing', 'Resin_coating', 'ResinXcoating']);
      await machine.selectProcess('Pressing');
      await machine.selectProcess('Resin_coating');
      assert.equal(await machine.control('taMachineSerie').inputValue(), serie);
      assert.equal(await machine.control('taMachinePartNumber').inputValue(), pn);
      const result = await machine.analyze();
      assert.deepEqual(result.data.rows.map((row) => row.machineName), ['RESIN-01']);
      assert.equal(result.data.rows[0].quantity, 12);
      assert.equal(result.data.totalMachines, 1);
      const chart = machine.control('taMachineChart');
      assert.match(await chart.textContent(), /RESIN-01/);
      assert.doesNotMatch(await chart.textContent(), /WRONG-PROCESS|EXCLUDED-MACHINE|OTHER-SERIES|OTHER-PART|OLD-LOT/);
      const analysis = requests.filter((row) => row.path === '/api/ta-yield-machine').at(-1).query;
      assert.deepEqual({ startDate: analysis.startDate, endDate: analysis.endDate, serie: analysis.serie, pn: analysis.pn }, { ...range, serie, pn });
      assert.ok(lotReads.some((filters) => filters.startDate === range.startDate && filters.endDate === range.endDate && filters.serie === serie && filters.pn === pn));
      assert.ok(eventReads.some(({ selection }) => selection.processName === 'Resin_coating'));
      await page.screenshot({ path: path.join(artifacts, `machine-processes-${repetition}.png`), fullPage: true });
      if (machineGraphLimitOnly) {
        await verifyMachineGraphLimit(page, machine, repetition);
        assert.deepEqual(errors, []);
        console.log(`PASS ${repetition}/${repetitions}: focused Machine graph cap and placement; no browser errors`);
        continue;
      }
      await verifyMachineGraphSnapshots(page, machine, repetition);
      // Narrow to a date range with no eligible lots: a stale process/defect cannot be submitted.
      await machine.control('taMachineStartDate').fill('2026-10-01');
      await machine.control('taMachineStartDate').dispatchEvent('change');
      await page.waitForFunction(() => document.getElementById('taMachineProcess')?.textContent.includes('No processes available'));
      assert.equal(await machine.control('taMachineProcess').inputValue(), '');
      assert.equal(await machine.control('taMachineDefect').inputValue(), '');
      assert.equal(await machine.control('taMachineApply').isDisabled(), true);
      assert.equal(await page.locator('#taMachineAddGraph').isDisabled(), true, 'An empty Machine result cannot be saved');
      assert.equal(await machine.control('taMachineSerie').inputValue(), serie);
      assert.equal(await machine.control('taMachinePartNumber').inputValue(), pn);
      await verifyRestoredDashboardControls(page, firstRequest, repetition);
      await page.screenshot({ path: path.join(artifacts, `dashboard-controls-${repetition}.png`), fullPage: true });
      assert.deepEqual(errors, []);
      console.log(`PASS ${repetition}/${repetitions}: Machine eligibility/scoped exact processes/stale clearing; Compare adds independent graphs, periods, LOOKUP and exports, unique IDs/ARIA, child close/re-add, Off/source disposal, desktop+narrow; Daily output defaults Off; no browser errors`);
    } catch (error) {
      await page.screenshot({ path: path.join(artifacts, `failure-${repetition}.png`), fullPage: true, timeout: 10000 });
      console.log(`Failure artifacts: ${artifacts}`);
      throw error;
    } finally {
      await context.tracing.stop({ path: path.join(artifacts, `trace-${repetition}.zip`) });
      await context.close();
    }
  }
  console.log(`Artifacts: ${artifacts}`);
} finally {
  await browser?.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
