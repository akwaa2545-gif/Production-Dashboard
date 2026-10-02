import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const deferred = () => { let resolve; let reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const settle = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };

function setup({ dailyEnabled = true, view = 'dashboard', table = 'summary' } = {}) {
  const daily = [];
  const lots = [];
  const summary = [{ line: 'FPS A3', finalGood: 1000 }];
  const elements = new Map();
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, { value: '', hidden: false, innerHTML: '', textContent: '', focus: vi.fn(), setAttribute: vi.fn() });
    return elements.get(id);
  };
  byId('startDate').value = '2026-08-01';
  byId('endDate').value = '2026-08-31';
  byId('product').value = 'NEO';
  const globals = {
    URLSearchParams, currentConfig: { dataset: 'ta-yield' }, dataRequestId: 0, dashboardDataModeGeneration: 0,
    dailyOutputPanelEnabled: dailyEnabled, latestTaYieldData: { summary: [], details: [] }, latestTaYieldLotsUrl: '', latestTaYieldLotsRequestId: 0,
    taYieldDailyOutputScope: null, taYieldDailyOutputRequest: null, taYieldLotDetailsRequest: null,
    taYieldInterval: 'month', taYieldTrendPartNumber: 'All', scYieldTendencyRequestId: 0, latestTaYieldTendencyData: [], latestTaYieldGroupTendencyData: [],
    taYieldTableView: table, taYieldDetailVisible: true, activeView: view, ids: [], byId,
    selectedDataset: () => context.currentConfig.dataset, selectedSeries: () => ['FPS A3'], selectedPartNumbers: () => ['PN1'], selectedReportingPeriod: () => '2026-08',
    document: { querySelector: () => ({ dataset: { view: context.activeView } }) },
    taYieldSummaryOutputRows: (rows) => rows.map((row) => ({ itemName: row.line, quantityMoved: row.finalGood })),
    taYieldDailyOutputRows: vi.fn(), renderDailyOutputPanel: vi.fn(), renderTaYield: vi.fn(), renderTaYieldCalculationLog: vi.fn(),
    updateTaYieldCompare: vi.fn(), setReportControlsLoading: vi.fn(), setStatus: vi.fn(), markReportControlsApplied: vi.fn(),
    renderTaYieldTendencySkeleton: vi.fn(), renderTaYieldTendencyLoadError: vi.fn(), updateDailyOutputToggle: vi.fn(),
    escapeHtml: (text) => String(text).replaceAll('<', '&lt;'), saveDashboardSubtab: vi.fn(), restoreDashboardSubtabControls: vi.fn(),
    request: vi.fn((url) => {
      if (url.startsWith('/api/daily-output?')) { const pending = deferred(); daily.push({ url, ...pending }); return pending.promise; }
      if (url.startsWith('/api/ta-yield-lots?')) { const pending = deferred(); lots.push({ url, ...pending }); return pending.promise; }
      return Promise.resolve(url.startsWith('/api/ta-yield?') ? summary : []);
    })
  };
  const context = vm.createContext(globals);
  const helperStart = source.indexOf('function isCurrentTaYieldDetailScope(');
  expect(helperStart).toBeGreaterThan(-1);
  const helperEnd = source.indexOf('function ensureTaYieldCompareController()', helperStart);
  const loadStart = source.indexOf('async function loadData()');
  const loadEnd = source.indexOf('async function refreshOptionsForProduct()', loadStart);
  const toggleStart = source.indexOf('function updateDailyOutputToggle()');
  const toggleEnd = source.indexOf('function calculateDailyOutputResize(', toggleStart);
  vm.runInContext(`${source.slice(helperStart, helperEnd)}\n${source.slice(loadStart, loadEnd)}\n${source.slice(toggleStart, toggleEnd)}`, context);
  return { context, daily, lots, elements, summary };
}

function installCalculationLogLoader(fixture) {
  const holder = { innerHTML: '' };
  fixture.context.ensureTaYieldLogView = () => holder;
  fixture.context.logPaints = 0;
  const start = source.indexOf('async function renderTaYieldCalculationLog(');
  const end = source.indexOf('  const period =', start);
  vm.runInContext(`${source.slice(start, end)}\n globalThis.logPaints += 1; }`, fixture.context);
  return holder;
}

