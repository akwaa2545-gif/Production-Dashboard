import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('SC Yield and defect tendency chart', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  const start = app.indexOf('function renderScYieldTendencyCharts');
  const end = app.indexOf('function renderTaYieldTendencySkeleton', start);
  const renderer = app.slice(start, end);

  it('matches the TA tendency layout without a part-number filter', () => {
    expect(app).toContain("let scYieldTrendSeries = 'Total'");
    expect(app).toContain("let scYieldInterval = 'month'");
    expect(renderer).toContain('Total quality trend');
    expect(renderer).toContain('Yield and defect tendency');
    expect(renderer).toContain('id="scYieldTrendSeries"');
    expect(renderer).toContain('id="scYieldInterval"');
    expect(renderer).toContain('id="scYieldTrendChartType"');
    expect(renderer).toContain('<option value="day"');
    expect(renderer).toContain('<option value="week"');
    expect(renderer).toContain('<option value="month"');
    expect(renderer).toContain('id="scYieldYieldChart"');
    expect(renderer).toContain('id="scYieldDefectChart"');
    expect(renderer).toContain('<option value="summary"');
    expect(renderer).toContain('>Column</option>');
    expect(renderer).toContain('<option value="line"');
    expect(renderer).toContain('>Line</option>');
    expect(renderer).not.toContain('Part number');
    expect(renderer).not.toContain('trendPn');
  });

  it('filters series locally and reloads only when grouping changes', () => {
    expect(renderer).toContain("scYieldTrendSeries = byId('scYieldTrendSeries').value");
    expect(renderer).toContain("renderScYieldTendencyCharts(latestScYieldTendencyData, 'scYieldTrendSeries')");
    expect(renderer).toContain("scYieldInterval = byId('scYieldInterval').value");
    expect(renderer).toContain("loadScYieldTendency('scYieldInterval')");
    expect(renderer).toContain("renderScYieldTendencyCharts(latestScYieldTendencyData, 'scYieldTrendChartType')");
    expect(renderer).toContain("const trendRows = scYieldTrendSeries === 'Total' ? rows : rows.filter((row) => row.line === scYieldTrendSeries)");
    expect(styles).toContain('#scYieldChart { grid-column: 1 / -1;');
    expect(renderer).toContain('class="sc-yield-chart-scroll" tabindex="0"');
    expect(renderer).toContain('class="table-wrap" tabindex="0"');
    expect(renderer).toContain('role="status" aria-live="polite" aria-atomic="true"');
    expect(renderer).not.toContain("mark.setAttribute('tabindex', '0')");
  });

  it('loads an interval-specific SC tendency dataset', () => {
    expect(app).toContain("request(`/api/sc-yield-tendency?${tendencyParams}`)");
    expect(app).toContain("tendencyParams.set('interval', scYieldInterval)");
    expect(app).toContain("scYieldInterval === 'month' ? Promise.resolve(undefined)");
    expect(app).toContain('latestScYieldTendencyData = tendencyRows || rows');
    expect(app).toContain('scYieldTendencyRequestId += 1');
    expect(app).toContain("['scYieldTrendSeries', 'scYieldInterval', 'scYieldTrendChartType']");
  });

  it('keeps the SC Yield detail table scrollable to about ten visible rows', () => {
    const index = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    expect(index).toContain('id="scYieldTableWrap" class="table-wrap sc-yield-table-scroll" role="region"');
    expect(index).toContain('aria-label="Scrollable SC Yield detail table"');
    expect(styles).toContain('.sc-yield-table-scroll { max-height: 500px; overflow: auto; }');
    expect(styles).toContain('.sc-yield-table-scroll thead th { position: sticky; top: 0;');
  });
});
