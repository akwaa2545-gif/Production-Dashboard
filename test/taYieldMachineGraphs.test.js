import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.attributes = []; this.listeners = {}; this.isConnected = true; this.value = ''; }
  append(...nodes) { nodes.forEach((node) => { node.remove(); node.parentNode = this; this.children.push(node); }); }
  addEventListener(type, handler) { this.listeners[type] = handler; }
  remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  focus() { this.focused = true; }
  setAttribute(name, value) { this.removeAttribute(name); this.attributes.push({ name, value: String(value) }); }
  getAttribute(name) { return this.attributes.find((a) => a.name === name)?.value ?? null; }
  removeAttribute(name) { this.attributes = this.attributes.filter((a) => a.name !== name); }
  matches(selector) {
    if (selector === '*') return true;
    if (selector.startsWith('.')) return (this.className || '').split(' ').includes(selector.slice(1));
    const attr = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
    if (attr) return this.getAttribute(attr[1]) !== null && (attr[2] === undefined || this.getAttribute(attr[1]) === attr[2]);
    return selector === this.tagName;
  }
  querySelector(selector) { return selector === 'svg' && this.svg ? {} : this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) { return this.children.flatMap((child) => [child, ...child.querySelectorAll('*')]).filter((child) => selector.split(',').some((part) => child.matches(part.trim()))); }
  cloneNode() { const node = new Element(this.tagName); Object.assign(node, { svg: this.svg, className: this.className, textContent: this.textContent }); node.attributes = this.attributes.map((a) => ({ ...a })); node.append(...this.children.map((child) => child.cloneNode())); return node; }
}
const scope = { startDate: '2026-10-01', endDate: '2026-10-16', process: 'Resin_coating', serie: 'FPS A08', pn: 'PN1', defectType: 'category', defect: 'SH', groupBy: 'week' };
const rows = [{ machineName: 'RESIN01', date: '2026-10-01' }, { machineName: 'RESIN02', date: '2026-10-01' }];
const flush = async () => { for (let i = 0; i < 15; i += 1) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function setup(handler) {
  const request = vi.fn(handler || (async (url) => url.startsWith('/api/options') ? { serie: ['FPS A08', 'FPS A09'], pn: ['PN1', 'PN2'] } : url.startsWith('/api/ta-yield-machine-processes') ? { processes: ['Resin_coating', 'Molding'] } : url.startsWith('/api/ta-yield-machine-options') ? { categories: ['SH', 'LC'], codes: ['0301'] } : { rows, totalMachines: 2 }));
  const renderChart = vi.fn(() => { const chart = new Element(); chart.svg = true; return chart; });
  const window = {}; vm.runInNewContext(fs.readFileSync(new URL('../public/ta-yield-machine-graphs.js', import.meta.url), 'utf8'), { window, document: { createElement: (tag) => new Element(tag) }, URLSearchParams });
  const controller = window.createTaYieldMachineGraphs({ request, renderChart });
  const view = new Element(); const button = new Element('button'); const chart = new Element(); chart.svg = true;
  controller.attach(view, button);
  const seed = () => controller.setAnalysis(controller.begin(), { ...scope }, chart, () => ({ machines: ['RESIN02'], order: 'date-machine', rows, totalMachines: 2 }));
  const add = async () => { controller.add(); await flush(); return view.children[0].children.at(-1); };
  return { controller, view, button, chart, request, renderChart, seed, add };
}
const control = (card, name) => card.querySelector(`[data-machine-filter="${name}"]`);
const change = async (card, name, value) => { const node = control(card, name); node.value = value; await node.listeners.change?.({ target: node }); await flush(); };
const analyze = async (card) => { await card.querySelector('.ta-machine-comparison-analyze').listeners.click(); await flush(); };
describe('independent Machine comparison graphs', () => {
  it('renders a fresh full-range graph from selected rows when the main SVG is already enhanced', async () => {
    const h = setup();
    const query = h.chart.querySelector.bind(h.chart);
    h.chart.querySelector = (selector) => selector === 'svg[data-machine-chart-enhanced]' ? {} : query(selector);
    h.seed();
    await h.add();
    expect(h.renderChart).toHaveBeenCalledWith([rows[1]], 'date-machine', 2);
  });

  it('keeps clipped Machine points out of keyboard navigation when tooltip bindings refresh', () => {
    const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    const start = app.indexOf('const enableMachinePointTooltips =');
    const end = app.indexOf('\nnew MutationObserver(enableMachinePointTooltips)', start);
    const points = [true, false].map((hidden) => ({
      getAttribute: () => hidden ? 'true' : null,
      querySelector: () => ({ textContent: 'Machine point' }),
      setAttribute: vi.fn(),
    }));
    new Function('document', `${app.slice(start, end)}\nenableMachinePointTooltips();`)({ querySelectorAll: () => points });
    expect(points.map((point) => point.tabIndex)).toEqual([-1, 0]);
  });

  it('keeps Add graph below the latest card after additions, removals and reattachment', async () => {
    const h = setup(); h.seed(); const first = await h.add(); const second = await h.add();
    const shelf = first.parentNode;
    expect(shelf.children).toEqual([first, second]);
    expect(h.view.children).toEqual([shelf, h.button]);
    second.querySelector('.ta-machine-comparison-remove').listeners.click();
    expect(shelf.children).toEqual([first]); expect(h.view.children.at(-1)).toBe(h.button);
    const next = new Element(); const nextButton = new Element('button'); h.controller.attach(next, nextButton);
    expect(next.children).toEqual([shelf, nextButton]); expect(nextButton.disabled).toBe(true);
    h.seed(); const third = h.controller.add(); expect(third).toBe(true);
    expect(next.children.at(-1)).toBe(nextButton); expect(shelf.children).toHaveLength(2);
  });
  it('limits added graphs to four and allows another after removal without extra rejected requests', async () => {
    const h = setup(); h.seed();
    expect(Array.from({ length: 4 }, () => h.controller.add())).toEqual([true, true, true, true]);
    await flush(); const shelf = h.view.children[0]; h.request.mockClear();
    expect(h.button.disabled).toBe(true);
    expect(h.controller.add()).toBe(false); expect(h.controller.add()).toBe(false);
    await flush(); expect(shelf.children).toHaveLength(4); expect(h.request).not.toHaveBeenCalled();
    h.seed(); expect(h.button.disabled).toBe(true);
    shelf.children[1].querySelector('.ta-machine-comparison-remove').listeners.click();
    expect(h.button.disabled).toBe(false); expect(h.controller.add()).toBe(true);
    expect(shelf.children).toHaveLength(4); expect(h.button.disabled).toBe(true);
  });
  it('preserves the cap across reattachment and resets it only after a new successful main analysis', async () => {
    const h = setup(); h.seed(); for (let i = 0; i < 4; i += 1) h.controller.add(); await flush();
    const next = new Element(); const nextButton = new Element('button'); h.controller.attach(next, nextButton);
    h.seed(); expect(nextButton.disabled).toBe(true); expect(h.controller.add()).toBe(false);
    h.controller.begin(); next.children[0].children[0].querySelector('.ta-machine-comparison-remove').listeners.click();
    expect(nextButton.disabled).toBe(true); expect(h.controller.add()).toBe(false);
    h.controller.reset(); expect(next.children[0].children).toHaveLength(0); expect(nextButton.disabled).toBe(true);
    h.seed(); expect(nextButton.disabled).toBe(false);
    expect(Array.from({ length: 5 }, () => h.controller.add())).toEqual([true, true, true, true, false]);
  });
  it('requires successful main chart, seeds own filters without requesting analysis or printing long caption', async () => {
    const h = setup(); expect(h.controller.add()).toBe(false); h.seed(); const card = await h.add();
    expect(card.querySelector('.ta-machine-comparison-scope')).toBeNull();
    expect(control(card, 'process').value).toBe('Resin_coating'); expect(control(card, 'startDate').value).toBe(scope.startDate);
    expect(control(card, 'order').value).toBe('date-machine'); expect(card.querySelector('.ta-machine-comparison-chart').children[0]).not.toBe(h.chart);
    expect(h.request.mock.calls.filter(([url]) => url.startsWith('/api/ta-yield-machine?'))).toHaveLength(0);
  });
  it('requests its own scope without changing another card or main controls', async () => {
    const h = setup(); h.seed(); const first = await h.add(); const second = await h.add();
    await change(first, 'startDate', '2026-10-03'); await change(first, 'serie', 'FPS A09'); await change(first, 'pn', 'PN2'); await change(first, 'process', 'Molding'); await change(first, 'defect', 'code|0301'); await change(first, 'groupBy', 'month'); await analyze(first);
    const call = h.request.mock.calls.filter(([url]) => url.startsWith('/api/ta-yield-machine?')).at(-1)[0];
    expect(Object.fromEntries(new URL(call, 'http://local').searchParams)).toEqual({ dataset: 'ta-yield', startDate: '2026-10-03', endDate: '2026-10-16', serie: 'FPS A09', pn: 'PN2', process: 'Molding', defectType: 'code', defect: '0301', groupBy: 'month', machine: '__ALL__' });
    expect(control(second, 'process').value).toBe('Resin_coating'); expect(scope.process).toBe('Resin_coating');
  });
  it('rerenders order and machine selection locally', async () => {
    const h = setup(); h.seed(); const card = await h.add(); h.request.mockClear(); await change(card, 'order', 'machine-date');
    expect(h.renderChart).toHaveBeenLastCalledWith([rows[1]], 'machine-date', 2);
    const boxes = card.querySelectorAll('[data-machine-name]'); boxes[0].checked = true; await boxes[0].listeners.change();
    expect(h.renderChart).toHaveBeenLastCalledWith(rows, 'machine-date', 2); expect(h.request).not.toHaveBeenCalled(); expect(card.querySelector('summary').textContent).not.toContain('RESIN');
  });
  it('clears outdated results and ignores analysis completed after filter changes', async () => {
    const pending = deferred(); const h = setup(async (url) => url.startsWith('/api/options') ? { serie: ['FPS A08'], pn: ['PN1'] } : url.startsWith('/api/ta-yield-machine-processes') ? { processes: ['Resin_coating'] } : url.startsWith('/api/ta-yield-machine-options') ? { categories: ['SH'] } : pending.promise);
    h.seed(); const card = await h.add(); const running = analyze(card); await change(card, 'groupBy', 'day'); pending.resolve({ rows, totalMachines: 2 }); await running;
    expect(h.renderChart).not.toHaveBeenCalled(); expect(card.querySelector('.ta-machine-comparison-chart').children).toHaveLength(0); expect(card.querySelector('.ta-machine-comparison-status').textContent).toContain('Analyze');
  });
  it('ignores stale process options and clears invalid selections', async () => {
    const pending = deferred(); let processCalls = 0;
    const h = setup(async (url) => url.startsWith('/api/options') ? { serie: ['FPS A08'], pn: ['PN1'] } : url.startsWith('/api/ta-yield-machine-processes') ? (++processCalls === 1 ? pending.promise : { processes: ['Molding'] }) : { categories: ['LC'] });
    h.seed(); h.controller.add(); const card = h.view.children[0].children[0]; await flush(); await change(card, 'startDate', '2026-10-03'); pending.resolve({ processes: ['Resin_coating'] }); await flush();
    expect(control(card, 'process').value).toBe(''); expect(control(card, 'defect').value).toBe(''); expect(control(card, 'defect').disabled).toBe(true); expect(control(card, 'process').children.map((node) => node.value)).toContain('Molding');
  });
  it('retains controls across main rerenders and invalidates source reset', async () => {
    const h = setup(); h.seed(); const card = await h.add(); await change(card, 'groupBy', 'month'); const next = new Element(); const nextButton = new Element('button'); h.controller.attach(next, nextButton);
    expect(next.children[0].children[0]).toBe(card); expect(control(card, 'groupBy').value).toBe('month'); const token = h.controller.begin(); h.controller.reset(); expect(next.children[0].children).toHaveLength(0); expect(h.controller.setAnalysis(token, scope, h.chart)).toBe(false);
  });
  it('replaces old results with empty/error messages', async () => {
    const h = setup(); h.seed(); const card = await h.add(); h.request.mockImplementationOnce(async () => ({ rows: [], totalMachines: 0 })); await analyze(card);
    expect(card.querySelector('.ta-machine-comparison-chart').children).toHaveLength(0); expect(card.querySelector('.ta-machine-comparison-status').textContent).toContain('No matching');
    h.request.mockImplementationOnce(async () => { throw new Error('Unavailable'); }); await analyze(card); expect(card.querySelector('.ta-machine-comparison-status').textContent).toContain('Unavailable');
  });
  it('strips cloned global IDs/controls while preserving main and supports removal', async () => {
    const h = setup(); h.chart.setAttribute('id', 'taMachineChart'); const child = new Element('select'); h.chart.append(child); h.seed(); const card = await h.add(); const clone = card.querySelector('.ta-machine-comparison-chart').children[0];
    expect(clone.attributes).toEqual([]); expect(clone.children).toHaveLength(0); expect(h.chart.children).toHaveLength(1); card.querySelector('.ta-machine-comparison-remove').listeners.click(); expect(h.view.children[0].hidden).toBe(true);
  });
  it('allows independent analysis to finish across main begin and reattach', async () => {
    const h = setup(); h.seed(); const card = await h.add(); const pending = deferred(); h.request.mockImplementationOnce(() => pending.promise);
    const running = analyze(card); h.controller.begin(); const next = new Element(); h.controller.attach(next, new Element('button'));
    pending.resolve({ rows, totalMachines: 2 }); await running;
    expect(h.renderChart).toHaveBeenCalledWith(rows, 'date-machine', 2); expect(next.children[0].children[0]).toBe(card);
  });
  it('ignores analysis after card removal and source reset while siblings still work', async () => {
    const h = setup(); h.seed(); const first = await h.add(); const second = await h.add(); const pending = deferred(); h.request.mockImplementationOnce(() => pending.promise);
    const running = analyze(first); first.querySelector('.ta-machine-comparison-remove').listeners.click(); pending.resolve({ rows, totalMachines: 2 }); await running;
    expect(h.renderChart).not.toHaveBeenCalled(); await analyze(second); expect(h.renderChart).toHaveBeenCalledTimes(1);
    const resetPending = deferred(); h.request.mockImplementationOnce(() => resetPending.promise); const resetRunning = analyze(second); h.controller.reset(); resetPending.resolve({ rows, totalMachines: 2 }); await resetRunning;
    expect(h.renderChart).toHaveBeenCalledTimes(1);
  });
  it('ignores stale defect responses and reports current catalog errors locally', async () => {
    const h = setup(); h.seed(); const card = await h.add(); const pending = deferred(); h.request.mockImplementationOnce(() => pending.promise);
    const previous = change(card, 'process', 'Molding'); await flush(); await change(card, 'process', 'Resin_coating'); pending.resolve({ categories: ['STALE'] }); await previous;
    expect(control(card, 'defect').children.map((node) => node.value)).not.toContain('category|STALE');
    h.request.mockImplementationOnce(async () => { throw new Error('Catalog unavailable'); }); await change(card, 'startDate', '2026-10-02');
    expect(card.querySelector('.ta-machine-comparison-analyze').disabled).toBe(true); expect(control(card, 'defect').disabled).toBe(true);
    expect(card.querySelector('.ta-machine-comparison-chart').children).toHaveLength(0); expect(card.querySelector('.ta-machine-comparison-status').textContent).toContain('Catalog unavailable');
  });
  it('preserves selected process and defect during quick successive catalog reloads', async () => {
    const h = setup(); h.seed(); const card = await h.add(); const pending = deferred(); h.request.mockImplementationOnce(() => pending.promise);
    const previous = change(card, 'startDate', '2026-10-02'); await flush(); await change(card, 'endDate', '2026-10-15'); pending.resolve({ processes: ['STALE'] }); await previous;
    expect(control(card, 'process').value).toBe('Resin_coating'); expect(control(card, 'defect').value).toBe('category|SH');
    const scoped = h.request.mock.calls.filter(([url]) => url.startsWith('/api/ta-yield-machine-processes') || url.startsWith('/api/ta-yield-machine-options')).at(-1)[0];
    const query = new URL(scoped, 'http://local').searchParams; expect(query.get('startDate')).toBe('2026-10-02'); expect(query.get('endDate')).toBe('2026-10-15'); expect(query.get('serie')).toBe('FPS A08'); expect(query.get('pn')).toBe('PN1');
  });
  it('reloads the corrected scope if delayed lot filters remove stale initial series and PN', async () => {
    const pending = deferred(); const h = setup(); h.request.mockImplementationOnce(() => pending.promise); h.seed(); h.controller.add();
    const card = h.view.children[0].children[0]; await change(card, 'startDate', '2026-10-02'); pending.resolve({ serie: [], pn: [] }); await flush();
    const calls = h.request.mock.calls.filter(([url]) => url.startsWith('/api/ta-yield-machine-processes'));
    const query = new URL(calls.at(-1)[0], 'http://local').searchParams; expect(query.has('serie')).toBe(false); expect(query.has('pn')).toBe(false); expect(query.get('startDate')).toBe('2026-10-02');
  });
  it.each(['', '2026-02-30', '2026-10-17'])('does not request analysis for invalid start date %s', async (value) => {
    const h = setup(); h.seed(); const card = await h.add(); h.request.mockClear(); await change(card, 'startDate', value); await analyze(card);
    expect(h.request).not.toHaveBeenCalled(); expect(card.querySelector('.ta-machine-comparison-status').textContent).toContain('valid start and end date');
  });
});