describe('TA dashboard independent enrichment', () => {
  it('applies shared source-mode response guards to independent Daily output requests', () => {
    const context = vm.createContext({});
    const declaration = source.split('\n').find((line) => line.startsWith('const isDashboardSourceRequest ='));
    vm.runInContext(`${declaration}\nglobalThis.guarded = isDashboardSourceRequest('/api/daily-output?dataset=ta-yield');`, context);
    expect(context.guarded).toBe(true);
  });

  it('renders core data and releases Apply while distinct JobName counts are pending', async () => {
    const fixture = setup();
    await fixture.context.loadData();
    expect(fixture.context.renderTaYield).toHaveBeenCalledOnce();
    expect(fixture.context.latestTaYieldData.summary).toEqual(fixture.summary);
    expect(fixture.context.latestTaYieldData.dailyOutputLoading).toBe(true);
    expect(fixture.elements.get('apply').textContent).toBe('Apply');
    expect(fixture.daily).toHaveLength(1);
    expect(fixture.lots).toHaveLength(0);
    fixture.daily[0].resolve([{ itemName: 'FPS A3', quantityMoved: 1250, lotCount: 1, jobNames: ['6K01N00052'] }]);
    await settle();
    expect(fixture.context.latestTaYieldData.dailyOutput[0].lotCount).toBe(1);
    expect(fixture.context.renderTaYield).toHaveBeenCalledOnce();
    expect(fixture.context.renderDailyOutputPanel).toHaveBeenCalled();
  });

  it('skips hidden Daily output and loads the last applied dates when it reopens', async () => {
    const fixture = setup({ dailyEnabled: false });
    await fixture.context.loadData();
    expect(fixture.daily).toHaveLength(0);
    fixture.elements.get('startDate').value = '2026-09-01';
    fixture.elements.get('endDate').value = '2026-09-30';
    fixture.context.toggleDailyOutputPanel();
    expect(fixture.daily).toHaveLength(1);
    const params = new URLSearchParams(fixture.daily[0].url.split('?')[1]);
    expect(params.get('startDate')).toBe('2026-08-01');
    expect(params.get('endDate')).toBe('2026-08-31');
    expect(fixture.context.renderTaYield).toHaveBeenCalledOnce();
  });

  it('does not reopen a closed panel, but coalesces close/reopen while its request is pending', async () => {
    const fixture = setup();
    await fixture.context.loadData();
    fixture.context.closeDailyOutputPanel();
    fixture.context.renderDailyOutputPanel.mockClear();
    fixture.daily[0].resolve([{ itemName: 'FPS A3', quantityMoved: 1000, lotCount: 1 }]);
    await settle();
    expect(fixture.context.renderDailyOutputPanel).not.toHaveBeenCalled();
    expect(fixture.context.dailyOutputPanelEnabled).toBe(false);
    fixture.context.toggleDailyOutputPanel();
    expect(fixture.daily).toHaveLength(1);
    await fixture.context.loadData();
    fixture.context.closeDailyOutputPanel();
    fixture.context.toggleDailyOutputPanel();
    expect(fixture.daily).toHaveLength(2);
    fixture.daily[1].resolve([]);
    await settle();
    expect(fixture.context.dailyOutputPanelEnabled).toBe(true);
  });

  it('keeps a Daily output error local after the main dashboard is already loaded', async () => {
    const fixture = setup();
    await fixture.context.loadData();
    fixture.daily[0].reject(new Error('JobName count failed'));
    await settle();
    expect(fixture.context.latestTaYieldData.dailyOutputError).toBe('JobName count failed');
    expect(fixture.context.latestTaYieldData.dailyOutput).toEqual([{ itemName: 'FPS A3', quantityMoved: 1000 }]);
    expect(fixture.context.latestTaYieldData.dailyOutputLoading).toBe(false);
    expect(fixture.context.renderTaYield).toHaveBeenCalledOnce();
    expect(fixture.context.setStatus).not.toHaveBeenCalledWith('JobName count failed');
  });

  it('rejects obsolete success and error responses after a different report is applied', async () => {
    const fixture = setup();
    await fixture.context.loadData();
    fixture.elements.get('startDate').value = '2026-09-01';
    await fixture.context.loadData();
    fixture.daily[1].resolve([{ itemName: 'LATEST', quantityMoved: 3000, lotCount: 2 }]);
    await settle();
    fixture.daily[0].reject(new Error('OLD'));
    await settle();
    expect(fixture.context.latestTaYieldData.dailyOutput[0].itemName).toBe('LATEST');
    expect(fixture.context.latestTaYieldData.dailyOutputError).toBe('');
  });

  it.each(['dataset', 'source'])('rejects pending enrichment after a %s change', async (change) => {
    const fixture = setup();
    await fixture.context.loadData();
    if (change === 'dataset') fixture.context.currentConfig = { dataset: 'closed' };
    else fixture.context.dashboardDataModeGeneration += 1;
    fixture.context.renderDailyOutputPanel.mockClear();
    fixture.daily[0].resolve([{ itemName: 'OLD', quantityMoved: 3000, lotCount: 2 }]);
    await settle();
    expect(fixture.context.latestTaYieldData.dailyOutput[0].itemName).not.toBe('OLD');
    expect(fixture.context.renderDailyOutputPanel).not.toHaveBeenCalled();
  });
});

