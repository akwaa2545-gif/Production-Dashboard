import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(new URL('../public/ta-yield-compare.js', import.meta.url), 'utf8');
const styles = fs.readFileSync(new URL('../public/ta-yield-compare.css', import.meta.url), 'utf8');
const context = vm.createContext({ window: {}, Intl, Date, URLSearchParams });
vm.runInContext(source, context);
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const graphs = (groups, extra = {}) => context.taYieldCompareLookupGraphs({ groups, ...extra }, escapeHtml);
const group = (name, current, compare, delta) => ({ group: name, currentRate: current, compareRate: compare, deltaRate: delta });

describe('Compare LOOKUP visual analysis', () => {
  it('names graph periods with the returned dates and the selected series', () => {
    const html = graphs([group('ESR', 0.78, 0.72, 0.06), group('Other2', 0, 0, 0)], {
      selection: { label: 'FPS A3' },
      currentRange: { startDate: '2026-09-05', endDate: '2026-09-20' },
      compareRange: { startDate: '2026-08-05', endDate: '2026-08-20' }
    });
    expect(html).toContain('5–20 Sep 2026 (Report dates)');
    expect(html).toContain('5–20 Aug 2026 (Compare with)');
    expect(html).toContain('Report dates 5–20 Sep 2026 0.78%');
    expect(html).toContain('Compare with 5–20 Aug 2026 0.72%');
    const values = [...html.matchAll(/class="ta-lookup-chart-value"[^>]*>([^<]*)<\/text>/g)].map((match) => match[1]);
    expect(values.slice(0, 2)).toEqual(['0.78%', '0.72%']);
    expect(values.every((value) => !/Sep|Aug/.test(value))).toBe(true);
    expect(html).toContain('Defect rates by group · FPS A3');
    expect(html).toContain('5–20 Sep 2026 minus 5–20 Aug 2026');
    expect(html).not.toMatch(/Selected:|Comparison:|Selected Report period|Comparison period/);
  });

  it('formats exact single dates, cross-month/year ranges and unknown periods without calendar defaults', () => {
    const period = context.taYieldLookupPeriod;
    expect(typeof period).toBe('function');
    expect(period({ startDate: '2026-10-01', endDate: '2026-10-01' }, 'Report dates unavailable')).toBe('1 Oct 2026');
    expect(period({ startDate: '2026-08-31', endDate: '2026-09-02' })).toBe('31 Aug–2 Sep 2026');
    expect(period({ startDate: '2025-12-31', endDate: '2026-01-02' })).toBe('31 Dec 2025–2 Jan 2026');
    expect(period({ startDate: '2026-02-30', endDate: '2026-03-02' }, 'Report dates unavailable')).toBe('Report dates unavailable');
    expect(period({ startDate: '2026-09-20', endDate: '2026-09-05' }, 'Report dates unavailable')).toBe('Report dates unavailable');
    expect(period({ startDate: '2024-02-29', endDate: '2024-02-29' })).toBe('29 Feb 2024');
    expect(period({ startDate: '2026-02-01', endDate: '2026-02-28' })).toBe('1–28 Feb 2026');
    const html = graphs([group('ESR', null, 0, null)], { selection: { label: '<img src=x>' } });
    expect(html).toContain('Report dates Report dates unavailable N/A');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x&gt;');
    const sameDates = { startDate: '2026-10-01', endDate: '2026-10-01' };
    const equalPeriods = graphs([group('ESR', 1, 2, -1)], { currentRange: sameDates, compareRange: sameDates });
    expect(equalPeriods).toContain('1 Oct 2026 (Report dates)');
    expect(equalPeriods).toContain('1 Oct 2026 (Compare with)');
  });

  it('fills the main chart width without stretching LOOKUP charts to oversized dimensions', () => {
    const html = context.taYieldCompareChart([{ label: 'FPS A3', currentYield: 91, compareYield: 92, delta: -1 }], escapeHtml, 1600);
    expect(html).toMatch(/viewBox="0 0 1600 \d+"/);
    expect(styles.match(/\.ta-compare-chart-card \{([^}]+)\}/)[1]).toContain('height: auto');
    expect(styles).not.toMatch(/\.ta-compare-chart-card \{ height: 350px/);
    expect(styles.match(/\.ta-compare-chart svg \{([^}]+)\}/)[1]).toContain('height: auto');
    expect(styles.match(/\.ta-lookup-graph-scroll svg \{([^}]+)\}/)[1]).toContain('width: 100%');
    expect(styles.match(/\.ta-lookup-graphs \{([^}]+)\}/)[1]).toContain('repeat(auto-fit, minmax(min(100%, 620px), 1fr))');
    expect(styles.match(/\.ta-lookup-graph-scroll \{([^}]+)\}/)[1]).toContain('max-height: 420px');
  });

  it('uses actual periods across summary, main chart tooltips, defect tables and jobs', () => {
    const data = { currentRange: { startDate: '2026-09-01', endDate: '2026-09-30' }, compareRange: { startDate: '2026-07-01', endDate: '2026-07-30' } };
    const rows = [{ label: 'Total', currentYield: 98, compareYield: 97, delta: 1 }];
    const html = context.taYieldCompareAnalysisTable(rows, escapeHtml, data) + context.taYieldCompareChart(rows, escapeHtml, 900, data) + context.taYieldCompareInvestigation({ ...data, groups: [] }, 0, escapeHtml);
    expect(html).toContain('1–30 Sep 2026 (Report dates)');
    expect(html).toContain('1–30 Jul 2026 (Compare with)');
    expect(html).toContain('1–30 Sep 2026 (Report dates): 98.00%');
    expect(html).not.toMatch(/Selected Report period|Comparison period|Selected qty|Selected rate|Comparison qty|Comparison rate|Current:|Comparison:/);
  });

  it('fits LOOKUP plot geometry to the card without scaling labels or allowing bars into the value column', () => {
    const rows = [group('ESR', 2, 1, 1)];
    const periods = { current: '1–30 Sep 2026', compare: '1–30 Jul 2026' };
    for (const width of [620, 900, 1300]) {
      const html = context.taYieldLookupRateGraph(rows, escapeHtml, periods, width);
      expect(html).toContain(`viewBox="0 0 ${width} `);
      const bar = html.match(/data-period="current"[^>]*x="([\d.]+)"[^>]*width="([\d.]+)"/);
      expect(Number(bar[1]) + Number(bar[2])).toBeLessThanOrEqual(width - 150);
      const change = context.taYieldLookupChangeGraph(rows, escapeHtml, periods, width);
      expect(change).toContain(`viewBox="0 0 ${width} `);
      expect(change).not.toMatch(/(?:width|height|x|y)="(?:NaN|Infinity|-Infinity)/);
    }
  });

  it('uses LOOKUP for user-visible actions, headings and announcements', () => {
    const table = context.taYieldCompareAnalysisTable([{ label: 'FPS A3' }], escapeHtml);
    expect(table).toContain('>LOOKUP</button>');
    expect(table).toContain('aria-label="LOOKUP FPS A3"');
    expect(source).not.toMatch(/(?:>Investigate<|Investigate \$\{|Investigation loaded|Close investigation|Retry investigation|bar to investigate)/);
  });

  it('draws paired defect rates on a shared scale and a signed percentage-point change graph', () => {
    const html = graphs([group('ESR', 10, 5, 5), group('LC', 2, 4, -2)]);
    expect(html.match(/<svg\b/g)).toHaveLength(2);
    expect(html).toContain('Defect rates by group');
    expect(html).toContain('Defect-rate change');
    expect(html).toContain('data-period="current" data-rate="10"');
    expect(html).toContain('data-period="compare" data-rate="5"');
    const widths = [...html.matchAll(/data-period="(?:current|compare)" data-rate="(?:10|5)"[^>]*width="([\d.]+)"/g)].map((match) => Number(match[1]));
    expect(widths).toHaveLength(2);
    expect(widths[0]).toBeCloseTo(widths[1] * 2);
    expect(html).toContain('5.00 pp');
    expect(html).toContain('(2.00) pp');
    expect(html).toContain('Increased defects');
    expect(html).toContain('Decreased defects');
    expect(html).toContain('fill="#d32f2f"');
    expect(html).toContain('fill="#008a3e"');
  });

  it('keeps signed Other2 separate from physical defect graphs', () => {
    const html = graphs([group('ESR', 1, 2, -1), group('Other2', -2, 1, -3)]);
    expect(html).toContain('Other2');
    expect(html).toContain('Reconciliation adjustment');
    expect(html).toContain('(2.00)%');
    expect(html).toContain('(3.00) pp');
    expect(html).not.toContain('data-lookup-group="Other2"');
  });

  it('shows unavailable rates as N/A, distinguishes zero, and avoids invalid SVG dimensions', () => {
    const html = graphs([group('ESR', null, 0, null), group('LC', 0, 0, 0), group('ACC', NaN, Infinity, null)]);
    expect(html).toContain('N/A');
    expect(html).toContain('0.00%');
    expect(html).toContain('No change');
    expect(html).not.toMatch(/(?:width|height|x|y)="(?:NaN|Infinity|-Infinity)/);
    expect(html).not.toContain('data-rate="null"');
  });

  it('escapes group names and keeps graphs independent of paged job records', () => {
    const groups = [group('<img src=x onerror="bad">', 1, 2, -1)];
    const first = graphs(groups, { lots: { current: { rows: [{ lotNo: 'first' }] } } });
    const next = graphs(groups, { lots: { current: { rows: [{ lotNo: 'next' }] } } });
    expect(first).toBe(next);
    expect(first).not.toContain('<img');
    expect(first).toContain('&lt;img src=x onerror=&quot;bad&quot;&gt;');
  });

  it('provides accessible chart descriptions and explicit empty states', () => {
    const html = graphs([group('ESR', 1, 2, -1)]);
    expect(html.match(/role="img"/g)).toHaveLength(2);
    expect(html).toContain('<title>');
    expect(html).toContain('Compare dates unavailable');
    const empty = graphs([]);
    expect(empty).toContain('No defect-rate data');
    expect(empty).not.toContain('<svg');
    const adjustmentOnly = graphs([group('Other2', 1, 0, 1)]);
    expect(adjustmentOnly).toContain('Reconciliation adjustment');
    expect(adjustmentOnly).not.toContain('<svg');
  });

  it('preserves negative staged rates with a signed baseline and explanation', () => {
    const html = graphs([group('ESR', -2, -1, -1)]);
    const widths = [...html.matchAll(/data-rate="-[12]"[^>]*width="([\d.]+)"/g)].map((match) => Number(match[1]));
    expect(widths).toHaveLength(2);
    expect(widths.every((width) => width > 0)).toBe(true);
    expect(html).toContain('Negative rates are signed staged values');
    expect(html).toContain('(2.00)%');
  });

  it('uses the available change plot for small differences instead of forcing a one-point range', () => {
    const html = context.taYieldLookupChangeGraph([group('ESR', 1.01, 1, 0.01)], escapeHtml);
    const width = Number(html.match(/<rect[^>]*width="([\d.]+)"/)[1]);
    expect(width).toBeCloseTo(210);
    expect(html).toContain('(0.005) pp');
    expect(html).toContain('0.005 pp');
  });

  it('renders graphs in LOOKUP above the tables and keeps Other2 table changes neutral', () => {
    const html = context.taYieldCompareInvestigation({ groups: [group('ESR', 1, 2, -1), group('Other2', -2, 1, -3)] }, 50, escapeHtml);
    expect(html.indexOf('ta-lookup-visuals')).toBeLessThan(html.indexOf('<table'));
    expect(html.match(/<svg\b/g)).toHaveLength(2);
    const adjustmentRow = html.match(/<tr><th scope="row">Other2[^]*?<\/tr>/)[0];
    expect(adjustmentRow).not.toContain('ta-compare-better');
    expect(adjustmentRow).not.toContain('ta-compare-worse');
  });
});
