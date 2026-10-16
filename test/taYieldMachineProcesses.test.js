import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';

vi.mock('../src/taYieldMapping.js', async (importOriginal) => ({
  ...await importOriginal(),
  loadTaWorkbookReconciliationMapping: async () => new Map(),
  loadTaYieldMapping: async () => ({
    neo: new Map([['1304_Welding_Def', { category: 'Inproc Dw' }]]),
    gps: new Map()
  })
}));

const environment = {
  SQL_SERVER: 'test-server', SQL_DATABASE: 'test-mes',
  DASHBOARD_TA_YIELD_STAGING_ENABLED: 'true',
  STAGING_SQL_SERVER: 'test-staging', STAGING_SQL_DATABASE: 'test-staging',
  STAGING_SQL_USER: 'test-user', STAGING_SQL_PASSWORD: 'test-password'
};
const filters = {
  startDate: '2026-09-01', endDate: '2026-10-16', product: 'NEO',
  serie: 'Ta NEO Capacitor FPS series B3 case', pn: 'TEFPS'
};
const baseQuery = { dataset: 'ta-yield', ...filters };
const lot = (lotNo, extra = {}) => ({
  lotNo, tapingDate: '2026-09-15', line: filters.serie, itemName: filters.pn,
  modes: [{ mode: '1304_Welding_Def', category: 'Inproc Dw', quantity: 12 }],
  ...extra
});
const event = (lotNo, operationName, machineName = 'MC-01') => ({
  lotNo, operationName, machineName, occuredOn: '2026-09-15T03:00:00.000Z'
});

function fixture({ lots = [lot('ELIGIBLE')], events = [] } = {}) {
  const getMachineLots = vi.fn(async (selection) => lots.filter((row) =>
    row.tapingDate >= selection.startDate && row.tapingDate <= selection.endDate
    && (!selection.serie || row.line === selection.serie)
    && (!selection.pn || row.itemName === selection.pn)));
  // Return extra events deliberately: the API must preserve the eligible lot boundary.
  const getMachineEvents = vi.fn(async () => events);
  const app = createApp({
    environment,
    taYieldStagingRepository: { getMachineLots, getMachineEvents },
    yieldDefectSettingRepository: { list: async () => [] }
  });
  return { app, getMachineLots, getMachineEvents };
}

const analysisQuery = (process) => ({
  ...baseQuery, process, machine: '__ALL__', defectType: 'category', defect: 'Inproc Dw'
});

