import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
vi.mock('../src/taYieldMapping.js', async (original) => ({ ...await original(), loadTaWorkbookReconciliationMapping: async () => new Map() }));
const environment = { SQL_SERVER: 'test', SQL_DATABASE: 'test', DB_AUTH: 'ActiveDirectoryInteractive', DB_VIEW: 'dbo.LotCompleteLog', DATE_COLUMN: 'completedAt' };
const line = 'Ta NEO Capacitor FPS series A3 case';
const base = '/api/ta-yield-compare-details?dataset=ta-yield&startDate=2026-09-07&endDate=2026-09-18&comparisonMode=same-dates&kind=total&key=Total';
const stagedLot = (filters, extra = {}) => ({ line, lotNo: '6K01N00052', itemName: 'PN1', tapingDate: filters.startDate, categories: { Input: 100, Good: 90, ESR: 10 }, ...extra });
const staging = (getWorkbookRows = async (filters) => [stagedLot(filters)]) => ({ hasWorkbookCoverage: vi.fn(async () => true), getWorkbookRows: vi.fn(getWorkbookRows) });
describe('staging-only Compare investigation API', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-08T19:00:00Z')); });
  afterEach(() => vi.useRealTimers());
  it('uses exact applied dates, pagination, staged job names, and cache without reading MES', async () => {
    const stage = staging(); const mes = vi.fn(async () => { throw new Error('MES must not be used'); });
    const app = createApp({ environment, taYieldStagingRepository: stage, taYieldRepository: { getWorkbookReconciliationRows: mes } });
    const first = await request(app).get(base);
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ dataSource: 'staging', selection: { kind: 'total', key: 'Total', label: 'Total' }, currentRange: { startDate: '2026-09-07', endDate: '2026-09-18' }, compareRange: { startDate: '2026-08-07', endDate: '2026-08-18' }, current: { input: 100, good: 90, lotCount: 1 }, lots: { current: { total: 1, offset: 0, limit: 50, rows: [{ lotNo: '6K01N00052' }] } } });
    expect((await request(app).get(base)).body).toEqual(first.body);
    expect(stage.getWorkbookRows).toHaveBeenCalledTimes(2);
    expect(mes).not.toHaveBeenCalled();
  });
  it('applies part-number and series filters before selection aggregation', async () => {
    const stage = staging(async (filters) => [stagedLot(filters), stagedLot(filters, { itemName: 'PN2', lotNo: 'other' })]);
    const response = await request(createApp({ environment, taYieldStagingRepository: stage })).get(`${base}&pn=PN1&serie=${encodeURIComponent(line)}`);
    expect(response.status).toBe(200); expect(response.body.data.current.lotCount).toBe(1);
  });
  it.each(['comparisonMode=bad', 'comparisonMode=same-dates&comparisonMode=full-month', 'kind=bad&key=Total', 'kind=total&key=bad', 'kind=total&key=Total&limit=101', 'kind=total&key=Total&offset=-1', 'kind=total&kind=series&key=Total'])('rejects invalid inputs without reads: %s', async (query) => {
    const stage = staging();
    const response = await request(createApp({ environment, taYieldStagingRepository: stage })).get(`/api/ta-yield-compare-details?dataset=ta-yield&startDate=2026-09-07&endDate=2026-09-18&${query}`);
    expect(response.status).toBe(400); expect(stage.getWorkbookRows).not.toHaveBeenCalled();
  });
  it('rejects calendar rollover dates before staging reads', async () => {
    const stage = staging();
    const response = await request(createApp({ environment, taYieldStagingRepository: stage })).get(base.replace('2026-09-07', '2026-02-01').replace('2026-09-18', '2026-02-31'));
    expect(response.status).toBe(400); expect(stage.getWorkbookRows).not.toHaveBeenCalled();
  });
  it.each(['missing', 'coverage', 'read', 'live'])('rejects unavailable staging safely without MES fallback: %s', async (failure) => {
    const stage = staging(); const mes = vi.fn(async () => []);
    if (failure === 'coverage') stage.hasWorkbookCoverage = async (filters) => filters.startDate.startsWith('2026-09');
    if (failure === 'read') stage.getWorkbookRows = async () => { throw new Error('secret database details'); };
    const response = await request(createApp({ environment: { ...environment, DASHBOARD_DATA_MODE: failure === 'live' ? 'live' : 'staging' }, taYieldStagingRepository: failure === 'missing' ? undefined : stage, taYieldRepository: { getWorkbookReconciliationRows: mes } })).get(base);
    expect(response.status).toBe(503); expect(response.body.code).toBe('TA_COMPARE_STAGING_UNAVAILABLE');
    expect(response.body.error).toMatch(/staging/i); expect(response.body.error).not.toContain('secret'); expect(mes).not.toHaveBeenCalled();
  });
  it('rejects nonexistent series and preserves bounded pagination', async () => {
    const stage = staging(async (filters) => Array.from({ length: 120 }, (_, index) => stagedLot(filters, { lotNo: `job-${index}` })));
    const app = createApp({ environment, taYieldStagingRepository: stage });
    const response = await request(app).get(`${base}&offset=100&limit=10`);
    expect(response.body.data.lots.current).toMatchObject({ total: 120, offset: 100, limit: 10 });
    expect(response.body.data.lots.current.rows).toHaveLength(10);
    const missing = await request(app).get(base.replace('kind=total&key=Total', 'kind=series&key=missing'));
    expect(missing.status).toBe(400);
  });
  it('rate-limits investigation reads with a retry hint and cached normal reads', async () => {
    const stage = staging(); const app = createApp({ environment, taYieldStagingRepository: stage });
    for (let index = 0; index < 60; index += 1) expect((await request(app).get(base)).status).toBe(200);
    const blocked = await request(app).get(base);
    expect(blocked.status).toBe(429); expect(blocked.headers['retry-after']).toBe('60');
    expect(blocked.body.code).toBe('COMPARE_DETAILS_RATE_LIMIT');
    expect(stage.getWorkbookRows).toHaveBeenCalledTimes(2);
  });
});
