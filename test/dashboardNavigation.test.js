import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const storageKey = 'onemes-dashboard-navigation-v1';
const views = ['dashboard', 'ta-yield-machine', 'ta-data-table', 'parameters', 'sc-yield-log', 'ta-yield-log', 'defects', 'staging', 'comments', 'model'];

function createNavigation({ stored, storage, initialize: initializeOverride } = {}) {
  const elements = {
    dataSource: { value: 'closed', options: ['closed', 'lot', 'yield', 'ta-yield'].map((value) => ({ value })) },
    product: { value: 'NEO' },
  };
  let activeView = 'dashboard';
  const clicks = [];
  const config = { dataset: 'closed' };
  const tabs = views.map((view) => ({
    dataset: { view },
    hidden: false,
    click: vi.fn(() => {
      activeView = view;
      clicks.push({ view, dataset: config.dataset, product: elements.product.value });
    }),
  }));
  const sessionStorage = storage || {
    getItem: vi.fn(() => stored ?? null),
    setItem: vi.fn((_key, value) => { stored = value; }),
  };
  const document = {
    querySelectorAll: vi.fn((selector) => selector.includes('.app-tab') ? tabs.filter((tab) => !selector.includes(':not([hidden])') || !tab.hidden) : []),
    querySelector: vi.fn((selector) => {
      if (selector === '.app-tab.active') return tabs.find((tab) => tab.dataset.view === activeView);
      const view = selector.match(/data-view=["']([^"']+)/)?.[1];
      return tabs.find((tab) => tab.dataset.view === view);
    }),
  };
  const initialize = vi.fn(async () => {
    await initializeOverride?.();
    config.dataset = elements.dataSource.value;
  });
  const updateYieldUtilityTabs = vi.fn();
  const start = app.indexOf('const dashboardNavigationKey =');
  const end = app.indexOf('const selectedPartNumbers', start);
  const build = new Function('sessionStorage', 'document', 'byId', 'selectedDataset', 'setSelectedProduct', 'updateYieldUtilityTabs', 'initialize', 'currentConfig', 'console', `${app.slice(start, end)}\nreturn { readDashboardNavigation, saveDashboardNavigation, initializeDashboardNavigation };`);
  const navigation = build(sessionStorage, document, (id) => elements[id], () => elements.dataSource.value, (value) => { elements.product.value = value; }, updateYieldUtilityTabs, initialize, config, { warn: vi.fn() });
  return { ...navigation, elements, tabs, clicks, sessionStorage, initialize, config, updateYieldUtilityTabs, setActiveView: (view) => { activeView = view; } };
}

describe('Dashboard navigation across refresh', () => {
  it('makes TA Target Setting available before the report finishes loading', () => {
    const start = app.indexOf('document.querySelector(\'.app-tab[data-view="parameters"]\').hidden', app.indexOf('async function initialize()'));
    const end = app.indexOf("byId('scYieldLogTab')", start);
    const tab = { hidden: true, textContent: '' };
    new Function('document', 'supportsMtd', 'isScYield', 'isTaYield', app.slice(start, end))({ querySelector: () => tab }, false, false, true);
    expect(tab.hidden).toBe(false);
    expect(tab.textContent).toBe('TA Yield target setting');
  });

  it.each([
    ['ta-yield', 'ta-yield-machine', 'NEO'],
    ['ta-yield', 'parameters', 'NEO'],
    ['yield', 'sc-yield-log', 'SC'],
    ['lot', 'dashboard', 'SC'],
    ['closed', 'parameters', 'SC'],
    ['closed', 'dashboard', ''],
  ])('restores %s / %s and its product after refresh', async (dataset, view, product) => {
    const beforeRefresh = createNavigation();
    beforeRefresh.elements.dataSource.value = dataset;
    beforeRefresh.elements.product.value = product;
    beforeRefresh.setActiveView(view);
    beforeRefresh.saveDashboardNavigation();
    const persisted = beforeRefresh.sessionStorage.setItem.mock.calls.at(-1);
    expect(persisted[0]).toBe(storageKey);
    expect(JSON.parse(persisted[1])).toEqual({ dataset, view, product });

    const afterRefresh = createNavigation({ stored: persisted[1] });
    await afterRefresh.initializeDashboardNavigation();
    expect(afterRefresh.elements.dataSource.value).toBe(dataset);
    expect(afterRefresh.elements.product.value).toBe(product);
    expect(afterRefresh.clicks).toEqual([{ dataset, view, product }]);
    expect(afterRefresh.updateYieldUtilityTabs).toHaveBeenCalled();
  });

  it.each([undefined, '', '{broken', 'null', '[]', '42', '"yield"', '{"dataset":"missing","view":"dashboard","product":"NEO"}'])('ignores absent or malformed saved state: %s', async (stored) => {
    const navigation = createNavigation({ stored });
    expect(navigation.readDashboardNavigation()).toBeUndefined();
    await navigation.initializeDashboardNavigation();
    expect(navigation.elements.dataSource.value).toBe('closed');
    expect(navigation.initialize).toHaveBeenCalledOnce();
  });

  it('ignores an invalid product and returns an unavailable tab to the dashboard', async () => {
    const navigation = createNavigation({ stored: JSON.stringify({ dataset: 'closed', view: 'ta-yield-machine', product: '<bad>' }) });
    navigation.tabs.find((tab) => tab.dataset.view === 'ta-yield-machine').hidden = true;
    await navigation.initializeDashboardNavigation();
    expect(navigation.elements.product.value).toBe('');
    expect(navigation.clicks.map(({ view }) => view)).toEqual(['dashboard']);
  });

  it('falls back to the dashboard for an unknown view', async () => {
    const navigation = createNavigation({ stored: JSON.stringify({ dataset: 'yield', view: 'unknown', product: 'SC' }) });
    await navigation.initializeDashboardNavigation();
    expect(navigation.clicks.map(({ view }) => view)).toEqual(['dashboard']);
  });

  it('keeps the dashboard usable when browser storage is blocked', async () => {
    const storage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    const navigation = createNavigation({ storage });
    expect(navigation.readDashboardNavigation()).toBeUndefined();
    expect(() => navigation.saveDashboardNavigation('parameters')).not.toThrow();
    await expect(navigation.initializeDashboardNavigation()).resolves.toBeUndefined();
    expect(navigation.initialize).toHaveBeenCalledOnce();
  });

  it('waits until the selected dataset is initialized before opening its saved tab', async () => {
    let finish;
    const ready = new Promise((resolve) => { finish = resolve; });
    const navigation = createNavigation({ stored: JSON.stringify({ dataset: 'ta-yield', view: 'ta-yield-machine', product: 'NEO' }), initialize: () => ready });
    const initializing = navigation.initializeDashboardNavigation();
    expect(navigation.elements.dataSource.value).toBe('ta-yield');
    expect(navigation.clicks).toEqual([]);
    finish();
    await initializing;
    expect(navigation.clicks).toEqual([{ dataset: 'ta-yield', view: 'ta-yield-machine', product: 'NEO' }]);
  });

  it('does not overwrite a newer tab selection while initialization is pending', async () => {
    let finish;
    const ready = new Promise((resolve) => { finish = resolve; });
    const navigation = createNavigation({ stored: JSON.stringify({ dataset: 'ta-yield', view: 'ta-yield-machine', product: 'NEO' }), initialize: () => ready });
    const initializing = navigation.initializeDashboardNavigation();
    navigation.setActiveView('parameters');
    navigation.saveDashboardNavigation();
    finish();
    await initializing;
    expect(navigation.clicks).toEqual([]);
    expect(JSON.parse(navigation.sessionStorage.setItem.mock.calls.at(-1)[1]).view).toBe('parameters');
  });

  it('does not restore an old tab after the user switches dataset during initialization', async () => {
    let finish;
    const ready = new Promise((resolve) => { finish = resolve; });
    const navigation = createNavigation({ stored: JSON.stringify({ dataset: 'ta-yield', view: 'ta-yield-machine', product: 'NEO' }), initialize: () => ready });
    const initializing = navigation.initializeDashboardNavigation();
    navigation.elements.dataSource.value = 'closed';
    finish();
    await initializing;
    expect(navigation.clicks).toEqual([]);
  });

  it('does not open a saved tab when initialization has no matching dataset configuration', async () => {
    const navigation = createNavigation({ stored: JSON.stringify({ dataset: 'ta-yield', view: 'ta-yield-machine', product: 'NEO' }) });
    navigation.initialize.mockImplementation(async () => {});
    await navigation.initializeDashboardNavigation();
    expect(navigation.clicks).toEqual([]);
  });
});
