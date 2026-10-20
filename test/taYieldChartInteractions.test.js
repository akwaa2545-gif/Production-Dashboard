import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

function interactions(globals = {}) {
  const filename = fileURLToPath(new URL('../public/ta-yield-chart-interactions.js', import.meta.url));
  const source = fs.readFileSync(filename, 'utf8');
  const context = vm.createContext({ ...globals });
  vm.runInContext(source, context, { filename });
  return context.TaYieldChartInteractions;
}

function expectRange(actual, start, end) {
  expect(actual.start).toBeCloseTo(start, 10);
  expect(actual.end).toBeCloseTo(end, 10);
}

function fakeHolder() {
  const document = {
    createElement: (tag) => element(tag),
    createElementNS: (_namespace, tag) => element(tag),
  };
  function element(tag = 'div') {
    const attributes = new Map();
    const listeners = new Map();
    const classes = new Set();
    const captures = new Set();
    function matches(selector) {
      return selector.split(',').some((part) => {
        const value = part.trim();
        if (value.startsWith('.')) return node.classList.contains(value.slice(1));
        return tag.toLowerCase() === value.toLowerCase();
      });
    }
    const node = {
      tagName: tag.toUpperCase(), ownerDocument: document, children: [], dataset: {}, style: {},
      textContent: '', innerHTML: '', parentNode: null,
      get parentElement() { return node.parentNode; },
      classList: {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        contains: (name) => classes.has(name) || (attributes.get('class') || node.className || '').split(/\s+/).includes(name),
        toggle(name, force) {
          const enabled = force ?? !classes.has(name);
          if (enabled) classes.add(name); else classes.delete(name);
          return enabled;
        },
      },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute: (name) => attributes.get(name) ?? null,
      hasAttribute: (name) => attributes.has(name),
      removeAttribute: (name) => attributes.delete(name),
      appendChild(child) {
        child.remove(); child.parentNode = node; node.children.push(child); return child;
      },
      append(...children) { children.forEach((child) => node.appendChild(child)); },
      prepend(child) { child.parentNode = node; node.children.unshift(child); },
      insertBefore(child, reference) {
        if (!reference) return node.appendChild(child);
        child.parentNode = node;
        node.children.splice(node.children.indexOf(reference), 0, child);
        return child;
      },
      remove() { if (node.parentNode) node.parentNode.children = node.parentNode.children.filter((child) => child !== node); node.parentNode = null; },
      matches,
      querySelectorAll(selector) {
        return node.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
      },
      querySelector(selector) { return node.querySelectorAll(selector)[0] || null; },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 300 }),
      setPointerCapture: (id) => captures.add(id),
      hasPointerCapture: (id) => captures.has(id),
      releasePointerCapture: (id) => captures.delete(id),
      focus() { document.activeElement = node; },
      addEventListener(name, listener) {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(listener);
      },
      removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
      listenerCount: () => [...listeners.values()].reduce((count, entries) => count + entries.size, 0),
      emit(name, extra = {}) {
        const event = { button: 0, pointerId: 1, clientX: 500, clientY: 150, preventDefault: vi.fn(), ...extra };
        listeners.get(name)?.forEach((listener) => listener(event));
        return event;
      },
    };
    return node;
  }
  return element();
}

function controller(options = {}, fixture = {}, globals = {}) {
  const holder = fixture.holder || fakeHolder();
  let frameId = 0;
  const frames = new Map();
  const { create } = interactions({
    document: holder.ownerDocument,
    requestAnimationFrame: (callback) => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: (id) => frames.delete(id),
    ...globals,
  });
  const instance = create({
    holder, charts: [], periods: Array.from({ length: 20 }, (_, index) => `W${index + 1}`),
    interval: 'week', scopeKey: 'FPS:2026:week', ...options,
  });
  const flush = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback()); };
  return { instance, holder, flush, frames };
}

