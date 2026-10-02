import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { registerTaYieldCompareExportRoute } from '../src/taYieldCompareExportRoute.js';
import { taYieldComparePeriods } from '../src/taYieldCompare.js';
import { createDashboardDataMode } from '../src/dashboardDataMode.js';

const base = '/api/export/ta-yield-compare?dataset=ta-yield&startDate=2026-09-05&endDate=2026-09-20&compareMonth=2026-08&comparisonMode=same-dates';
const lot = (filters, index) => ({ line: 'FPS series A3 case', lotNo: `job-${index}`, itemName: 'PN1', tapingDate: filters.startDate, categories: { Input: 1000, Good: 900, ESR: 100 } });
function fixture(options = {}) {
  const app = express();
  const loadStagedRows = vi.fn(async (filters) => ({ rows: Array.from({ length: 120 }, (_, index) => lot(filters, index)), mapping: new Map() }));
  const buildWorkbook = vi.fn(async () => Buffer.from('PKtest'));
  registerTaYieldCompareExportRoute(app, {
    validateFilters: (query) => typeof query.startDate !== 'string' || typeof query.endDate !== 'string' ? { error: 'Report dates required.' } : { filters: { startDate: query.startDate, endDate: query.endDate, pn: query.pn } },
    getPeriods: (query, filters) => taYieldComparePeriods(query, { startDate: '2026-10-01', endDate: '2026-10-08' }, filters),
    contextFor: (req) => ({ dataset: req.query.dataset || 'ta-yield' }), loadStagedRows,
    runTracked: (task) => task(), buildWorkbook, ...options
  });
  return { app, loadStagedRows, buildWorkbook };
}

