import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const storageKey = 'onemes-dashboard-subtabs-v1';
const options = {
  taTargets: ['current', 'upcoming', 'history'],
  mtdParameters: ['current', 'upcoming', 'history'],
  staging: ['overview', 'map'],
  taActions: ['IN_PROGRESS', 'CLOSED'],
  scActions: ['IN_PROGRESS', 'CLOSED'],
  taTable: ['summary', 'lots'],
  taDetails: ['hidden', 'visible'],
  productionChart: ['stacked', 'grouped', 'line', 'area', 'percent'],
  mtdChart: ['bullet', 'column', 'line', 'area', 'accumulated'],
};
const defaults = Object.fromEntries(Object.entries(options).map(([key, values]) => [key, values[0]]));

function createSubtabs({ stored, storage } = {}) {
  const controls = [
    ['.chart-mode', 'chartMode', 'productionChart'],
    ['.mtd-chart-mode', 'mtdChartStyle', 'mtdChart'],
    ['.ta-yield-table-mode', 'taYieldTable', 'taTable'],
  ];
  const buttons = Object.fromEntries(controls.map(([selector, attribute, key]) => [selector, options[key].map((value) => {
    const activeClasses = new Set(['active']);
    const attributes = {};
    return {
      dataset: { [attribute]: value },
      classList: {
        toggle: (name, active) => active ? activeClasses.add(name) : activeClasses.delete(name),
        contains: (name) => activeClasses.has(name),
      },
      setAttribute: (name, value) => { attributes[name] = String(value); },
      getAttribute: (name) => attributes[name],
    };
  })]));
  const sessionStorage = storage || {
    getItem: vi.fn(() => stored ?? null),
    setItem: vi.fn((_key, value) => { stored = value; }),
  };
  const saveDashboardNavigation = vi.fn();
  const document = { querySelectorAll: vi.fn((selector) => buttons[selector] || []) };
  const start = app.indexOf('const dashboardSubtabOptions');
  const end = app.indexOf('const dashboardNavigationKey', start);
  if (start < 0 || end < 0) throw new Error('Dashboard subtab persistence is not implemented');
  const build = new Function('sessionStorage', 'saveDashboardNavigation', 'document', 'console', `${app.slice(start, end)}\nreturn { readDashboardSubtabs, saveDashboardSubtab, restoreDashboardSubtabControls, getState: () => dashboardSubtabs };`);
  return { ...build(sessionStorage, saveDashboardNavigation, document, { warn: vi.fn() }), sessionStorage, saveDashboardNavigation, buttons };
}

async function renderTargetTabs(initialTab) {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { id, innerHTML: '', attributes: {}, listeners: {},
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, handler) { this.listeners[name] = handler; },
      classList: { toggle: vi.fn() }, focus: vi.fn() });
    return nodes.get(id);
  };
  const tabs = ['current', 'upcoming', 'history'].map((tab) => Object.assign(node(`taYieldTarget${tab[0].toUpperCase()}${tab.slice(1)}Tab`), { dataset: { taYieldTargetTab: tab } }));
  node('parameterView').querySelectorAll = () => tabs;
  const save = vi.fn();
  const targets = [{ serie: 'Facedown', period: '2026-06', target: 89.12 }, { serie: 'Facedown', period: '2026-09', target: 90.86 }];
  const block = app.slice(app.indexOf('function taYieldTargetTimeline'), app.indexOf('function ensureTaWorkbookVerificationView'));
  const render = new Function('byId', 'document', 'request', 'saveDashboardSubtab', 'initialTab', `
    const latestTaYieldData = { summary: [] };
    const shortTaSeries = String;
    const escapeHtml = String;
    const bangkokToday = () => '2026-09-16';
    const taYieldTargetSearch = '';
    let taYieldTargets = {};
    let taYieldTargetTab = initialTab;
    ${block}
    return renderTaYieldTargetParameters;
  `)(node, { querySelectorAll: () => tabs }, async () => targets, save, initialTab);
  await render();
  return { node, tabs, save };
}

