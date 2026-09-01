import { describe, expect, it } from 'vitest';
import { stagingIncrementalRefreshFilters, stagingIncrementalRefreshPlan } from '../src/stagingRefreshPlan.js';

describe('stagingIncrementalRefreshPlan', () => {
  const month = { startDate: '2026-09-01', endDate: '2026-09-03' };

  it('backfills every missing day after the last staged day', () => {
    expect(stagingIncrementalRefreshPlan(month, '2026-09-01')).toEqual({ startDate: '2026-09-02', endDate: '2026-09-03' });
  });

  it('rechecks only the current day after staging is current', () => {
    expect(stagingIncrementalRefreshPlan(month, '2026-09-03')).toEqual({ startDate: '2026-09-03', endDate: '2026-09-03' });
  });

  it('loads the current month when staging has no current-month data', () => {
    expect(stagingIncrementalRefreshPlan(month, '2026-08-31')).toEqual(month);
    expect(stagingIncrementalRefreshPlan(month, undefined)).toEqual(month);
  });

  it('accepts SQL date values from staging activity', () => {
    expect(stagingIncrementalRefreshPlan(month, new Date('2026-09-02T00:00:00.000Z'))).toEqual({ startDate: '2026-09-03', endDate: '2026-09-03' });
  });
});

describe('stagingIncrementalRefreshFilters', () => {
  const month = { startDate: '2026-09-01', endDate: '2026-09-03' };

  it('bootstraps a missing staging table with the full current month', async () => {
    const target = { getActivity: () => Promise.reject(Object.assign(new Error("Invalid object name 'dbo.Dashboard901Daily'."), { number: 208 })) };

    await expect(stagingIncrementalRefreshFilters(target, month)).resolves.toEqual(month);
  });

  it('does not hide activity failures other than a missing staging table', async () => {
    const target = { getActivity: () => Promise.reject(new Error('staging database is unavailable')) };

    await expect(stagingIncrementalRefreshFilters(target, month)).rejects.toThrow('staging database is unavailable');
  });
});