describe('Compare Excel export route', () => {
  it('exports the applied periods and main numeric summary without automatically adding LOOKUP', async () => {
    const { app, loadStagedRows, buildWorkbook } = fixture();
    const response = await request(app).get(`${base}&pn=PN1`);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(response.headers['content-disposition']).toContain('ta-yield-compare-2026-09-05-to-2026-09-20-vs-2026-08-05-to-2026-08-20.xlsx');
    expect(loadStagedRows.mock.calls.map(([filters]) => filters.startDate)).toEqual(['2026-09-05', '2026-08-05']);
    const [compare, details] = buildWorkbook.mock.calls[0];
    expect(compare.rows[0]).toMatchObject({ currentInput: 120000, currentGood: 108000, currentYield: 90 });
    expect(compare.filters.pn).toBe('PN1'); expect(details).toBeUndefined();
  });

  it('exports all affected jobs from the open LOOKUP rather than its 50-record page', async () => {
    const { app, buildWorkbook } = fixture();
    expect((await request(app).get(`${base}&kind=total&key=Total`)).status).toBe(200);
    const details = buildWorkbook.mock.calls[0][1];
    expect(details.lots.current.rows).toHaveLength(120);
    expect(details.lots.compare.rows).toHaveLength(120);
    expect(details.current.lotCount).toBe(120);
    expect(details.selection.label).toBe('Total');
  });

  it.each(['kind=bad&key=Total', 'kind=total', 'key=Total', 'offset=50', 'limit=50', 'comparisonMode=bad', 'dataset=closed', 'kind=series&key=missing'])('rejects invalid export scope safely: %s', async (extra) => {
    const { app, buildWorkbook } = fixture();
    const params = new URLSearchParams(base.split('?')[1]);
    new URLSearchParams(extra).forEach((value, key) => params.set(key, value));
    expect((await request(app).get(`/api/export/ta-yield-compare?${params}`)).status).toBe(400);
    expect(buildWorkbook).not.toHaveBeenCalled();
  });

  it('rejects oversized full exports explicitly, without generating a partial workbook', async () => {
    const { app, buildWorkbook } = fixture({ maxJobRecords: 200 });
    const response = await request(app).get(`${base}&kind=total&key=Total`);
    expect(response.status).toBe(413); expect(response.body.code).toBe('COMPARE_EXPORT_TOO_LARGE');
    expect(buildWorkbook).not.toHaveBeenCalled();
  });

  it('returns a safe staged-coverage failure without attachment headers or database details', async () => {
    const { app } = fixture({ loadStagedRows: async () => { throw Object.assign(new Error('private database detail'), { code: 'TA_COMPARE_STAGING_UNAVAILABLE' }); } });
    const response = await request(app).get(base);
    expect(response.status).toBe(503); expect(response.body.code).toBe('TA_COMPARE_STAGING_UNAVAILABLE');
    expect(response.body.error).not.toContain('private'); expect(response.headers['content-disposition']).toBeUndefined();
  });

  it('bounds export frequency', async () => {
    const { app, buildWorkbook } = fixture();
    for (let count = 0; count < 6; count += 1) expect((await request(app).get(base)).status).toBe(200);
    const response = await request(app).get(base);
    expect(response.status).toBe(429); expect(response.headers['retry-after']).toBeDefined();
    expect(buildWorkbook).toHaveBeenCalledTimes(6);
  });

  it('bounds concurrent generation and releases capacity after a builder failure', async () => {
    const entered = []; const releases = [];
    const signals = Array.from({ length: 2 }, (_, index) => new Promise((resolve) => { entered[index] = resolve; }));
    let call = 0;
    const buildWorkbook = vi.fn(() => {
      const index = call++;
      if (index > 1) return Buffer.from('PKdone');
      entered[index]();
      return new Promise((resolve, reject) => { releases[index] = index === 0 ? () => reject(new Error('private workbook details')) : () => resolve(Buffer.from('PKdone')); });
    });
    const logger = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { app } = fixture({ buildWorkbook });
      const first = request(app).get(base).then((response) => response);
      const second = request(app).get(base).then((response) => response);
      await Promise.all(signals);
      const busy = await request(app).get(base);
      expect(busy.status).toBe(503); expect(busy.body.code).toBe('COMPARE_EXPORT_BUSY');
      expect(busy.headers['retry-after']).toBe('5'); expect(buildWorkbook).toHaveBeenCalledTimes(2);
      releases[0](); releases[1]();
      const responses = await Promise.all([first, second]);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 503]);
      const failed = responses.find((response) => response.status === 503);
      expect(failed.body.code).toBe('COMPARE_EXPORT_FAILED'); expect(failed.body.error).not.toContain('private');
      expect(failed.headers['content-disposition']).toBeUndefined();
      expect((await request(app).get(base)).status).toBe(200);
    } finally { logger.mockRestore(); }
  });

  it('tracks both staged reads and workbook creation until completion', async () => {
    const events = [];
    const runTracked = vi.fn(async (task) => {
      events.push('tracked start');
      await task(); events.push('tracked complete');
    });
    const { app } = fixture({ runTracked, buildWorkbook: async () => { events.push('workbook'); return Buffer.from('PKdone'); } });
    expect((await request(app).get(base)).status).toBe(200);
    expect(events).toEqual(['tracked start', 'workbook', 'tracked complete']);
  });

  it('requires applied Report dates and respects a context rejection', async () => {
    const { app, loadStagedRows } = fixture();
    expect((await request(app).get('/api/export/ta-yield-compare?dataset=ta-yield')).status).toBe(400);
    expect(loadStagedRows).not.toHaveBeenCalled();
    const rejected = fixture({ contextFor: (_req, res) => { res.status(400).json({ success: false }); } });
    expect((await request(rejected.app).get(base)).status).toBe(400);
    expect(rejected.loadStagedRows).not.toHaveBeenCalled();
  });

  it('retains data-mode ownership after disconnect until workbook work finishes', async () => {
    const mode = createDashboardDataMode();
    let handler; let started; let finish;
    const building = new Promise((resolve) => { started = resolve; });
    const generated = new Promise((resolve) => { finish = resolve; });
    registerTaYieldCompareExportRoute({ get: (_path, _limiter, callback) => { handler = callback; } }, {
      validateFilters: () => ({ filters: { startDate: '2026-09-05', endDate: '2026-09-20' } }),
      getPeriods: (query, filters) => taYieldComparePeriods(query, { startDate: '2026-10-01', endDate: '2026-10-08' }, filters),
      contextFor: () => ({ dataset: 'ta-yield' }),
      loadStagedRows: async (filters) => ({ rows: [lot(filters, 0)], mapping: new Map() }),
      runTracked: mode.track, buildWorkbook: () => { started(); return generated; }
    });
    const response = { destroyed: false, writableEnded: false, attachment: vi.fn(), status: vi.fn() };
    const pending = handler({ query: Object.fromEntries(new URLSearchParams(base.split('?')[1])) }, response);
    await building;
    expect(mode.setMode('live')).toMatchObject({ mode: 'staging', transitioning: true });
    response.destroyed = true;
    expect(mode.status().activeWork).toBe(1);
    finish(Buffer.from('PKdone')); await pending;
    expect(mode.status()).toMatchObject({ mode: 'live', activeWork: 0, transitioning: false });
    expect(response.attachment).not.toHaveBeenCalled(); expect(response.status).not.toHaveBeenCalled();
  });
});