function chartFixture(positioning = 'center') {
  const holder = fakeHolder();
  const make = (tag, attributes = {}) => {
    const node = holder.ownerDocument.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, value));
    return node;
  };
  const container = make('section');
  const viewport = make('div');
  const svg = make('svg', { viewBox: '0 0 1000 300', 'aria-label': 'Yield trend' });
  const grid = make('line', { class: 'gridline', x1: 100, x2: 900, y1: 100, y2: 100 });
  const axis = make('text', { class: 'axis', x: 40, y: 100 });
  const bar = make('rect', { x: 300, y: 150, width: 20, height: 50, tabindex: '0', 'aria-hidden': 'false' });
  const offscreen = make('rect', { x: 180, y: 150, width: 20, height: 50, tabindex: '0', 'aria-hidden': 'false' });
  const circle = make('circle', { cx: 500, cy: 150, r: 4 });
  const polyline = make('polyline', { points: '300,100 500,120 700,130' });
  const tick = make('text', { class: 'axis', x: 500, y: 250 });
  const tooltip = make('div', { class: 'ta-yield-trend-tooltip' });
  svg.append(grid, axis, bar, offscreen, circle, polyline, tick);
  viewport.append(svg);
  container.append(viewport, tooltip);
  holder.append(container);
  return { holder, container, viewport, svg, grid, axis, bar, offscreen, circle, polyline, tooltip, positioning, make };
}

describe('TA Yield chart horizontal viewport', () => {
  it('zooms at the mouse anchor while preserving its visible position', () => {
    const { zoomRange } = interactions();
    const original = Object.freeze({ start: 0.2, end: 0.8 });
    const next = zoomRange(original, 2, 0.25);
    expectRange(next, 0.275, 0.575);
    expect(original).toEqual({ start: 0.2, end: 0.8 });
    expect(next).not.toBe(original);
    expect((0.35 - next.start) / (next.end - next.start)).toBeCloseTo(0.25);
  });

  it.each([
    [0, 0, 0.5],
    [0.5, 0.25, 0.75],
    [1, 0.5, 1],
  ])('keeps anchor %s fixed when zooming the full range', (anchor, start, end) => {
    expectRange(interactions().zoomRange({ start: 0, end: 1 }, 2, anchor), start, end);
  });

  it('clamps zooming out to the full domain without losing either boundary', () => {
    const { zoomRange } = interactions();
    expectRange(zoomRange({ start: 0.8, end: 1 }, 0.5, 0), 0.6, 1);
    expectRange(zoomRange({ start: 0, end: 0.2 }, 0.5, 1), 0, 0.4);
    expectRange(zoomRange({ start: 0.4, end: 0.6 }, 0.00001), 0, 1);
  });

  it('honors minimum span even under extreme repeated zoom', () => {
    const { zoomRange } = interactions();
    let range = { start: 0, end: 1 };
    for (let index = 0; index < 100; index += 1) range = zoomRange(range, 1000, 0.8, 0.125);
    expect(range.end - range.start).toBeCloseTo(0.125, 10);
    expect(range.start).toBeGreaterThanOrEqual(0);
    expect(range.end).toBeLessThanOrEqual(1);
  });

  it.each([0, -1, Number.NaN, Infinity, -Infinity, undefined, null, 'bad'])('ignores invalid zoom factor %s', (factor) => {
    expectRange(interactions().zoomRange({ start: 0.2, end: 0.6 }, factor), 0.2, 0.6);
  });

  it('pans in domain units, preserves span, and leaves the supplied state unchanged', () => {
    const { panRange } = interactions();
    const original = Object.freeze({ start: 0.25, end: 0.75 });
    expectRange(panRange(original, 0.1), 0.35, 0.85);
    expectRange(panRange(original, 10000), 0.5, 1);
    expectRange(panRange(original, -10000), 0, 0.5);
    expect(original).toEqual({ start: 0.25, end: 0.75 });
    expect(panRange(original, 0)).not.toBe(original);
  });

  it('cannot pan a viewport already showing all periods', () => {
    const { panRange } = interactions();
    expectRange(panRange({ start: 0, end: 1 }, 0.6), 0, 1);
    expectRange(panRange({ start: 0, end: 1 }, -0.6), 0, 1);
  });

  it.each([null, undefined, {}, { start: Number.NaN, end: 1 }, { start: 0, end: Infinity }])('defaults malformed ranges to a finite full domain: %j', (range) => {
    const { zoomRange, panRange } = interactions();
    expectRange(panRange(range, 0), 0, 1);
    expectRange(zoomRange(range, 2), 0.25, 0.75);
  });

  it('bounds out-of-range anchors and can lock a single-bucket range', () => {
    const { zoomRange } = interactions();
    expectRange(zoomRange({ start: 0, end: 1 }, 2, -100), 0, 0.5);
    expectRange(zoomRange({ start: 0, end: 1 }, 2, 100), 0.5, 1);
    expectRange(zoomRange({ start: 0, end: 1 }, 100, 0.5, 1), 0, 1);
  });

  it.each([Number.NaN, Infinity, -Infinity, undefined, null, 'bad'])('ignores invalid pan delta %s', (delta) => {
    expectRange(interactions().panRange({ start: 0.2, end: 0.6 }, delta), 0.2, 0.6);
  });
});

