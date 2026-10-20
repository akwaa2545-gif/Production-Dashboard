import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function tooltipContext() {
  const context = vm.createContext({ getComputedStyle: (mark) => ({
    getPropertyValue: (name) => mark.computed[name] || '',
    fill: mark.computed.fill || 'none', stroke: mark.computed.stroke || 'none',
  }) });
  const escapeHtml = source.split(/\r?\n/).find((line) => line.startsWith('const escapeHtml ='));
  const start = source.indexOf('function bindScYieldWeeklyTooltips(');
  const end = source.indexOf('function setScYieldWeeklyVisibility(', start);
  vm.runInContext(`${escapeHtml}\n${source.slice(start, end)}`, context);
  return context;
}

function chartMarks(entries) {
  const tooltip = { hidden: true, innerHTML: '', style: {}, dataset: {} };
  const panel = {
    querySelector: (selector) => selector === 'h4' ? { textContent: 'FPS Yield <Overview>' } : tooltip,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 300 }),
    classList: { contains: () => false },
  };
  const marks = entries.map(({ title = 'W40: yield 84.06%; target 93.00%', classes = ['yield-column', 'below-target'], computed = {}, dataset = {} } = {}) => {
    const listeners = {};
    return {
      computed, dataset, classList: { contains: (name) => classes.includes(name) },
      matches: (selector) => selector.split('.').filter(Boolean).every((name) => classes.includes(name)),
      querySelector: () => ({ textContent: title }), closest: () => panel,
      getBoundingClientRect: () => ({ left: 100, top: 150, width: 20, height: 50 }),
      getAttribute: (name) => name === 'fill' ? computed.fill || null : name === 'stroke' ? computed.stroke || null : null,
      addEventListener: (name, callback) => { listeners[name] = callback; },
      emit(name, event) { listeners[name]?.(event); },
    };
  });
  return { tooltip, marks, holder: { querySelectorAll: () => marks, classList: { contains: () => false } } };
}

describe('TA Yield tooltip appearance', () => {
  it('uses the original series color while a below-target column is animating red', () => {
    const context = tooltipContext();
    const { marks } = chartMarks([{ computed: { '--yield-series-fill': '#2b318f', fill: 'rgb(239, 68, 68)' } }]);
    const appearance = context.taYieldTooltipAppearance(marks[0]);
    expect(appearance.background).toBe('#2b318f');
    expect(appearance.color).toBe('#ffffff');
  });

  it.each(['#2b318f', '#4d6ae3', '#35add0', '#ee8d2d', '#8063b3', 'rgb(43, 49, 143)', 'rgba(255, 255, 255, 0.8)'])('uses the requested white text for every series color %s', (background) => {
    const context = tooltipContext();
    const { marks } = chartMarks([{ computed: { '--yield-series-fill': background } }]);
    const appearance = context.taYieldTooltipAppearance(marks[0]);
    expect(appearance.background).toBe(background);
    expect(appearance.color).toBe('#ffffff');
  });

  it('falls back from unfilled line marks to their stroke color', () => {
    const context = tooltipContext();
    const { marks } = chartMarks([{ classes: ['ta-yield-line-point'], computed: { fill: 'none', stroke: '#35add0' } }]);
    expect(context.taYieldTooltipAppearance(marks[0]).background).toBe('#35add0');
  });

  it('uses the computed fill for defect segments without a series custom property', () => {
    const context = tooltipContext();
    const { marks } = chartMarks([{ classes: [], computed: { fill: 'rgb(238, 141, 45)' } }]);
    expect(context.taYieldTooltipAppearance(marks[0]).background).toBe('rgb(238, 141, 45)');
  });

  it('keeps the requested white text for a translucent fill', () => {
    const context = tooltipContext();
    const { marks } = chartMarks([{ computed: { fill: 'rgba(0, 0, 0, 0.1)' } }]);
    const appearance = context.taYieldTooltipAppearance(marks[0]);
    expect(appearance.background).toBe('rgba(0, 0, 0, 0.1)');
    expect(appearance.color).toBe('#ffffff');
  });

  it('ignores transparent fills when the line stroke provides the visible color', () => {
    const context = tooltipContext();
    const { marks } = chartMarks([{ computed: { fill: 'transparent', stroke: '#35add0' } }]);
    expect(context.taYieldTooltipAppearance(marks[0]).background).toBe('#35add0');
  });
});

