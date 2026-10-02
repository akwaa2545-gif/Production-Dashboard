import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function setup(dataset = 'ta-yield') {
  const controller = { enabled: false, setAvailable: vi.fn(), refresh: vi.fn(), syncFilters: vi.fn(), toggle: vi.fn() };
  const factory = vi.fn(() => controller);
  const button = {};
  const context = vm.createContext({
    window: { createTaYieldCompareWindow: factory }, request: vi.fn(), fetchDashboardExport: vi.fn(), bindDailyOutputResize: vi.fn(), escapeHtml: vi.fn(),
    selectedDataset: () => dataset, selectedSeries: () => ['FPS series A3'], selectedPartNumbers: () => ['PN1'],
    byId: (id) => ({ product: { value: 'TA' }, startDate: { value: '2026-09-05' }, endDate: { value: '2026-09-20' } }[id] || button),
    dashboardDataMode: { mode: 'staging' }, dashboardDataModeGeneration: 4
  });
  const start = source.indexOf('function ensureTaYieldCompareController()');
  const end = source.indexOf('function updateDailyOutputToggle()', start);
  vm.runInContext(`let taYieldCompareController;\n${source.slice(start, end)}`, context);
  return { context, controller, factory, button };
}

describe('Compare dashboard integration', () => {
  it('syncs Report control selections without loading comparison data or creating a closed window', () => {
    const { context, controller, factory } = setup();
    context.syncTaYieldCompareSelection();
    expect(factory).not.toHaveBeenCalled();
    context.ensureTaYieldCompareController();
    context.syncTaYieldCompareSelection();
    expect(controller.syncFilters).toHaveBeenCalledWith(expect.objectContaining({ startDate: '2026-09-05', endDate: '2026-09-20' }));
    expect(controller.refresh).not.toHaveBeenCalled();
    const notice = source.split('\n').find((line) => line.startsWith('function updateReportPendingNotice()'));
    expect(notice).toContain('syncTaYieldCompareSelection()');
  });
  it('includes Compare in the shared source-mode and stale-response guards', () => {
    const context = vm.createContext({});
    const declaration = source.split('\n').find((line) => line.startsWith('const isDashboardSourceRequest ='));
    vm.runInContext(`${declaration}\nglobalThis.guarded = isDashboardSourceRequest('/api/ta-yield-compare?dataset=ta-yield');`, context);
    expect(context.guarded).toBe(true);
    vm.runInContext("globalThis.detailGuarded = isDashboardSourceRequest('/api/ta-yield-compare-details?kind=series');", context);
    expect(context.detailGuarded).toBe(true);
  });
  it('makes Compare available only on TA Yield and does not fetch while closed', () => {
    const { context, controller } = setup();
    context.updateTaYieldCompare();
    expect(controller.setAvailable).toHaveBeenCalledWith(true);
    expect(controller.refresh).not.toHaveBeenCalled();
    const nonTa = setup('closed');
    nonTa.controller.enabled = true;
    nonTa.context.updateTaYieldCompare();
    expect(nonTa.controller.setAvailable).toHaveBeenCalledWith(false);
    expect(nonTa.controller.refresh).not.toHaveBeenCalled();
  });

  it('refreshes using the selected reporting dates, scope filters and source generation', () => {
    const { context, controller, factory, button } = setup();
    controller.enabled = true;
    context.updateTaYieldCompare();
    context.updateTaYieldCompare();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0][0].toggleButton).toBe(button);
    expect(factory.mock.calls[0][0].getFilters().startDate).toBe('2026-09-05');
    expect(factory.mock.calls[0][0].fetchExport).toBe(context.fetchDashboardExport);
    expect(context.fetchDashboardExport).not.toHaveBeenCalled();
    expect(controller.refresh).toHaveBeenCalledWith({ startDate: '2026-09-05', endDate: '2026-09-20', product: 'TA', serie: ['FPS series A3'], pn: ['PN1'], dataMode: 'staging:4' }, true);
  });

  it('sets the current scope before opening or closing the floating window', () => {
    const { context, controller } = setup();
    context.toggleTaYieldCompare();
    expect(controller.refresh).toHaveBeenCalledTimes(1);
    expect(controller.toggle).toHaveBeenCalledTimes(1);
    expect(controller.refresh.mock.invocationCallOrder[0]).toBeLessThan(controller.toggle.mock.invocationCallOrder[0]);
  });

  it('closes Compare without starting a new request for unapplied Report selections', () => {
    const { context, controller } = setup();
    controller.enabled = true;
    context.toggleTaYieldCompare();
    expect(controller.toggle).toHaveBeenCalledOnce();
    expect(controller.refresh).not.toHaveBeenCalled();
  });

  it('loads the Compare assets before main application wiring and defaults the toggle off', () => {
    const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    expect(html).toContain('id="taYieldCompareToggle"');
    expect(html).toContain('Compare: Off');
    expect(html.indexOf('<script src="/ta-yield-compare.js')).toBeLessThan(html.indexOf('<script src="/app.js'));
    expect(html).toContain('href="/ta-yield-compare.css');
    expect(source).toContain("byId('taYieldCompareToggle').addEventListener('click', toggleTaYieldCompare)");
  });
});