describe('Dashboard subtabs across refresh', () => {
  it('renders the restored History tab with matching content and accessible label', async () => {
    const { node, tabs } = await renderTargetTabs('history');
    expect(node('taYieldTargetGroups').innerHTML).toContain('2026-06');
    expect(node('taYieldTargetGroups').innerHTML).not.toContain('2026-09');
    expect(node('taYieldTargetGroups').attributes['aria-labelledby']).toBe(tabs[2].id);
    expect(tabs[2].attributes['aria-selected']).toBe('true');
    expect(tabs[2].tabIndex).toBe(0);
  });

  it('saves target subtab selections from both click and keyboard handlers', async () => {
    const { node, tabs, save } = await renderTargetTabs('current');
    await node('parameterView').listeners.click({ target: { closest: () => tabs[2] } });
    expect(save).toHaveBeenLastCalledWith('taTargets', 'history');
    const preventDefault = vi.fn();
    node('parameterView').listeners.keydown({ target: { closest: () => tabs[2] }, key: 'Home', preventDefault });
    expect(save).toHaveBeenLastCalledWith('taTargets', 'current');
    expect(tabs[0].focus).toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalled();
    expect(node('taYieldTargetGroups').innerHTML).toContain('2026-09');
  });

  it.each(Object.entries(options).flatMap(([key, values]) => values.map((value) => [key, value])))('restores saved %s selection %s', (key, value) => {
    const beforeRefresh = createSubtabs();
    beforeRefresh.saveDashboardSubtab(key, value);
    const [savedKey, stored] = beforeRefresh.sessionStorage.setItem.mock.calls.at(-1);
    expect(savedKey).toBe(storageKey);
    expect(beforeRefresh.saveDashboardNavigation).toHaveBeenCalled();
    expect(createSubtabs({ stored }).getState()).toEqual({ ...defaults, [key]: value });
  });

  it('preserves independent preferences and replaces state without mutating earlier state', () => {
    const subtabs = createSubtabs();
    const original = subtabs.getState();
    subtabs.saveDashboardSubtab('taTargets', 'history');
    subtabs.saveDashboardSubtab('mtdParameters', 'upcoming');
    subtabs.saveDashboardSubtab('staging', 'map');
    const stored = subtabs.sessionStorage.setItem.mock.calls.at(-1)[1];
    expect(original).toEqual(defaults);
    expect(createSubtabs({ stored }).getState()).toEqual({ ...defaults, taTargets: 'history', mtdParameters: 'upcoming', staging: 'map' });
  });

  it.each([undefined, '', '{broken', 'null', '[]', '42', '"history"'])('uses defaults for absent or malformed storage: %s', (stored) => {
    expect(createSubtabs({ stored }).getState()).toEqual(defaults);
  });

  it('validates saved values independently and ignores unknown keys', () => {
    const stored = JSON.stringify({ taTargets: 'history', staging: 'unknown', taTable: null, mtdChart: 1, unexpected: 'map', productionChart: ['line'] });
    expect(createSubtabs({ stored }).getState()).toEqual({ ...defaults, taTargets: 'history' });
  });

  it.each([
    ['unknown', 'map'], ['__proto__', 'map'], ['constructor', 'map'],
    ['staging', 'history'], ['taTargets', ''], ['taTargets', null],
    ['taTargets', undefined], ['taTargets', 1], ['taTargets', ['history']],
    ['taTargets', '<script>'], ['staging', 'แผนที่ 🗺️'], [null, 'map'],
  ])('ignores invalid selection %s / %s', (key, value) => {
    const subtabs = createSubtabs();
    expect(() => subtabs.saveDashboardSubtab(key, value)).not.toThrow();
    expect(subtabs.getState()).toEqual(defaults);
    expect(subtabs.sessionStorage.setItem).not.toHaveBeenCalled();
  });

  it('keeps the selection usable and saves main navigation when storage is blocked', () => {
    const storage = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    };
    const subtabs = createSubtabs({ storage });
    expect(subtabs.getState()).toEqual(defaults);
    expect(() => subtabs.saveDashboardSubtab('staging', 'map')).not.toThrow();
    expect(subtabs.getState().staging).toBe('map');
    expect(subtabs.saveDashboardNavigation).toHaveBeenCalled();
  });

  it('restores static buttons and their accessible pressed states', () => {
    const subtabs = createSubtabs({ stored: JSON.stringify({ productionChart: 'line', mtdChart: 'accumulated', taTable: 'lots' }) });
    subtabs.restoreDashboardSubtabControls();
    for (const [selector, attribute, selected] of [
      ['.chart-mode', 'chartMode', 'line'],
      ['.mtd-chart-mode', 'mtdChartStyle', 'accumulated'],
      ['.ta-yield-table-mode', 'taYieldTable', 'lots'],
    ]) {
      for (const button of subtabs.buttons[selector]) {
        const active = button.dataset[attribute] === selected;
        expect(button.classList.contains('active')).toBe(active);
        expect(button.getAttribute('aria-pressed')).toBe(String(active));
      }
    }
  });
});