describe('TA Yield tooltip target status', () => {
  it('reports the difference in percentage points for a below-target yield', () => {
    const context = tooltipContext();
    const { marks } = chartMarks([{}]);
    expect(context.taYieldTooltipTargetStatus(marks[0], 'W40: yield 84.06%; target 93.00%')).toBe('Below target 8.94%');
  });

  it('preserves a true below-target warning when rounding makes yield and target look equal', () => {
    const context = tooltipContext();
    const { marks } = chartMarks([{ dataset: { yieldValue: '92.999', yieldTarget: '93' } }]);
    expect(context.taYieldTooltipTargetStatus(marks[0], 'W40: yield 93.00%; target 93.00%')).toBe('Below target <0.01%');
  });

  it('shows a full hundredth when floating-point subtraction falls just under 0.01', () => {
    const context = tooltipContext();
    const { marks } = chartMarks([{ dataset: { yieldValue: '92.98', yieldTarget: '92.99' } }]);
    expect(context.taYieldTooltipTargetStatus(marks[0], 'W40: yield 92.98%; target 92.99%')).toBe('Below target 0.01%');
  });

  it.each([
    ['84.064', '93', 'W40: yield 84.06%; target 93.00%'],
    ['84.064', '93.006', 'W40: yield 84.06%; target 93.01%'],
  ])('calculates the target gap using unrounded values %s and %s', (yieldValue, yieldTarget, detail) => {
    const context = tooltipContext();
    const { marks } = chartMarks([{ dataset: { yieldValue, yieldTarget } }]);
    expect(context.taYieldTooltipTargetStatus(marks[0], detail)).toBe('Below target 8.94%');
  });

  it.each([
    { yieldValue: 'not-a-number', yieldTarget: '93' },
    { yieldValue: 'Infinity', yieldTarget: '93' },
    { yieldValue: '84.064', yieldTarget: '-Infinity' },
  ])('falls back to valid title values when raw metadata is not finite: %j', (dataset) => {
    const context = tooltipContext();
    const { marks } = chartMarks([{ dataset }]);
    expect(context.taYieldTooltipTargetStatus(marks[0], 'W40: yield 84.06%; target 93.00%')).toBe('Below target 8.94%');
  });

  it.each([
    ['W40: yield 94.00%; target 93.00%', ['yield-column']],
    ['W40: yield 93.00%; target 93.00%', ['yield-column', 'below-target']],
    ['W40: yield 84.06%; no saved target', ['yield-column', 'below-target']],
    ['W40: yield 0.00%; target 0.00%', ['yield-column', 'below-target']],
    ['W40: defect 8.94%; target 93.00%', []],
    ['W40: yield 84.06%; target 93.00%', ['target-point']],
    ['W40: yield 84.06%; target 93.00%', ['ta-yield-line-point']],
    ['W40: yield unknown; target 93.00%', ['yield-column', 'below-target']],
    ['', ['yield-column', 'below-target']],
  ])('does not claim below-target status for %s with classes %j', (detail, classes) => {
    const context = tooltipContext();
    const { marks } = chartMarks([{ classes }]);
    expect(context.taYieldTooltipTargetStatus(marks[0], detail)).toBe('');
  });
});