describe('TA lot details on demand', () => {
  it.each([
    { details: [], detailsLoaded: false, expected: 'FPS A3' },
    { details: [{ series: 'FPS A3' }], detailsLoaded: true, expected: 'FPS A3' },
    { details: [], detailsLoaded: true, expected: '' }
  ])('preserves the selected lot series while detail data is loading: $detailsLoaded/$expected', ({ details, detailsLoaded, expected }) => {
    const start = source.indexOf('  const lotSeries =', source.indexOf('function renderTaYield(payload)'));
    const end = source.indexOf('  const lotSeriesSelect =', start);
    const context = vm.createContext({ details, payload: { detailsLoaded }, taYieldLotSeries: 'FPS A3' });
    vm.runInContext(source.slice(start, end), context);
    expect(context.taYieldLotSeries).toBe(expected);
  });

  it('does not request lot evidence until a detail consumer asks, shares its request, and caches valid empty data', async () => {
    const fixture = setup({ dailyEnabled: false });
    await fixture.context.loadData();
    expect(fixture.lots).toHaveLength(0);
    const first = fixture.context.loadTaYieldLotDetails();
    const second = fixture.context.loadTaYieldLotDetails();
    expect(fixture.lots).toHaveLength(1);
    fixture.lots[0].resolve([]);
    await Promise.all([first, second]);
    expect(fixture.context.latestTaYieldData.detailsLoaded).toBe(true);
    await fixture.context.loadTaYieldLotDetails();
    expect(fixture.lots).toHaveLength(1);
  });

  it('loads an already selected lot table after rendering core without delaying Apply', async () => {
    const fixture = setup({ dailyEnabled: false, table: 'lots' });
    await fixture.context.loadData();
    expect(fixture.context.renderTaYield).toHaveBeenCalledOnce();
    expect(fixture.elements.get('apply').textContent).toBe('Apply');
    expect(fixture.lots).toHaveLength(1);
    fixture.context.taYieldTableView = 'summary';
    fixture.lots[0].resolve([{ lotNo: '6K01N00052' }]);
    await settle();
    expect(fixture.context.latestTaYieldData.detailsLoaded).toBe(true);
    expect(fixture.context.renderTaYield).toHaveBeenCalledOnce();
  });

  it('discards stale lot data and keeps a lot request failure out of the main load status', async () => {
    const fixture = setup({ dailyEnabled: false, table: 'lots' });
    await fixture.context.loadData();
    await fixture.context.loadData();
    fixture.lots[0].resolve([{ lotNo: 'OLD' }]);
    fixture.lots[1].reject(new Error('<evidence unavailable>'));
    await settle();
    expect(fixture.context.latestTaYieldData.details).toEqual([]);
    expect(fixture.context.latestTaYieldData.detailsLoaded).toBe(false);
    expect(fixture.elements.get('taYieldRows').innerHTML).toContain('&lt;evidence unavailable>');
    expect(fixture.context.setStatus).not.toHaveBeenCalledWith('<evidence unavailable>');
  });

  it('renders cached lots on dashboard return after a hidden table request completed', async () => {
    const fixture = setup({ dailyEnabled: false, table: 'lots' });
    await fixture.context.loadData();
    fixture.context.activeView = 'ta-yield-log';
    fixture.lots[0].resolve([{ lotNo: '6K01N00052' }]);
    await settle();
    expect(fixture.context.renderTaYield).toHaveBeenCalledOnce();
    fixture.context.activeView = 'dashboard';
    fixture.context.restoreTaYieldDashboardDetails();
    expect(fixture.context.renderTaYield).toHaveBeenCalledTimes(2);
    expect(fixture.context.renderTaYield.mock.calls[1][0].details[0].lotNo).toBe('6K01N00052');
    expect(fixture.lots).toHaveLength(1);
    const nav = source.slice(source.indexOf('function showView(view)'), source.indexOf('\n', source.indexOf('function showView(view)')));
    expect(nav).toContain("if (view === 'dashboard') restoreTaYieldDashboardDetails();");
  });

  it('starts lazy lots on dashboard return when the core loaded on another tab', async () => {
    const fixture = setup({ dailyEnabled: false, view: 'parameters', table: 'lots' });
    await fixture.context.loadData();
    expect(fixture.lots).toHaveLength(0);
    fixture.context.activeView = 'dashboard';
    fixture.context.restoreTaYieldDashboardDetails();
    expect(fixture.lots).toHaveLength(1);
  });

  it('shares calculation-log evidence work and treats a successful empty log as loaded', async () => {
    const fixture = setup({ dailyEnabled: false, view: 'ta-yield-log' });
    await fixture.context.loadData();
    installCalculationLogLoader(fixture);
    const first = fixture.context.renderTaYieldCalculationLog();
    const second = fixture.context.renderTaYieldCalculationLog();
    expect(fixture.lots).toHaveLength(1);
    fixture.lots[0].resolve([]);
    await Promise.all([first, second]);
    await fixture.context.renderTaYieldCalculationLog();
    expect(fixture.lots).toHaveLength(1);
    expect(fixture.context.logPaints).toBe(3);
  });

  it('caches calculation evidence while guarding a log view that was closed during loading', async () => {
    const fixture = setup({ dailyEnabled: false, view: 'ta-yield-log' });
    await fixture.context.loadData();
    installCalculationLogLoader(fixture);
    const pending = fixture.context.renderTaYieldCalculationLog();
    fixture.context.activeView = 'dashboard';
    fixture.lots[0].resolve([{ lotNo: '6K01N00052' }]);
    await pending;
    expect(fixture.context.latestTaYieldData.detailsLoaded).toBe(true);
    expect(fixture.context.logPaints).toBe(0);
  });

  it('reports calculation-log errors locally and rejects evidence after a source change', async () => {
    const fixture = setup({ dailyEnabled: false, view: 'ta-yield-log' });
    await fixture.context.loadData();
    const holder = installCalculationLogLoader(fixture);
    let pending = fixture.context.renderTaYieldCalculationLog();
    fixture.lots[0].reject(new Error('<log unavailable>'));
    await pending;
    expect(holder.innerHTML).toContain('&lt;log unavailable>');
    expect(fixture.context.setStatus).not.toHaveBeenCalledWith('<log unavailable>');
    pending = fixture.context.renderTaYieldCalculationLog();
    fixture.context.dashboardDataModeGeneration += 1;
    fixture.lots[1].resolve([{ lotNo: 'OLD' }]);
    await pending;
    expect(fixture.context.latestTaYieldData.details).toEqual([]);
    expect(fixture.context.logPaints).toBe(0);
  });
});