describe('TA Yield chart viewport controller', () => {
  it('supports zoom, pan and reset through the same public viewport state', () => {
    const { instance } = controller();
    expect(instance.snapshot()).toEqual({ scopeKey: 'FPS:2026:week', start: 0, end: 1 });
    instance.zoom(2);
    expectRange(instance.snapshot(), 0.25, 0.75);
    instance.pan(0.1);
    expectRange(instance.snapshot(), 0.35, 0.85);
    instance.reset();
    expectRange(instance.snapshot(), 0, 1);
    instance.destroy();
  });

  it('restores a viewport only for the same data scope', () => {
    const state = Object.freeze({ scopeKey: 'FPS:2026:week', start: 0.2, end: 0.7 });
    const matched = controller({ initialState: state });
    expectRange(matched.instance.snapshot(), 0.2, 0.7);
    const changed = controller({ initialState: state, scopeKey: 'NEO:2026:month' });
    expectRange(changed.instance.snapshot(), 0, 1);
    expect(changed.instance.snapshot().scopeKey).toBe('NEO:2026:month');
    matched.instance.destroy();
    changed.instance.destroy();
  });

  it('returns snapshots independent of the live viewport state', () => {
    const { instance } = controller();
    const snapshot = instance.snapshot();
    snapshot.start = 0.99;
    expectRange(instance.snapshot(), 0, 1);
    instance.zoom(2);
    expectRange(instance.snapshot(), 0.25, 0.75);
    instance.destroy();
  });

  it.each([[], ['W1']])('keeps empty and single-period charts at the full range: %j', (periods) => {
    const { instance } = controller({ periods });
    instance.zoom(1000);
    instance.pan(0.5);
    expectRange(instance.snapshot(), 0, 1);
    instance.destroy();
  });

  it('removes event listeners and its toolbar when destroyed repeatedly', () => {
    const { instance, holder } = controller();
    const nodes = [holder, ...holder.children, ...holder.children.flatMap((child) => child.children)];
    instance.destroy();
    instance.destroy();
    expect(nodes.reduce((count, node) => count + node.listenerCount(), 0)).toBe(0);
    expect(holder.children).toHaveLength(0);
  });
});

