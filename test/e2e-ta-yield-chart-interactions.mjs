import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

// Read-only fixture: the real dashboard renderer/styles, synthetic data, no MES or app server.
// PLAYWRIGHT_MODULE_PATH can select an existing playwright-core installation.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright-core');
const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
const artifactDirectory = fileURLToPath(new URL('../artifacts/ta-yield-chart-interactions/', import.meta.url));
await mkdir(artifactDirectory, { recursive: true });
const repetitions = Number(process.env.E2E_REPETITIONS || 3);
assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 5);
const baselineOnly = process.env.E2E_BASELINE_ONLY === 'true';
const styleOnly = process.env.E2E_STYLE_ONLY === 'true';
const tooltipOnly = process.env.E2E_TOOLTIP_ONLY === 'true';
const sourceHtml = await readFile(path.join(publicDirectory, 'index.html'), 'utf8');
const applicationSource = await readFile(path.join(publicDirectory, 'app.js'), 'utf8');
const startup = 'initializeDashboardDataModeControls().then(initializeDashboardNavigation).catch((error) => setStatus(error.message));';
assert.equal(applicationSource.split(startup).length, 2, 'Only startup is disabled; chart rendering uses unchanged application source');
const fixtureSource = applicationSource.replace(startup, 'globalThis.__chartFixtureReady = true;');
const series = ['FPS A2', 'FPS A3', 'FPS B10', 'FPS B2', 'FPS B3'];
const periods = Array.from({ length: 13 }, (_, index) => `2026-W${String(31 + index).padStart(2, '0')}`);
const rows = periods.flatMap((month, periodIndex) => series.map((line, seriesIndex) => {
  const input = 20000 + periodIndex * 200 + seriesIndex * 100;
  const defect = 1200 + ((periodIndex * 719 + seriesIndex * 327) % 4300);
  const groups = ['ACC', 'App', 'C0', 'DF', 'ESR', 'Inproc Dw', 'Inproc Up', 'LC', 'Other2', 'PULSE', 'SH'];
  const weights = [1, 5, 2, 1, 9, 4, 3, 1, 1, 1, 2];
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  return { month, line, input, finalGood: input - defect, defect, partNumbers: ['TEFPS-01'],
    groups: groups.map((group, index) => ({ group, quantity: defect * weights[index] / weightTotal })) };
}));
const targets = Object.fromEntries([...series, 'Total', 'Standard Production'].map((name, index) => [name,
  Object.fromEntries(['2026-07', '2026-08', '2026-09', '2026-10'].map((month) => [month, 94 - index * .4]))]));
