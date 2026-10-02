import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';

vi.mock('../src/taYieldMapping.js', async (importOriginal) => ({ ...await importOriginal(), loadTaWorkbookReconciliationMapping: async () => new Map() }));

const environment = { SQL_SERVER: 'test', SQL_DATABASE: 'test', DB_AUTH: 'ActiveDirectoryInteractive', DB_VIEW: 'dbo.LotCompleteLog', DATE_COLUMN: 'completedAt', DASHBOARD_TA_YIELD_STAGING_ENABLED: 'true', STAGING_SQL_SERVER: 'test', STAGING_SQL_DATABASE: 'test', STAGING_SQL_USER: 'test', STAGING_SQL_PASSWORD: 'test' };
const lot = (month, input, good) => ({ line: 'Ta NEO Capacitor FPS series A3 case', lotNo: `${month}-lot`, itemName: 'PN1', tapingDate: `${month}-01`, categories: { Input: input, Good: good } });

describe('TA yield Compare API', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-08T19:00:00Z')); });
  afterEach(() => vi.useRealTimers());
  it('matches report days in fair-period mode and provides stable investigation keys', async () => {
    const workbook = vi.fn(async (filters) => [lot(filters.startDate.slice(0, 7), 100, 90)]);
    const response = await request(createApp({ environment, taYieldStagingRepository: { getWorkbookRows: workbook } })).get('/api/ta-yield-compare?dataset=ta-yield&startDate=2026-09-07&endDate=2026-09-18&comparisonMode=same-dates');
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ comparisonMode: 'same-dates', compareRange: { startDate: '2026-08-07', endDate: '2026-08-18' } });
    expect(response.body.data.rows[0]).toMatchObject({ key: 'Total', currentInput: 100, currentGood: 90 });
    expect(response.body.data.rows[1].key).toBe('STD');
    expect(response.body.data.rows[4].key).toBe('TA NEO CAPACITOR FPS SERIES A3 CASE');
  });

  it('uses Bangkok current month to date and the previous complete month', async () => {
    const workbook = vi.fn(async (filters) => [lot(filters.startDate.slice(0, 7), 100, filters.startDate === '2026-10-01' ? 95 : 90)]);
    const response = await request(createApp({ environment, taYieldStagingRepository: { getWorkbookRows: workbook } })).get('/api/ta-yield-compare?dataset=ta-yield');
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ currentMonth: '2026-10', compareMonth: '2026-09', currentRange: { startDate: '2026-10-01', endDate: '2026-10-09' }, compareRange: { startDate: '2026-09-01', endDate: '2026-09-30' } });
    expect(response.body.data.rows[0]).toMatchObject({ currentYield: 95, compareYield: 90, delta: 5 });
    expect(workbook).toHaveBeenCalledTimes(2);
  });

  it('compares historical full months using cached monthly summaries without double-counting defect rows', async () => {
    const monthly = vi.fn(async (filters) => ['ESR', 'ACC'].map((group) => ({ month: filters.startDate.slice(0, 7), line: 'FPS A3', group, input: 1000, finalGood: filters.startDate === '2026-09-01' ? 910 : 900, defect: 10 })));
    const workbook = vi.fn(async () => { throw new Error('Full months must use staging summaries'); });
    const app = createApp({ environment, taYieldStagingRepository: { getMonthlySummary: monthly, getMonthlyPartNumbers: async () => [], getWorkbookRows: workbook } });
    const endpoint = '/api/ta-yield-compare?dataset=ta-yield&currentMonth=2026-09&compareMonth=2026-08';
    const first = await request(app).get(endpoint);
    expect(first.status).toBe(200);
    expect(first.body.data.rows[0]).toMatchObject({ currentInput: 1000, compareInput: 1000, currentYield: 91, compareYield: 90, delta: 1 });
    expect((await request(app).get(endpoint)).body).toEqual(first.body);
    expect(monthly).toHaveBeenCalledTimes(2);
    expect(workbook).not.toHaveBeenCalled();
  });

  it('retains series and part number filters and exact selected report dates', async () => {
    const workbook = vi.fn(async (filters) => [lot(filters.startDate.slice(0, 7), 100, 90)]);
    const response = await request(createApp({ environment, taYieldStagingRepository: { getWorkbookRows: workbook } })).get('/api/ta-yield-compare?dataset=ta-yield&startDate=2026-01-01&endDate=2026-01-02&serie=Ta%20NEO%20Capacitor%20FPS%20series%20A3%20case&pn=PN1');
    expect(response.status).toBe(200);
    expect(workbook.mock.calls.map(([filters]) => filters)).toEqual([
      { startDate: '2026-01-01', endDate: '2026-01-02', serie: 'Ta NEO Capacitor FPS series A3 case', pn: 'PN1' },
      { startDate: '2025-12-01', endDate: '2025-12-31', serie: 'Ta NEO Capacitor FPS series A3 case', pn: 'PN1' }
    ]);
  });

  it('uses partial and multi-month report ranges without substituting calendar month dates', async () => {
    const workbook = vi.fn(async (filters) => [lot(filters.startDate.slice(0, 7), 100, 90)]);
    const app = createApp({ environment, taYieldStagingRepository: { getWorkbookRows: workbook } });
    const partial = await request(app).get('/api/ta-yield-compare?dataset=ta-yield&startDate=2026-09-07&endDate=2026-09-18');
    expect(partial.status).toBe(200);
    expect(partial.body.data).toMatchObject({ currentRange: { startDate: '2026-09-07', endDate: '2026-09-18' }, compareMonth: '2026-08' });
    const multiMonth = await request(app).get('/api/ta-yield-compare?dataset=ta-yield&startDate=2026-01-12&endDate=2026-03-21&compareMonth=2026-08');
    expect(multiMonth.status).toBe(200);
    expect(multiMonth.body.data).toMatchObject({ currentRange: { startDate: '2026-01-12', endDate: '2026-03-21' }, compareMonth: '2026-08' });
    expect(workbook.mock.calls[0][0]).toEqual({ startDate: '2026-09-07', endDate: '2026-09-18' });
    expect(workbook.mock.calls[2][0]).toEqual({ startDate: '2026-01-12', endDate: '2026-03-21' });
  });

  it('keeps the monthly summary optimization for a selected complete calendar month', async () => {
    const monthly = vi.fn(async (filters) => [{ month: filters.startDate.slice(0, 7), line: 'FPS A3', group: 'ESR', input: 100, finalGood: 95, defect: 5 }]);
    const workbook = vi.fn(async () => []);
    const app = createApp({ environment, taYieldStagingRepository: { getMonthlySummary: monthly, getMonthlyPartNumbers: async () => [], getWorkbookRows: workbook } });
    const result = await request(app).get('/api/ta-yield-compare?dataset=ta-yield&startDate=2026-09-01&endDate=2026-09-30');
    expect(result.status).toBe(200);
    expect(monthly).toHaveBeenCalledTimes(2);
    expect(workbook).not.toHaveBeenCalled();
  });

  it.each([
    'startDate=2026-09-01', 'endDate=2026-09-30',
    'startDate=2026-09-30&endDate=2026-09-01',
    'startDate=not-a-date&endDate=2026-09-30',
    'startDate=2025-01-01&endDate=2026-09-30',
    'startDate=2026-09-01&startDate=2026-09-02&endDate=2026-09-30',
    'startDate=2026-09-01&endDate=2026-09-30&endDate=2026-09-29'
  ])('rejects invalid selected report ranges %s', async (range) => {
    const workbook = vi.fn(async () => []);
    const app = createApp({ environment, taYieldStagingRepository: { getWorkbookRows: workbook } });
    expect((await request(app).get(`/api/ta-yield-compare?dataset=ta-yield&${range}`)).status).toBe(400);
    expect(workbook).not.toHaveBeenCalled();
  });

  it.each(['dataset=closed', 'dataset=ta-yield&compareMonth=2026-13', 'dataset=ta-yield&currentMonth=2026-11', 'dataset=ta-yield&compareMonth=2026-09&compareMonth=2026-08', `dataset=ta-yield&pn=${'x'.repeat(201)}`])('rejects unsupported source and invalid inputs %s', async (query) => {
    expect((await request(createApp({ environment })).get(`/api/ta-yield-compare?${query}`)).status).toBe(400);
  });

  it('returns unavailable values for an empty month and propagates database errors', async () => {
    const empty = await request(createApp({ environment, taYieldStagingRepository: { getWorkbookRows: async () => [] } })).get('/api/ta-yield-compare?dataset=ta-yield');
    expect(empty.body.data.rows.every((row) => row.delta === null)).toBe(true);
    const app = createApp({ environment, taYieldRepository: { getWorkbookReconciliationRows: async () => { throw Object.assign(new Error('database details'), { code: 'ESOCKET' }); } }, taYieldStagingRepository: { getWorkbookRows: async () => { throw new Error('unavailable'); } } });
    const failure = await request(app).get('/api/ta-yield-compare?dataset=ta-yield');
    expect(failure.status).toBe(503);
    expect(failure.body.code).toBe('DATABASE_UNREACHABLE');
    expect(failure.body.error).not.toContain('database details');
  });
});
