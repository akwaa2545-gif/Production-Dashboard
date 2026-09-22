import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { TtlCache } from '../src/ttlCache.js';

const environment = {
  SQL_SERVER: 'test-server',
  SQL_DATABASE: 'test-report-db',
  DB_AUTH: 'ActiveDirectoryInteractive',
  DATE_COLUMN: 'completedAt'
};

function repositories() {
  return {
    repository: { getQuantity: vi.fn().mockResolvedValue([{ bucketDate: '2026-09-01', quantityMoved: 10 }]) },
    scYieldRepository: { getYieldRows: vi.fn().mockResolvedValue({ inputs: [], defects: [] }) },
    taYieldRepository: { getYieldRows: vi.fn().mockResolvedValue([{ inputQ: 20 }]) }
  };
}

function stagingRepositories() {
  return {
    staging901Repository: { getQuantity: vi.fn().mockResolvedValue([{ bucketDate: '2026-09-01', quantityMoved: 90 }]) },
    stagingWipRepository: { getQuantity: vi.fn().mockResolvedValue([{ bucketDate: '2026-09-01', quantityMoved: 80 }]) },
    scYieldStagingRepository: {
      getYieldRows: vi.fn(async (_filters, bucket = 'month') => ({
        inputs: [{ bucketMonth: bucket === 'week' ? '2026-09-07' : '2026-09', line: 'FM', quantity: 100 }],
        defects: []
      }))
    },
    taYieldStagingRepository: { getYieldRows: vi.fn().mockResolvedValue([{ inputQ: 70 }]) }
  };
}

function expectNoLiveQueries(live) {
  expect(live.repository.getQuantity).not.toHaveBeenCalled();
  expect(live.scYieldRepository.getYieldRows).not.toHaveBeenCalled();
  expect(live.taYieldRepository.getYieldRows).not.toHaveBeenCalled();
}

describe('current month cache warmer', () => {
  it('warms each cache from its staging repository with the existing filters and row shapes', async () => {
    const live = repositories();
    const staging = stagingRepositories();
    const cache = new TtlCache();
    const app = createApp({ environment, ...live, ...staging, cache });

    const { status, filters } = await app.warmCurrentMonthCaches();

    expect(status).toBe('WARMED');
    expectNoLiveQueries(live);
    for (const [dataset, source] of [['closed', staging.staging901Repository], ['lot', staging.stagingWipRepository]]) {
      expect(source.getQuantity).toHaveBeenCalledTimes(2);
      for (const product of ['NEO', 'SC']) {
        const scopedFilters = { ...filters, product };
        expect(source.getQuantity).toHaveBeenCalledWith(scopedFilters);
        expect(cache.getStale(`${dataset}:quantity:${JSON.stringify(scopedFilters)}`)).toEqual(await source.getQuantity.mock.results[0].value);
      }
    }
    expect(staging.scYieldStagingRepository.getYieldRows).toHaveBeenCalledTimes(2);
    expect(staging.scYieldStagingRepository.getYieldRows).toHaveBeenNthCalledWith(1, filters);
    expect(staging.scYieldStagingRepository.getYieldRows).toHaveBeenNthCalledWith(2, filters, 'week');
    expect(cache.getStale(`yield:summary:${JSON.stringify(filters)}`)).toEqual([expect.objectContaining({ month: '2026-09', input: 100, yield: 100 })]);
    expect(cache.getStale(`yield:weekly:${JSON.stringify(filters)}`)).toEqual([expect.objectContaining({ month: '2026-09-07', input: 100, yield: 100 })]);
    expect(staging.taYieldStagingRepository.getYieldRows).toHaveBeenCalledExactlyOnceWith(filters);
    expect(cache.getStale(`ta-yield:rows:${JSON.stringify(filters)}`)).toEqual([{ inputQ: 70 }]);

    await app.warmCurrentMonthCaches();
    expect(staging.staging901Repository.getQuantity).toHaveBeenCalledTimes(2);
    expect(staging.stagingWipRepository.getQuantity).toHaveBeenCalledTimes(2);
    expect(staging.scYieldStagingRepository.getYieldRows).toHaveBeenCalledTimes(2);
    expect(staging.taYieldStagingRepository.getYieldRows).toHaveBeenCalledTimes(1);
    expectNoLiveQueries(live);
  });

  it('retains direct source warming when staging is absent', async () => {
    const live = repositories();
    const app = createApp({ environment, ...live });

    const { status, filters } = await app.warmCurrentMonthCaches();

    expect(status).toBe('WARMED');
    expect(live.repository.getQuantity.mock.calls).toEqual([
      [{ ...filters, product: 'NEO' }], [{ ...filters, product: 'SC' }],
      [{ ...filters, product: 'NEO' }], [{ ...filters, product: 'SC' }]
    ]);
    expect(live.scYieldRepository.getYieldRows.mock.calls).toEqual([[filters], [filters, 'week']]);
    expect(live.taYieldRepository.getYieldRows).toHaveBeenCalledExactlyOnceWith(filters);
  });

  it.each([
    ['staging901Repository', 'getQuantity'],
    ['stagingWipRepository', 'getQuantity'],
    ['scYieldStagingRepository', 'getYieldRows'],
    ['taYieldStagingRepository', 'getYieldRows']
  ])('reports %s failure without falling back to MES and permits a subsequent retry', async (name, method) => {
    const live = repositories();
    const staging = stagingRepositories();
    staging[name][method].mockRejectedValueOnce(new Error('Staging unavailable'));
    const app = createApp({ environment, ...live, ...staging });

    await expect(app.warmCurrentMonthCaches()).rejects.toThrow('Staging unavailable');
    expectNoLiveQueries(live);
    await expect(app.warmCurrentMonthCaches()).resolves.toEqual(expect.objectContaining({ status: 'WARMED' }));
    expectNoLiveQueries(live);
  });
});
