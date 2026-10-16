import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';

vi.mock('../src/taYieldMapping.js', async (original) => ({
  ...await original(),
  loadTaWorkbookReconciliationMapping: async () => new Map()
}));

const lots = [{ lotNo: 'TA-CALCULATED', line: 'FPS', itemName: 'PART', tapingDate: '2026-10-16', categories: { Input: 100, Good: 90, App: 10 } }];
const filters = { startDate: '2026-10-01', endDate: '2026-10-16' };

function fixture() {
  const getMachineEvents = vi.fn(async () => []);
  const staging = {
    getLatestWorkbookSnapshotForMonth: vi.fn(async () => ({ scopeStart: filters.startDate, scopeEnd: '2026-10-15', rows: [] })),
    replaceMonthlySummary: vi.fn(async () => {}), replaceMachineRows: vi.fn(async () => {}),
    replaceMachineRowsForLots: vi.fn(async () => {}), replaceWorkbookRows: vi.fn(async () => {})
  };
  const app = createApp({
    environment: { SQL_SERVER: 'fixture', SQL_DATABASE: 'fixture', DASHBOARD_TA_YIELD_LATE_ARRIVAL_DAYS: '1' },
    taYieldRepository: { getWorkbookReconciliationRows: async () => lots, getMachineEvents },
    taYieldStagingRepository: staging
  });
  return { app, getMachineEvents, staging };
}

describe('TA calculated lot all-process staging refresh', () => {
  it.each(['full', 'resume', 'day'])('loads every operation in the %s refresh using only calculated lot identifiers', async (mode) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-16T05:00:00Z'));
    try {
      const { app, getMachineEvents, staging } = fixture();
      if (mode === 'full') await app.refreshTaYieldStaging(filters);
      if (mode === 'resume') await app.refreshTaYieldStagingResume();
      if (mode === 'day') await app.refreshTaYieldStagingDay({ date: '2026-10-16' });
      expect(getMachineEvents).toHaveBeenCalledTimes(1);
      const [scope, options] = getMachineEvents.mock.calls[0];
      expect(options.lotNumbers).toEqual(['TA-CALCULATED']);
      expect(options.processName).toBeUndefined();
      expect(options.processPattern).toBeUndefined();
      expect(scope.startDate).toBe(filters.startDate);
      expect(scope.endDate).toBe(mode === 'day' ? '2026-10-31' : filters.endDate);
      expect(staging.replaceWorkbookRows).toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
