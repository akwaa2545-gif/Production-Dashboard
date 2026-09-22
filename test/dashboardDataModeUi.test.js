import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function harness() {
  let mode = { mode: 'staging', requestedMode: 'staging', revision: 0, transitioning: false, controlConfigured: true };
  const fetch = vi.fn(async (url) => ({ ok: true, status: 200, headers: { get: (name) => name === 'X-Dashboard-Data-Mode' ? mode.mode : name === 'X-Dashboard-Data-Revision' ? String(mode.revision) : 'max-age=120' }, json: async () => ({ success: true, data: url === '/api/data-mode' ? { ...mode } : ['fresh'] }) }));
  const context = vm.createContext({ fetch, URLSearchParams, setTimeout: vi.fn(), clearTimeout: vi.fn(), setInterval: vi.fn(), clientResponseCache: new Map(), clientCacheLimit: 20, dataRequestId: 1, scYieldTendencyRequestId: 0, latestTaYieldLotsRequestId: 0, latestTaYieldLotsUrl: '', stagingWipCompletedAt: undefined, isWipCacheRequest: () => false, byId: () => null, document: { querySelector: () => null, querySelectorAll: () => [] }, window: { addEventListener: vi.fn() }, setStatus: vi.fn(), readApiPayload: (response) => response.json() });
  const start = source.indexOf('// Global dashboard data mode.');
  expect(start).toBeGreaterThan(-1);
  vm.runInContext(source.slice(start, source.indexOf('async function loadData()', start)), context);
  return { context, fetch, setMode: (next) => { mode = { ...mode, ...next }; } };
}

function autofillHarness() {
  const ui = harness();
  const elements = new Map();
  const handlers = {};
  ui.context.byId = (id) => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', disabled: false, open: true, dataset: {}, classList: { toggle: vi.fn() }, addEventListener: (name, callback) => { handlers[`${id}:${name}`] = callback; } });
    return elements.get(id);
  };
  ui.setMode({ controlConfigured: false, localAutofillAvailable: true });
  return { ...ui, elements, handlers };
}

function sourceIndicatorHarness() {
  const ui = harness();
  const elements = Object.fromEntries([
    'dashboardSourceIndicator', 'dashboardSourceLabel', 'dashboardSourceDescription',
  ].map((id) => [id, { textContent: '', dataset: {} }]));
  ui.context.byId = (id) => elements[id] || null;
  return { ...ui, elements };
}

describe('dashboard source indicator', () => {
  it('shows that the source is being checked before the first response', () => {
    const ui = sourceIndicatorHarness();
    ui.context.renderDashboardDataMode();
    expect(ui.elements.dashboardSourceIndicator.dataset.mode).toBe('checking');
    expect(ui.elements.dashboardSourceLabel.textContent).toBe('Checking source…');
  });

  it.each([
    ['live', 'Live MES'], ['staging', 'Staging'],
  ])('shows the confirmed %s source without mounting the settings controls', async (mode, label) => {
    const ui = sourceIndicatorHarness();
    ui.setMode({ mode });
    await ui.context.checkDashboardDataMode();
    expect(ui.elements.dashboardSourceIndicator.dataset.mode).toBe(mode);
    expect(ui.elements.dashboardSourceLabel.textContent).toBe(label);
    expect(ui.elements.dashboardSourceDescription.textContent).not.toBe('');
  });

  it.each([
    ['staging', 'live', 'Live MES', 'Staging'],
    ['live', 'staging', 'Staging', 'Live MES'],
  ])('distinguishes the requested source from the current %s source during a switch', async (mode, requestedMode, requestedLabel, currentLabel) => {
    const ui = sourceIndicatorHarness();
    ui.setMode({ mode, requestedMode, transitioning: true });
    await ui.context.checkDashboardDataMode();
    expect(ui.elements.dashboardSourceIndicator.dataset.mode).toBe('switching');
    expect(ui.elements.dashboardSourceLabel.textContent).toBe(`Switching to ${requestedLabel}…`);
    expect(ui.elements.dashboardSourceDescription.textContent).toContain(currentLabel);
  });

  it.each([
    ['live', 'Live MES'], ['staging', 'Staging'],
  ])('marks a failed source check unavailable, retaining the last confirmed %s source, and recovers', async (mode, label) => {
    const ui = sourceIndicatorHarness();
    ui.setMode({ mode });
    await ui.context.checkDashboardDataMode();
    ui.fetch.mockRejectedValueOnce(new Error('Network unavailable'));
    await expect(ui.context.checkDashboardDataMode()).rejects.toThrow('Network unavailable');
    expect(ui.elements.dashboardSourceIndicator.dataset.mode).toBe('unavailable');
    expect(ui.elements.dashboardSourceLabel.textContent).toBe('Source unavailable');
    expect(ui.elements.dashboardSourceDescription.textContent).toContain(label);
    await ui.context.checkDashboardDataMode();
    expect(ui.elements.dashboardSourceIndicator.dataset.mode).toBe(mode);
    expect(ui.elements.dashboardSourceLabel.textContent).toBe(label);
  });
});