describe('TA Machine process discovery and eligible lot scope', () => {
  it('includes processes for zero-defect calculated workbook lots without requiring defect staging rows', async () => {
    const getMachineEvents = vi.fn(async () => [event('ZERO-DEFECT', 'DryPacking'), event('EXCLUDED', 'Excluded-only')]);
    const app = createApp({
      environment,
      yieldDefectSettingRepository: { list: async () => [] },
      taYieldStagingRepository: {
        getWorkbookRows: async () => [{ lotNo: 'ZERO-DEFECT', line: filters.serie, itemName: filters.pn, tapingDate: '2026-09-15', categories: { Input: 100, Good: 100 } }],
        getMachineLots: async () => { throw new Error('Zero-defect calculated lots have no defect rows'); },
        getMachineEvents
      }
    });
    const response = await request(app).get('/api/ta-yield-machine-processes').query(baseQuery);
    expect(response.status).toBe(200);
    expect(response.body.data.processes).toEqual(['DryPacking']);
    expect(getMachineEvents).toHaveBeenCalledWith(expect.objectContaining(filters), { lotNumbers: ['ZERO-DEFECT'] });
  });

  it('returns a successful empty defect analysis for a process used only by zero-defect calculated lots', async () => {
    const getMachineEventsSnapshot = vi.fn(async () => { throw new Error('No legacy JSON snapshot exists'); });
    const app = createApp({
      environment,
      yieldDefectSettingRepository: { list: async () => [] },
      taYieldStagingRepository: {
        getWorkbookRows: async () => [{ lotNo: 'ZERO-DEFECT', line: filters.serie, itemName: filters.pn, tapingDate: '2026-09-15', categories: { Input: 100, Good: 100 } }],
        getMachineLots: async () => { throw new Error('TA Yield Machine staging data is not ready for this date range.'); },
        getMachineEvents: async () => [event('ZERO-DEFECT', 'DryPacking')],
        getMachineEventsSnapshot
      }
    });
    const response = await request(app).get('/api/ta-yield-machine').query(analysisQuery('DryPacking'));
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ rows: [] });
    expect(getMachineEventsSnapshot).not.toHaveBeenCalled();
  });

  it('discovers all distinct processes only for eligible lots in the report date, series, and part selection', async () => {
    const { app, getMachineLots } = fixture({
      lots: [lot('ELIGIBLE'), lot('OLD', { tapingDate: '2026-08-31' }),
        lot('OTHER-SERIES', { line: 'Other series' }), lot('OTHER-PART', { itemName: 'OTHER' })],
      events: [event('ELIGIBLE', 'Pressing'), event('ELIGIBLE', 'Sintering'),
        event('ELIGIBLE', 'Pressing'), event('OLD', 'Old-only'),
        event('OTHER-SERIES', 'Other-series-only'), event('OTHER-PART', 'Other-part-only'),
        event('NON-STANDARD-LOT', 'Excluded-job-only')]
    });

    const response = await request(app).get('/api/ta-yield-machine-processes').query(baseQuery);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.processes.sort()).toEqual(['Pressing', 'Sintering']);
    expect(getMachineLots).toHaveBeenCalledWith(expect.objectContaining(filters));
  });

  it('returns an empty process list when there are no calculation eligible lots', async () => {
    const { app } = fixture({ lots: [], events: [event('EXCLUDED', 'Pressing')] });
    const response = await request(app).get('/api/ta-yield-machine-processes').query(baseQuery);
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ processes: [] });
  });

  it('analyzes a newly available exact operation and excludes other processes and unscoped machines', async () => {
    const { app, getMachineLots, getMachineEvents } = fixture({ events: [
      event('ELIGIBLE', 'Resin_coating'), event('ELIGIBLE', 'ResinXcoating', 'WRONG-PROCESS'),
      event('EXCLUDED', 'Resin_coating', 'EXCLUDED-MACHINE')
    ] });
    const response = await request(app).get('/api/ta-yield-machine').query(analysisQuery('Resin_coating'));

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      totalMachines: 1,
      rows: [{ date: '2026-09-15', machineName: 'MC-01', mode: '1304_Welding_Def', quantity: 12, lotCount: 1 }]
    });
    expect(getMachineLots).toHaveBeenCalledWith(expect.objectContaining(filters));
    expect(getMachineEvents).toHaveBeenCalledWith(expect.objectContaining(filters), expect.objectContaining({ processName: 'Resin_coating' }));
  });

  it('returns no rows or machines for an unknown or excluded-lot-only process', async () => {
    const { app } = fixture({ events: [event('ELIGIBLE', 'Pressing'), event('EXCLUDED', 'Excluded-only')] });
    for (const process of ['Unknown process', 'Excluded-only']) {
      const response = await request(app).get('/api/ta-yield-machine').query(analysisQuery(process));
      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({ rows: [], totalMachines: 0 });
    }
  });

  it.each([
    ['1.1stAnodization', '1.1stAnodization'],
    ['2.Welding', '2.Welding'],
    ['3.Ei', '3.Ei']
  ])('preserves legacy process selection %s', async (process, operationName) => {
    const { app } = fixture({ events: [event('ELIGIBLE', operationName)] });
    const response = await request(app).get('/api/ta-yield-machine').query(analysisQuery(process));
    expect(response.status).toBe(200);
    expect(response.body.data.rows).toEqual([
      { date: '2026-09-15', machineName: 'MC-01', mode: '1304_Welding_Def', quantity: 12, lotCount: 1 }
    ]);
  });

  it('keeps first Anodization separate from second Anodization', async () => {
    const { app } = fixture({ events: [
      event('ELIGIBLE', '1.1stAnodization', 'AN-01'),
      event('ELIGIBLE', '2ndAnodization', 'AN-02')
    ] });
    const response = await request(app).get('/api/ta-yield-machine').query(analysisQuery('1.1stAnodization'));
    expect(response.status).toBe(200);
    expect(response.body.data.totalMachines).toBe(1);
    expect(response.body.data.rows.map((row) => row.machineName)).toEqual(['AN-01']);
  });

  it.each(['', 'x'.repeat(201), 'Pressing\nInjected'])('rejects invalid process input %j', async (process) => {
    const { app, getMachineEvents } = fixture();
    const response = await request(app).get('/api/ta-yield-machine').query(analysisQuery(process));
    expect(response.status).toBe(400);
    expect(getMachineEvents).not.toHaveBeenCalled();
  });

  it('validates report dates and requires the TA Yield dataset for discovery', async () => {
    const { app } = fixture();
    expect((await request(app).get('/api/ta-yield-machine-processes').query({ ...baseQuery, startDate: 'invalid' })).status).toBe(400);
    expect((await request(app).get('/api/ta-yield-machine-processes').query({ ...baseQuery, dataset: 'closed' })).status).toBe(400);
  });

  it('reports discovery storage failures instead of returning an empty successful list', async () => {
    const app = createApp({
      environment,
      taYieldStagingRepository: {
        getMachineLots: async () => { throw new Error('Storage unavailable'); },
        getMachineEvents: async () => []
      }
    });
    const response = await request(app).get('/api/ta-yield-machine-processes').query(baseQuery);
    expect(response.status).toBe(503);
    expect(response.body.success).toBe(false);
  });
});
