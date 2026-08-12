import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('TA Yield Calculation Log', () => {
  it('provides a TA-only calculation-log tab and keeps mode evidence out of the lot table', () => {
    const html = read('public/index.html');
    const app = read('public/app.js');

    expect(html).toContain('id="taYieldLogTab"');
    expect(html).toContain('data-view="ta-yield-log"');
    expect(app).toContain('function ensureTaYieldLogView()');
    expect(app).toContain('function renderTaYieldCalculationLog(');
    expect(app).toContain('<th>Mode</th><th>Defect Yield Category</th>');
    expect(app).toContain('<details class="sc-yield-log-detail"><summary>${escapeHtml(series)}');
    expect(app).toContain('TA mode evidence');
    expect(app).toContain('SH fallback — PartType not in ParametersECP_v');
    expect(app).toContain('SH — acc_volt is 0 in ParametersECP_v');
    expect(app).toContain('ACC — PartType found in ParametersECP_v');
    expect(app).toContain('id="taYieldLogSeries"');
    expect(app).toContain('id="taYieldLogMode"');
    expect(app).toContain('id="taYieldLogCategory"');
    expect(app).toContain('id="taYieldLogSearch"');
    expect(app).toContain('All modes');
    expect(app).toContain('All categories');
    expect(app).toContain('Search Lot No or Mode');
    expect(app).toContain("focusTarget === 'search'");
    expect(app).toContain('requestId === dataRequestId && detailUrl === latestTaYieldLotsUrl');
    expect(app).toContain('function ensureTaYieldLotSeriesControl()');
    expect(app).toContain('Select a series to display lot details.');
    expect(app).toContain('requestId !== dataRequestId || detailUrl !== latestTaYieldLotsUrl');
    expect(app).not.toContain('<th>MES mode / yield category</th>');
  });
});
