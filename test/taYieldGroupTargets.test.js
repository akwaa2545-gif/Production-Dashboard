import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const targetHelpers = app.slice(app.indexOf('const taChartGroup'), app.indexOf('let currentConfig'));
const groupRenderer = app.slice(app.indexOf('function renderTaYieldGroupTendencyCharts'), app.indexOf('function renderTaYieldTendencySkeleton'));

function render(targets, rows, buckets, interval = 'month') {
  const holder = { innerHTML: '', querySelectorAll: () => [] };
  const draw = new Function('taYieldTargets', 'byId', 'escapeHtml', 'taYieldInterval', 'bindTaYieldGroupTrendTooltips',
    `${targetHelpers}\n${groupRenderer}\nreturn renderTaYieldGroupTendencyCharts;`)(targets, () => holder, String, interval, () => {});
  draw(rows, buckets);
  return holder.innerHTML;
}

function card(html, group = 'Facedown') {
  return html.split('<article').find((section) => section.includes(`<h4>%TTL Yield of ${group}</h4>`));
}

const row = (line, input, month = '2026-06') => ({ line, input, finalGood: input * 0.9, month });
const facedownRows = (month = '2026-06') => [row('Ta NEO Capacitor FPS series A1 case', 100, month), row('FPS series A2', 300, month)];