describe('TA Yield rendered chart navigation', () => {
  function setup(options = {}, globals = {}) {
    const fixture = chartFixture(options.positioning);
    const result = controller({ charts: [{ container: fixture.container, positioning: fixture.positioning }], ...options }, fixture, globals);
    return { ...fixture, ...result };
  }

  it('reprojects marks horizontally while keeping vertical values and the Y axis fixed', () => {
    const { instance, flush, svg, bar, circle, polyline, grid, axis, viewport } = setup();
    instance.zoom(2);
    flush();
    expect(Number(bar.getAttribute('x'))).toBeCloseTo(100);
    expect(Number(bar.getAttribute('width'))).toBeCloseTo(40);
    expect(Number(circle.getAttribute('cx'))).toBeCloseTo(500);
    expect(polyline.getAttribute('points')).toBe('100 100 500 120 900 130');
    expect(bar.getAttribute('y')).toBe('150');
    expect(circle.getAttribute('cy')).toBe('150');
    expect(axis.getAttribute('x')).toBe('40');
    expect(grid.getAttribute('x1')).toBe('100');
    expect(grid.getAttribute('x2')).toBe('900');
    expect(svg.querySelector('clipPath')).not.toBeNull();
    expect(viewport.getAttribute('tabindex')).toBe('0');
    expect(viewport.getAttribute('aria-label')).toContain('Scroll to zoom');
    instance.reset();
    flush();
    expect(bar.getAttribute('x')).toBe('300');
    expect(bar.getAttribute('width')).toBe('20');
    instance.destroy();
  });

  it('normalizes endpoint and centered chart buckets into a shared viewport', () => {
    const fixture = chartFixture('endpoints');
    fixture.circle.setAttribute('cx', '100');
    const { instance, flush } = controller({
      charts: [{ container: fixture.container, positioning: 'endpoints' }],
      periods: ['W1', 'W2', 'W3', 'W4'],
    }, fixture);
    expect(Number(fixture.circle.getAttribute('cx'))).toBeCloseTo(200);
    instance.zoom(2, 0);
    flush();
    expect(Number(fixture.circle.getAttribute('cx'))).toBeCloseTo(300);
    instance.destroy();
  });

  it('prevents focus entering clipped marks and restores original accessibility attributes on reset', () => {
    const { instance, flush, offscreen, viewport, holder } = setup();
    offscreen.focus();
    instance.zoom(2);
    flush();
    expect(offscreen.getAttribute('tabindex')).toBe('-1');
    expect(offscreen.getAttribute('aria-hidden')).toBe('true');
    expect(holder.ownerDocument.activeElement).toBe(viewport);
    instance.reset();
    flush();
    expect(offscreen.getAttribute('tabindex')).toBe('0');
    expect(offscreen.getAttribute('aria-hidden')).toBe('false');
    instance.destroy();
  });

  it('zooms around the wheel position, prevents page scrolling and hides tooltips', () => {
    const { instance, viewport, tooltip } = setup();
    const event = viewport.emit('wheel', { deltaY: -100, clientX: 300 });
    const range = instance.snapshot();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(range.end - range.start).toBeLessThan(1);
    expect((0.25 - range.start) / (range.end - range.start)).toBeCloseTo(0.25);
    expect(tooltip.hidden).toBe(true);
    const unchanged = instance.snapshot();
    expect(viewport.emit('wheel', { deltaY: 0 }).preventDefault).not.toHaveBeenCalled();
    expect(viewport.emit('wheel', { deltaY: Number.NaN }).preventDefault).not.toHaveBeenCalled();
    expect(instance.snapshot()).toEqual(unchanged);
    instance.destroy();
  });

  it.each([1, 2])('normalizes wheel delta mode %s', (deltaMode) => {
    const { instance, viewport } = setup();
    viewport.emit('wheel', { deltaY: -1, deltaMode });
    expect(instance.snapshot().end - instance.snapshot().start).toBeLessThan(1);
    instance.destroy();
  });

  it('uses horizontal drag distance to pan and releases capture when the drag ends', () => {
    const { instance, viewport, holder } = setup();
    instance.zoom(2);
    viewport.emit('pointerdown');
    viewport.emit('pointermove', { clientX: 502 });
    expect(viewport.hasPointerCapture(1)).toBe(false);
    viewport.emit('pointermove', { clientX: 600 });
    expect(viewport.hasPointerCapture(1)).toBe(true);
    expect(holder.classList.contains('ta-chart-is-dragging')).toBe(true);
    expectRange(instance.snapshot(), 0.1875, 0.6875);
    viewport.emit('pointerup');
    expect(viewport.hasPointerCapture(1)).toBe(false);
    expect(holder.classList.contains('ta-chart-is-dragging')).toBe(false);
    viewport.emit('pointermove', { clientX: 800 });
    expectRange(instance.snapshot(), 0.1875, 0.6875);
    instance.destroy();
  });

  it.each(['pointercancel', 'lostpointercapture'])('stops dragging after %s and ignores other pointers', (finish) => {
    const { instance, viewport } = setup();
    instance.zoom(2);
    viewport.emit('pointerdown');
    viewport.emit('pointermove', { pointerId: 2, clientX: 700 });
    expectRange(instance.snapshot(), 0.25, 0.75);
    viewport.emit('pointermove', { clientX: 600 });
    viewport.emit(finish);
    viewport.emit('pointermove', { clientX: 800 });
    expectRange(instance.snapshot(), 0.1875, 0.6875);
    expect(viewport.hasPointerCapture(1)).toBe(false);
    instance.destroy();
  });

  it.each([{ button: 2 }, { isPrimary: false }, { clientX: 50 }, { clientX: 950 }])('ignores unsupported drag starts %j', (input) => {
    const { instance, viewport } = setup();
    instance.zoom(2);
    viewport.emit('pointerdown', input);
    viewport.emit('pointermove', { clientX: 700 });
    expectRange(instance.snapshot(), 0.25, 0.75);
    expect(viewport.hasPointerCapture(1)).toBe(false);
    instance.destroy();
  });

  it('leaves vertical gestures available for scrolling and cancels a pending drag on pointerleave', () => {
    const { instance, viewport } = setup();
    instance.zoom(2);
    viewport.emit('pointerdown');
    const move = viewport.emit('pointermove', { clientX: 505, clientY: 200 });
    expect(move.preventDefault).not.toHaveBeenCalled();
    viewport.emit('pointerleave');
    viewport.emit('pointermove', { clientX: 700 });
    expectRange(instance.snapshot(), 0.25, 0.75);
    instance.destroy();
  });

  it('supports toolbar buttons, keyboard shortcuts and disabled states', () => {
    const { instance, holder, viewport, flush } = setup();
    const buttons = holder.querySelectorAll('button');
    const button = (action) => buttons.find((item) => item.dataset.chartAction === action);
    expect(button('reset').disabled).toBe(true);
    button('zoom-in').emit('click');
    flush();
    expect(instance.snapshot().end - instance.snapshot().start).toBeCloseTo(2 / 3);
    expect(button('reset').disabled).toBe(false);
    const before = instance.snapshot();
    expect(viewport.emit('keydown', { key: '+', ctrlKey: true }).preventDefault).not.toHaveBeenCalled();
    expect(viewport.emit('keydown', { key: 'Tab' }).preventDefault).not.toHaveBeenCalled();
    expect(instance.snapshot()).toEqual(before);
    viewport.emit('keydown', { key: 'ArrowRight' });
    expect(instance.snapshot().start).toBeGreaterThan(before.start);
    viewport.emit('keydown', { key: 'ArrowLeft' });
    expectRange(instance.snapshot(), before.start, before.end);
    viewport.emit('keydown', { key: '+' });
    viewport.emit('keydown', { key: '-' });
    expect(instance.snapshot().end - instance.snapshot().start).toBeCloseTo(2 / 3);
    viewport.emit('keydown', { key: 'Home' });
    expectRange(instance.snapshot(), 0, 1);
    button('zoom-in').emit('click');
    button('zoom-out').emit('click');
    expectRange(instance.snapshot(), 0, 1);
    button('zoom-in').emit('click');
    button('reset').emit('click');
    expectRange(instance.snapshot(), 0, 1);
    instance.destroy();
  });

  it('coalesces redraws, responds to resize and disconnects all listeners and observers on destroy', () => {
    let resize;
    const disconnect = vi.fn();
    const observe = vi.fn();
    class ResizeObserver {
      constructor(callback) { resize = callback; }
      observe = observe;
      disconnect = disconnect;
    }
    const { instance, viewport, svg, grid, flush, frames } = setup({}, { ResizeObserver });
    expect(observe).toHaveBeenCalledWith(viewport);
    instance.zoom(2);
    instance.pan(0.1);
    expect(frames.size).toBe(1);
    viewport.clientWidth = 1200;
    resize();
    flush();
    expect(svg.getAttribute('viewBox')).toBe('0 0 1000 300');
    expect(grid.getAttribute('x2')).toBe('900');
    viewport.clientWidth = 600;
    resize();
    flush();
    expect(svg.getAttribute('viewBox')).toBe('0 0 600 300');
    expect(grid.getAttribute('x2')).toBe('500');
    resize();
    instance.destroy();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    expect(viewport.listenerCount()).toBe(0);
    const state = instance.snapshot();
    viewport.emit('wheel', { deltaY: -100 });
    instance.zoom(2);
    expect(instance.snapshot()).toEqual(state);
  });

  it('preserves original visual scale and converts physical mouse coordinates into SVG coordinates', () => {
    const fixture = chartFixture();
    fixture.viewport.clientWidth = 1600;
    fixture.svg.getBoundingClientRect = () => ({ left: 40, top: 0, width: 1600, height: 480 });
    const { instance, flush } = controller({ charts: [{ container: fixture.container, positioning: 'center' }] }, fixture);
    expect(fixture.svg.getAttribute('viewBox')).toBe('0 0 1000 300');
    expect(fixture.grid.getAttribute('x2')).toBe('900');

    fixture.viewport.emit('wheel', { deltaY: -100, clientX: 520 });
    const range = instance.snapshot();
    expect((0.25 - range.start) / (range.end - range.start)).toBeCloseTo(0.25);
    instance.reset();
    instance.zoom(2);
    flush();
    fixture.viewport.emit('pointerdown', { clientX: 840 });
    fixture.viewport.emit('pointermove', { clientX: 1000 });
    expectRange(instance.snapshot(), 0.1875, 0.6875);
    fixture.viewport.emit('pointerup');

    const previous = instance.snapshot();
    fixture.viewport.emit('pointerdown', { clientX: 150 });
    fixture.viewport.emit('pointermove', { clientX: 700 });
    expect(instance.snapshot()).toEqual(previous);
    instance.destroy();
  });

  it('hides complete labels at clipped edges and restores them when the whole text fits', () => {
    const fixture = chartFixture();
    const labels = [300, 500, 700].map((x) => {
      const label = fixture.make('text', { class: 'ta-yield-column-value', x, y: 130, 'text-anchor': 'middle' });
      label.textContent = '95.23%';
      label.getComputedTextLength = () => 36;
      fixture.svg.append(label);
      return label;
    });
    const { instance, flush } = controller({ charts: [{ container: fixture.container, positioning: 'center' }] }, fixture);
    expect(labels.map((label) => label.style.visibility)).toEqual(['', '', '']);
    instance.zoom(2);
    flush();
    expect(labels.map((label) => label.style.visibility)).toEqual(['hidden', '', 'hidden']);
    expect(fixture.axis.style.visibility).not.toBe('hidden');
    instance.reset();
    flush();
    expect(labels.map((label) => label.style.visibility)).toEqual(['', '', '']);
    instance.destroy();
  });

  it('retains nonoverlapping original-size value labels using their measured text widths', () => {
    const fixture = chartFixture();
    const labels = [400, 440].map((x) => {
      const label = fixture.make('text', { class: 'ta-yield-column-value', x, y: 130, 'text-anchor': 'middle' });
      label.textContent = '95%';
      label.getComputedTextLength = () => 20;
      fixture.svg.append(label);
      return label;
    });
    const { instance } = controller({ charts: [{ container: fixture.container, positioning: 'center' }] }, fixture);
    expect(labels.map((label) => label.style.visibility)).toEqual(['', '']);
    instance.destroy();
  });
});

