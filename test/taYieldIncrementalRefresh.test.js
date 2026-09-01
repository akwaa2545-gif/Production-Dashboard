import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mergeTaWorkbookLots, taYieldRefreshPlan } from '../src/taYieldRefreshPlan.js';

describe('TA Yield scheduled staging refresh', () => {
  it('resumes from the day after the current-month snapshot instead of reloading prior days', async () => {
    const plan = taYieldRefreshPlan({ startDate: '2026-09-01', endDate: '2026-09-03' }, { scopeStart: '2026-09-01', scopeEnd: '2026-09-02' });

    expect(plan).toEqual({ mode: 'RESUME' });
  });

  it('refreshes the current day when the current-month snapshot is already current', async () => {
    const plan = taYieldRefreshPlan({ startDate: '2026-09-01', endDate: '2026-09-03' }, { scopeStart: '2026-09-01', scopeEnd: '2026-09-03' });

    expect(plan).toEqual({ mode: 'REFRESH_CURRENT' });
  });

  it('replaces current-day lots that MES has removed instead of retaining them', () => {
    const lots = mergeTaWorkbookLots(
      [{ lotNo: 'OLD', tapingDate: '2026-09-03T01:00:00.000Z' }, { lotNo: 'PRIOR', tapingDate: '2026-09-02T01:00:00.000Z' }],
      [{ lotNo: 'NEW', tapingDate: '2026-09-03T02:00:00.000Z' }],
      { replaceDate: '2026-09-03', dateForLot: (lot) => lot.tapingDate.slice(0, 10), keyForLot: (lot) => lot.lotNo }
    );

    expect(lots.map((lot) => lot.lotNo)).toEqual(['PRIOR', 'NEW']);
  });

  it('publishes the workbook snapshot only after the summary and machine stages succeed', () => {
    const refresh = readFileSync('src/app.js', 'utf8').slice(
      readFileSync('src/app.js', 'utf8').indexOf('app.refreshTaYieldStaging ='),
      readFileSync('src/app.js', 'utf8').indexOf('app.refreshTaYieldStagingResume =')
    );

    expect(refresh.indexOf('replaceMonthlySummary(monthlySummary, filters)')).toBeLessThan(refresh.indexOf('replaceWorkbookRows(workbookLots, filters)'));
    expect(refresh.indexOf('replaceMachineRows(machineEvents, workbookLots, filters)')).toBeLessThan(refresh.indexOf('replaceWorkbookRows(workbookLots, filters)'));
  });

  it('reads an available staged workbook snapshot before falling back to direct MES', () => {
    const app = readFileSync('src/app.js', 'utf8');
    const readRows = app.slice(app.indexOf('async function sharedTaWorkbookYieldRows'), app.indexOf('async function sharedTaMachineSnapshotLots'));

    expect(readRows).toContain('try { return await taYieldStaging.getWorkbookRows(filters); }');
    expect(readRows).not.toContain('hasWorkbookCoverage(filters)');
  });

  it('repairs one historical day without deleting the other days in its monthly snapshot', () => {
    const app = readFileSync('src/app.js', 'utf8');
    const repairStart = app.indexOf('app.refreshTaYieldStagingDay =');
    const repair = app.slice(repairStart, app.indexOf('app.refreshTaYieldStagingHistory ='));

    expect(repairStart).toBeGreaterThan(-1);
    expect(repair).toContain('mergeTaWorkbookLots(snapshot.rows, freshLots, { replaceDate: repairFilters.startDate');
    expect(repair).toContain('replaceMonthlySummary(monthlySummary, monthFilters)');
    expect(repair).toContain('replaceMachineRowsForLots(machineEvents, freshLots, monthFilters, { lotNumbersToRemove: previousDayLots.map((lot) => lot.lotNo) })');
    expect(repair).toContain('replaceWorkbookRows(mergedLots, publishFilters)');
    expect(repair).toContain('source.getMachineEvents(monthFilters');
    expect(repair).not.toContain('actionLookbackMonths: 0');
  });
});
