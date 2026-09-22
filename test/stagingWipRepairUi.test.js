import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function harness({ pipeline = {}, failure } = {}) {
  const handlers = {};
  const observers = [];
  const status = { textContent: '' };
  const button = { disabled: false };
  const form = {
    elements: { startDate: { value: '2026-09-19' }, endDate: { value: '2026-09-20' }, operatorToken: { value: 'test-operator-token' } },
    matches: () => true,
    querySelector: (selector) => selector === '[role="status"]' ? status : button
  };
  const request = failure ? vi.fn().mockRejectedValue(new Error(failure)) : vi.fn().mockResolvedValue({});
  const context = vm.createContext({
    document: { body: {}, addEventListener: (name, handler) => { handlers[name] = handler; } },
    MutationObserver: class { constructor(callback) { observers.push(callback); } observe() {} },
    clientResponseCache: new Map(), URLSearchParams,
    Node: { ELEMENT_NODE: 1 },
    stagingMonitorPayload: { pipelines: { wip: pipeline } },
    byId: () => ({ value: '2026-09-20' }),
    bangkokToday: () => '2026-09-21',
    escapeHtml: (text) => String(text).replaceAll('<', '&lt;'),
    stagingTime: (value) => value || 'No refresh recorded',
    window: { confirm: vi.fn(() => true) },
    request, renderStagingStatus: vi.fn().mockResolvedValue(), setTimeout: vi.fn()
  });
  const start = source.indexOf('let stagingWipRepairRange');
  expect(start).toBeGreaterThan(-1);
  vm.runInContext(source.slice(start, source.indexOf('const stagingTime', start)), context);
  const submit = () => handlers.submit({ target: { closest: () => form }, preventDefault: vi.fn() });
  return { context, handlers, observers, form, status, button, request, submit };
}

