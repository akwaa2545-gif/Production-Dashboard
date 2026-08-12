import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('TA yield tendency', () => {

  it('splits total yield and defect charts with one Day, Week, or Month interval control', () => {
    const html = read('public/index.html');
    const app = read('public/app.js');

    expect(html).toContain('id="taYieldChart"');
    expect(app).toContain('id="taYieldInterval"');
    expect(app).toContain('id="taYieldYieldChart"');
    expect(app).toContain('id="taYieldDefectChart"');
    expect(app).toContain('function renderTaYieldTendencyCharts(');
    expect(app).toContain('/api/ta-yield-tendency?${tendencyParams}');
    expect(app).toContain('groups.reduce((total, group) => total + (row.groups[group] || 0), 0)');
    expect(app).toContain('function renderTaYieldTargetParameters()');
    expect(app).toContain('/api/ta-yield-targets');
    expect(app).toContain('id="taYieldTargetPeriod"');
    expect(app).toContain('id="taYieldTargetForm"');
    expect(app).toContain('const yieldColumns = buckets.map(');
    expect(app).toContain("' below-target'");
  });

  it('keeps the weekly and accumulated weekly tendency charts populated below the split charts', () => {
    const html = read('public/index.html');
    const app = read('public/app.js');

    expect(html).toContain('id="taYieldWeeklyChart"');
    expect(app).toContain('/api/ta-yield-weekly?${params}');
    expect(app).toContain('renderTaYieldWeeklyChart(weeklyRows);');
  });
});