const app = express();
let forbiddenRequests = [];
app.use('/api', (request, response) => {
  forbiddenRequests = [...forbiddenRequests, `${request.method} ${request.originalUrl}`];
  response.status(405).json({ success: false, error: 'No API calls are allowed in this read-only chart fixture.' });
});
app.get('/', (request, response) => {
  let html = sourceHtml;
  if (baselineOnly || request.query.baseline === 'true') html = html
    .replace(/<script[^>]+ta-yield-chart-interactions[^>]*><\/script>/g, '')
    .replace(/<link[^>]+ta-yield-chart-interactions[^>]*>/g, '');
  const instrumentation = `<script>if(globalThis.TaYieldChartInteractions?.create){const original=globalThis.TaYieldChartInteractions.create;globalThis.TaYieldChartInteractions.create=(options)=>{const controller=original(options);globalThis.__chartFixtureController=controller;return controller;};}</script>`;
  html = html.replace(/(<script src="\/app\.js[^>]*>)/, `${instrumentation}$1`);
  response.type('html').send(html);
});
app.get('/app.js', (_request, response) => response.type('js').send(fixtureSource));
app.use(express.static(publicDirectory));
let server;
let browser;
let context;
let page;
let coverageSession;
const errors = [];

async function renderFixture(options = {}) {
  await page.evaluate(({ rows, targets, series, options }) => {
    if (!globalThis.__chartFixtureMounted) {
      const chart = document.getElementById('taYieldChart');
      const main = document.createElement('main');
      main.className = 'chart-fixture dashboard';
      main.append(chart);
      chart.hidden = false;
      [...document.body.children].forEach((node) => { if (node.tagName !== 'SCRIPT') node.hidden = true; });
      document.body.append(main);
      const style = document.createElement('style');
      style.textContent = 'body{margin:0;min-width:0}.chart-fixture{box-sizing:border-box;width:100%;max-width:1480px;margin:0 auto;padding:24px;min-width:0}#taYieldChart{display:block;width:100%;box-sizing:border-box}.chart-fixture .yield-column.below-target{animation-play-state:paused!important;animation-delay:0s!important}@media(max-width:600px){.chart-fixture{padding:12px}}';
      document.head.append(style);
      globalThis.__chartFixtureMounted = true;
    }
    taYieldInterval = options.interval || 'week';
    taYieldTrendSeries = options.total ? ['Total'] : [...series];
    taYieldTrendChartType = options.chartType || 'summary';
    taYieldTargets = targets;
    const dated = rows.map((row) => {
      const index = Number(row.month.slice(-2)) - 31;
      const month = options.interval === 'day' ? `2026-10-${String(index + 1).padStart(2, '0')}`
        : options.interval === 'month' ? new Date(Date.UTC(options.periodCount ? 2026 : 2025, (options.periodCount ? 7 : 9) + index, 1)).toISOString().slice(0, 7) : row.month;
      const tooltipYield = options.tooltipAboveTarget && row.line === 'FPS B3' ? { 0: .96, 1: .92399 }[index] : undefined;
      return { ...row, month, ...(tooltipYield === undefined ? {} : { finalGood: row.input * tooltipYield }) };
    });
    const selectedPeriods = [...new Set(dated.map((row) => row.month))].slice(0, options.onePeriod ? 1 : options.periodCount || Infinity);
    const selected = dated.filter((row) => selectedPeriods.includes(row.month));
    renderTaYieldTendencyCharts(selected, selected);
  }, { rows, targets, series, options });
  await page.locator('#taYieldYieldChart svg').waitFor();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function appearance() {
  return page.evaluate(() => {
    const style = (selector, properties) => {
      const node = document.querySelector(selector);
      if (!node) throw new Error(`Missing appearance probe: ${selector}`);
      const computed = getComputedStyle(node);
      return Object.fromEntries(properties.map((property) => [property, computed.getPropertyValue(property)]));
    };
    const text = ['font-family', 'font-size', 'font-weight', 'fill', 'stroke', 'stroke-width'];
    return {
      tooltip: style('.ta-yield-trend-tooltip', ['background-color', 'border-radius', 'padding', 'font-family', 'font-size', 'border-left-width', 'border-left-color']),
      axis: style('#taYieldYieldChart .axis:not(.axis-title)', text),
      axisTitle: style('#taYieldYieldChart .axis-title', text),
      value: style('#taYieldYieldChart .ta-yield-column-value', text),
      target: style('#taYieldYieldChart .target-line', ['stroke', 'stroke-width', 'stroke-dasharray', 'opacity']),
      bar: style('#taYieldYieldChart .yield-column', ['rx']),
      grid: style('#taYieldYieldChart .gridline', ['stroke', 'stroke-width']),
      legend: style('#taYieldYieldChart .sc-yield-legend span', ['font-family', 'font-size', 'font-weight', 'border-radius', 'padding', 'background-color']),
      panel: style('.ta-yield-tendency-panel', ['padding', 'border-width', 'border-radius', 'background-color'])
    };
  });
}

async function snapshot() {
  return page.evaluate(() => globalThis.__chartFixtureController?.snapshot());
}

async function drawn() {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function chartGeometry() {
  return page.locator('#taYieldYieldChart svg, #taYieldDefectChart svg').evaluateAll((charts) => charts.map((svg) => ({
    axes: [...svg.querySelectorAll('text.axis')].filter((node) => node.getAttribute('text-anchor') === 'end')
      .map((node) => ({ text: node.textContent, x: node.getAttribute('x'), y: node.getAttribute('y'),
        visible: getComputedStyle(node).visibility === 'visible' && getComputedStyle(node).display !== 'none',
        fill: getComputedStyle(node).fill, opacity: getComputedStyle(node).opacity })),
    marks: [...svg.querySelectorAll('rect[fill],rect.yield-column,circle.yield-point,circle.ta-yield-line-point')]
      .map((node) => ({ x: Number(node.getAttribute('x') ?? node.getAttribute('cx')), y: Number(node.getAttribute('y') ?? node.getAttribute('cy')) })),
    labels: [...svg.querySelectorAll('.ta-yield-column-value')].filter((node) => getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden')
      .map((node) => ({ x: Number(node.getAttribute('x')), text: node.textContent }))
  })));
}

async function gestureZoom(chart, delta = -320, horizontalRatio = .5) {
  await chart.scrollIntoViewIfNeeded();
  const box = await chart.boundingBox();
  await page.mouse.move(box.x + box.width * horizontalRatio, box.y + box.height * .5);
  const previous = JSON.stringify(await snapshot());
  await page.mouse.wheel(0, delta);
  await page.waitForFunction((previous) => JSON.stringify(globalThis.__chartFixtureController?.snapshot()) !== previous, previous);
  await drawn();
}

async function verifyColoredTooltips(repetition) {
  await renderFixture({ interval: 'month', periodCount: 3, tooltipAboveTarget: true });
  const tooltip = page.locator('.ta-yield-tendency-panel').first().locator('.ta-yield-trend-tooltip');
  const column = (name) => page.locator('#taYieldYieldChart .yield-column').filter({ hasText: `2026-08 | ${name}:` });
  const expectedColor = (mark, property = '--yield-series-fill') => mark.evaluate((node, property) => {
    const color = getComputedStyle(node).getPropertyValue(property).trim() || node.getAttribute('fill');
    const probe = document.createElement('span');
    probe.style.backgroundColor = color;
    document.body.append(probe);
    const background = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return background;
  }, property);
  const details = (holder) => holder.evaluate((node) => ({
    background: getComputedStyle(node).backgroundColor, text: node.textContent,
    heading: node.querySelector('strong')?.textContent || '',
    status: node.querySelector('.ta-yield-tooltip-target-status')?.textContent || '',
    textColors: [...node.querySelectorAll('strong,span,b,small,p')].filter((child) => child.textContent.trim()).map((child) => getComputedStyle(child).color)
  }));
  const tinyGap = page.locator('#taYieldYieldChart .yield-column').filter({ hasText: '2026-09 | FPS B3:' });
  const rawTinyYield = Number(await tinyGap.getAttribute('data-yield-value'));
  assert.ok(Number.isFinite(rawTinyYield) && Math.abs(rawTinyYield - 92.399) < 1e-9, 'The actual renderer retains raw yield precision independently of the rounded title');
  assert.equal(Number(await tinyGap.getAttribute('data-yield-target')), 92.4, 'The actual renderer retains the exact saved target');
  for (const name of ['FPS A2', 'FPS B10', 'FPS B2']) {
    const mark = column(name);
    if (name !== 'FPS A2') {
      await mark.evaluate((node) => node.style.setProperty('animation-delay', '-0.625s', 'important'));
      await drawn();
      assert.notEqual(await mark.evaluate((node) => getComputedStyle(node).fill), await expectedColor(mark), 'Fixture exercises the red phase of the below-target blink');
    }
    await mark.hover();
    assert.equal(await tooltip.isVisible(), true, `${name} hover opens its tooltip`);
    const current = await details(tooltip);
    assert.equal(current.heading, name, 'The first tooltip line identifies only the hovered series');
    assert.equal(current.background, await expectedColor(mark), `${name} tooltip matches its original series fill`);
    assert.ok(current.textColors.every((color) => color === 'rgb(255, 255, 255)'), `${name} tooltip text is uniformly white`);
    if (name === 'FPS A2') assert.doesNotMatch(current.text, /Below target/, 'An equal-target column has no below-target message');
    else {
      const row = rows.find((row) => row.month === periods[0] && row.line === name);
      const gap = (targets[name]['2026-08'] - row.finalGood / row.input * 100).toFixed(2);
      assert.equal(current.status, `Below target ${gap}%`);
    }
    if (repetition === 1) await tooltip.screenshot({ path: path.join(artifactDirectory, `tooltip-${name.replaceAll(' ', '-').toLowerCase()}.png`) });
  }
  await tinyGap.hover();
  assert.equal((await details(tooltip)).status, 'Below target <0.01%', 'A raw below-target gap remains visible when yield and target both round to 92.40 percent');
  if (repetition === 1) await tooltip.screenshot({ path: path.join(artifactDirectory, 'tooltip-below-target-sub-cent.png') });
  await column('FPS B3').hover();
  assert.doesNotMatch(await tooltip.textContent(), /Below target/, 'An above-target column clears the previous below-target status');
  await column('FPS A2').hover();
  assert.doesNotMatch(await tooltip.textContent(), /Below target/, 'Moving back to an equal-target column clears the previous status');
  const cyan = column('FPS B10');
  await cyan.focus();
  const focused = await details(tooltip);
  assert.equal(await cyan.evaluate((node) => document.activeElement === node), true, 'Yield columns support keyboard focus');
  assert.equal(focused.background, await expectedColor(cyan), 'Keyboard focus uses the same series background');
  assert.equal(focused.status, 'Below target 2.38%', 'Keyboard focus gives the same concise exact target gap');
  const targetPoint = page.locator('#taYieldYieldChart .target-point').filter({ hasText: '2026-08 | FPS B10:' });
  await targetPoint.hover();
  const target = await details(tooltip);
  assert.equal(target.heading, 'FPS B10', 'Target point tooltips identify only the hovered series');
  assert.equal(target.status, '', 'Target points do not inherit a below-target column status');
  const segment = page.locator('#taYieldDefectChart rect[fill]').filter({ hasText: '2026-08 | FPS B10 | ESR:' });
  const defectTooltip = page.locator('.ta-yield-tendency-panel').nth(1).locator('.ta-yield-trend-tooltip');
  await segment.hover();
  const defect = await details(defectTooltip);
  assert.equal(defect.heading, 'FPS B10', 'The defect tooltip identifies only the hovered series');
  assert.equal(defect.background, await expectedColor(segment, 'fill'), 'Defect tooltip matches the hovered segment fill');
  assert.doesNotMatch(defect.text, /Below target/, 'Defect tooltips never inherit a yield target status');
  assert.ok(defect.textColors.every((color) => color === 'rgb(255, 255, 255)'), 'Defect tooltip text is uniformly white');
  if (repetition === 1) await defectTooltip.screenshot({ path: path.join(artifactDirectory, 'tooltip-defect-segment.png') });
  console.log(`PASS ${repetition}: series-colored tooltips, white text, concise exact below-target gap, raw precision, cleared status, focus and defect segments`);
}

async function runJourney(repetition) {
  await verifyColoredTooltips(repetition);
  await renderFixture();
  await page.evaluate(() => globalThis.__chartFixtureController.reset());
  await drawn();
  const yieldChart = page.locator('#taYieldYieldChart svg');
  const defectChart = page.locator('#taYieldDefectChart svg');
  assert.equal(await page.locator('.ta-yield-chart-navigation').count(), 1, 'One shared toolbar controls both charts');
  assert.equal(await page.locator('svg[data-chart-enhanced="true"]').count(), 2);
  const initial = await snapshot();
  assert.ok(initial, 'Application uses the shared interaction controller');
  const initialGeometry = await chartGeometry();
  await gestureZoom(yieldChart);
  let zoomed = await snapshot();
  assert.notDeepEqual(zoomed, initial);
  assert.ok(Math.abs(zoomed.start + (zoomed.end - zoomed.start) * .5 - .5) < .01, 'Wheel zoom keeps the cursor anchored to the same period');
  const linkedRanges = await page.locator('svg[data-chart-enhanced="true"]').evaluateAll((charts) => charts.map((svg) => [svg.dataset.chartStart, svg.dataset.chartEnd]));
  assert.deepEqual(linkedRanges[0], linkedRanges[1], 'Yield and defect charts share exactly the same visible period domain');
  await gestureZoom(yieldChart);
  zoomed = await snapshot();
  const zoomedGeometry = await chartGeometry();
  assert.ok(zoomedGeometry[0].labels.length > 0, 'Zoom retains readable exact values');
  const zoomLabelBounds = await yieldChart.evaluate((svg) => {
    const grid = svg.querySelector('.gridline');
    return [...svg.querySelectorAll('.ta-yield-column-value')].filter((node) => getComputedStyle(node).visibility === 'visible').map((node) => {
      const box = node.getBBox();
      return { text: node.textContent, inside: box.x >= Number(grid.getAttribute('x1')) && box.x + box.width <= Number(grid.getAttribute('x2')) };
    });
  });
  assert.ok(zoomLabelBounds.every((label) => label.inside), 'Visible zoom labels remain complete inside the plot');
  for (let index = 0; index < 2; index += 1) {
    assert.deepEqual(zoomedGeometry[index].axes, initialGeometry[index].axes, 'Vertical axes remain fixed while the plot zooms');
    assert.notDeepEqual(zoomedGeometry[index].marks, initialGeometry[index].marks, 'Both plots zoom together');
  }
  const chartBox = await defectChart.boundingBox();
  await defectChart.scrollIntoViewIfNeeded();
  const dragBox = await defectChart.boundingBox();
  await page.mouse.move(dragBox.x + dragBox.width * .65, dragBox.y + dragBox.height * .55);
  await page.mouse.down();
  await page.mouse.move(dragBox.x + dragBox.width * .45, dragBox.y + dragBox.height * .55, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction((previous) => JSON.stringify(globalThis.__chartFixtureController?.snapshot()) !== previous, JSON.stringify(zoomed));
  await drawn();
  const pannedGeometry = await chartGeometry();
  for (let index = 0; index < 2; index += 1) {
    assert.notDeepEqual(pannedGeometry[index].marks, zoomedGeometry[index].marks, 'Dragging either chart pans both plots');
    assert.deepEqual(pannedGeometry[index].axes, initialGeometry[index].axes, 'Panning preserves axis position, visibility, color and opacity');
    assert.ok(pannedGeometry[index].axes.every((axis) => axis.visible && Number(axis.opacity) > 0), 'Y-axis labels remain visible after panning');
  }
  if (repetition === 1) {
    const diagnostics = await page.locator('#taYieldYieldChart svg, #taYieldDefectChart svg').evaluateAll((charts) => charts.map((svg) => ({
      svg: svg.outerHTML, scrollLeft: svg.parentElement.scrollLeft,
      axes: [...svg.querySelectorAll('text.axis')].filter((node) => node.getAttribute('text-anchor') === 'end').map((node) => ({
        text: node.textContent, bounds: node.getBoundingClientRect().toJSON(), fill: getComputedStyle(node).fill,
        visibility: getComputedStyle(node).visibility, display: getComputedStyle(node).display,
        parent: node.parentElement.tagName, clip: getComputedStyle(node).clipPath
      }))
    })));
    await writeFile(path.join(artifactDirectory, 'zoomed-axis-diagnostics.json'), JSON.stringify(diagnostics, null, 2));
  }
  if (repetition === 1) await page.locator('#taYieldChart').screenshot({ path: path.join(artifactDirectory, 'zoomed-and-panned.png') });
  await page.getByRole('button', { name: 'Reset chart view', exact: true }).click();
  await drawn();
  assert.deepEqual(await snapshot(), initial, 'The Reset toolbar button restores the complete period range');
  await gestureZoom(yieldChart, -320, .35);
  await page.evaluate(() => document.querySelector('#taYieldYieldChart [tabindex="0"]')?.focus());
  const keyboardBefore = await snapshot();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction((previous) => JSON.stringify(globalThis.__chartFixtureController?.snapshot()) !== previous, JSON.stringify(keyboardBefore));
  await page.keyboard.press('Home');
  await drawn();
  assert.deepEqual(await snapshot(), initial, 'Home resets the chart using the keyboard');
  await page.locator('#taYieldTrendChartType').selectOption('multi-line');
  await page.waitForFunction(() => document.querySelector('#taYieldYieldChart svg')?.dataset.chartEnhanced === 'true');
  assert.ok(await page.locator('#taYieldYieldChart .ta-yield-line-point').count() > 0, 'Real line-mode renderer is used');
  await gestureZoom(yieldChart);
  assert.ok(await snapshot());
  const focusability = await page.locator('#taYieldYieldChart .ta-yield-line-point').evaluateAll((marks) => marks.reduce((result, mark) => {
    const svg = mark.ownerSVGElement;
    const grid = svg.querySelector('.gridline');
    const x = Number(mark.getAttribute('cx'));
    const clipped = x < Number(grid.getAttribute('x1')) || x > Number(grid.getAttribute('x2'));
    return { hidden: result.hidden + Number(clipped), visible: result.visible + Number(!clipped),
      invalid: result.invalid + Number(clipped ? mark.getAttribute('tabindex') !== '-1' || mark.getAttribute('aria-hidden') !== 'true' : mark.getAttribute('tabindex') !== '0') };
  }, { hidden: 0, visible: 0, invalid: 0 }));
  assert.ok(focusability.hidden > 0 && focusability.visible > 0, 'Line zoom has visible and clipped points');
  assert.equal(focusability.invalid, 0, 'Only visible line points remain keyboard-focusable');
  await page.locator('#taYieldYieldChart .ta-yield-line-point[tabindex="0"]').filter({ hasText: '| FPS B10:' }).first().focus();
  assert.equal(await page.locator('.ta-yield-tendency-panel').first().locator('.ta-yield-trend-tooltip').isVisible(), true, 'Keyboard focus retains the real chart tooltip');
  assert.equal(await page.locator('.ta-yield-tendency-panel').first().locator('.ta-yield-trend-tooltip strong').textContent(), 'FPS B10', 'Line point tooltip headings identify only the focused series');
  await page.evaluate(() => globalThis.__chartFixtureController.reset());
  await drawn();
  assert.equal(await page.locator('#taYieldYieldChart .ta-yield-line-point[tabindex="-1"]').count(), 0, 'Reset restores clipped points to keyboard navigation');
  for (let redraw = 0; redraw < 4; redraw += 1) await renderFixture({ chartType: redraw % 2 ? 'multi-line' : 'summary' });
  assert.equal(await page.locator('.ta-yield-chart-navigation').count(), 1, 'Repeated redraws do not duplicate navigation');
  for (const interval of ['day', 'month']) {
    await renderFixture({ interval });
    const fullRange = await snapshot();
    assert.equal(fullRange.start, 0);
    assert.equal(fullRange.end, 1);
    await gestureZoom(yieldChart);
    assert.ok((await snapshot()).end - (await snapshot()).start < 1, `${interval} date keys support wheel zoom`);
    const linked = await page.locator('svg[data-chart-enhanced="true"]').evaluateAll((charts) => charts.map((svg) => [svg.dataset.chartStart, svg.dataset.chartEnd]));
    assert.deepEqual(linked[0], linked[1], `${interval} charts remain synchronized`);
    await page.getByRole('button', { name: 'Reset chart view', exact: true }).click();
    await drawn();
    assert.deepEqual(await snapshot(), fullRange, `${interval} toolbar reset restores every date`);
  }
  await renderFixture({ onePeriod: true });
  assert.ok(await snapshot());
  assert.equal(await page.locator('svg[data-chart-enhanced="true"]').count(), 2, 'A single period is handled by both charts');
  assert.equal(await page.getByRole('button', { name: 'Zoom in', exact: true }).isDisabled(), true, 'Single-period charts cannot zoom beyond their data');
  await renderFixture();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth + 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'No page-wide horizontal overflow at a narrow viewport');
  await gestureZoom(yieldChart);
  if (repetition === 1) await page.locator('#taYieldChart').screenshot({ path: path.join(artifactDirectory, 'narrow-zoomed.png') });
  await page.setViewportSize({ width: 1479, height: 1000 });
  assert.ok(chartBox.width > 0);
  console.log(`PASS ${repetition}/${repetitions}: real TA charts; wheel zoom, linked drag pan, fixed axes, toolbar reset, keyboard, line mode, repeated redraw, day/week/month dates, single period, narrow resize`);
}

try {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH, headless: true });
  context = await browser.newContext({ viewport: { width: 1479, height: 1000 } });
  await context.tracing.start({ screenshots: true, snapshots: false, sources: true });
  page = await context.newPage();
  coverageSession = await context.newCDPSession(page);
  await coverageSession.send('Profiler.enable');
  await coverageSession.send('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  page.on('pageerror', (error) => errors.push(error.stack || error.message));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(`${origin}/?baseline=true`);
  await page.waitForFunction(() => globalThis.__chartFixtureReady === true);
  await renderFixture();
  const originalAppearance = await appearance();
  assert.equal(originalAppearance.tooltip['background-color'], 'rgb(48, 60, 152)');
  assert.equal(originalAppearance.tooltip['border-radius'], '0px');
  assert.equal(originalAppearance.tooltip.padding, '10px 12px');
  await writeFile(path.join(artifactDirectory, 'original-appearance.json'), JSON.stringify(originalAppearance, null, 2));
  await renderFixture({ interval: 'month', periodCount: 3 });
  const originalMonthlyValues = await page.locator('#taYieldYieldChart .ta-yield-column-value').evaluateAll((nodes) => nodes.filter((node) => getComputedStyle(node).visibility === 'visible').length);
  await page.locator('#taYieldChart').screenshot({ path: path.join(artifactDirectory, 'monthly-three-periods-before.png') });
  await page.goto(origin);
  await page.waitForFunction(() => globalThis.__chartFixtureReady === true);
  await renderFixture();
  if (!baselineOnly) {
    const enhancedAppearance = await appearance();
    await writeFile(path.join(artifactDirectory, 'enhanced-appearance.json'), JSON.stringify(enhancedAppearance, null, 2));
    assert.deepEqual(enhancedAppearance, originalAppearance, 'Enhancement preserves the original tooltip, typography, axes, targets, bars, grid, legends and panels');
    console.log('PASS: original chart appearance preserved after enhancement');
    await renderFixture({ interval: 'month', periodCount: 3 });
    await page.locator('#taYieldChart').screenshot({ path: path.join(artifactDirectory, 'monthly-three-periods.png') });
    const monthlyLabelDiagnostics = await page.locator('#taYieldYieldChart .ta-yield-column-value').evaluateAll((nodes) => nodes.map((node) => {
      const { x, y, width, height } = node.getBBox();
      return { value: node.textContent, visibility: getComputedStyle(node).visibility, bounds: { x, y, width, height } };
    }));
    await writeFile(path.join(artifactDirectory, 'monthly-label-diagnostics.json'), JSON.stringify(monthlyLabelDiagnostics, null, 2));
    assert.equal(monthlyLabelDiagnostics.length, originalMonthlyValues, 'Every original three-month value label remains in the chart');
    const visibleLabels = monthlyLabelDiagnostics.filter((label) => label.visibility === 'visible');
    const hiddenLabels = monthlyLabelDiagnostics.filter((label) => label.visibility !== 'visible');
    const overlaps = (first, second) => first.x < second.x + second.width && first.x + first.width > second.x
      && first.y < second.y + second.height && first.y + first.height > second.y;
    assert.ok(visibleLabels.length > 0, 'Three-month values stay visible at the full period range');
    assert.ok(visibleLabels.every((label, index) => visibleLabels.slice(index + 1).every((other) => !overlaps(label.bounds, other.bounds))), 'Visible monthly values do not overlap');
    assert.ok(hiddenLabels.every((label) => visibleLabels.some((other) => overlaps(label.bounds, other.bounds))), 'Monthly values are hidden only where their original bounds overlap another visible value');
    await renderFixture();
  }
  await page.locator('#taYieldChart').screenshot({ path: path.join(artifactDirectory, baselineOnly ? 'before.png' : 'after.png') });
  if (!baselineOnly && tooltipOnly) await verifyColoredTooltips(1);
  else if (!baselineOnly && !styleOnly) for (let repetition = 1; repetition <= repetitions; repetition += 1) await runJourney(repetition);
  const coverage = await coverageSession.send('Profiler.takePreciseCoverage');
  await coverageSession.send('Profiler.stopPreciseCoverage');
  await coverageSession.send('Profiler.disable');
  await coverageSession.detach();
  coverageSession = undefined;
  const moduleCoverage = coverage.result.filter((entry) => entry.url.includes('/ta-yield-chart-interactions.js')).map((entry) => {
    const ranges = entry.functions.flatMap((item) => item.ranges);
    const boundaries = [...new Set(ranges.flatMap((range) => [range.startOffset, range.endOffset]))].sort((left, right) => left - right);
    const totalBytes = Math.max(...ranges.map((range) => range.endOffset));
    const executedBytes = boundaries.slice(1).reduce((sum, end, index) => {
      const start = boundaries[index];
      const specific = ranges.filter((range) => range.startOffset <= start && range.endOffset >= end)
        .sort((left, right) => (left.endOffset - left.startOffset) - (right.endOffset - right.startOffset))[0];
      return sum + (specific?.count > 0 ? end - start : 0);
    }, 0);
    return { url: entry.url, totalBytes, executedBytes, percent: Number((executedBytes / totalBytes * 100).toFixed(2)) };
  });
  if (!baselineOnly) console.log('Interaction module browser coverage:', JSON.stringify(moduleCoverage));
  assert.deepEqual(errors, [], 'No browser application errors');
  assert.deepEqual(forbiddenRequests, [], 'No API or MES requests were made');
  await writeFile(path.join(artifactDirectory, baselineOnly ? 'baseline-report.json' : 'report.json'), JSON.stringify({ success: true, repetitions: baselineOnly ? 0 : repetitions, errors, apiRequests: forbiddenRequests, moduleCoverage }, null, 2));
  console.log(`Artifacts: ${artifactDirectory}`);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(artifactDirectory, 'failure.png'), fullPage: true });
  throw error;
} finally {
  if (coverageSession) await coverageSession.detach();
  if (context) await context.tracing.stop({ path: path.join(artifactDirectory, baselineOnly ? 'baseline-trace.zip' : 'trace.zip') });
  await context?.close();
  await browser?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
