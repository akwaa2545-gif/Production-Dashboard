import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const directions = ['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw'];
const bounds = Object.freeze({ left: 200, top: 150, width: 500, height: 450 });
const viewport = { width: 1200, height: 900 };
const limits = { minWidth: 310, minHeight: 360 };

function resizeContext(globals = {}) {
  const start = source.indexOf('function calculateDailyOutputResize(');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('function ensureDailyOutputPanel', start);
  const context = vm.createContext(globals);
  vm.runInContext(source.slice(start, end), context);
  return context;
}

function resizePanel() {
  const handles = directions.map((direction) => {
    const listeners = {};
    const captured = new Set();
    return {
      dataset: { resizeDirection: direction }, listeners,
      addEventListener: (name, callback) => { listeners[name] = callback; },
      setPointerCapture: (id) => captured.add(id),
      hasPointerCapture: (id) => captured.has(id),
      releasePointerCapture: (id) => captured.delete(id)
    };
  });
  const classes = new Set();
  const panel = {
    style: {}, html: '', hidden: false,
    classList: { contains: (name) => classes.has(name) },
    getBoundingClientRect: () => ({ ...bounds }),
    insertAdjacentHTML: (_position, html) => { panel.html += html; },
    querySelectorAll: () => handles
  };
  const context = resizeContext({
    window: { innerWidth: viewport.width, innerHeight: viewport.height },
    getComputedStyle: () => ({ minWidth: '310px', minHeight: '360px' })
  });
  context.bindDailyOutputResize(panel);
  const event = (extra = {}) => ({
    button: 0, pointerId: 1, clientX: 200, clientY: 150,
    preventDefault() {}, stopPropagation() {}, ...extra
  });
  return { panel, handles, classes, event };
}

describe('Daily output resize geometry', () => {
  it.each(directions)('resizes %s without moving the opposite edges', (direction) => {
    const context = resizeContext();
    const next = context.calculateDailyOutputResize(bounds, direction, 40, 30, viewport, limits);
    expect(next).toEqual({
      left: bounds.left + (direction.includes('w') ? 40 : 0),
      top: bounds.top + (direction.includes('n') ? 30 : 0),
      width: bounds.width + (direction.includes('e') ? 40 : direction.includes('w') ? -40 : 0),
      height: bounds.height + (direction.includes('s') ? 30 : direction.includes('n') ? -30 : 0)
    });
    expect(bounds).toEqual({ left: 200, top: 150, width: 500, height: 450 });
  });

  it('clamps shrinking to the minimum size while keeping right and bottom fixed', () => {
    const context = resizeContext();
    expect(context.calculateDailyOutputResize(bounds, 'nw', 900, 900, viewport, limits))
      .toEqual({ left: 390, top: 240, width: 310, height: 360 });
  });

  it('clamps both corners inside the viewport', () => {
    const context = resizeContext();
    expect(context.calculateDailyOutputResize(bounds, 'nw', -900, -900, viewport, limits))
      .toEqual({ left: 8, top: 8, width: 692, height: 592 });
    expect(context.calculateDailyOutputResize(bounds, 'se', 900, 900, viewport, limits))
      .toEqual({ left: 200, top: 150, width: 992, height: 742 });
  });

  it('fits minimum dimensions inside a smaller viewport', () => {
    const context = resizeContext();
    expect(context.calculateDailyOutputResize(bounds, 'se', 900, 900, { width: 280, height: 300 }, limits))
      .toEqual({ left: 8, top: 8, width: 264, height: 284 });
  });
});

describe('Daily output resize controls', () => {
  it('provides all eight accessible handles and supports pointer capture and cancellation', () => {
    const { panel, handles, event } = resizePanel();
    directions.forEach((direction) => expect(panel.html).toContain(`data-resize-direction="${direction}"`));
    expect(panel.html).toContain('tabindex="0"');
    const handle = handles.find((item) => item.dataset.resizeDirection === 'nw');
    handle.listeners.pointerdown(event());
    expect(handle.hasPointerCapture(1)).toBe(true);
    handle.listeners.pointermove(event({ clientX: 240, clientY: 180 }));
    expect(panel.style).toMatchObject({ left: '240px', top: '180px', width: '460px', height: '420px', right: 'auto', bottom: 'auto' });
    handle.listeners.pointercancel(event());
    expect(handle.hasPointerCapture(1)).toBe(false);
    handle.listeners.pointermove(event({ clientX: 300, clientY: 300 }));
    expect(panel.style.width).toBe('460px');
  });

  it.each(['is-minimized', 'is-maximized'])('does not resize when %s', (name) => {
    const { panel, handles, classes, event } = resizePanel();
    classes.add(name);
    handles[1].listeners.pointerdown(event());
    handles[1].listeners.pointermove(event({ clientX: 240 }));
    handles[1].listeners.keydown(event({ key: 'ArrowRight' }));
    expect(panel.style).toEqual({});
    expect(handles[1].hasPointerCapture(1)).toBe(false);
  });

  it('ignores a different pointer and stops resizing after capture is lost', () => {
    const { panel, handles, event } = resizePanel();
    handles[1].listeners.pointerdown(event());
    handles[1].listeners.pointermove(event({ pointerId: 2, clientX: 240 }));
    expect(panel.style).toEqual({});
    handles[1].listeners.lostpointercapture(event());
    handles[1].listeners.pointermove(event({ clientX: 240 }));
    expect(panel.style).toEqual({});
  });

  it.each([{ button: 2 }, { isPrimary: false }])('ignores unsupported pointer input %j', (input) => {
    const { panel, handles, event } = resizePanel();
    handles[1].listeners.pointerdown(event(input));
    handles[1].listeners.pointermove(event({ clientX: 240 }));
    expect(panel.style).toEqual({});
    expect(handles[1].hasPointerCapture(1)).toBe(false);
  });

  it('releases capture on pointerup and permits a new resize', () => {
    const { panel, handles, event } = resizePanel();
    handles[1].listeners.pointerdown(event());
    handles[1].listeners.pointermove(event({ clientX: 240 }));
    handles[1].listeners.pointerup(event());
    expect(handles[1].hasPointerCapture(1)).toBe(false);
    handles[1].listeners.pointermove(event({ clientX: 300 }));
    expect(panel.style.width).toBe('540px');
    handles[1].listeners.pointerdown(event({ pointerId: 2 }));
    expect(handles[1].hasPointerCapture(2)).toBe(true);
  });

  it('resizes with keyboard arrows and uses larger steps with Shift', () => {
    const { panel, handles, event } = resizePanel();
    handles[1].listeners.keydown(event({ key: 'ArrowRight' }));
    expect(panel.style.width).toBe('510px');
    handles[0].listeners.keydown(event({ key: 'ArrowDown', shiftKey: true }));
    expect(panel.style).toMatchObject({ top: '200px', height: '400px' });
  });
});