describe('TA Yield tooltip hover and focus integration', () => {
  it.each([
    ['2026-09 | FPS A3: yield 84.06%; target 93.00%', ['yield-column', 'below-target']],
    ['2026-09 | FPS A3: target 93.00%', ['target-point']],
    ['2026-09 | FPS A3: yield 84.06%', ['ta-yield-line-point']],
    ['2026-09 | FPS A3 | ESR: defect 4.12%', []],
  ])('uses the hovered series in the native mark title: %s', (title, classes) => {
    const context = tooltipContext();
    const { holder, marks, tooltip } = chartMarks([{ title, classes, computed: { fill: '#4d6ae3' } }]);
    context.bindTaYieldTrendTooltips(holder);
    marks[0].emit('focus');
    expect(tooltip.innerHTML).toMatch(/^<strong>FPS A3<\/strong>/);
  });

  it('keeps the chart heading for a single-series defect title containing only period and defect group', () => {
    const context = tooltipContext();
    const { holder, marks, tooltip } = chartMarks([{ title: '2026-09 | ESR: defect 4.12%', classes: [], computed: { fill: '#4d6ae3' } }]);
    context.bindTaYieldTrendTooltips(holder);
    marks[0].emit('focus');
    expect(tooltip.innerHTML).toMatch(/^<strong>FPS Yield &lt;Overview&gt;<\/strong>/);
  });

  it('uses only the hovered column series as the tooltip heading in a multi-series chart', () => {
    const context = tooltipContext();
    const { holder, marks, tooltip } = chartMarks([{ dataset: { seriesLabel: 'FPS A3' }, computed: { '--yield-series-fill': '#4d6ae3' } }]);
    context.bindTaYieldTrendTooltips(holder);
    marks[0].emit('mousemove', { clientX: 140, clientY: 180 });
    expect(tooltip.innerHTML).toMatch(/^<strong>FPS A3<\/strong>/);
    expect(tooltip.innerHTML).not.toContain('FPS Yield');
  });

  it('escapes series metadata before inserting it into the tooltip heading', () => {
    const context = tooltipContext();
    const { holder, marks, tooltip } = chartMarks([{ dataset: { seriesLabel: '<img src=x onerror=alert(1)>' }, computed: { '--yield-series-fill': '#4d6ae3' } }]);
    context.bindTaYieldTrendTooltips(holder);
    marks[0].emit('focus');
    expect(tooltip.innerHTML).toMatch(/^<strong>&lt;img src=x onerror=alert\(1\)&gt;<\/strong>/);
    expect(tooltip.innerHTML).not.toContain('<img');
  });

  it('updates colors and clears the target warning when moving between different marks', () => {
    const context = tooltipContext();
    const { holder, marks, tooltip } = chartMarks([
      { computed: { '--yield-series-fill': '#2b318f', fill: 'rgb(239, 68, 68)' } },
      { title: 'W41: yield 95.00%; target 93.00%', classes: ['yield-column'], computed: { '--yield-series-fill': '#ee8d2d' } },
      { title: 'W42: yield 85.00%; no saved target', classes: ['yield-column'], computed: { '--yield-series-fill': '#8063b3' } },
    ]);
    context.bindTaYieldTrendTooltips(holder);
    marks[0].emit('mousemove', { clientX: 140, clientY: 180 });
    expect(tooltip.hidden).toBe(false);
    expect(tooltip.style.background || tooltip.style.backgroundColor).toBe('#2b318f');
    expect(tooltip.style.color).toBe('#ffffff');
    expect(tooltip.innerHTML).toContain('Below target 8.94%');
    marks[1].emit('focus');
    expect(tooltip.style.background || tooltip.style.backgroundColor).toBe('#ee8d2d');
    expect(tooltip.style.color).toBe('#ffffff');
    expect(tooltip.innerHTML).not.toContain('Below target');
    marks[2].emit('mousemove', { clientX: 140, clientY: 180 });
    expect(tooltip.style.background || tooltip.style.backgroundColor).toBe('#8063b3');
    expect(tooltip.innerHTML).not.toContain('Below target');
    marks[2].emit('mouseleave');
    expect(tooltip.hidden).toBe(true);
    marks[1].emit('focus');
    marks[1].emit('blur');
    expect(tooltip.hidden).toBe(true);
  });

  it('escapes titles and period text before inserting tooltip HTML', () => {
    const context = tooltipContext();
    const { holder, marks, tooltip } = chartMarks([{ title: '<img src=x onerror=alert(1)>: yield 84.06%; target 93.00%', computed: { '--yield-series-fill': '#2b318f' } }]);
    context.bindTaYieldTrendTooltips(holder);
    marks[0].emit('focus');
    expect(tooltip.innerHTML).toContain('FPS Yield &lt;Overview&gt;');
    expect(tooltip.innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(tooltip.innerHTML).not.toContain('<img');
  });
});
