import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function dailyOutputContext() {
  expect(source).toContain('function aggregateDailyOutput');
  const start = source.indexOf('function aggregateDailyOutput');
  const end = source.indexOf('function ensureDailyOutputPanel', start);
  const context = vm.createContext({ Number, Map, Set, String, Math, Array, Object });
  vm.runInContext(source.slice(start, end), context);
  return context;
}

function dailyOutputToggleContext(enabled = true) {
  const elements = {
    dailyOutputPanel: { hidden: false },
    dailyOutputToggle: {
      hidden: false,
      textContent: '',
      attributes: {},
      focusCount: 0,
      setAttribute(name, value) { this.attributes[name] = value; },
      focus() { this.focusCount += 1; }
    }
  };
  const start = source.indexOf('function updateDailyOutputToggle');
  const end = source.indexOf('function ensureDailyOutputPanel', start);
  const declarations = `let dailyOutputPanelEnabled = ${Boolean(enabled)}; let currentConfig = { dataset: 'closed' };`;
  const context = vm.createContext({
    byId: (id) => elements[id] || null,
    latestTaYieldData: {},
    latestDailyOutputData: [],
      renderTaYield: () => {},
      renderTaYieldDailyOutputPanel: () => {}, loadTaYieldDailyOutput: () => {},
    renderDailyOutputPanel: () => {}
  });
  vm.runInContext(`${declarations}\n${source.slice(start, end)}`, context);
  return { context, elements };
}