describe('WIP repair operator controls', () => {
  it('bypasses HTTP cache for WIP GETs while retaining the JS cache and closed request behavior', async () => {
    const ui = harness();
    ui.context.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, headers: { get: () => 'private, max-age=120' } });
    ui.context.readApiPayload = vi.fn().mockResolvedValue({ success: true, data: ['fresh'] });
    ui.context.clientCacheLimit = 20;
    vm.runInContext(source.slice(source.indexOf('async function request('), source.indexOf('async function loadData()')), ui.context);
    const lotUrl = '/api/quantity?dataset=lot';
    await ui.context.request(lotUrl);
    expect(ui.context.fetch).toHaveBeenLastCalledWith(lotUrl, { cache: 'no-store' });
    await ui.context.request(lotUrl);
    expect(ui.context.fetch).toHaveBeenCalledTimes(1);
    await ui.context.request('/api/quantity?dataset=closed');
    expect(ui.context.fetch).toHaveBeenLastCalledWith('/api/quantity?dataset=closed', {});
  });

  it('does not repopulate WIP cache with a response started before repair completed', async () => {
    const ui = harness();
    let finishOldRequest;
    ui.context.fetch = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finishOldRequest = resolve; }))
      .mockResolvedValue({ ok: true, status: 200, headers: { get: () => 'max-age=120' } });
    ui.context.readApiPayload = vi.fn().mockResolvedValue({ success: true, data: ['quantity'] });
    ui.context.clientCacheLimit = 20;
    vm.runInContext(source.slice(source.indexOf('async function request('), source.indexOf('async function loadData()')), ui.context);
    const lotUrl = '/api/quantity?dataset=lot';
    const pending = ui.context.request(lotUrl);
    vm.runInContext("invalidateCompletedWipRepairCache({ status: 'SUCCEEDED', completedAt: '2026-09-21T03:00:00Z' })", ui.context);
    finishOldRequest({ ok: true, status: 200, headers: { get: () => 'max-age=120' } });
    await pending;
    expect(ui.context.clientResponseCache.has(lotUrl)).toBe(false);
    await ui.context.request(lotUrl);
    expect(ui.context.fetch).toHaveBeenCalledTimes(2);
    expect(ui.context.clientResponseCache.has(lotUrl)).toBe(true);
  });

  it('invalidates only lot cache once for each successful WIP completion', () => {
    const ui = harness();
    const cache = ui.context.clientResponseCache;
    const lotUrl = '/api/quantity?dataset=lot&product=NEO';
    const chartUrl = '/api/chart?product=NEO&dataset=lot';
    const closedUrl = '/api/quantity?dataset=closed';
    cache.set(lotUrl, 'old lot');
    cache.set(chartUrl, 'old chart');
    cache.set(closedUrl, 'closed');
    const observe = (status, completedAt) => {
      ui.context.pipeline = { status, completedAt };
      vm.runInContext('invalidateCompletedWipRepairCache(pipeline)', ui.context);
    };
    observe('RUNNING', '2026-09-21T01:00:00Z');
    observe('FAILED', '2026-09-21T01:00:00Z');
    observe('SUCCEEDED', undefined);
    expect(cache.size).toBe(3);
    observe('SUCCEEDED', '2026-09-21T01:00:00Z');
    expect([...cache]).toEqual([[closedUrl, 'closed']]);
    cache.set(lotUrl, 'fresh lot');
    observe('SUCCEEDED', '2026-09-21T01:00:00Z');
    expect(cache.get(lotUrl)).toBe('fresh lot');
    observe('SUCCEEDED', '2026-09-21T02:00:00Z');
    expect([...cache]).toEqual([[closedUrl, 'closed']]);
    expect(source).toContain('invalidateCompletedWipRepairCache(payload.pipelines?.wip)');
  });

  it('observer restores removed form dates and mounts shared progress and repair only once', () => {
    const ui = harness({ pipeline: { status: 'RUNNING', stage: 'Reading daily quantities' } });
    const inserted = [];
    const appended = [];
    const card = {
      querySelector: (selector) => selector === 'h3' ? { textContent: 'WIP daily quantity' } : appended[0],
      append: (section) => appended.push(section)
    };
    const monitor = {
      querySelector: (selector) => selector === '.staging-wip-run' ? inserted[0] : { insertAdjacentElement: (_position, section) => inserted.push(section) },
      querySelectorAll: () => [card]
    };
    ui.context.byId = (id) => id === 'stagingStatusView' ? { hidden: false, querySelector: () => monitor } : { value: '2026-09-20' };
    ui.context.document.createElement = () => ({ setAttribute: vi.fn(), innerHTML: '' });
    ui.observers[0]([{ removedNodes: [{ ...ui.form, nodeType: 1 }] }]);
    expect(inserted[0].innerHTML).toContain('Reading daily quantities');
    expect(appended[0].innerHTML).toContain('value="2026-09-19"');
    expect(appended[0].innerHTML).toContain('type="submit" disabled');
    ui.observers[0]([]);
    expect(inserted).toHaveLength(1);
    expect(appended).toHaveLength(1);
  });

  it.each([
    ['2026-02-30', '2026-03-01', 'valid date'],
    ['', '2026-09-20', 'valid date'],
    ['2026-09-20', '2026-09-19', 'valid date'],
    ['2026-09-19', '2026-09-22', 'future'],
    ['2026-09-01', '2026-09-08', '7 days']
  ])('blocks invalid range %s to %s before requesting a repair', async (start, end, message) => {
    const ui = harness();
    ui.form.elements.startDate.value = start;
    ui.form.elements.endDate.value = end;
    await ui.submit();
    expect(ui.request).not.toHaveBeenCalled();
    expect(ui.status.textContent).toContain(message);
  });

  it('submits both dates with authorization, clears the token, and blocks duplicate submits', async () => {
    const ui = harness();
    await ui.submit();
    expect(ui.request).toHaveBeenCalledWith('/api/staging/wip-repair', expect.objectContaining({
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-operator-token' },
      body: JSON.stringify({ startDate: '2026-09-19', endDate: '2026-09-20' })
    }));
    expect(ui.form.elements.operatorToken.value).toBe('');
    expect(ui.button.disabled).toBe(true);
    await ui.submit();
    expect(ui.request).toHaveBeenCalledTimes(1);
  });

  it('shows request failures and allows retry without retaining the token', async () => {
    const ui = harness({ failure: 'Repair is unavailable.' });
    await ui.submit();
    expect(ui.status.textContent).toBe('Repair is unavailable.');
    expect(ui.button.disabled).toBe(false);
    expect(ui.form.elements.operatorToken.value).toBe('');
  });

  it('accepts exactly seven days ending today', async () => {
    const ui = harness();
    ui.form.elements.startDate.value = '2026-09-15';
    ui.form.elements.endDate.value = '2026-09-21';
    await ui.submit();
    expect(ui.request).toHaveBeenCalledTimes(1);
  });

  it('requires the operator token and honors cancellation', async () => {
    const ui = harness();
    ui.form.elements.operatorToken.value = '';
    await ui.submit();
    expect(ui.status.textContent).toBe('Enter the operator token.');
    ui.form.elements.operatorToken.value = 'test-operator-token';
    ui.context.window.confirm.mockReturnValue(false);
    await ui.submit();
    expect(ui.request).not.toHaveBeenCalled();
    expect(ui.button.disabled).toBe(false);
  });

  it('preserves the date range on rerender without copying the token into markup', () => {
    const ui = harness();
    ui.context.form = ui.form;
    vm.runInContext('rememberStagingWipRepairRange(form)', ui.context);
    const html = vm.runInContext('stagingWipRepairMarkup({})', ui.context);
    expect(html).toContain('value="2026-09-19"');
    expect(html).toContain('value="2026-09-20"');
    expect(html).not.toContain('test-operator-token');
    expect(html).toContain('daily quantities and process charts');
  });

  it('copies date edits into cloned markup while ignoring token input events', () => {
    const ui = harness();
    const setAttribute = vi.fn();
    ui.handlers.input({ target: { name: 'operatorToken', value: 'secret', setAttribute, closest: () => ui.form } });
    expect(setAttribute).not.toHaveBeenCalled();
    ui.form.elements.startDate.value = '2026-09-18';
    ui.handlers.input({ target: { name: 'startDate', value: '2026-09-18', setAttribute, closest: () => ui.form } });
    expect(setAttribute).toHaveBeenCalledWith('value', '2026-09-18');
    expect(vm.runInContext('stagingWipRepairMarkup({})', ui.context)).toContain('value="2026-09-18"');
    expect(source).toContain('rememberStagingWipRepairRange(view); await renderStagingStatusWithTabs()');
  });

  it('disables repair while WIP runs and renders escaped progress for the shared operation', async () => {
    const pipeline = { status: 'RUNNING', stage: '<loading daily and process>', startDate: '2026-09-19', endDate: '2026-09-20' };
    const ui = harness({ pipeline });
    ui.context.pipeline = pipeline;
    expect(vm.runInContext('stagingWipRepairMarkup(pipeline)', ui.context)).toContain('type="submit" disabled');
    expect(vm.runInContext('stagingWipProgressMarkup(pipeline)', ui.context)).toContain('&lt;loading daily and process>');
    await ui.submit();
    expect(ui.request).not.toHaveBeenCalled();
  });
});
