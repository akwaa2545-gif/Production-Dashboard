import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { taYieldRefreshPlan } from '../src/taYieldRefreshPlan.js';

describe('TA Yield scheduled staging refresh', () => {
  it('resumes from the day after the current-month snapshot instead of reloading prior days', async () => {
    const plan = taYieldRefreshPlan({ startDate: '2026-09-01', endDate: '2026-09-03' }, { scopeStart: '2026-09-01', scopeEnd: '2026-09-02' });

    expect(plan).toEqual({ mode: 'RESUME' });
  });

  it('does not reload a day when the current-month snapshot is already current', async () => {
    const plan = taYieldRefreshPlan({ startDate: '2026-09-01', endDate: '2026-09-03' }, { scopeStart: '2026-09-01', scopeEnd: '2026-09-03' });

    expect(plan).toMatchObject({ mode: 'CURRENT', result: { status: 'ALREADY_CURRENT', startDate: '2026-09-01', endDate: '2026-09-03' } });
  });

  it('publishes the workbook snapshot only after the summary and machine stages succeed', () => {
    const refresh = readFileSync('src/app.js', 'utf8').slice(
      readFileSync('src/app.js', 'utf8').indexOf('app.refreshTaYieldStaging ='),
      readFileSync('src/app.js', 'utf8').indexOf('app.refreshTaYieldStagingResume =')
    );

    expect(refresh.indexOf('replaceMonthlySummary(monthlySummary, filters)')).toBeLessThan(refresh.indexOf('replaceWorkbookRows(workbookLots, filters)'));
    expect(refresh.indexOf('replaceMachineRows(machineEvents, workbookLots, filters)')).toBeLessThan(refresh.indexOf('replaceWorkbookRows(workbookLots, filters)'));
  });
});
