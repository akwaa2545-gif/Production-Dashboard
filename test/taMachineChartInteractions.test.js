import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

function machineSvg(points) {
  const holder = { classList: { add: vi.fn(), remove: vi.fn() }, dataset: {} };
  const viewport = { parentElement: holder, classList: { add: vi.fn(), remove: vi.fn() }, dataset: {} };
  const circles = points.map(({ x, title }) => {
    const attributes = new Map([['cx', String(x)]]);
    return {
      dataset: {},
      getAttribute: (name) => attributes.get(name) ?? null,
      hasAttribute: (name) => attributes.has(name),
      setAttribute: (name, value) => attributes.set(name, String(value)),
      querySelector: () => ({ textContent: title }),
    };
  });
  const svg = {
    parentElement: viewport, isConnected: true, dataset: {},
    getAttribute: (name) => name === 'viewBox' ? '0 0 1000 440' : null,
    setAttribute: vi.fn(),
    querySelectorAll: (selector) => selector.includes('circle') ? circles : [],
    matches: (selector) => selector === '.ta-machine-date-machine-chart',
    closest: () => viewport,
  };
  holder.querySelector = (selector) => selector === 'svg' ? svg : null;
  viewport.querySelector = holder.querySelector;
  return { svg, holder, viewport, circles };
}

function adapterFixture(charts = []) {
  const nodes = charts.map((chart) => chart.svg);
  const controllers = [];
  const create = vi.fn((options) => {
    const controller = { destroy: vi.fn(), snapshot: () => ({ start: 0, end: 1, scopeKey: options.scopeKey }) };
    controllers.push(controller);
    return controller;
  });
  let mutation;
  const disconnect = vi.fn();
  const observe = vi.fn();
  class MutationObserver {
    constructor(callback) { mutation = callback; }
    observe = observe;
    disconnect = disconnect;
  }
  const frames = new Map();
  let sequence = 0;
  const document = {
    readyState: 'complete', body: {}, documentElement: {},
    querySelectorAll: () => nodes.filter((node) => node.isConnected),
    contains: (node) => node.isConnected,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  };
  const context = vm.createContext({
    document, MutationObserver, TaYieldChartInteractions: { create },
    requestAnimationFrame: (callback) => { frames.set(++sequence, callback); return sequence; },
    cancelAnimationFrame: (id) => frames.delete(id),
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  });
  const filename = fileURLToPath(new URL('../public/ta-machine-chart-interactions.js', import.meta.url));
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const flush = () => {
    for (let index = 0; frames.size && index < 10; index += 1) {
      const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback());
    }
  };
  flush();
  return { adapter: context.TaMachineChartInteractions, create, controllers, document, observe, disconnect, nodes, flush, frames, mutate: () => mutation?.([{ type: 'childList' }]) };
}

describe('Machine chart interaction adapter', () => {
  const chart = () => machineSvg([
    { x: 700, title: '2026-10-03 · M3 · 4.1% · 41 defects' },
    { x: 100, title: '2026-10-01 · M1 · 2.1% · 21 defects' },
    { x: 100, title: '2026-10-01 · M1 · 1.5% · 15 defects' },
    { x: 400, title: '2026-10-02 · M2 · 3.1% · 31 defects' },
  ]);

  it('attaches an independent shared viewport to each machine SVG and leaves repeated scans idempotent', () => {
    const first = chart();
    const second = chart();
    const { adapter, create, controllers } = adapterFixture([first, second]);
    adapter.scan();
    adapter.scan();
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0].holder).toBe(first.holder);
    expect(create.mock.calls[1][0].holder).toBe(second.holder);
    expect(controllers[0]).not.toBe(controllers[1]);
    expect(controllers[0].destroy).not.toHaveBeenCalled();
    adapter.dispose();
  });

  it('uses point titles ordered by plotted X coordinates and collapses duplicate positions', () => {
    const fixture = chart();
    const { adapter, create } = adapterFixture([fixture]);
    adapter.scan();
    const options = create.mock.calls[0][0];
    expect(Array.from(options.periods)).toEqual([
      '2026-10-01 · M1', '2026-10-02 · M2', '2026-10-03 · M3',
    ]);
    expect(options.toolbarBefore).toBe(fixture.viewport);
    expect(options.tooltipSelector).toContain('.ta-machine-point-tooltip');
    expect(options.charts).toHaveLength(1);
    expect(options.charts[0].gridSelector).toBe('.ta-machine-grid');
    expect(options.charts[0].positioning).toBe('endpoints');
    expect(options.charts[0].labelSelector).toBe('.ta-machine-date-label');
    expect(options.charts[0].preserveAspectRatio).toBe('none');
    expect(fixture.circles.every((circle) => circle.getAttribute('tabindex') === '0')).toBe(true);
    adapter.dispose();
  });

  it('destroys a removed chart and enhances a replacement after DOM changes', () => {
    const oldChart = chart();
    const { adapter, create, controllers, nodes, mutate, flush } = adapterFixture([oldChart]);
    adapter.scan();
    oldChart.svg.isConnected = false;
    const replacement = chart();
    nodes.push(replacement.svg);
    mutate();
    flush();
    adapter.scan();
    expect(controllers[0].destroy).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0].holder).toBe(replacement.holder);
    adapter.dispose();
  });

  it('observes child changes and releases observers, pending scans and controllers on disposal', () => {
    const { adapter, observe, disconnect, controllers, mutate, frames } = adapterFixture([chart()]);
    adapter.scan();
    expect(observe).toHaveBeenCalled();
    const options = observe.mock.calls[0][1];
    expect(options).toMatchObject({ childList: true, subtree: true });
    expect(options.attributes).not.toBe(true);
    mutate();
    adapter.dispose();
    adapter.dispose();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(controllers.every((controller) => controller.destroy.mock.calls.length === 1)).toBe(true);
    expect(frames.size).toBe(0);
  });

  it('preserves existing keyboard settings, tolerates untitled points and skips enhanced or detached viewports', () => {
    const untitled = machineSvg([{ x: 100, title: '' }]);
    untitled.circles[0].setAttribute('tabindex', '-1');
    const enhanced = chart();
    enhanced.svg.dataset.machineChartEnhanced = 'true';
    const detached = chart();
    detached.svg.parentElement = null;
    const { adapter, create } = adapterFixture([untitled, enhanced, detached]);
    expect(create).toHaveBeenCalledOnce();
    expect(Array.from(create.mock.calls[0][0].periods)).toEqual(['1']);
    expect(untitled.circles[0].getAttribute('tabindex')).toBe('-1');
    adapter.dispose();
    adapter.scan();
    expect(create).toHaveBeenCalledOnce();
  });
});