describe('Daily output floating panel data', () => {
  it.each(['closed', 'lot'])('uses existing quantity rows for %s output without depending on new repository methods', async (dataset) => {
    const data = [{ itemName: 'FPS', quantityMoved: 2500, bucketDate: '2026-09-01' }];
    const elements = { startDate: { value: '2026-09-01' }, endDate: { value: '2026-09-30' }, product: { value: 'NEO' }, apply: {} };
    const calls = [];
    const renders = [];
    const context = vm.createContext({
      URLSearchParams, Promise, currentConfig: { dataset, chartAxis: 'date' }, ids: [],
      byId: (id) => elements[id], selectedDataset: () => dataset,
      selectedSeries: () => [], selectedPartNumbers: () => [], selectedReportingPeriod: () => null,
      updateTaYieldCompare: () => {}, setReportControlsLoading: () => {}, setStatus: () => {}, markReportControlsApplied: () => {},
      loadCellComments: async () => undefined,
      request: async (url) => { calls.push(url); return url.startsWith('/api/quantity?') ? data : []; },
      renderData: (...args) => renders.push(args)
    });
    const start = source.indexOf('async function loadData()');
    const end = source.indexOf('async function refreshOptionsForProduct', start);
    vm.runInContext(`let dataRequestId = 0; let dashboardDataModeGeneration = 0; let scYieldTendencyRequestId = 0; let taYieldDailyOutputScope, taYieldDailyOutputRequest, taYieldLotDetailsRequest, latestTaYieldLotsUrl, latestTaYieldLotsRequestId; ${source.slice(start, end)}`, context);
    await context.loadData();
    expect(renders.length).toBeGreaterThan(0);
    expect(renders[0][3]).toEqual(data);
    expect(calls.some((url) => url.startsWith('/api/daily-output?'))).toBe(false);
  });

  it('starts off in the application and HTML but can still be opened with the toggle', () => {
    const declaration = source.match(/let dailyOutputPanelEnabled = (?:true|false);/)[0];
    const enabled = vm.runInNewContext(`${declaration}\ndailyOutputPanelEnabled`);
    expect(enabled).toBe(false);
    const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    expect(html).toMatch(/id="dailyOutputToggle"[^>]*aria-pressed="false"[^>]*>Daily output: Off<\/button>/);
    const { context, elements } = dailyOutputToggleContext(enabled);
    context.setDailyOutputPanelEnabled(enabled);
    expect(elements.dailyOutputPanel.hidden).toBe(true);
    expect(elements.dailyOutputToggle.textContent).toBe('Daily output: Off');
    let opened = false;
    expect(context.toggleDailyOutputPanel(() => { opened = true; elements.dailyOutputPanel.hidden = false; })).toBe(true);
    expect(opened).toBe(true);
    expect(elements.dailyOutputPanel.hidden).toBe(false);
    expect(elements.dailyOutputToggle.attributes['aria-pressed']).toBe('true');
    expect(elements.dailyOutputToggle.textContent).toBe('Daily output: On');
  });

  it('converts moved pieces to kpcs and preserves the server-calculated distinct JobName lot count', () => {
    const { aggregateDailyOutput } = dailyOutputContext();

    expect(aggregateDailyOutput([
      { itemName: 'PSL-B3', quantityMoved: 2000, lotCount: 4 },
      { itemName: 'FPS-A3', quantityMoved: 306, lotCount: 1 }
    ])).toEqual([
      { itemName: 'FPS-A3', quantityKpcs: 0.306, lotCount: 1 },
      { itemName: 'PSL-B3', quantityKpcs: 2, lotCount: 4 }
    ]);
  });

  it('does not turn chart rows into fake lots when the source did not provide JobName counts', () => {
    const { aggregateDailyOutput } = dailyOutputContext();

    expect(aggregateDailyOutput([{ itemName: 'PSL-B3', quantityMoved: 1500 }]))
      .toEqual([{ itemName: 'PSL-B3', quantityKpcs: 1.5, lotCount: null }]);
  });

  it('converts the full output quantity to kpcs and deduplicates JobNames across rows', () => {
    const { aggregateDailyOutput } = dailyOutputContext();
    expect(aggregateDailyOutput([
      { itemName: 'FPS', quantityMoved: 1200000, lotCount: 1, jobNames: ['6K01N00052'] },
      { itemName: 'FPS', quantityMoved: 1205110, lotCount: 2, jobNames: ['6K01N00052', ' 6K01N00053 '] }
    ])).toEqual([{ itemName: 'FPS', quantityKpcs: 2405.11, lotCount: 2, jobNames: ['6K01N00052', '6K01N00053'] }]);
    expect(aggregateDailyOutput([{ itemName: 'FPS', quantityMoved: 1000, lotCount: null }])[0].lotCount).toBeNull();
  });

  it('uses compact TA series names in chart labels while retaining the full source name for details', () => {
    const renderStart = source.indexOf('function renderDailyOutputPanel');
    const renderBlock = source.slice(renderStart, source.indexOf('function renderChart', renderStart));
    const paletteStart = source.indexOf('const dailyOutputPalette');
    const paletteBlock = source.slice(paletteStart, source.indexOf('function bindDailyOutputTooltips', paletteStart));
    const elements = {
      startDate: { value: '2026-09-01' },
      endDate: { value: '2026-09-22' },
      dailyOutputScope: { textContent: '' },
      dailyOutputSummary: { innerHTML: '' },
      dailyOutputChart: { innerHTML: '' }
    };
    let panelHeight = 720;
    let maximized = true;
    const panel = { hidden: false, classList: { contains: (name) => name === 'is-maximized' && maximized }, getBoundingClientRect: () => ({ height: panelHeight }) };
    const context = vm.createContext({
      panel,
      byId: (id) => elements[id],
      ensureDailyOutputPanel: () => panel,
      updateDailyOutputToggle: () => {},
      aggregateDailyOutput: (rows) => rows,
      bindDailyOutputTooltips: () => {},
      escapeHtml: String,
      shortTaSeries: (value) => value.includes('PSL') ? 'PSL B3' : 'FPS B2',
      format: new Intl.NumberFormat('en-US')
    });
    vm.runInContext(`${paletteBlock} let currentConfig = { dataset: 'ta-yield' }; let dailyOutputPanelEnabled = true; ${renderBlock}`, context);
    const rows = [
      { itemName: 'Ta NEO Capacitor PSL series B3 case', quantityKpcs: 1.25, lotCount: 2 },
      { itemName: 'Ta NEO Capacitor FPS series B2 case', quantityKpcs: 3.75, lotCount: null }
    ];
    context.renderDailyOutputPanel(rows);

    const chart = elements.dailyOutputChart.innerHTML;
    expect(elements.dailyOutputSummary.innerHTML).toContain('<small>Total output</small><b>5</b>');
    expect(elements.dailyOutputSummary.innerHTML).toContain('<small>Total lots</small><b>2</b>');
    expect(chart).toMatch(/<text[^>]*>PSL B3<\/text>/);
    expect(chart).not.toMatch(/<text[^>]*>Ta NEO Capacitor PSL series B3 case<\/text>/);
    expect(chart).toContain('data-tooltip-output="1.25 kpcs. / 1,250 pcs"');
    expect(chart).toContain('data-tooltip-share="25.0% of selected output"');
    expect(chart).toContain('data-tooltip-lots="2"');
    expect(chart).toContain('data-tooltip-lots="Unavailable"');
    expect(chart).not.toContain('<title>');
    expect(chart).toMatch(/class="daily-output-value-label"[^>]*>1\.25<\/text>/);
    expect(chart).not.toMatch(/daily-output-value-label[^>]+style="fill:/);
    const height = Number(chart.match(/viewBox="0 0 \d+ (\d+)"/)[1]);
    const labelY = Number(chart.match(/<text class="daily-output-series-label" x="[^"]+" y="(\d+)"/)[1]);
    expect(height - labelY).toBeGreaterThanOrEqual(40);
    expect(height).toBeGreaterThanOrEqual(520);
    const seriesColors = [...chart.matchAll(/data-series-color="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(seriesColors).size).toBe(2);
    seriesColors.forEach((color) => expect(chart).toContain(`style="fill:${color}"`));
    expect(chart).toContain('id="dailyOutputTooltip"');
    expect(chart).toContain('class="daily-output-tooltip"');
    expect(chart).toContain('data-tooltip-series="Ta NEO Capacitor PSL series B3 case"');
    expect(chart).toContain('data-tooltip-output="1.25 kpcs. / 1,250 pcs"');
    expect(source).toContain('function bindDailyOutputTooltips');
    const initialColor = chart.match(/data-series-color="([^"]+)" data-tooltip-series="Ta NEO Capacitor PSL series B3 case"/)[1];
    context.renderDailyOutputPanel([...rows].reverse());
    const reorderedColor = elements.dailyOutputChart.innerHTML.match(/data-series-color="([^"]+)" data-tooltip-series="Ta NEO Capacitor PSL series B3 case"/)[1];
    expect(reorderedColor).toBe(initialColor);
    panelHeight = 430;
    maximized = false;
    context.renderDailyOutputPanel(rows);
    const normalHeight = Number(elements.dailyOutputChart.innerHTML.match(/viewBox="0 0 \d+ (\d+)"/)[1]);
    expect(height).toBeGreaterThan(normalHeight);
    context.renderDailyOutputPanel([
      { itemName: 'FPS', quantityKpcs: 1200, lotCount: 1, jobNames: ['6K01N00052'] },
      { itemName: 'PSL', quantityKpcs: 1205.11, lotCount: 2, jobNames: ['6K01N00052', '6K01N00053'] }
    ]);
    expect(elements.dailyOutputSummary.innerHTML).toContain('<small>Total output</small><b>2,405.11</b>');
    expect(elements.dailyOutputSummary.innerHTML).toContain('<small>Total lots</small><b>2</b>');
    expect(elements.dailyOutputSummary.innerHTML).toContain('Distinct JobName');
    context.renderDailyOutputPanel(rows, 'JobName data could not be loaded.');
    expect(elements.dailyOutputScope.textContent).toContain('Lot count unavailable: JobName data could not be loaded.');
    const styles = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
    expect(styles).toContain('.daily-output-panel-scroll { overflow: auto;');
    expect(styles).toMatch(/\.daily-output-panel \{[^}]*grid-template-rows: auto minmax\(0, 1fr\)/);
    expect(styles).toMatch(/\.daily-output-panel-content \{[^}]*min-height: 0;[^}]*overflow: hidden/);
    expect(styles).toMatch(/\.daily-output-panel-chart \{[^}]*grid-template-rows: auto minmax\(0, 1fr\) auto;[^}]*min-height: 0/);
    expect(styles).toMatch(/\.daily-output-panel-scroll \{[^}]*min-height: 0/);
  });

  it('shows and hides the rich tooltip for pointer and keyboard users', () => {
    const listeners = {};
    const tooltip = { hidden: true, innerHTML: '', style: {}, offsetWidth: 210, offsetHeight: 110, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
    const mark = {
      dataset: { seriesColor: '#187b9b', tooltipSeries: 'FPS & <A2>', tooltipOutput: '12.5 kpcs. / 12,500 pcs', tooltipShare: '25.0% of selected output', tooltipLots: '4' },
      addEventListener(name, callback) { listeners[name] = callback; },
      getBoundingClientRect: () => ({ left: 140, top: 160, width: 24, height: 120 })
    };
    const chart = { querySelectorAll: () => [mark], getBoundingClientRect: () => ({ left: 20, top: 40, width: 500, height: 350 }) };
    const start = source.indexOf('function bindDailyOutputTooltips');
    const block = source.slice(start, source.indexOf('function taYieldDailyOutputRows', start));
    const context = vm.createContext({
      byId: (id) => id === 'dailyOutputTooltip' ? tooltip : null,
      escapeHtml: (value) => String(value).replace(/[&<>]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character])
    });
    vm.runInContext(block, context);
    context.bindDailyOutputTooltips(chart);

    listeners.focus();
    expect(tooltip.hidden).toBe(false);
    expect(tooltip.attributes['aria-hidden']).toBe('false');
    expect(tooltip.innerHTML).toContain('FPS &amp; &lt;A2&gt;');
    expect(tooltip.innerHTML).toContain('12.5 kpcs. / 12,500 pcs');
    expect(tooltip.innerHTML).toContain('25.0% of selected output');
    expect(tooltip.innerHTML).toContain('>4</span>');
    listeners.keydown({ key: 'Escape' });
    expect(tooltip.hidden).toBe(true);
    expect(tooltip.attributes['aria-hidden']).toBe('true');
    listeners.pointermove({ clientX: 180, clientY: 170 });
    expect(tooltip.hidden).toBe(false);
    listeners.pointerleave();
    expect(tooltip.hidden).toBe(true);
  });
});