describe('global dashboard data mode', () => {
  it('checks mode before cache hits and bypasses caches for every live Apply', async () => {
    const ui = harness();
    const url = '/api/quantity?dataset=closed';
    await ui.context.request(url);
    await ui.context.request(url);
    expect(ui.fetch.mock.calls.filter(([value]) => value === url)).toHaveLength(1);
    ui.setMode({ mode: 'live', revision: 1 });
    await ui.context.request(url);
    await ui.context.request(url);
    expect(ui.fetch.mock.calls.filter(([value]) => value === url)).toHaveLength(3);
    expect(ui.fetch).toHaveBeenCalledWith(url, { cache: 'no-store' });
    expect(ui.context.clientResponseCache.size).toBe(0);
    expect(ui.fetch.mock.calls.filter(([value]) => value === '/api/data-mode').every(([, options]) => options.cache === 'no-store')).toBe(true);
  });

  it('blocks new production queries while active work drains', async () => {
    const ui = harness();
    ui.setMode({ transitioning: true, requestedMode: 'live' });
    await expect(ui.context.request('/api/ta-yield?dataset=ta-yield')).rejects.toThrow(/switch/i);
    expect(ui.fetch.mock.calls.map(([url]) => url)).toEqual(['/api/data-mode']);
  });

  it.each(['/api/quantity?dataset=lot', '/api/defect-settings'])('rejects an old response for %s after another browser changes the mode', async (url) => {
    const ui = harness();
    let finish;
    ui.fetch.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ success: true, data: { mode: 'staging', revision: 0, transitioning: false } }) }));
    ui.fetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = ui.context.request(url);
    while (!finish) await Promise.resolve();
    vm.runInContext("acceptDashboardDataMode({ mode: 'live', revision: 1, transitioning: false })", ui.context);
    finish({ ok: true, headers: { get: () => null }, json: async () => ({ success: true, data: ['old'] }) });
    await expect(pending).rejects.toThrow(/changed/i);
    expect(ui.context.clientResponseCache.size).toBe(0);
  });

  it('includes accessible controls and a nonpersistent password field', () => {
    const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    expect(html).toContain('id="dashboardDataModeStatus"');
    expect(html).toContain('id="dashboardDataModeToken" type="password" autocomplete="off"');
    expect(html).toContain('id="dashboardDataModeApply"');
    expect(source).toContain("token.value = ''");
  });

  it('clears the operator token even when the switch fails and allows retry', async () => {
    const ui = harness();
    const token = { value: 'operator-secret' };
    const status = { textContent: '' };
    const elements = { dashboardDataModeToken: token, dashboardDataModeDialogStatus: status, dashboardDataModeSelection: { value: 'live' } };
    ui.context.byId = (id) => elements[id];
    ui.fetch.mockResolvedValueOnce({ ok: false, json: async () => ({ success: false, error: 'Invalid operator token.' }) });
    await ui.context.submitDashboardDataMode({ preventDefault: vi.fn() });
    expect(token.value).toBe('');
    expect(status.textContent).toBe('Invalid operator token.');
    expect(ui.fetch).toHaveBeenCalledWith('/api/data-mode', expect.objectContaining({ method: 'PUT', cache: 'no-store', body: JSON.stringify({ mode: 'live' }), headers: expect.objectContaining({ Authorization: 'Bearer operator-secret' }) }));
    expect(vm.runInContext('dashboardDataModeSubmitting', ui.context)).toBe(false);
  });

  it('uses today for Live MES TA yield instead of historical staging coverage', async () => {
    const ui = harness();
    ui.setMode({ mode: 'live' });
    const start = source.indexOf('async function latestTaYieldStagingDate');
    vm.runInContext(source.slice(start, source.indexOf('\n', start)), ui.context);
    expect(await ui.context.latestTaYieldStagingDate('2026-09-21')).toBe('2026-09-21');
    expect(ui.fetch.mock.calls.map(([url]) => url)).toEqual(['/api/data-mode']);
  });

  it('refreshes source options and PN lookup state while retaining selected filters', async () => {
    const ui = harness();
    const context = ui.context;
    const options = { serie: ['SERIES-A'], process: ['TA'], case: ['small'] };
    context.byId = (id) => ({ value: ({ process: 'TA', case: 'small', product: 'NEO' })[id] });
    context.selectedSeries = () => ['SERIES-A'];
    context.selectedPartNumbers = () => ['PN-1'];
    context.selectedDataset = () => 'closed';
    context.request = vi.fn().mockResolvedValueOnce({ dataset: 'closed' }).mockResolvedValueOnce(options);
    context.populateOptions = vi.fn();
    context.pnState = { requestId: 3, selected: ['PN-1'] };
    context.resetPartNumbers = vi.fn(() => { context.pnState.selected = []; });
    context.renderPartNumberSelection = vi.fn();
    context.loadData = vi.fn().mockResolvedValue();
    context.scheduleDashboardDataModeReload();
    await context.setTimeout.mock.calls.at(-1)[0]();
    expect(context.request).toHaveBeenCalledWith('/api/options?dataset=closed&product=NEO');
    expect(context.populateOptions).toHaveBeenCalledWith(options, { process: 'TA', serie: ['SERIES-A'], case: 'small' });
    expect(context.resetPartNumbers).toHaveBeenCalledOnce();
    expect(context.pnState.selected).toEqual(['PN-1']);
    expect(context.pnState.requestId).toBe(4);
    expect(context.loadData).toHaveBeenCalledOnce();
  });

  it('fills a temporary local token and enables Apply without a configured secret', async () => {
    const ui = autofillHarness();
    await ui.context.checkDashboardDataMode();
    expect(ui.context.byId('dashboardDataModeApply').disabled).toBe(true);
    ui.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { token: 'temporary-token', expiresAt: new Date(Date.now() + 120000).toISOString() } }) });
    await ui.context.autofillDashboardDataModeToken();
    expect(ui.context.byId('dashboardDataModeToken').value).toBe('temporary-token');
    expect(ui.context.byId('dashboardDataModeApply').disabled).toBe(false);
    expect(ui.fetch).toHaveBeenLastCalledWith('/api/data-mode/local-token', expect.objectContaining({ method: 'POST', cache: 'no-store' }));
    const expiry = ui.context.setTimeout.mock.calls.at(-1)[0];
    expiry();
    expect(ui.context.byId('dashboardDataModeToken').value).toBe('');
    expect(ui.context.byId('dashboardDataModeApply').disabled).toBe(true);
    expect(ui.context.byId('dashboardDataModeDialogStatus').textContent).toMatch(/expired/i);
  });

  it('reports a failed autofill without enabling Apply and allows retry', async () => {
    const ui = autofillHarness();
    await ui.context.checkDashboardDataMode();
    ui.fetch.mockResolvedValueOnce({ ok: false, json: async () => ({ success: false, error: 'Local access is required.' }) });
    await ui.context.autofillDashboardDataModeToken();
    expect(ui.context.byId('dashboardDataModeToken').value).toBe('');
    expect(ui.context.byId('dashboardDataModeApply').disabled).toBe(true);
    expect(ui.context.byId('dashboardDataModeAutofill').disabled).toBe(false);
    expect(ui.context.byId('dashboardDataModeDialogStatus').textContent).toBe('Local access is required.');
  });

  it('discards a late autofill response after the dialog closes', async () => {
    const ui = autofillHarness();
    await ui.context.initializeDashboardDataModeControls();
    let finish;
    ui.fetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = ui.context.autofillDashboardDataModeToken();
    ui.context.byId('dashboardDataModeDialog').open = false;
    ui.handlers['dashboardDataModeDialog:close']();
    finish({ ok: true, json: async () => ({ success: true, data: { token: 'late-token', expiresAt: new Date(Date.now() + 120000).toISOString() } }) });
    await pending;
    expect(ui.context.byId('dashboardDataModeToken').value).toBe('');
    expect(ui.context.byId('dashboardDataModeApply').disabled).toBe(true);
  });

  it('keeps autofill disabled for remote clients and explains how to get access', async () => {
    const ui = autofillHarness();
    ui.setMode({ localAutofillAvailable: false });
    await ui.context.checkDashboardDataMode();
    expect(ui.context.byId('dashboardDataModeAutofill').disabled).toBe(true);
    expect(ui.context.byId('dashboardDataModeTokenHelp').textContent).toMatch(/localhost|administrator/i);
  });
});