describe('TTL Yield product-group target rendering', () => {
  it.each([
    ['Facedown', 'FPS'], ['Standard Production', 'PSG'], ['GPS', 'GPS']
  ])('uses the saved %s monthly target ahead of individual series targets', (group, prefix) => {
    const html = render({ [group]: { '2026-06': 94 }, [`${prefix} A1`]: { '2026-06': 80 }, [`${prefix} A2`]: { '2026-06': 88 } },
      [row(`${prefix} series A1`, 100), row(`${prefix} series A2`, 300)], ['2026-06']);
    expect(card(html, group)).toContain('2026-06: target 94.00%');
    expect(card(html, group)).not.toContain('target 86.00%');
  });

  it('omits the group target when only contributing series have saved targets', () => {
    const html = render({ 'FPS A1': { '2026-06': 80 }, 'FPS A2': { '2026-06': 88 } }, facedownRows(), ['2026-06']);
    expect(card(html)).not.toContain('class="target-line"');
    expect(card(html)).toContain('class="yield-line"');
  });

  it('omits the group target when a contributing series lacks a target', () => {
    const html = render({ 'FPS A1': { '2026-06': 80 } }, facedownRows(), ['2026-06']);
    expect(card(html)).not.toContain('class="target-line"');
    expect(card(html)).toContain('class="yield-line"');
  });

  it('does not substitute a saved series target even if other series have zero input', () => {
    const html = render({ 'FPS A1': { '2026-06': 80 } }, [row('FPS series A1', 100), row('FPS series A2', 0)], ['2026-06']);
    expect(card(html)).not.toContain('class="target-line"');
    expect(card(html)).toContain('class="yield-line"');
  });

  it('treats a saved zero group target as an explicit target', () => {
    const html = render({ Facedown: { '2026-06': 0 }, 'FPS A1': { '2026-06': 80 }, 'FPS A2': { '2026-06': 88 } }, facedownRows(), ['2026-06']);
    expect(card(html)).toContain('2026-06: target 0.00%');
  });

  it.each([['day', '2026-06-15'], ['week', '2026-W23']])('uses the saved month target for %s buckets', (interval, bucket) => {
    const html = render({ Facedown: { '2026-06': 94 }, 'FPS A1': { '2026-06': 80 }, 'FPS A2': { '2026-06': 88 } }, facedownRows(bucket), [bucket], interval);
    expect(card(html)).toContain(`${bucket}: target 94.00%`);
  });

  it('resolves each month separately without carrying forward another month target', () => {
    const targets = { Facedown: { '2026-06': 94 }, 'FPS A1': { '2026-06': 80, '2026-07': 82 }, 'FPS A2': { '2026-06': 88, '2026-07': 90 } };
    const html = render(targets, [...facedownRows(), ...facedownRows('2026-07')], ['2026-06', '2026-07']);
    expect(card(html)).toContain('2026-06: target 94.00%');
    expect(card(html)).not.toContain('2026-07: target');
    expect(card(html)).toContain('2026-07: 90.00%');
  });

  it.each([null, '', ' ', undefined])('omits an unset group target (%j) instead of calculating one', (target) => {
    const html = render({ Facedown: { '2026-06': target }, 'FPS A1': { '2026-06': 80 }, 'FPS A2': { '2026-06': 88 } }, facedownRows(), ['2026-06']);
    expect(card(html)).not.toContain('class="target-line"');
    expect(card(html)).toContain('2026-06: 90.00%');
  });

  it('leaves a gap between saved targets when the middle month has no target', () => {
    const html = render({ Facedown: { '2026-06': 94, '2026-08': 96 } },
      [...facedownRows(), ...facedownRows('2026-07'), ...facedownRows('2026-08')], ['2026-06', '2026-07', '2026-08']);
    const targetLines = [...card(html).matchAll(/<polyline class="target-line" points="([^"]*)"/g)];
    expect(targetLines).toHaveLength(2);
    expect(targetLines.map((line) => line[1].trim().split(/\s+/).length)).toEqual([1, 1]);
    expect(card(html)).not.toContain('2026-07: target');
    expect(card(html)).toContain('2026-07: 90.00%');
  });

  it('clears the panel when no buckets are available', () => {
    expect(render({}, [], [])).toBe('');
  });

  it('splits target segments at missing values while retaining zero targets', () => {
    const segments = new Function(`${targetHelpers}\nreturn taYieldTargetSegments;`)();
    expect(segments([undefined, 0, 90, undefined, 95, undefined], (index) => index, (value) => value))
      .toEqual(['1,0 2,90', '4,95']);
    expect(segments([undefined, null, NaN], (index) => index, (value) => value)).toEqual([]);
  });

  it('leaves target gaps in the main column chart', () => {
    const block = app.slice(app.indexOf('  const targetPoints = taYieldTargetSegments(buckets'), app.indexOf('  const yieldColumns = buckets.map', app.indexOf('function renderTaYieldTendencyCharts')));
    const draw = new Function('buckets', 'targetsByBucket', 'x', 'yieldY', 'escapeHtml', 'label', 'base',
      `${targetHelpers}\n${block}\nreturn targetPoints + targetDots;`);
    const buckets = ['2026-06', '2026-07', '2026-08'].map((month) => ({ month }));
    const html = draw(buckets, new Map([['2026-06', 94], ['2026-08', 96]]), (index) => index, (value) => value, String, String, 200);
    expect([...html.matchAll(/<polyline class="target-line" points="([^"]*)"/g)].map((line) => line[1])).toEqual(['0,94', '2,96']);
    expect(html).not.toContain('2026-07: target');
  });

  it('leaves target gaps for individual series columns', () => {
    const start = app.indexOf('  const multiSeriesTargets =');
    const block = app.slice(start, app.indexOf('  const yieldVisual =', start));
    const draw = new Function('selectedSeriesMetrics', 'buckets', 'slot', 'x', 'yieldY', 'escapeHtml',
      `${targetHelpers}\n${block}\nreturn multiSeriesTargets;`);
    const buckets = ['2026-06', '2026-07', '2026-08'].map((month) => ({ month }));
    const series = [{ label: 'FPS A1', color: '#123456', values: [{ target: 94 }, {}, { target: 96 }] }];
    const html = draw(series, buckets, 100, (index) => index, (value) => value, String);
    expect([...html.matchAll(/class="target-line ta-yield-series-target"[^>]*points="([^"]*)"/g)].map((line) => line[1])).toEqual(['0,94', '2,96']);
    expect(html).not.toContain('2026-07 | FPS A1: target');
  });

  it('leaves gaps in Line view and omits unsaved aggregate targets', () => {
    const block = app.slice(app.indexOf('function renderTaYieldMultiSeriesChart'), app.indexOf('function scrollTaYieldTendencyToLatest'));
    const holder = { innerHTML: '' };
    const draw = new Function('byId', 'escapeHtml', 'chartColors', `${targetHelpers}\n${block}\nreturn renderTaYieldMultiSeriesChart;`)(() => holder, String, ['#123456']);
    const buckets = ['2026-06', '2026-07', '2026-08'].map((month) => ({ month, yield: 90 }));
    const rows = buckets.map(({ month }) => row('FPS series A1', 100, month));
    draw(rows, buckets, new Map([['2026-06', 94], ['2026-08', 96]]), String, true, 'Total Target', 'Total Yield');
    expect([...holder.innerHTML.matchAll(/class="ta-yield-total-target-line" points="([^"]*)"/g)].map((line) => line[1].split(' ').length)).toEqual([1, 1]);
    expect(holder.innerHTML).not.toContain('2026-07 | Total Target');
    draw(rows, buckets, new Map(), String, true, 'Combined Target', 'Combined Yield');
    expect(holder.innerHTML).not.toContain('ta-yield-total-target-line');
    expect(holder.innerHTML).not.toContain('Combined Target');
    expect(holder.innerHTML).toContain('2026-07 | Combined Yield: 90.00%');
  });
});