describe('Machine chart shared viewport integration', () => {
  it('keeps the first rotated footer label readable in the axis gutter using a separate full-width clip', () => {
    const fixture = chartFixture();
    fixture.svg.setAttribute('viewBox', '0 0 1000 440');
    const label = fixture.make('text', {
      class: 'ta-machine-date-label ta-machine-vertical-label', x: 100, y: 424,
      'text-anchor': 'start', transform: 'rotate(-90 100 424)',
    });
    label.textContent = '2026-10-20 | MACHINE 1';
    label.getComputedTextLength = () => 120;
    fixture.svg.append(label);
    const { instance, flush } = controller({
      periods: Array.from({ length: 100 }, (_, index) => `Point ${index + 1}`),
      charts: [{ container: fixture.container, positioning: 'endpoints', labelSelector: '.ta-machine-date-label' }],
    }, fixture);
    expect(label.style.visibility).toBe('');
    expect(label.parentElement === fixture.circle.parentElement).toBe(false);
    const clipId = label.parentElement.getAttribute('clip-path')?.match(/^url\(#(.+)\)$/)?.[1];
    expect(clipId).toBeTruthy();
    const labelClip = fixture.svg.querySelectorAll('clipPath').find((node) => node.getAttribute('id') === clipId).querySelector('rect');
    expect(labelClip.getAttribute('x')).toBe('0');
    expect(labelClip.getAttribute('width')).toBe('1000');
    fixture.viewport.clientWidth = 600;
    instance.zoom(1);
    flush();
    expect(label.style.visibility).toBe('');
    expect(labelClip.getAttribute('width')).toBe('600');
    const plotClipId = fixture.circle.parentElement.getAttribute('clip-path').match(/^url\(#(.+)\)$/)[1];
    const plotClip = fixture.svg.querySelectorAll('clipPath').find((node) => node.getAttribute('id') === plotClipId).querySelector('rect');
    expect(plotClip.getAttribute('x')).toBe('100');
    expect(plotClip.getAttribute('width')).toBe('400');
    instance.destroy();
  });

  it('keeps nested machine grid lines and their Y-axis labels outside the moving plot', () => {
    const fixture = chartFixture();
    fixture.grid.setAttribute('class', 'ta-machine-grid');
    const group = fixture.make('g', { class: 'ta-machine-grid-group' });
    group.append(fixture.grid, fixture.axis);
    fixture.svg.prepend(group);
    const { instance, flush } = controller({ charts: [{
      container: fixture.container, positioning: 'center', gridSelector: '.ta-machine-grid',
      fixedGroupSelector: '.ta-machine-grid-group', preserveAspectRatio: 'none',
    }] }, fixture);
    instance.zoom(2);
    flush();
    expect(group.parentElement === fixture.svg).toBe(true);
    expect(fixture.axis.parentElement === group).toBe(true);
    expect(fixture.axis.getAttribute('x')).toBe('40');
    expect(fixture.grid.getAttribute('x1')).toBe('100');
    expect(fixture.grid.getAttribute('x2')).toBe('900');
    expect(fixture.bar.getAttribute('x')).toBe('100');
    expect(fixture.svg.getAttribute('preserveAspectRatio')).toBe('none');
    instance.destroy();
  });

  it('places each machine toolbar immediately before its own viewport', () => {
    const fixture = chartFixture();
    const { instance } = controller({
      holder: fixture.container, toolbarBefore: fixture.viewport,
      charts: [{ container: fixture.container, positioning: 'center' }],
    }, fixture);
    expect(fixture.container.children[0].className).toBe('ta-yield-chart-navigation');
    expect(fixture.container.children[1]).toBe(fixture.viewport);
    instance.destroy();
    expect(fixture.container.children[0]).toBe(fixture.viewport);
  });

  it('hides machine point tooltips during wheel zoom and drag', () => {
    const fixture = chartFixture();
    fixture.tooltip.setAttribute('class', 'ta-machine-point-tooltip');
    fixture.tooltip.hidden = false;
    const { instance } = controller({
      tooltipSelector: '.ta-machine-point-tooltip',
      charts: [{ container: fixture.container, positioning: 'center' }],
    }, fixture);
    fixture.viewport.emit('wheel', { deltaY: -100, clientX: 500 });
    expect(fixture.tooltip.hidden).toBe(true);
    fixture.tooltip.hidden = false;
    fixture.viewport.emit('pointerdown');
    fixture.viewport.emit('pointermove', { clientX: 600 });
    expect(fixture.tooltip.hidden).toBe(true);
    instance.destroy();
  });

  it('moves rotated date labels and their rotation pivots together while using rotated bounds for collisions', () => {
    const fixture = chartFixture();
    const labels = [300, 400, 430].map((x) => {
      const label = fixture.make('text', {
        class: 'ta-machine-date-label ta-machine-vertical-label', x, y: 270,
        'text-anchor': 'start', transform: `rotate(-90 ${x} 270)`,
      });
      label.textContent = '2026-10-20 | MACHINE 1';
      label.getComputedTextLength = () => 120;
      fixture.svg.append(label);
      return label;
    });
    const { instance, flush } = controller({ charts: [{ container: fixture.container, positioning: 'center' }] }, fixture);
    expect(labels.map((label) => label.style.visibility)).toEqual(['', '', '']);
    instance.zoom(2);
    flush();
    expect(labels[1].getAttribute('x')).toBe('300');
    expect(labels[1].getAttribute('transform')).toBe('rotate(-90 300 270)');
    const rotated = labels[2].getAttribute('transform').match(/^rotate\(-90 ([\d.-]+) 270\)$/);
    expect(rotated).not.toBeNull();
    expect(Number(rotated[1])).toBeCloseTo(360, 10);
    expect(labels.map((label) => label.style.visibility)).toEqual(['hidden', '', '']);
    instance.reset();
    flush();
    expect(labels[1].getAttribute('transform')).toBe('rotate(-90 400 270)');
    expect(labels.map((label) => label.style.visibility)).toEqual(['', '', '']);
    instance.destroy();
  });
});
