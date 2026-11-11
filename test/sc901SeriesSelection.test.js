import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function declaration(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  if (!match) return '';
  const lineEnd = source.indexOf('\n', match.index);
  const firstLine = source.slice(match.index, lineEnd).trimEnd();
  return firstLine.endsWith('}') ? firstLine : source.slice(match.index, source.indexOf('\n}', match.index) + 2);
}

function element(tag = 'div') {
  const classes = new Set();
  const attributes = {};
  return {
    tagName: tag.toUpperCase(), children: [], handlers: {}, value: '', hidden: false,
    disabled: false, checked: false, selected: false, dataset: {}, textContent: '', innerHTML: '',
    classList: {
      toggle(name, active) { if (active) classes.add(name); else classes.delete(name); },
      add(name) { classes.add(name); }, remove(name) { classes.delete(name); },
      contains: (name) => classes.has(name),
    },
    setAttribute(name, value) { attributes[name] = String(value); },
    getAttribute(name) { return attributes[name] ?? null; },
    removeAttribute(name) { delete attributes[name]; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    add(option) { this.children.push(option); },
    get options() { return this.children; },
    get selectedOptions() { return this.children.filter((child) => child.selected); },
    addEventListener(name, handler) { this.handlers[name] = handler; },
    closest() { return this.field; },
    querySelectorAll(selector) {
      return this.children.flatMap((child) => [
        ...(selector === 'input' && child.tagName === 'INPUT' ? [child] : []),
        ...(child.querySelectorAll ? child.querySelectorAll(selector) : []),
      ]);
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    focus: vi.fn(),
  };
}

function harness({ product = 'SC', dataset = 'closed' } = {}) {
  const elements = new Map();
  const field = element('label');
  const get = (id) => {
    if (!elements.has(id)) {
      const node = element(id === 'serie' ? 'select' : 'div');
      node.field = field;
      elements.set(id, node);
    }
    return elements.get(id);
  };
  get('product').value = product;
  get('startDate').value = '2026-11-05';
  get('endDate').value = '2026-11-10';
  const setting = (target, period = '2026-11') => ({ periods: { [period]: { target, workingDay: 20 } } });
  const settings = { SC: { CAN: setting(2000), Element: setting(4000), FC: setting(6000), FM: setting(8000), 'Target only': setting(10000), Future: setting(12000, '2026-12') } };
  const context = vm.createContext({
    Set, Map, Object, Array, Number, Math, String, URLSearchParams, Promise,
    Option: function Option(text, value, _defaultSelected, selected = false) {
      return { ...element('option'), text, value, selected };
    },
    document: {
      createElement: element, createTextNode: (text) => ({ textContent: text }),
      querySelector: (selector) => selector === '.serie-field' ? field : null,
      querySelectorAll: () => [], getElementById: get,
    },
    byId: get, ids: ['process', 'serie', 'case', 'pn'],
    selectedDataset: () => context.currentConfig.dataset,
    currentConfig: { dataset, chartAxis: 'date', filters: { serie: true } },
    readTargetSettings: () => settings,
    selectedReportingPeriod: () => '2026-11',
    setSelectedProcess: (value) => { get('process').value = value; },
    refreshOptionsForSerie: vi.fn(), updateReportPendingNotice: vi.fn(),
    resetPartNumbers: vi.fn(), setStatus: vi.fn(),
    renderMtdGauge: vi.fn(), renderMtdChart: vi.fn(),
    escapeHtml: (value) => String(value), format: new Intl.NumberFormat('en-US'),
    selectedPartNumbers: () => [], updateTaYieldCompare: vi.fn(),
    setReportControlsLoading: vi.fn(), markReportControlsApplied: vi.fn(),
    loadCellComments: async () => undefined, request: vi.fn(async () => []), renderData: vi.fn(),
  });
  const names = ['usesScCompletionSeries', 'syncSerieFilterVisibility', 'selectedSeries',
    'updateSerieTrigger', 'serieFamily', 'seriePickerOption', 'renderSeriePicker',
    'selectAllCompletionSeries', 'populateOptions', 'setFilterAvailability',
    'mtdTargetProduct', 'targetSetting', 'savedSeriesForPeriod', 'mtdPlan', 'renderMtd'];
  vm.runInContext(names.map(declaration).filter(Boolean).join('\n'), context);
  vm.runInContext('let dataRequestId = 0, dashboardDataModeGeneration = 0, scYieldTendencyRequestId = 0; let taYieldDailyOutputScope, taYieldDailyOutputRequest, taYieldLotDetailsRequest, latestTaYieldLotsUrl, latestTaYieldLotsRequestId;', context);
  vm.runInContext(declaration('loadData'), context);
  return { context, get, field, settings };
}

const sourceSeries = ['CAN', 'Element', 'FC', 'FM'];
function populate(ui, selection) {
  ui.context.populateOptions({ serie: sourceSeries }, selection ? { serie: selection } : {});
}
function checkbox(ui, name) {
  const label = ui.get('serieOptions').children.find((node) => node.children.some((child) => child.textContent === name));
  expect(label, `Missing series checkbox: ${name}`).toBeDefined();
  return label.children.find((node) => node.tagName === 'INPUT');
}
function toggle(ui, name, checked) {
  const input = checkbox(ui, name);
  input.checked = checked;
  input.handlers.change({ target: input });
}

describe('Completion 901 SC series selection', () => {
  it('starts with all MES and saved-target series included, including target-only and future-period series', () => {
    const ui = harness();
    populate(ui);
    expect([...ui.context.selectedSeries()].sort()).toEqual([...sourceSeries, 'Target only', 'Future'].sort());
    for (const name of [...sourceSeries, 'Target only', 'Future']) expect(checkbox(ui, name).checked).toBe(true);
  });

  it.each([
    ['closed', 'SC', true], ['closed', 'NEO', false], ['lot', 'SC', false], ['yield', 'SC', false], ['ta-yield', 'NEO', false],
  ])('exposes the control only for dataset %s and product %s', (dataset, product, visible) => {
    const ui = harness({ dataset, product });
    ui.context.setFilterAvailability({ serie: true });
    expect(typeof ui.context.syncSerieFilterVisibility).toBe('function');
    ui.context.syncSerieFilterVisibility();
    expect(ui.field.hidden).toBe(!visible);
    expect(ui.field.getAttribute('aria-hidden')).toBe(String(!visible));
  });

  it('does not expose the control when the configured series filter is unavailable', () => {
    const ui = harness();
    ui.context.currentConfig.filters.serie = false;
    ui.context.setFilterAvailability({ serie: false });
    expect(typeof ui.context.syncSerieFilterVisibility).toBe('function');
    ui.context.syncSerieFilterVisibility();
    expect(ui.field.hidden).toBe(true);
    expect(ui.get('serieTrigger').disabled).toBe(true);
  });

  it('removes and restores a series from the included values without changing saved targets', () => {
    const ui = harness();
    populate(ui);
    const original = JSON.stringify(ui.settings);
    toggle(ui, 'CAN', false);
    expect([...ui.context.selectedSeries()]).not.toContain('CAN');
    toggle(ui, 'CAN', true);
    expect([...ui.context.selectedSeries()]).toContain('CAN');
    expect(JSON.stringify(ui.settings)).toBe(original);
  });

  it('keeps the last included series selected instead of treating an empty list as all series', () => {
    const ui = harness();
    populate(ui, ['FC']);
    expect(checkbox(ui, 'FC').disabled).toBe(true);
    toggle(ui, 'FC', false); // Also protects synthetic change events.
    expect([...ui.context.selectedSeries()]).toEqual(['FC']);
  });

  it('restores all series with the select-all action', () => {
    const ui = harness();
    populate(ui, ['FC']);
    expect(typeof ui.context.selectAllCompletionSeries).toBe('function');
    ui.context.selectAllCompletionSeries();
    expect([...ui.context.selectedSeries()].sort()).toEqual([...sourceSeries, 'Target only', 'Future'].sort());
  });

  it('does not carry SC selections or target-only options into the NEO product', () => {
    const ui = harness();
    populate(ui, ['FC']);
    ui.get('product').value = 'NEO';
    ui.context.populateOptions({ serie: ['FPS A2', 'FPS B3'] });
    expect([...ui.context.selectedSeries()]).toEqual([]);
    expect(ui.get('serie').options.map((option) => option.value)).toEqual(['FPS A2', 'FPS B3']);
    ui.get('product').value = 'SC';
    populate(ui);
    expect([...ui.context.selectedSeries()]).toContain('CAN');
  });

  it('preserves an explicit SC selection when options are rebuilt in the same scope', () => {
    const ui = harness();
    populate(ui, ['FC', 'FM']);
    ui.context.populateOptions({ serie: sourceSeries }, { serie: ui.context.selectedSeries() });
    expect([...ui.context.selectedSeries()].sort()).toEqual(['FC', 'FM']);
  });

  it('excludes both actuals and target plans from every MTD view and restores them when re-included', () => {
    const ui = harness();
    populate(ui);
    const data = [{ itemName: 'CAN', quantityMoved: 100 }, { itemName: 'FC', quantityMoved: 300 }, { itemName: 'FM', quantityMoved: 400 }];
    toggle(ui, 'CAN', false);
    toggle(ui, 'Target only', false);
    ui.context.renderMtd(data);
    const entries = ui.context.renderMtdGauge.mock.calls.at(-1)[0];
    expect(entries.map((entry) => entry.serie)).not.toContain('CAN');
    expect(entries.map((entry) => entry.serie)).not.toContain('Target only');
    expect(entries.reduce((sum, entry) => sum + entry.actual, 0)).toBe(700);
    expect(entries.reduce((sum, entry) => sum + entry.monthlyPlan, 0)).toBe(18000);
    expect(entries.reduce((sum, entry) => sum + entry.mtdTarget, 0)).toBe(9000);
    expect(ui.context.renderMtdChart.mock.calls.at(-1)[0]).toEqual(entries);
    expect(ui.get('mtdRows').innerHTML).not.toContain('<td>CAN</td>');
    toggle(ui, 'CAN', true);
    toggle(ui, 'Target only', true);
    ui.context.renderMtd(data);
    const restored = ui.context.renderMtdGauge.mock.calls.at(-1)[0];
    expect(restored.reduce((sum, entry) => sum + entry.actual, 0)).toBe(800);
    expect(restored.reduce((sum, entry) => sum + entry.monthlyPlan, 0)).toBe(30000);
    expect(restored.reduce((sum, entry) => sum + entry.mtdTarget, 0)).toBe(15000);
  });

  it('sends the same included series to output and MTD requests, with month-start dates for MTD', async () => {
    const ui = harness();
    populate(ui, ['FC', 'FM']);
    await ui.context.loadData();
    for (const endpoint of ['/api/quantity?', '/api/mtd-quantity?']) {
      const url = ui.context.request.mock.calls.find(([url]) => url.startsWith(endpoint))?.[0];
      expect(url).toBeDefined();
      const query = new URLSearchParams(url.split('?')[1]);
      expect(query.getAll('serie')).toEqual(['FC', 'FM']);
      expect(query.get('product')).toBe('SC');
      expect(query.get('startDate')).toBe(endpoint.includes('mtd') ? '2026-11-01' : '2026-11-05');
    }
  });
});