describe('Daily output floating panel contracts', () => {
  it('still loads the main TA dashboard when the JobName count request fails', async () => {
    const start = source.indexOf('    if (isTaYield) {', source.indexOf('async function loadData()'));
    const end = source.indexOf('    if (isLot) {', start);
    const summary = [{ line: 'FPS', finalGood: 2405110 }];
    let rendered;
    const context = vm.createContext({
      URLSearchParams, params: new URLSearchParams('dataset=ta-yield'), isTaYield: true,
      taYieldInterval: 'month', taYieldTrendPartNumber: 'All', requestId: 1, dataRequestId: 1,
      sourceGeneration: 0, dashboardDataModeGeneration: 0, currentConfig: { dataset: 'ta-yield' },
      selectedDataset: () => 'ta-yield', dailyOutputPanelEnabled: true, taYieldDailyOutputScope: null,
      taYieldDailyOutputRequest: null, latestTaYieldData: { summary: [], details: [] },
      taYieldSummaryOutputRows: (rows) => rows.map((row) => ({ itemName: row.line, quantityMoved: row.finalGood })),
      request: async (url) => {
        if (url.startsWith('/api/daily-output?')) throw new Error('JobName data could not be loaded.');
        return url.startsWith('/api/ta-yield?') ? summary : [];
      },
      renderTaYield: (payload) => { rendered = payload; }, renderDailyOutputPanel: () => {},
      setStatus: () => {}, loadTaYieldLotsTable: () => {}
    });
    const helpers = source.slice(source.indexOf('function isCurrentTaYieldDetailScope('), source.indexOf('function loadTaYieldLotDetails('));
    vm.runInContext(helpers, context);
    await vm.runInContext(`(async () => { ${source.slice(start, end)} })()`, context);
    expect(rendered.summary).toEqual(summary);
    expect(rendered.dailyOutput).toEqual([{ itemName: 'FPS', quantityMoved: 2405110 }]);
    expect(rendered.dailyOutputError).toBe('');
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    expect(context.latestTaYieldData.dailyOutputError).toBe('JobName data could not be loaded.');
  });

  it('provides a fixed draggable, resizable and minimizable panel without layout space', () => {
    const styles = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

    expect(source).toContain('daily-output-panel');
    expect(source).toContain("setPointerCapture(event.pointerId)");
    expect(source).toContain("aria-expanded");
    expect(source).toContain('dailyOutputMaximize');
    expect(source).toContain('is-maximized');
    expect(source).toContain("panel.classList.remove('is-minimized')");
    expect(source).toContain('dailyOutputToggle');
    expect(styles).toContain('.daily-output-panel { position: fixed;');
    expect(styles).toContain('resize: none');
    expect(source).toContain('bindDailyOutputResize(panel)');
    expect(styles).toContain('.daily-output-resize-handle');
  });

  it('renders in TA Yield from staged lot detail instead of hiding the floating panel', () => {
    expect(source).toContain("['closed', 'lot', 'ta-yield'].includes(currentConfig.dataset)");
    expect(source).toContain('function taYieldDailyOutputRows');
    expect(source).toContain('function taYieldSummaryOutputRows');
    expect(source).toContain('taYieldDailyOutputRows(details)');
    expect(source).toContain("if (isScYield) { renderDailyOutputPanel([]);");
  });

  it('keeps the On/Off control in shared report controls so TA Yield can use it', () => {
    const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

    expect(html).toMatch(/<section id="reportControls"[\s\S]*id="dailyOutputToggle"[\s\S]*<\/section>\s*<div class="report-top">/);
    expect(source).toContain("button.hidden = !supported");
    expect(source).toContain("return setDailyOutputPanelEnabled(!dailyOutputPanelEnabled");
  });

  it('closes through the shared toggle state and returns focus to the reopen control', () => {
    const { context, elements } = dailyOutputToggleContext();
    let restoreCount = 0;

    expect(context.closeDailyOutputPanel()).toBe(false);
    expect(context.closeDailyOutputPanel()).toBe(false);
    expect(elements.dailyOutputPanel.hidden).toBe(true);
    expect(elements.dailyOutputToggle.attributes['aria-pressed']).toBe('false');
    expect(elements.dailyOutputToggle.textContent).toBe('Daily output: Off');
    expect(elements.dailyOutputToggle.focusCount).toBe(2);
    expect(source).toContain('id="dailyOutputClose"');
    expect(source).toContain('aria-label="Close Daily output panel"');

    expect(context.toggleDailyOutputPanel(() => {
      restoreCount += 1;
      elements.dailyOutputPanel.hidden = false;
    })).toBe(true);
    expect(restoreCount).toBe(1);
    expect(elements.dailyOutputPanel.hidden).toBe(false);
    expect(elements.dailyOutputToggle.attributes['aria-pressed']).toBe('true');
    expect(elements.dailyOutputToggle.textContent).toBe('Daily output: On');
  });
});
