import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

// Real frontend renderer/card manager, synthetic rows, no application server or MES.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright-core');
const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
const artifacts = fileURLToPath(new URL('../artifacts/machine-chart-interactions/', import.meta.url));
await mkdir(artifacts, { recursive: true });
const html = await readFile(path.join(publicDirectory, 'index.html'), 'utf8');
const source = await readFile(path.join(publicDirectory, 'app.js'), 'utf8');
const startup = 'initializeDashboardDataModeControls().then(initializeDashboardNavigation).catch((error) => setStatus(error.message));';
assert.equal(source.split(startup).length, 2);
const fixtureSource = source.replace(startup, 'globalThis.__machineFixtureReady=true;');
const machines = ['PRESS-01', 'PRESS-02', 'PRESS-03', 'PRESS-04', 'PRESS-05'];
const rows = machines.flatMap((machineName, machine) => Array.from({ length: 15 }, (_, date) => ({
  date: `2026-10-${String(date + 1).padStart(2, '0')}`, machineName,
  quantity: 12 + ((machine * 13 + date * 7) % 53)
})));
const app = express();
const apiRequests = [];
app.use('/api', (request, response) => {
  apiRequests.push(`${request.method} ${request.originalUrl}`);
  response.status(405).json({ success: false, error: 'This browser fixture does not access APIs.' });
});
app.get('/', (_request, response) => response.type('html').send(html));
app.get('/app.js', (_request, response) => response.type('js').send(fixtureSource));
app.use(express.static(publicDirectory));
let server;
let browser;
let context;
let page;
const errors = [];

