import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const path = new URL('../public/ta-yield-compare.js', import.meta.url);
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function element() {
  const classes = new Set();
  return {
    style: {}, dataset: {}, attributes: {}, listeners: {}, hidden: false, value: '', innerHTML: '', textContent: '', focus: vi.fn(),
    classList: { contains: (name) => classes.has(name), add: (name) => classes.add(name), remove: (name) => classes.delete(name), toggle(name, on) { const next = on ?? !classes.has(name); if (next) classes.add(name); else classes.delete(name); return next; } },
    addEventListener(name, callback) { this.listeners[name] = callback; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getBoundingClientRect: () => ({ left: 100, top: 100, width: 1000, height: 620 }),
    setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn(),
    querySelectorAll: () => [],
    closest: () => null
  };
}

function context(request = vi.fn().mockResolvedValue(payload()), options = {}) {
  const elements = new Map();
  const downloads = [];
  const objectUrls = { createObjectURL: vi.fn(() => 'blob:compare-export'), revokeObjectURL: vi.fn() };
  const document = {
    getElementById: (id) => elements.get(id),
    createElement(tag) {
      if (tag === 'a') { const link = { click: vi.fn(), remove: vi.fn() }; downloads.push(link); return link; }
      const panel = element();
      panel.querySelector = (selector) => {
        if (!elements.has(selector)) elements.set(selector, element());
        return elements.get(selector);
      };
      elements.set('panel', panel);
      return panel;
    },
    body: { append: vi.fn() }
  };
  const toggleButton = element();
  const globals = vm.createContext({ document, window: { innerWidth: 1400, innerHeight: 900 }, URL: objectUrls, URLSearchParams, Intl, Date, getComputedStyle: () => ({ zIndex: '80' }) });
  vm.runInContext(fs.readFileSync(path, 'utf8'), globals);
  const bindResize = vi.fn();
  const controller = globals.window.createTaYieldCompareWindow({ request, escapeHtml, bindResize, toggleButton, ...options });
  return { globals, elements, controller, toggleButton, request, bindResize, downloads, objectUrls };
}

function payload(extra = {}) {
  return { currentMonth: '2026-10', compareMonth: '2026-09', currentRange: { startDate: '2026-10-01', endDate: '2026-10-01' }, compareRange: { startDate: '2026-09-01', endDate: '2026-09-30' }, rows: [{ label: 'Total', kind: 'total', currentYield: 91.5, compareYield: 91.85, delta: -0.35 }], ...extra };
}
function detailsPayload(extra = {}) {
  return { selection: { kind: 'series', key: 'FPS SERIES A3', label: 'FPS A3' },
    currentRange: { startDate: '2026-09-05', endDate: '2026-09-20' }, compareRange: { startDate: '2026-08-05', endDate: '2026-08-20' },
    groups: [{ group: 'Crack', currentQty: 20, compareQty: 10, currentRate: 2, compareRate: 1, deltaRate: 1 }, { group: 'Other2', currentQty: -5, compareQty: 0, currentRate: -0.5, compareRate: 0, deltaRate: -0.5 }],
    lots: { current: { total: 51, rows: [{ lotNo: '6K01N00052', itemName: 'PN1', line: 'FPS SERIES A3', input: 1000, good: 980, yield: 98, defectQty: 20, groups: [] }] }, compare: { total: 0, rows: [] } }, ...extra };
}
const selectEvent = (index = 0) => ({ target: { closest: () => ({ dataset: { compareIndex: String(index) } }) } });
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe('Compare Excel export', () => {
  const get = (fixture, name) => fixture.elements.get(`[data-compare-${name}]`);
  const response = () => ({ ok: true, blob: vi.fn().mockResolvedValue({ workbook: true }) });

  it('exports only on demand using applied Report dates, filters and alignment, then cleans up the download', async () => {
    const fetchExport = vi.fn().mockResolvedValue(response());
    const fixture = context(undefined, { fetchExport });
    fixture.controller.setAvailable(true);
    fixture.controller.refresh({ startDate: '2026-10-01', endDate: '2026-10-01', product: 'TA', serie: ['FPS'], pn: ['PN1'] });
    fixture.controller.toggle();
    expect(get(fixture, 'export').disabled).toBe(true);
    await settle();
    expect(fetchExport).not.toHaveBeenCalled();
    expect(get(fixture, 'export').disabled).toBe(false);
    await get(fixture, 'export').listeners.click(); await settle();
    const url = fetchExport.mock.calls[0][0]; const params = new URLSearchParams(url.split('?')[1]);
    expect(url).toContain('/api/export/ta-yield-compare?');
    expect(params.get('startDate')).toBe('2026-10-01'); expect(params.get('endDate')).toBe('2026-10-01');
    expect(params.get('comparisonMode')).toBe('same-dates'); expect(params.getAll('serie')).toEqual(['FPS']);
    expect(params.getAll('pn')).toEqual(['PN1']); expect(params.get('product')).toBe('TA'); expect(params.has('kind')).toBe(false);
    expect(fixture.downloads[0].click).toHaveBeenCalledOnce(); expect(fixture.downloads[0].remove).toHaveBeenCalledOnce();
    expect(fixture.downloads[0].download).toMatch(/\.xlsx$/); expect(fixture.objectUrls.revokeObjectURL).toHaveBeenCalledWith('blob:compare-export');
    expect(get(fixture, 'export-status').textContent).toContain('download'); expect(get(fixture, 'export').disabled).toBe(false);
  });

  it('includes successful LOOKUP identity without paging and disables export while pending or failed', async () => {
    let resolve;
    const fetchExport = vi.fn().mockResolvedValue(response());
    const request = vi.fn().mockResolvedValueOnce(payload()).mockImplementationOnce(() => new Promise((done) => { resolve = done; })).mockRejectedValueOnce(new Error('Missing staging')).mockResolvedValue(detailsPayload());
    const fixture = context(request, { fetchExport }); fixture.controller.setAvailable(true); fixture.controller.toggle(); await settle();
    get(fixture, 'chart').listeners.click(selectEvent()); expect(get(fixture, 'export').disabled).toBe(true);
    resolve(detailsPayload()); await settle();
    await get(fixture, 'export').listeners.click(); await settle();
    const params = new URLSearchParams(fetchExport.mock.calls[0][0].split('?')[1]);
    expect(params.get('kind')).toBe('series'); expect(params.get('key')).toBe('FPS SERIES A3');
    expect(params.has('offset')).toBe(false); expect(params.has('limit')).toBe(false);
    get(fixture, 'detail-next').listeners.click(); await settle(); expect(get(fixture, 'export').disabled).toBe(true);
    get(fixture, 'export').listeners.click(); expect(fetchExport).toHaveBeenCalledOnce();
    get(fixture, 'detail-retry').listeners.click(); await settle(); expect(get(fixture, 'export').disabled).toBe(false);
  });

  it('shows export errors safely without losing the chart and allows retry', async () => {
    const fetchExport = vi.fn().mockResolvedValueOnce({ ok: false, json: vi.fn().mockResolvedValue({ error: '<bad export>' }) }).mockResolvedValue(response());
    const fixture = context(undefined, { fetchExport }); fixture.controller.setAvailable(true); fixture.controller.toggle(); await settle();
    await get(fixture, 'export').listeners.click(); await settle();
    expect(get(fixture, 'export-status').textContent).toBe('<bad export>'); expect(get(fixture, 'chart').innerHTML).toContain('<svg');
    expect(get(fixture, 'export').disabled).toBe(false); expect(fixture.downloads).toHaveLength(0);
    await get(fixture, 'export').listeners.click(); await settle(); expect(fixture.downloads).toHaveLength(1);
  });

  it('coalesces clicks and discards stale exports on close, report, mode, month, source or LOOKUP change', async () => {
    for (const change of ['close', 'report', 'mode', 'month', 'source', 'lookup']) {
      let resolve;
      const fetchExport = vi.fn(() => new Promise((done) => { resolve = done; }));
      const fixture = context(vi.fn().mockResolvedValueOnce(payload()).mockResolvedValue(detailsPayload()), { fetchExport });
      fixture.controller.setAvailable(true); fixture.controller.toggle(); await settle();
      get(fixture, 'export').listeners.click(); get(fixture, 'export').listeners.click(); expect(fetchExport).toHaveBeenCalledOnce();
      if (change === 'close') get(fixture, 'close').listeners.click();
      if (change === 'report') fixture.controller.syncFilters({ startDate: '2026-09-01', endDate: '2026-09-30' });
      if (change === 'mode') { get(fixture, 'mode').value = 'full-month'; get(fixture, 'mode').listeners.change(); }
      if (change === 'month') { get(fixture, 'month').value = '2026-07'; get(fixture, 'month').listeners.input(); }
      if (change === 'source') fixture.controller.setAvailable(false);
      if (change === 'lookup') get(fixture, 'chart').listeners.click(selectEvent());
      resolve(response()); await settle(); expect(fixture.downloads).toHaveLength(0);
    }
  });

  it('disables export without the injected downloader and after unapplied draft dates', async () => {
    const fixture = context(); fixture.controller.setAvailable(true); fixture.controller.toggle(); await settle();
    expect(get(fixture, 'export').disabled).toBe(true);
    const injected = context(undefined, { fetchExport: vi.fn() }); injected.controller.setAvailable(true); injected.controller.toggle(); await settle();
    get(injected, 'month').value = '2026-07'; get(injected, 'month').listeners.input();
    expect(get(injected, 'export').disabled).toBe(true);
  });

  it('discards delayed blobs after closing LOOKUP and reenables export for the main Compare', async () => {
    let resolveBlob;
    const fetchExport = vi.fn().mockResolvedValue({ ok: true, blob: () => new Promise((done) => { resolveBlob = done; }) });
    const fixture = context(vi.fn().mockResolvedValueOnce(payload()).mockResolvedValue(detailsPayload()), { fetchExport });
    fixture.controller.setAvailable(true); fixture.controller.toggle(); await settle();
    get(fixture, 'chart').listeners.click(selectEvent()); await settle();
    const pending = get(fixture, 'export').listeners.click(); await settle();
    get(fixture, 'detail-close').listeners.click(); expect(get(fixture, 'export').disabled).toBe(false);
    resolveBlob({ workbook: true }); await pending;
    expect(fixture.downloads).toHaveLength(0); expect(get(fixture, 'export-status').textContent).toBe('');
  });

  it('handles invalid error JSON and download errors without leaking URLs or leaving the export button busy', async () => {
    const fetchExport = vi.fn().mockResolvedValueOnce({ ok: false, json: vi.fn().mockResolvedValue(null) }).mockResolvedValue(response());
    const fixture = context(undefined, { fetchExport }); fixture.controller.setAvailable(true); fixture.controller.toggle(); await settle();
    await get(fixture, 'export').listeners.click();
    expect(get(fixture, 'export-status').textContent).toContain('could not be created');
    fixture.objectUrls.createObjectURL.mockImplementation(() => { throw new Error('Download unavailable'); });
    await get(fixture, 'export').listeners.click();
    expect(get(fixture, 'export-status').textContent).toBe('Download unavailable');
    expect(get(fixture, 'export').disabled).toBe(false); expect(fixture.downloads[0].click).not.toHaveBeenCalled();
  });
});

describe('Compare analysis improvements', () => {
  it('defaults to same dates, supports full month, and rejects multi-month matching explicitly', async () => {
    const fixture = context();
    fixture.controller.setAvailable(true);
    fixture.controller.refresh({ startDate: '2026-09-05', endDate: '2026-09-20' });
    fixture.controller.toggle();
    expect(new URLSearchParams(fixture.request.mock.calls[0][0].split('?')[1]).get('comparisonMode')).toBe('same-dates');
    await settle();
    fixture.controller.refresh({ startDate: '2026-08-05', endDate: '2026-09-20' });
    expect(fixture.request).toHaveBeenCalledTimes(1);
    expect(fixture.elements.get('[data-compare-chart]').innerHTML).toContain('Full month');
    const mode = fixture.elements.get('[data-compare-mode]');
    mode.value = 'full-month';
    mode.listeners.change();
    fixture.elements.get('[data-compare-apply]').listeners.click();
    expect(new URLSearchParams(fixture.request.mock.calls[1][0].split('?')[1]).get('comparisonMode')).toBe('full-month');
  });

  it('shows yield, percentage point change, input and good output for both periods with clamp notes', async () => {
    const fixture = context(vi.fn().mockResolvedValue(payload({ rangeNotes: ['End day clamped to February 28.'], rows: [{ label: 'Total', kind: 'total', key: 'Total', currentYield: 98, compareYield: 97, delta: 1, currentInput: 2000000, currentGood: 1960000, compareInput: 1000000, compareGood: 970000 }] })));
    fixture.controller.setAvailable(true); fixture.controller.toggle(); await settle();
    const table = fixture.elements.get('[data-compare-summary]').innerHTML;
    expect(table).toContain('1,960.00'); expect(table).toContain('970.00');
    expect(table).toContain('98.00%'); expect(table).toContain('Input (kpcs.)'); expect(table).toContain('Change (pp)');
    expect(fixture.elements.get('[data-compare-notes]').textContent).toContain('February 28');
    expect(fixture.request).toHaveBeenCalledTimes(1);
  });

  it('investigates only on selection, sends canonical identity and applied scope, and coalesces pending clicks', async () => {
    let resolve;
    const request = vi.fn().mockResolvedValueOnce(payload({ currentRange: { startDate: '2026-09-05', endDate: '2026-09-20' }, compareMonth: '2026-08', compareRange: { startDate: '2026-08-05', endDate: '2026-08-20' }, rows: [{ label: 'FPS A3', kind: 'series', key: 'FPS SERIES A3', delta: 1 }] })).mockImplementation(() => new Promise((done) => { resolve = done; }));
    const fixture = context(request);
    fixture.controller.setAvailable(true); fixture.controller.refresh({ startDate: '2026-09-05', endDate: '2026-09-20', serie: ['FPS'], pn: ['PN1'], product: 'TA' }); fixture.controller.toggle(); await settle();
    expect(request).toHaveBeenCalledTimes(1);
    fixture.elements.get('[data-compare-chart]').listeners.click(selectEvent());
    fixture.elements.get('[data-compare-summary]').listeners.click(selectEvent());
    expect(request).toHaveBeenCalledTimes(2);
    const url = request.mock.calls[1][0]; const params = new URLSearchParams(url.split('?')[1]);
    expect(url).toContain('/api/ta-yield-compare-details?');
    expect(params.get('key')).toBe('FPS SERIES A3'); expect(params.get('kind')).toBe('series');
    expect(params.get('startDate')).toBe('2026-09-05'); expect(params.get('comparisonMode')).toBe('same-dates'); expect(params.getAll('pn')).toEqual(['PN1']);
    resolve(detailsPayload()); await settle();
    const body = fixture.elements.get('[data-compare-detail-body]').innerHTML;
    expect(body).toContain('6K01N00052'); expect(body).toContain('Crack'); expect(body).toContain('Reconciliation adjustment');
    expect(body).toContain('No staged jobs'); expect(body).toContain('1–1 of 51');
    fixture.elements.get('[data-compare-detail-next]').listeners.click();
    expect(new URLSearchParams(request.mock.calls[2][0].split('?')[1]).get('offset')).toBe('50');
    resolve(detailsPayload()); await settle();
  });

  it('supports keyboard bar activation and ignores details after close, mode or report changes', async () => {
    const resolves = [];
    const request = vi.fn().mockResolvedValueOnce(payload()).mockImplementation(() => new Promise((done) => resolves.push(done)));
    const fixture = context(request); fixture.controller.setAvailable(true); fixture.controller.toggle(); await settle();
    const preventDefault = vi.fn();
    fixture.elements.get('[data-compare-chart]').listeners.keydown({ ...selectEvent(), key: 'Enter', preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce(); expect(request).toHaveBeenCalledTimes(2);
    fixture.elements.get('[data-compare-detail-close]').listeners.click(); resolves[0](detailsPayload()); await settle();
    expect(fixture.elements.get('[data-compare-detail]').hidden).toBe(true);
    expect(fixture.elements.get('[data-compare-detail-body]').innerHTML).not.toContain('6K01N00052');
    fixture.elements.get('[data-compare-chart]').listeners.keydown({ ...selectEvent(), key: ' ', preventDefault });
    fixture.controller.syncFilters({ startDate: '2026-08-01', endDate: '2026-08-10' }); resolves[1](detailsPayload()); await settle();
    expect(fixture.elements.get('[data-compare-detail]').hidden).toBe(true);
    expect(fixture.elements.get('[data-compare-summary]').innerHTML).toBe('');
  });

  it('keeps detail errors local, supports retry, and escapes staged fields', async () => {
    const request = vi.fn().mockResolvedValueOnce(payload()).mockRejectedValueOnce(new Error('<missing staging>')).mockResolvedValueOnce(detailsPayload({ selection: { label: '<bad>' }, groups: [{ group: '<bad>', currentQty: 1, compareQty: 2, currentRate: 1, compareRate: 2, deltaRate: -1 }], lots: { current: { total: 1, rows: [{ lotNo: '<img>', line: '<line>', groups: [] }] }, compare: { total: 0, rows: [] } } }));
    const fixture = context(request); fixture.controller.setAvailable(true); fixture.controller.toggle(); await settle();
    fixture.elements.get('[data-compare-chart]').listeners.click(selectEvent()); await settle();
    expect(fixture.elements.get('[data-compare-detail-body]').innerHTML).toContain('&lt;missing staging&gt;');
    expect(fixture.elements.get('[data-compare-chart]').innerHTML).toContain('<svg');
    fixture.elements.get('[data-compare-detail-retry]').listeners.click(); await settle();
    const body = fixture.elements.get('[data-compare-detail-body]').innerHTML;
    expect(body).toContain('&lt;img&gt;'); expect(body).not.toContain('<img>');
  });

  it('focuses the investigation heading, restores its initiating control, and Escape closes detail first', async () => {
    const fixture = context(vi.fn().mockResolvedValueOnce(payload()).mockResolvedValue(detailsPayload()));
    fixture.controller.setAvailable(true); fixture.controller.toggle(); await settle();
    const origin = element(); origin.isConnected = true; origin.dataset.compareIndex = '0';
    fixture.elements.get('[data-compare-chart]').listeners.click({ target: { closest: () => origin } });
    expect(fixture.elements.get('[data-compare-detail-heading]').focus).toHaveBeenCalledOnce();
    await settle();
    expect(fixture.elements.get('[data-compare-status]').textContent).toContain('LOOKUP loaded');
    const stopPropagation = vi.fn();
    fixture.elements.get('panel').listeners.keydown({ key: 'Escape', stopPropagation });
    expect(fixture.controller.enabled).toBe(true);
    expect(origin.focus).toHaveBeenCalledOnce();
    expect(fixture.elements.get('[data-compare-detail]').hidden).toBe(true);
    fixture.elements.get('panel').listeners.keydown({ key: 'Escape', stopPropagation });
    expect(fixture.controller.enabled).toBe(false);
    expect(stopPropagation).toHaveBeenCalledTimes(2);
  });

  it('rejects pending details after period mode, source generation, main Apply and panel close', async () => {
    for (const invalidation of ['mode', 'source', 'apply', 'close']) {
      let resolve;
      const request = vi.fn().mockResolvedValueOnce(payload()).mockImplementation((url) => url.startsWith('/api/ta-yield-compare-details')
        ? new Promise((done) => { resolve = done; }) : Promise.resolve(payload()));
      const fixture = context(request); fixture.controller.setAvailable(true); fixture.controller.toggle(); await settle();
      fixture.elements.get('[data-compare-chart]').listeners.click(selectEvent());
      if (invalidation === 'mode') { const mode = fixture.elements.get('[data-compare-mode]'); mode.value = 'full-month'; mode.listeners.change(); }
      if (invalidation === 'source') fixture.controller.refresh({ dataMode: 'staging:5' });
      if (invalidation === 'apply') fixture.elements.get('[data-compare-apply]').listeners.click();
      if (invalidation === 'close') fixture.elements.get('[data-compare-close]').listeners.click();
      resolve(detailsPayload()); await settle();
      expect(fixture.elements.get('[data-compare-detail]').hidden).toBe(true);
      expect(fixture.elements.get('[data-compare-detail-body]').innerHTML).not.toContain('6K01N00052');
    }
  });

  it('uses N/A for missing volumes and rates, handles empty evidence and disables final-page navigation', async () => {
    const data = detailsPayload({ current: { lotCount: 3 }, compare: { lotCount: 0 },
      groups: [{ group: 'Crack', currentQty: 0, compareQty: 0, currentRate: null, compareRate: null, deltaRate: null }],
      lots: { current: { total: 0, rows: [] }, compare: { total: 0, rows: [] } } });
    const fixture = context(vi.fn().mockResolvedValueOnce(payload()).mockResolvedValue(data));
    fixture.controller.setAvailable(true); fixture.controller.toggle(); await settle();
    expect(fixture.elements.get('[data-compare-summary]').innerHTML).toContain('N/A');
    fixture.elements.get('[data-compare-summary]').listeners.click(selectEvent()); await settle();
    const body = fixture.elements.get('[data-compare-detail-body]').innerHTML;
    expect(body).toContain('3 distinct lotNo jobs'); expect(body).toContain('0–0 of 0 affected job records');
    expect(body).toContain('>N/A</td>');
    expect(fixture.elements.get('[data-compare-detail-previous]').disabled).toBe(true);
    expect(fixture.elements.get('[data-compare-detail-next]').disabled).toBe(true);
  });

  it('uses canonical group keys and replaces a pending selection without painting its stale jobs', async () => {
    const resolves = [];
    const request = vi.fn().mockResolvedValueOnce(payload({ rows: [{ label: 'FPS', kind: 'group', key: 'FPS' }, { label: 'FPS A3 alternate', kind: 'series', key: 'FPS SERIES A3 ALT' }] }))
      .mockImplementation(() => new Promise((done) => resolves.push(done)));
    const fixture = context(request); fixture.controller.setAvailable(true); fixture.controller.toggle(); await settle();
    fixture.elements.get('[data-compare-chart]').listeners.click(selectEvent(0));
    fixture.elements.get('[data-compare-chart]').listeners.click(selectEvent(1));
    expect(new URLSearchParams(request.mock.calls[1][0].split('?')[1]).get('kind')).toBe('group');
    expect(new URLSearchParams(request.mock.calls[2][0].split('?')[1]).get('key')).toBe('FPS SERIES A3 ALT');
    resolves[1](detailsPayload({ lots: { current: { total: 0, rows: [] }, compare: { total: 0, rows: [] } } })); await settle();
    resolves[0](detailsPayload()); await settle();
    expect(fixture.elements.get('[data-compare-detail-heading]').textContent).toBe('LOOKUP FPS A3 alternate');
    expect(fixture.elements.get('[data-compare-detail-body]').innerHTML).not.toContain('6K01N00052');
  });
});

describe('TA yield comparison chart', () => {
  it('defaults to the previous Bangkok calendar month, including January rollover', () => {
    const { globals } = context();
    expect(globals.taYieldCompareMonths(new Date('2026-01-01T00:00:00+07:00'))).toEqual({ current: '2026-01', previous: '2025-12' });
    expect(globals.taYieldCompareMonths(new Date('2026-09-30T18:00:00Z'))).toEqual({ current: '2026-10', previous: '2026-09' });
  });

  it('renders green improvements, red declines, neutral zero, and missing yields as N/A', () => {
    const { globals } = context();
    const chart = globals.taYieldCompareChart([
      { label: 'FPS A08', currentYield: 95, compareYield: 90, delta: 5.31 },
      { label: 'GPS', currentYield: 90, compareYield: 91, delta: -1.49 },
      { label: 'STD', currentYield: 90, compareYield: 90, delta: 0 },
      { label: 'PSL', currentYield: null, compareYield: 90, delta: null }
    ], escapeHtml);
    expect(chart).toContain('fill="#008a3e"');
    expect(chart).toContain('fill="#d32f2f"');
    expect(chart).toContain('(1.49)');
    expect(chart).toContain('>0.00</text>');
    expect(chart).toContain('>N/A</text>');
    expect(chart).toContain('Report dates unavailable (Report dates): 95.00%');
    expect(chart).toContain('Compare dates unavailable (Compare with): 90.00%');
    expect(chart).toContain('tabindex="0"');
    expect(chart).toContain('class="ta-compare-zero"');
    expect(chart).toContain('rotate(-90');
  });

  it('escapes labels and tooltip attributes and never draws a null delta as zero', () => {
    const { globals } = context();
    const chart = globals.taYieldCompareChart([{ label: '<img "bad">', currentYield: 1, compareYield: null, delta: null }], escapeHtml);
    expect(chart).not.toContain('<img');
    expect(chart).toContain('&lt;img &quot;bad&quot;&gt;');
    expect(chart).toContain('Change: N/A');
    expect(chart).not.toMatch(/class="ta-compare-value"[^>]*>0\.00<\/text>/);
    expect(chart).not.toContain('stroke-width="3"');
  });

  it('uses a signed scale that covers all bars and a nonzero range for empty and zero data', () => {
    const { globals } = context();
    expect(globals.taYieldCompareScale([-5.11, 6.23])).toEqual({ min: -6, max: 8, step: 2 });
    expect(globals.taYieldCompareScale([0, null])).toEqual({ min: -1, max: 1, step: 0.5 });
  });
});

describe('TA Compare floating window', () => {
  it('reads Report dates on opening even without a previous refresh', () => {
    const fixture = context(undefined, { getFilters: () => ({ startDate: '2026-08-05', endDate: '2026-08-20' }) });
    fixture.controller.setAvailable(true);
    fixture.controller.toggle();
    expect(fixture.elements.get('[data-compare-current]').textContent).toBe('2026-08-05 to 2026-08-20');
    expect(fixture.elements.get('[data-compare-month]').value).toBe('2026-07');
    const params = new URLSearchParams(fixture.request.mock.calls[0][0].split('?')[1]);
    expect(params.get('startDate')).toBe('2026-08-05');
  });

  it('syncs selected Report dates immediately without fetching and rejects the old pending result', async () => {
    let resolve;
    const fixture = context(vi.fn(() => new Promise((done) => { resolve = done; })));
    fixture.controller.setAvailable(true);
    fixture.controller.refresh({ startDate: '2026-09-01', endDate: '2026-09-30' });
    fixture.controller.toggle();
    fixture.controller.syncFilters({ startDate: '2026-08-05', endDate: '2026-08-20' });
    expect(fixture.request).toHaveBeenCalledTimes(1);
    expect(fixture.elements.get('[data-compare-current]').textContent).toBe('2026-08-05 to 2026-08-20');
    expect(fixture.elements.get('[data-compare-month]').value).toBe('2026-07');
    expect(fixture.elements.get('[data-compare-chart]').innerHTML).toContain('Select Apply');
    resolve(payload());
    await settle();
    expect(fixture.elements.get('[data-compare-current]').textContent).toBe('2026-08-05 to 2026-08-20');
    fixture.controller.syncFilters({ startDate: '2026-08-05', endDate: '2026-08-20' });
    expect(fixture.request).toHaveBeenCalledTimes(1);
  });

  it('preserves a deliberately selected comparison month during Report date synchronization', () => {
    const fixture = context();
    fixture.controller.setAvailable(true);
    fixture.controller.refresh({ startDate: '2026-09-01', endDate: '2026-09-30' });
    fixture.controller.toggle();
    const month = fixture.elements.get('[data-compare-month]');
    month.value = '2026-06';
    month.listeners.input();
    fixture.controller.syncFilters({ startDate: '2026-08-05', endDate: '2026-08-20' });
    expect(month.value).toBe('2026-06');
    expect(fixture.elements.get('[data-compare-current]').textContent).toBe('2026-08-05 to 2026-08-20');
    expect(fixture.request).toHaveBeenCalledTimes(1);
  });

  it('leaves a finished chart intact when the Report selection has not changed', async () => {
    const range = { startDate: '2026-09-01', endDate: '2026-09-30' };
    const fixture = context(vi.fn().mockResolvedValue(payload({ currentRange: range, compareMonth: '2026-08' })));
    fixture.controller.setAvailable(true);
    fixture.controller.refresh(range);
    fixture.controller.toggle();
    await settle();
    const chart = fixture.elements.get('[data-compare-chart]').innerHTML;
    fixture.controller.syncFilters(range);
    expect(fixture.elements.get('[data-compare-chart]').innerHTML).toBe(chart);
    expect(chart).toContain('<svg');
    expect(fixture.request).toHaveBeenCalledTimes(1);
  });

  it('defaults January Report dates to December of the preceding year', () => {
    const fixture = context(undefined, { getFilters: () => ({ startDate: '2026-01-05', endDate: '2026-01-20' }) });
    fixture.controller.setAvailable(true);
    fixture.controller.toggle();
    expect(fixture.elements.get('[data-compare-month]').value).toBe('2025-12');
    expect(fixture.elements.get('[data-compare-current]').textContent).toBe('2026-01-05 to 2026-01-20');
  });

  it('reads newly selected Report controls dates when Compare Apply is clicked', async () => {
    let selectedRange = { startDate: '2026-09-01', endDate: '2026-09-15' };
    const fixture = context(undefined, { getFilters: () => selectedRange });
    fixture.controller.setAvailable(true);
    fixture.controller.refresh(selectedRange);
    fixture.controller.toggle();
    await settle();
    selectedRange = { startDate: '2026-08-05', endDate: '2026-08-20' };
    fixture.elements.get('[data-compare-apply]').listeners.click();
    const params = new URLSearchParams(fixture.request.mock.calls.at(-1)[0].split('?')[1]);
    expect(params.get('startDate')).toBe('2026-08-05');
    expect(params.get('endDate')).toBe('2026-08-20');
    expect(params.get('compareMonth')).toBe('2026-07');
    await settle();
  });

  it('uses the exact report range and defaults comparison to the preceding report month', async () => {
    const fixture = context();
    fixture.controller.setAvailable(true);
    fixture.controller.refresh({ startDate: '2026-09-05', endDate: '2026-09-20' });
    fixture.controller.toggle();
    const params = new URLSearchParams(fixture.request.mock.calls[0][0].split('?')[1]);
    expect(params.get('startDate')).toBe('2026-09-05');
    expect(params.get('endDate')).toBe('2026-09-20');
    expect(params.get('compareMonth')).toBe('2026-08');
    expect(fixture.elements.get('[data-compare-current]').textContent).toBe('2026-09-05 to 2026-09-20');
    await settle();
  });

  it('refreshes when report dates change, follows their default, and preserves an explicit comparison month', async () => {
    const fixture = context();
    fixture.controller.setAvailable(true);
    fixture.controller.refresh({ startDate: '2026-09-01', endDate: '2026-09-15' });
    fixture.controller.toggle();
    await settle();
    fixture.controller.refresh({ startDate: '2026-08-03', endDate: '2026-08-12' });
    expect(fixture.request).toHaveBeenCalledTimes(2);
    expect(fixture.elements.get('[data-compare-month]').value).toBe('2026-07');
    const month = fixture.elements.get('[data-compare-month]');
    month.value = '2026-06';
    month.listeners.input();
    fixture.elements.get('[data-compare-apply]').listeners.click();
    await settle();
    fixture.controller.refresh({ startDate: '2026-07-01', endDate: '2026-07-15' });
    expect(month.value).toBe('2026-06');
    const params = new URLSearchParams(fixture.request.mock.calls.at(-1)[0].split('?')[1]);
    expect(params.get('startDate')).toBe('2026-07-01');
    expect(params.get('endDate')).toBe('2026-07-15');
  });

  it('opens lazily, reuses eight-edge resize binding, and reflects its available dataset', async () => {
    const fixture = context();
    expect(fixture.controller.enabled).toBe(false);
    fixture.controller.setAvailable(true);
    fixture.controller.refresh({ product: 'NEO', serie: ['FPS'], pn: ['PN 1'] });
    expect(fixture.request).not.toHaveBeenCalled();
    fixture.controller.toggle();
    await settle();
    expect(fixture.controller.enabled).toBe(true);
    expect(fixture.toggleButton.textContent).toBe('Compare: On');
    expect(fixture.elements.get('[data-compare-month]').attributes.min).toBe('1900-01');
    expect(fixture.elements.get('[data-compare-month]').attributes.max).toBe(fixture.globals.taYieldCompareMonths().current);
    expect(fixture.bindResize).toHaveBeenCalledWith(fixture.elements.get('panel'), 'Compare');
    const params = new URLSearchParams(fixture.request.mock.calls[0][0].split('?')[1]);
    expect(params.get('dataset')).toBe('ta-yield');
    expect(params.get('product')).toBe('NEO');
    expect(params.getAll('serie')).toEqual(['FPS']);
    expect(params.getAll('pn')).toEqual(['PN 1']);
    fixture.controller.setAvailable(false);
    expect(fixture.elements.get('panel').hidden).toBe(true);
    expect(fixture.toggleButton.hidden).toBe(true);
    expect(fixture.controller.enabled).toBe(false);
  });

  it('coalesces refreshes and shows only the newest request when selected filters change', async () => {
    const resolves = [];
    const request = vi.fn(() => new Promise((resolve) => resolves.push(resolve)));
    const { controller, elements } = context(request);
    controller.setAvailable(true);
    controller.toggle();
    controller.refresh({});
    expect(request).toHaveBeenCalledTimes(1);
    controller.refresh({ serie: ['FPS'] });
    expect(request).toHaveBeenCalledTimes(2);
    resolves[1](payload({ rows: [{ label: 'LATEST', delta: 1, currentYield: 91, compareYield: 90 }] }));
    await settle();
    resolves[0](payload({ rows: [{ label: 'OLD', delta: -1, currentYield: 89, compareYield: 90 }] }));
    await settle();
    expect(elements.get('[data-compare-chart]').innerHTML).toContain('LATEST');
    expect(elements.get('[data-compare-chart]').innerHTML).not.toContain('OLD');
    controller.refresh({ serie: ['FPS'] });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('invalidates pending work on close, returns focus, and reloads on reopening', async () => {
    let resolve;
    const fixture = context(vi.fn(() => new Promise((done) => { resolve = done; })));
    fixture.controller.setAvailable(true);
    fixture.controller.toggle();
    fixture.elements.get('[data-compare-close]').listeners.click();
    resolve(payload());
    await settle();
    expect(fixture.elements.get('panel').hidden).toBe(true);
    expect(fixture.elements.get('[data-compare-chart]').innerHTML).not.toContain('<svg');
    expect(fixture.toggleButton.focus).toHaveBeenCalledOnce();
    fixture.controller.toggle();
    expect(fixture.request).toHaveBeenCalledTimes(2);
  });

  it('invalidates the old month before Apply and compares the newly selected month', async () => {
    const resolves = [];
    const fixture = context(vi.fn(() => new Promise((resolve) => resolves.push(resolve))));
    fixture.controller.setAvailable(true);
    fixture.controller.toggle();
    const month = fixture.elements.get('[data-compare-month]');
    month.value = '2026-08';
    month.listeners.input();
    resolves[0](payload());
    await settle();
    expect(fixture.elements.get('[data-compare-chart]').innerHTML).toContain('Select Apply');
    fixture.elements.get('[data-compare-apply]').listeners.click();
    expect(new URLSearchParams(fixture.request.mock.calls[1][0].split('?')[1]).get('compareMonth')).toBe('2026-08');
  });

  it('refreshes when source mode changes while treating reordered selections as identical', async () => {
    const fixture = context();
    fixture.controller.setAvailable(true);
    fixture.controller.refresh({ dataMode: 'staging', serie: ['GPS', 'FPS'] });
    fixture.controller.toggle();
    await settle();
    fixture.controller.refresh({ dataMode: 'staging', serie: ['FPS', 'GPS'] });
    expect(fixture.request).toHaveBeenCalledTimes(1);
    fixture.controller.refresh({ dataMode: 'live', serie: ['FPS', 'GPS'] });
    await settle();
    expect(fixture.request).toHaveBeenCalledTimes(2);
  });

  it('can force a fresh comparison after a dashboard data refresh', async () => {
    const fixture = context();
    fixture.controller.setAvailable(true);
    fixture.controller.toggle();
    await settle();
    fixture.controller.refresh({}, true);
    await settle();
    expect(fixture.request).toHaveBeenCalledTimes(2);
  });

  it('leaves space for disambiguated series labels below negative values', () => {
    const { globals } = context();
    const chart = globals.taYieldCompareChart([{ label: 'FPS A08 (alternate production)', delta: -1, currentYield: 90, compareYield: 91 }], escapeHtml);
    const height = Number(chart.match(/viewBox="0 0 \d+ (\d+)"/)[1]);
    expect(height - 325).toBeGreaterThan(200);
  });

  it('bounds visible fallback labels while retaining full comparison details', () => {
    const { globals } = context();
    const label = 'Unusually long series name with additional case size details';
    const chart = globals.taYieldCompareChart([{ label, delta: -1, currentYield: 90, compareYield: 91 }], escapeHtml);
    expect(chart).toContain(`${label} | Report dates unavailable (Report dates):`);
    expect(chart).toMatch(/class="ta-compare-label"[^>]*>Unusually long series name wi…<\/text>/);
  });

  it('rejects an invalid month without sending a request and permits fixing it', () => {
    const fixture = context();
    fixture.controller.setAvailable(true);
    fixture.controller.toggle();
    fixture.elements.get('[data-compare-month]').value = '2026-13';
    fixture.elements.get('[data-compare-apply]').listeners.click();
    expect(fixture.request).toHaveBeenCalledTimes(1);
    expect(fixture.elements.get('[data-compare-chart]').innerHTML).toContain('Choose a valid comparison month');
    expect(fixture.elements.get('[data-compare-apply]').disabled).toBe(false);
    fixture.elements.get('[data-compare-month]').value = '2026-08';
    fixture.elements.get('[data-compare-apply]').listeners.click();
    expect(fixture.request).toHaveBeenCalledTimes(2);
  });

  it('drags only from the header and stops after pointer cancellation', () => {
    const fixture = context();
    fixture.controller.setAvailable(true);
    fixture.controller.toggle();
    const panel = fixture.elements.get('panel');
    const header = fixture.elements.get('[data-compare-drag]');
    const event = { button: 0, pointerId: 1, clientX: 150, clientY: 150, target: { closest: () => null }, preventDefault: vi.fn() };
    header.listeners.pointerdown(event);
    header.listeners.pointermove({ ...event, clientX: 250, clientY: 210 });
    expect(panel.style).toMatchObject({ left: '200px', top: '160px' });
    header.listeners.pointercancel(event);
    header.listeners.pointermove({ ...event, clientX: 500 });
    expect(panel.style.left).toBe('200px');
    header.listeners.pointerdown({ ...event, target: { closest: () => ({}) } });
    header.listeners.pointermove({ ...event, clientX: 350 });
    expect(panel.style.left).toBe('200px');
    expect(header.setPointerCapture).toHaveBeenCalledOnce();
    expect(header.releasePointerCapture).toHaveBeenCalledOnce();
  });

  it('shows the same comparison details for pointer and keyboard focus', async () => {
    const fixture = context();
    fixture.controller.setAvailable(true);
    fixture.controller.toggle();
    const bar = element();
    bar.dataset.compareTooltip = 'FPS A08 | 1 Oct 2026 (Report dates): 95.00% | 1–30 Sep 2026 (Compare with): 90.00% | Change: 5.00 percentage points';
    fixture.elements.get('[data-compare-chart]').querySelectorAll = () => [bar];
    await settle();
    const tooltip = fixture.elements.get('[data-compare-tooltip]');
    bar.listeners.focus();
    expect(tooltip.hidden).toBe(false);
    expect(tooltip.textContent).toContain('1 Oct 2026 (Report dates): 95.00%');
    bar.listeners.blur();
    expect(tooltip.hidden).toBe(true);
    bar.listeners.pointerenter();
    expect(tooltip.hidden).toBe(false);
    const stopPropagation = vi.fn();
    bar.listeners.keydown({ key: 'Escape', stopPropagation });
    expect(tooltip.hidden).toBe(true);
    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it('shows request errors, escapes them, and Apply retries the same month', async () => {
    const fixture = context(vi.fn().mockRejectedValueOnce(new Error('<failed>')).mockResolvedValueOnce(payload()));
    fixture.controller.setAvailable(true);
    fixture.controller.toggle();
    await settle();
    expect(fixture.elements.get('[data-compare-chart]').innerHTML).toContain('&lt;failed&gt;');
    expect(fixture.elements.get('[data-compare-apply]').disabled).toBe(false);
    fixture.elements.get('[data-compare-apply]').listeners.click();
    await settle();
    expect(fixture.request).toHaveBeenCalledTimes(2);
    expect(fixture.elements.get('[data-compare-chart]').innerHTML).toContain('<svg');
    expect(fixture.elements.get('[data-compare-scope]').textContent).toContain('2026-10-01');
    expect(fixture.elements.get('[data-compare-scope]').textContent).toContain('2026-09-30');
  });

  it('minimizes and maximizes independently and restores the original bounds', () => {
    const { controller, elements } = context();
    controller.setAvailable(true);
    controller.toggle();
    const panel = elements.get('panel');
    elements.get('[data-compare-minimize]').listeners.click();
    expect(panel.classList.contains('is-minimized')).toBe(true);
    elements.get('[data-compare-minimize]').listeners.click();
    expect(panel.classList.contains('is-minimized')).toBe(false);
    elements.get('[data-compare-maximize]').listeners.click();
    expect(panel.classList.contains('is-maximized')).toBe(true);
    elements.get('[data-compare-maximize]').listeners.click();
    expect(panel.classList.contains('is-maximized')).toBe(false);
    expect(panel.style).toMatchObject({ left: '100px', top: '100px', width: '1000px', height: '620px' });
  });

  it('redraws at the resized chart width without refetching data', async () => {
    const fixture = context();
    let resize;
    const observe = vi.fn();
    fixture.globals.ResizeObserver = class { constructor(callback) { resize = callback; } observe = observe; };
    fixture.controller.setAvailable(true);
    fixture.controller.toggle();
    await settle();
    const chart = fixture.elements.get('[data-compare-chart]');
    expect(observe).toHaveBeenCalledWith(chart);
    const focusedBar = { dataset: { compareIndex: '0' } };
    const replacementBar = element();
    fixture.globals.document.activeElement = focusedBar;
    chart.contains = (node) => node === focusedBar;
    chart.querySelector = () => replacementBar;
    chart.getBoundingClientRect = () => ({ width: 1600 });
    resize();
    expect(chart.innerHTML).toMatch(/viewBox="0 0 1600 \d+"/);
    expect(replacementBar.focus).toHaveBeenCalledOnce();
    expect(fixture.request).toHaveBeenCalledTimes(1);
    const markup = chart.innerHTML;
    resize();
    expect(chart.innerHTML).toBe(markup);
    fixture.controller.syncFilters({ startDate: '2026-08-01', endDate: '2026-08-03' });
    resize();
    expect(chart.innerHTML).toContain('Select Apply');
  });

  it('resizes only LOOKUP graph hosts while preserving tables, scrolling and cached periods', async () => {
    const request = vi.fn().mockResolvedValueOnce(payload()).mockResolvedValue(detailsPayload());
    const fixture = context(request);
    let resize;
    fixture.globals.ResizeObserver = class { constructor(callback) { resize = callback; } observe() {} };
    fixture.controller.setAvailable(true);
    fixture.controller.toggle();
    await settle();
    const body = fixture.elements.get('[data-compare-detail-body]');
    const rate = element(); const change = element();
    rate.clientWidth = 1000; change.clientWidth = 1000;
    rate.scrollTop = 72; change.scrollTop = 38;
    body.querySelector = (selector) => selector.includes('rate-chart') ? rate : change;
    fixture.elements.get('[data-compare-chart]').listeners.click(selectEvent());
    await settle();
    expect(rate.innerHTML).toContain('viewBox="0 0 1000 ');
    expect(rate.innerHTML).toContain('5–20 Sep 2026');
    const tables = body.innerHTML;
    rate.clientWidth = 650; change.clientWidth = 650;
    resize();
    expect(rate.innerHTML).toContain('viewBox="0 0 650 ');
    expect(change.innerHTML).toContain('viewBox="0 0 650 ');
    expect(body.innerHTML).toBe(tables);
    expect(rate.scrollTop).toBe(72); expect(change.scrollTop).toBe(38);
    expect(request).toHaveBeenCalledTimes(2);
    fixture.elements.get('[data-compare-detail-close]').listeners.click();
    const lastChart = rate.innerHTML;
    rate.clientWidth = 1300;
    resize();
    expect(rate.innerHTML).toBe(lastChart);
    expect(body.innerHTML).toBe('');
  });
});