async function drawn() {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function mount() {
  await page.evaluate(({ rows, machines }) => {
    [...document.body.children].forEach((node) => { if (node.tagName !== 'SCRIPT') node.hidden = true; });
    const host = document.createElement('main');
    host.className = 'dashboard machine-fixture';
    host.id = 'machineFixture';
    const chart = document.createElement('section');
    chart.id = 'taMachineChart';
    chart.className = 'ta-machine-chart-wrap';
    chart.innerHTML = machineDateLines(rows);
    taYieldMachineTotalMachines = machines.length;
    taYieldMachineRows = rows;
    const add = document.createElement('button');
    add.id = 'taMachineAddGraph';
    add.className = 'ta-machine-add-graph';
    add.textContent = '+ Add graph';
    document.body.append(host);
    host.append(chart, add);
    const style = document.createElement('style');
    style.textContent = 'body{margin:0;min-width:0}.machine-fixture{box-sizing:border-box;width:100%;max-width:1480px;padding:24px;margin:auto;min-width:0}.machine-fixture>#taMachineChart{min-width:0}.machine-fixture .ta-machine-comparisons{min-width:0}@media(max-width:600px){.machine-fixture{padding:12px}}';
    document.head.append(style);
    const scope = { startDate: '2026-10-01', endDate: '2026-10-15', serie: 'FPS B3', pn: 'TEFPS', process: 'Pressing', defectType: 'category', defect: 'Inproc Dw', groupBy: 'day' };
    const request = async (url) => {
      if (url.startsWith('/api/options')) return { serie: ['FPS B3'], pn: ['TEFPS'] };
      if (url.startsWith('/api/ta-yield-machine-processes')) return { processes: ['Pressing'] };
      if (url.startsWith('/api/ta-yield-machine-options')) return { codes: [], categories: ['Inproc Dw'] };
      if (url.startsWith('/api/ta-yield-machine?')) return { rows, totalMachines: machines.length };
      throw new Error(`Unexpected fixture request: ${url}`);
    };
    globalThis.__machineCards = createTaYieldMachineGraphs({ request, renderChart: machineDateLinesForGraph });
    globalThis.__machineCards.attach(host, add);
    const token = globalThis.__machineCards.begin();
    globalThis.__machineCards.setAnalysis(token, scope, chart, () => ({ rows, totalMachines: machines.length, machines, order: chart.querySelector('.ta-machine-line-order').value }));
    globalThis.__machineFixtureRows = rows;
    globalThis.TaMachineChartInteractions?.scan();
  }, { rows, machines });
  await drawn();
}

async function range(chart) {
  return chart.locator('svg.ta-machine-date-machine-chart').evaluate((svg) => ({ start: Number(svg.dataset.chartStart), end: Number(svg.dataset.chartEnd) }));
}

async function geometry(chart) {
  return chart.locator('svg.ta-machine-date-machine-chart').evaluate((svg) => ({
    axes: [...svg.querySelectorAll('text[text-anchor="end"]')].map((node) => ({ text: node.textContent, x: node.getAttribute('x'), y: node.getAttribute('y'), visibility: getComputedStyle(node).visibility })),
    points: [...svg.querySelectorAll('.ta-machine-line-series circle')].map((node) => ({ x: Number(node.getAttribute('cx')), y: Number(node.getAttribute('cy')), title: node.querySelector('title')?.textContent || '' })),
    labels: [...svg.querySelectorAll('.ta-machine-vertical-label')].map((node) => ({ x: Number(node.getAttribute('x')), transform: node.getAttribute('transform'), machine: node.textContent })),
    dividers: [...svg.querySelectorAll('.ta-machine-group-divider')].map((node) => Number(node.getAttribute('x1')))
  }));
}

async function aligned(chart) {
  const current = await geometry(chart);
  for (const label of current.labels) {
    const pivot = label.transform.match(/rotate\(-90\s+([-\d.e]+)\s+([-\d.e]+)\)/);
    assert.ok(pivot, 'Machine labels keep their vertical rotation');
    assert.ok(Math.abs(Number(pivot[1]) - label.x) < .001, 'Rotated label pivots move with their x position');
    const firstPoint = current.points.find((point) => point.title.includes(label.machine));
    assert.ok(firstPoint && Math.abs(firstPoint.x - label.x) < .001, 'Machine labels align with their first plotted date');
  }
  const positions = [...new Set(current.points.map((point) => point.x))].sort((left, right) => left - right);
  assert.ok(current.dividers.every((divider) => positions.slice(1).some((position, index) => Math.abs((positions[index] + position) / 2 - divider) < .001)), 'Group separators stay halfway between adjacent plotted dates');
}

async function validClips() {
  const references = await page.locator('svg.ta-machine-date-machine-chart [clip-path]').evaluateAll((nodes) => nodes.map((node) => {
    const id = node.getAttribute('clip-path').match(/url\(#([^)]+)\)/)?.[1];
    return { id, matches: id ? [...document.querySelectorAll('[id]')].filter((candidate) => candidate.id === id).length : 0 };
  }));
  assert.ok(references.length > 0);
  assert.ok(references.every((reference) => reference.id && reference.matches === 1), 'Every graph has a unique, valid plot clipping reference');
}

async function wheel(chart, amount = -320) {
  const svg = chart.locator('svg.ta-machine-date-machine-chart');
  await svg.scrollIntoViewIfNeeded();
  const box = await svg.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * .4);
  const previous = await range(chart);
  await page.mouse.wheel(0, amount);
  await page.waitForFunction(({ selector, previous }) => {
    const svg = document.querySelector(selector);
    return Number(svg.dataset.chartStart) !== previous.start || Number(svg.dataset.chartEnd) !== previous.end;
  }, { selector: await svg.evaluate((node) => node.closest('[data-machine-graph-id]') ? `[data-machine-graph-id="${node.closest('[data-machine-graph-id]').dataset.machineGraphId}"] svg.ta-machine-date-machine-chart` : '#taMachineChart svg.ta-machine-date-machine-chart'), previous });
  await drawn();
}

async function validate() {
  assert.equal(await page.evaluate(() => typeof globalThis.TaMachineChartInteractions?.scan), 'function', 'Machine charts provide the interaction adapter');
  const main = page.locator('#taMachineChart');
  await main.locator('svg[data-machine-chart-enhanced="true"]').waitFor();
  assert.equal(await main.locator('.ta-yield-chart-navigation').count(), 1);
  const original = await geometry(main);
  assert.equal(original.axes.length, 5, 'The real renderer includes five nested Y-axis labels');
  assert.equal(await main.locator('.ta-machine-vertical-label').first().isVisible(), true, 'The first full-range machine label remains visible in the axis gutter');
  await wheel(main);
  const zoomedRange = await range(main);
  assert.ok(zoomedRange.end - zoomedRange.start < 1);
  assert.ok(Math.abs((zoomedRange.start + zoomedRange.end) / 2 - .5) < .01, 'Wheel zoom anchors around the pointer');
  const zoomed = await geometry(main);
  assert.deepEqual(zoomed.axes, original.axes, 'Nested Y axes stay fixed and visible');
  assert.notDeepEqual(zoomed.points, original.points);
  await aligned(main);
  await main.screenshot({ path: path.join(artifacts, 'main-zoomed.png') });
  await page.locator('#taMachineAddGraph').click();
  const first = page.locator('.ta-machine-comparison-card').first();
  await first.locator('svg[data-machine-chart-enhanced="true"]').waitFor();
  assert.deepEqual(await range(first), { start: 0, end: 1 }, 'Adding a graph after zooming starts from a fresh complete view');
  await validClips();
  await wheel(first);
  assert.deepEqual(await range(main), zoomedRange, 'Added graph zoom is independent of the main graph');
  const firstZoom = await range(first);
  const firstSvg = first.locator('svg.ta-machine-date-machine-chart');
  const dragBox = await firstSvg.boundingBox();
  await page.mouse.move(dragBox.x + dragBox.width * .65, dragBox.y + dragBox.height * .4);
  await page.mouse.down();
  await page.mouse.move(dragBox.x + dragBox.width * .45, dragBox.y + dragBox.height * .4, { steps: 8 });
  await page.mouse.up();
  await drawn();
  assert.notDeepEqual(await range(first), firstZoom, 'Dragging pans the added graph');
  assert.deepEqual(await range(main), zoomedRange, 'Dragging the added graph leaves the main range unchanged');
  await aligned(first);
  await first.locator('.ta-machine-line-scroll').focus();
  const beforeKey = await range(first);
  await page.keyboard.press('ArrowLeft');
  await drawn();
  assert.notDeepEqual(await range(first), beforeKey, 'Arrow keys pan the focused chart');
  await page.keyboard.press('Home');
  await drawn();
  assert.deepEqual(await range(first), { start: 0, end: 1 }, 'Home resets the focused chart');
  await first.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await drawn();
  const beforeOut = await range(first);
  await first.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await drawn();
  assert.ok((await range(first)).end - (await range(first)).start > beforeOut.end - beforeOut.start, 'Zoom out expands the period range');
  await page.locator('#taMachineAddGraph').click();
  const second = page.locator('.ta-machine-comparison-card').nth(1);
  await second.locator('svg[data-machine-chart-enhanced="true"]').waitFor();
  const secondRange = await range(second);
  await wheel(first);
  assert.deepEqual(await range(second), secondRange, 'Each added graph owns an independent viewport');
  await validClips();
  const focusablePoint = first.locator('.ta-machine-line-series circle[tabindex="0"]').first();
  await focusablePoint.focus();
  assert.equal(await first.locator('.ta-machine-point-tooltip').isVisible(), true, 'Visible points retain keyboard tooltips');
  const invalidFocus = await first.locator('.ta-machine-line-series circle[aria-hidden="true"]').evaluateAll((nodes) => nodes.some((node) => node.getAttribute('tabindex') !== '-1'));
  assert.equal(invalidFocus, false, 'Clipped points cannot receive keyboard focus');
  await first.locator('[data-machine-filter="order"]').selectOption('date-machine');
  await first.locator('svg[data-machine-chart-enhanced="true"]').waitFor();
  assert.equal(await first.locator('.ta-machine-vertical-label').count(), 0, 'Date-first redraw uses the real date labels');
  assert.equal(await first.locator('.ta-yield-chart-navigation').count(), 1, 'Redraw replaces the controller toolbar');
  await first.locator('[data-machine-filter="order"]').selectOption('machine-date');
  await first.locator('svg[data-machine-chart-enhanced="true"]').waitFor();
  await aligned(first);
  await wheel(first);
  await first.getByRole('button', { name: 'Reset chart view', exact: true }).click();
  await drawn();
  assert.deepEqual(await range(first), { start: 0, end: 1 });
  await main.getByRole('button', { name: 'Reset chart view', exact: true }).click();
  await drawn();
  assert.deepEqual(await range(main), { start: 0, end: 1 });
  await main.locator('.ta-machine-line-order').selectOption('date-machine');
  await main.locator('svg[data-machine-chart-enhanced="true"]').waitFor();
  assert.equal(await main.locator('.ta-machine-vertical-label').count(), 0, 'The main chart supports the real date-first order redraw');
  await main.locator('.ta-machine-line-order').selectOption('machine-date');
  await main.locator('svg[data-machine-chart-enhanced="true"]').waitFor();
  await aligned(main);
  await page.locator('#machineFixture').screenshot({ path: path.join(artifacts, 'desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await drawn();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'Machine charts do not create horizontal page overflow at390px');
  await wheel(main);
  await page.locator('#machineFixture').screenshot({ path: path.join(artifacts, 'narrow.png') });
  await page.setViewportSize({ width: 1479, height: 1000 });
  await first.locator('[data-machine-filter="startDate"]').fill('2026-10-02');
  await first.locator('[data-machine-filter="startDate"]').dispatchEvent('change');
  await drawn();
  assert.equal(await first.locator('.ta-yield-chart-navigation').count(), 0, 'Changing analysis filters cleans up the previous chart controller');
  await first.locator('.ta-machine-comparison-analyze').click();
  await first.locator('svg[data-machine-chart-enhanced="true"]').waitFor();
  assert.deepEqual(await range(first), { start: 0, end: 1 }, 'Fresh filter analysis begins with a complete viewport');
  await first.getByRole('button', { name: 'Remove Graph 1', exact: true }).click();
  assert.equal(await page.locator('.ta-machine-comparison-card').count(), 1, 'Removing a graph cleans up its visible controls');
  await page.evaluate(() => { document.getElementById('taMachineChart').innerHTML = machineDateLinesForGraph([globalThis.__machineFixtureRows[0]]); });
  await main.locator('svg[data-machine-chart-enhanced="true"]').waitFor();
  assert.equal(await main.getByRole('button', { name: 'Zoom in', exact: true }).isDisabled(), true, 'A single Machine point cannot zoom beyond its data');
  assert.equal(await main.locator('.ta-machine-vertical-label').isVisible(), true, 'A single Machine result retains its machine name');
  await page.evaluate(() => { document.getElementById('taMachineChart').innerHTML = machineDateLinesForGraph(globalThis.__machineFixtureRows.slice(0, 3)); });
  await main.locator('svg[data-machine-chart-enhanced="true"]').waitFor();
  assert.equal(await main.locator('.ta-machine-vertical-label').isVisible(), true, 'One machine with three dates retains its left-edge machine name');
  await main.screenshot({ path: path.join(artifacts, 'one-machine-three-dates.png') });
  await wheel(main);
  const threePointRange = await range(main);
  assert.ok(Math.abs(threePointRange.end - threePointRange.start - 2 / 3) < 1e-8, 'Three-point zoom respects the minimum two-point range');
  await page.evaluate(() => { document.getElementById('taMachineChart').replaceChildren(); globalThis.__machineCards.reset(); });
  await drawn();
  assert.equal(await page.locator('#machineFixture .ta-yield-chart-navigation').count(), 0, 'Empty results and graph reset remove all chart controls');
}

try {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH, headless: true });
  context = await browser.newContext({ viewport: { width: 1479, height: 1000 } });
  await context.tracing.start({ screenshots: true, snapshots: false, sources: true });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.stack || error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => globalThis.__machineFixtureReady);
  await mount();
  await validate();
  assert.deepEqual(errors, [], 'No browser application errors');
  assert.deepEqual(apiRequests, [], 'No API or MES calls');
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ success: true, errors, apiRequests }, null, 2));
  console.log(`PASS: real Machine chart browser interactions. Artifacts: ${artifacts}`);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true });
  throw error;
} finally {
  if (context) await context.tracing.stop({ path: path.join(artifacts, 'trace.zip') });
  await context?.close();
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}
