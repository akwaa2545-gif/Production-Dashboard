import request from 'supertest';
import { createServer, get as httpGet } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';

vi.mock('../src/taYieldMapping.js', async (importOriginal) => ({
  ...await importOriginal(),
  loadTaWorkbookReconciliationMapping: async () => new Map([['Cam1 defective for GPS', 'App']])
}));

const token = 'dashboard-data-mode-test-token-1234567890';
const environment = {
  SQL_SERVER: 'test-mes', SQL_DATABASE: 'OneMES_Report_THR', DB_AUTH: 'ActiveDirectoryInteractive',
  DB_VIEW: 'dbo.LotCompleteLog', DATE_COLUMN: 'completedAt', PROCESS_COLUMN: 'processName',
  SERIE_COLUMN: 'serie', CASE_COLUMN: 'caseNumber', PN_COLUMN: 'from_itemName',
  DASHBOARD_DATA_MODE: 'live', DASHBOARD_DATA_MODE_TOKEN: token
};
const dates = { startDate: '2026-08-01', endDate: '2026-08-31' };
it('prevents external sites from framing the dashboard operator controls', async () => {
  const { app } = fixture();
  const response = await request(app).get('/').expect(200);
  expect(response.headers['content-security-policy']).toBe("frame-ancestors 'self'");
  expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
});
const options = { process: ['MES process'], serie: ['MES series'], case: [], pn: ['MES PN'] };
const quantity = [{ bucketDate: '2026-08-19', itemName: 'MES series', quantityMoved: 456 }];
const stageMethods = [
  'getActivity', 'getQuantity', 'getOptions', 'getChartData', 'getPartNumbers',
  'getYieldRows', 'replaceYieldRows', 'getWorkbookRows', 'getWorkbookOptions',
  'hasWorkbookCoverage', 'getMonthlySummary', 'getMonthlyPartNumbers', 'getMachineLots',
  'getMachineEvents', 'getMachineEventsSnapshot', 'getLatestWorkbookSnapshotForMonth',
  'getModes', 'addModes', 'replaceMonthlySummary', 'replaceWorkbookRows', 'replaceMachineRows'
];

function fixture(overrides = {}) {
  const staging = Object.fromEntries(stageMethods.map((name) => [name, vi.fn(async () => {
    throw new Error(`Live mode must not invoke staging.${name}`);
  })]));
  const direct = {
    getQuantity: vi.fn(async () => quantity), getOptions: vi.fn(async () => options),
    getChartData: vi.fn(async () => [{ processName: 'MES process', quantityMoved: 456 }]),
    getPartNumbers: vi.fn(async () => ({ items: ['MES PN'], hasMore: false }))
  };
  const sc = {
    getYieldRows: vi.fn(async () => ({ inputs: [{ bucketMonth: '2026-08', line: 'CAN', quantity: 100 }], defects: [] })),
    getDefectModes: vi.fn(async () => [{ mode: 'SC_MES' }])
  };
  const ta = {
    getOptions: vi.fn(async () => options), getMtdSeriesOptions: vi.fn(async () => options),
    getWorkbookReconciliationRows: vi.fn(async () => [{
      line: 'FPS', lotNo: '6H19N00001', itemName: 'TEFPS', tapingDate: '2026-08-19',
      categories: { Input: 100, Good: 90, App: 10 }
    }]),
    getYieldRows: vi.fn(async () => []), getMachineEvents: vi.fn(async () => []),
    getDefectModes: vi.fn(async () => [{ mode: 'TA_MES', description: 'MES description' }])
  };
  const refresh901 = vi.fn(async () => { throw new Error('Unexpected 901 staging refresh'); });
  const refreshWip = vi.fn(async () => { throw new Error('Unexpected WIP staging refresh'); });
  const app = createApp({
    environment, repository: direct, scYieldRepository: sc, taYieldRepository: ta,
    staging901Repository: staging, stagingWipRepository: staging,
    scYieldStagingRepository: staging, taYieldStagingRepository: staging,
    defectModeStagingRepository: staging, yieldDefectSettingRepository: { list: async () => [] },
    refresh901StagingOperation: refresh901, refreshWipStagingOperation: refreshWip, ...overrides
  });
  return { app, staging, direct, sc, ta, refresh901, refreshWip };
}

function expectNoStaging(staging) {
  for (const method of Object.values(staging)) expect(method).not.toHaveBeenCalled();
}

function switchMode(app, mode, suppliedToken = token) {
  return request(app).put('/api/data-mode').set('Origin', 'http://localhost:3000')
    .set('Authorization', `Bearer ${suppliedToken}`).send({ mode });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('dashboard live data source API', () => {
  it.each(['closed', 'lot'])('loads %s quantities, options, charts, and part numbers directly', async (dataset) => {
    const { app, staging, direct } = fixture();
    for (const [path, method] of [
      ['/api/quantity', 'getQuantity'], ['/api/options', 'getOptions'],
      ['/api/chart', 'getChartData'], ['/api/part-numbers', 'getPartNumbers']
    ]) {
      const response = await request(app).get(path).query({ dataset, ...dates });
      expect(response.status, path).toBe(200);
      expect(response.headers['x-dashboard-data-mode']).toBe('live');
      expect(response.headers['x-dashboard-data-revision']).toBeDefined();
      expect(response.headers['cache-control']).toBe('no-store');
      expect(direct[method]).toHaveBeenCalled();
    }
    expectNoStaging(staging);
  });

  it('uses the direct MTD calculation for Completion 901', async () => {
    const { app, staging, direct } = fixture();
    const response = await request(app).get('/api/mtd-quantity').query({ dataset: 'closed', ...dates });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(quantity);
    expect(direct.getQuantity).toHaveBeenCalledWith(dates, { mtd: true });
    expectNoStaging(staging);
  });

  it('queries MES again on every live request instead of serving a response cache', async () => {
    const { app, staging, direct } = fixture();
    direct.getQuantity.mockResolvedValueOnce([{ quantityMoved: 1 }]).mockResolvedValueOnce([{ quantityMoved: 2 }]);
    const read = () => request(app).get('/api/quantity').query({ dataset: 'closed', ...dates });
    expect((await read()).body.data).toEqual([{ quantityMoved: 1 }]);
    expect((await read()).body.data).toEqual([{ quantityMoved: 2 }]);
    expect(direct.getQuantity).toHaveBeenCalledTimes(2);
    expectNoStaging(staging);
  });

  it('reports a MES outage without reading a staging fallback', async () => {
    const { app, staging, direct } = fixture();
    direct.getQuantity.mockRejectedValue(Object.assign(new Error('MES disconnected'), { code: 'ECONNREFUSED' }));
    const response = await request(app).get('/api/quantity').query({ dataset: 'closed', ...dates });
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ success: false, code: 'DATABASE_UNREACHABLE' });
    expectNoStaging(staging);
  });

  it.each(['/api/sc-yield', '/api/sc-yield-weekly', '/api/sc-yield-tendency'])('bypasses staged SC rows for %s', async (path) => {
    const { app, staging, sc } = fixture();
    const response = await request(app).get(path).query({ dataset: 'yield', ...dates });
    expect(response.status).toBe(200);
    expect(response.body.data[0]).toMatchObject({ input: 100, yield: 100 });
    expect(sc.getYieldRows).toHaveBeenCalled();
    expectNoStaging(staging);
  });

  it.each([
    '/api/ta-yield-workbook-reconciliation', '/api/ta-yield', '/api/ta-yield-weekly', '/api/ta-yield-tendency'
  ])('uses MES workbook rows for %s even when staging is configured', async (path) => {
    const { app, staging, ta } = fixture();
    const response = await request(app).get(path).query({ dataset: 'ta-yield', ...dates });
    expect(response.status).toBe(200);
    expect(response.body.data.length).toBeGreaterThan(0);
    expect(ta.getWorkbookReconciliationRows).toHaveBeenCalled();
    expectNoStaging(staging);
  });

  it('loads TA options and machine analysis without staged snapshots', async () => {
    const { app, staging, ta } = fixture();
    for (const product of ['NEO', 'TA']) {
      const response = await request(app).get('/api/options').query({ dataset: 'ta-yield', product });
      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(options);
    }
    const machineQuery = { dataset: 'ta-yield', ...dates, process: '1.1stAnodization', machine: '__ALL__', defectType: 'category', defect: 'App' };
    expect((await request(app).get('/api/ta-yield-machine-options').query(machineQuery)).status).toBe(200);
    expect((await request(app).get('/api/ta-yield-machine').query(machineQuery)).status).toBe(200);
    expect(ta.getOptions).toHaveBeenCalled();
    expect(ta.getMtdSeriesOptions).toHaveBeenCalled();
    expect(ta.getMachineEvents).toHaveBeenCalled();
    expectNoStaging(staging);
  });

  it('reads TA and SC defect modes directly while preserving saved mapping settings', async () => {
    const { app, staging, sc, ta } = fixture();
    const response = await request(app).get('/api/defect-settings');
    expect(response.status).toBe(200);
    expect(response.body.data.ta).toContainEqual(expect.objectContaining({ source: 'TA_MES', description: 'MES description' }));
    expect(response.body.data.sc).toContainEqual(expect.objectContaining({ mode: 'SC_MES' }));
    expect(sc.getDefectModes).toHaveBeenCalled();
    expect(ta.getDefectModes).toHaveBeenCalled();
    expectNoStaging(staging);
  });

  it.each([
    ['refresh901Staging'], ['repair901Staging', dates], ['refreshWipStaging'], ['repairWipStaging', dates],
    ['refreshScYieldStaging'], ['refreshScYieldStagingHistory'], ['refreshTaYieldStaging'],
    ['refreshTaYieldStagingResume'], ['refreshTaYieldStagingDay', { date: '2026-08-19' }],
    ['refreshTaYieldStagingHistory'], ['refreshDefectModeStaging'], ['runTaYieldStagingQa'],
    ['warmCurrentMonthCaches'], ['warmTaYieldDashboard']
  ])('skips %s without querying or writing either database', async (method, argument) => {
    const { app, staging, direct, sc, ta, refresh901, refreshWip } = fixture();
    expect(await app[method](argument)).toMatchObject({ status: 'SKIPPED' });
    for (const source of [staging, direct, sc, ta]) expectNoStaging(source);
    expect(refresh901).not.toHaveBeenCalled();
    expect(refreshWip).not.toHaveBeenCalled();
  });
});

describe('dashboard data mode control API', () => {
  it('exposes initial live mode without requiring operator authorization', async () => {
    const { app } = fixture();
    const response = await request(app).get('/api/data-mode');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, data: { mode: 'live' } });
    expect(JSON.stringify(response.body)).not.toContain(token);
  });

  it('requires an operator token before changing mode', async () => {
    const { app } = fixture();
    expect((await switchMode(app, 'staging', 'wrong')).status).toBe(401);
    expect((await request(app).get('/api/data-mode')).body.data.mode).toBe('live');
  });

  it.each([undefined, null, '', 'LIVE', 'invalid', 1, {}, ['live']].map((mode) => [mode]))('rejects invalid mode %j', async (mode) => {
    const { app } = fixture();
    expect((await switchMode(app, mode)).status).toBe(400);
  });

  it('invalidates cached quantities when switching staged to live and back', async () => {
    const stagedRead = vi.fn().mockResolvedValueOnce([{ quantityMoved: 10 }]).mockResolvedValue([{ quantityMoved: 30 }]);
    const { app, direct } = fixture({
      environment: { ...environment, DASHBOARD_DATA_MODE: 'staging' },
      staging901Repository: { getQuantity: stagedRead }
    });
    const read = () => request(app).get('/api/quantity').query({ dataset: 'closed', ...dates });
    expect((await read()).body.data).toEqual([{ quantityMoved: 10 }]);
    expect((await read()).body.data).toEqual([{ quantityMoved: 10 }]);
    expect(stagedRead).toHaveBeenCalledTimes(1);
    expect((await switchMode(app, 'live')).status).toBe(200);
    const live = await read();
    expect(live.body.data).toEqual(quantity);
    expect(live.headers['x-dashboard-data-mode']).toBe('live');
    expect(live.headers['cache-control']).toBe('no-store');
    expect(direct.getQuantity).toHaveBeenCalledTimes(1);
    expect((await switchMode(app, 'staging')).status).toBe(200);
    const staged = await read();
    expect(staged.body.data).toEqual([{ quantityMoved: 30 }]);
    expect(staged.headers['x-dashboard-data-mode']).toBe('staging');
    expect(staged.headers['x-dashboard-data-revision']).not.toBe(live.headers['x-dashboard-data-revision']);
  });

  it('drains an active WIP refresh before live mode and prevents subsequent refreshes', async () => {
    let releaseRefresh;
    let signalStarted;
    const started = new Promise((resolve) => { signalStarted = resolve; });
    const pending = new Promise((resolve) => { releaseRefresh = resolve; });
    const refresh = vi.fn(() => { signalStarted(); return pending; });
    const { app } = fixture({
      environment: { ...environment, DASHBOARD_DATA_MODE: 'staging' },
      stagingWipRepository: { getActivity: async () => ({ rowCount: 123, lastDataDate: '2026-08-19' }) },
      refreshWipStagingOperation: refresh
    });
    const refreshing = app.refreshWipStaging();
    await started;
    try {
      const transition = await switchMode(app, 'live');
      expect(transition.status).toBe(202);
      expect(await app.refreshWipStaging()).toMatchObject({ status: 'SKIPPED' });
    } finally {
      releaseRefresh({ rows: 1 });
      await refreshing;
    }
    expect((await request(app).get('/api/data-mode')).body.data.mode).toBe('live');
    expect(await app.refreshWipStaging()).toMatchObject({ status: 'SKIPPED' });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('drains an active dashboard request and blocks new reads until the mode changes', async () => {
    let releaseRead;
    let signalStarted;
    const started = new Promise((resolve) => { signalStarted = resolve; });
    const pending = new Promise((resolve) => { releaseRead = resolve; });
    const stagedRead = vi.fn(() => { signalStarted(); return pending; });
    const { app } = fixture({
      environment: { ...environment, DASHBOARD_DATA_MODE: 'staging' },
      staging901Repository: { getQuantity: stagedRead }
    });
    const runningRead = request(app).get('/api/quantity').query({ dataset: 'closed', ...dates }).then((response) => response);
    await started;
    try {
      const transition = await switchMode(app, 'live');
      expect(transition.status).toBe(202);
      expect(transition.body.data).toMatchObject({ mode: 'staging', requestedMode: 'live', transitioning: true });
      const waiting = await request(app).get('/api/quantity').query({ dataset: 'closed', ...dates });
      expect(waiting.status).toBe(503);
      expect(stagedRead).toHaveBeenCalledTimes(1);
    } finally {
      releaseRead([{ quantityMoved: 10 }]);
      await runningRead;
    }
    const live = await request(app).get('/api/quantity').query({ dataset: 'closed', ...dates });
    expect(live.status).toBe(200);
    expect(live.body.data).toEqual(quantity);
    expect(live.headers['x-dashboard-data-mode']).toBe('live');
  });

  it('keeps a disconnected request tracked through connection reset and deferred retry', async () => {
    const firstRead = deferred();
    const firstStarted = deferred();
    const reset = deferred();
    const resetStarted = deferred();
    const retry = deferred();
    const retryStarted = deferred();
    const disconnected = deferred();
    const getQuantity = vi.fn()
      .mockImplementationOnce(() => { firstStarted.resolve(); return firstRead.promise; })
      .mockImplementationOnce(() => { retryStarted.resolve(); return retry.promise; });
    const resetConnection = vi.fn(() => { resetStarted.resolve(); return reset.promise; });
    const { app } = fixture({
      environment: { ...environment, DASHBOARD_DATA_MODE: 'staging' },
      repository: { getQuantity, resetConnection },
      staging901Repository: { getQuantity }
    });
    const server = createServer(app);
    server.on('request', (_request, response) => response.once('close', () => disconnected.resolve()));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const query = new URLSearchParams({ dataset: 'closed', ...dates });
    const client = httpGet(`http://127.0.0.1:${server.address().port}/api/quantity?${query}`);
    client.on('error', () => {}); // The client intentionally disconnects before the database completes.
    try {
      await firstStarted.promise;
      expect((await switchMode(app, 'live')).status).toBe(202);
      client.destroy();
      await disconnected.promise;
      firstRead.reject(Object.assign(new Error('Connection failed after client disconnect'), { code: 'ECONNRESET' }));
      await resetStarted.promise;
      expect((await request(app).get('/api/data-mode')).body.data).toMatchObject({
        mode: 'staging', requestedMode: 'live', transitioning: true
      });
      reset.resolve();
      await retryStarted.promise;
      expect((await request(app).get('/api/data-mode')).body.data).toMatchObject({
        mode: 'staging', requestedMode: 'live', transitioning: true
      });
      expect((await request(app).get('/api/quantity').query({ dataset: 'closed', ...dates })).status).toBe(503);
    } finally {
      client.destroy();
      firstRead.resolve([]);
      reset.resolve();
      retry.resolve(quantity);
      await new Promise((resolve) => server.close(resolve));
    }
    await vi.waitFor(async () => {
      expect((await request(app).get('/api/data-mode')).body.data).toMatchObject({ mode: 'live', transitioning: false });
    });
    expect(resetConnection).toHaveBeenCalledTimes(1);
    expect(getQuantity).toHaveBeenCalledTimes(2);
  });

  it.each(['source reads', 'staging writes'])('waits for surviving SC %s after a parallel operation fails', async (phase) => {
    const failure = new Error(`SC monthly ${phase} failed`);
    const monthly = deferred();
    const weekly = deferred();
    const weeklyStarted = deferred();
    const rows = { inputs: [], defects: [] };
    const parallelOperation = (bucket) => {
      if (bucket !== 'week') return monthly.promise;
      weeklyStarted.resolve();
      return weekly.promise;
    };
    const getYieldRows = vi.fn((_filters, bucket) => phase === 'source reads' ? parallelOperation(bucket) : Promise.resolve(rows));
    const replaceYieldRows = vi.fn((_rows, _filters, bucket) => parallelOperation(bucket));
    const { app } = fixture({
      environment: { ...environment, DASHBOARD_DATA_MODE: 'staging' },
      scYieldRepository: { getYieldRows },
      scYieldStagingRepository: { replaceYieldRows }
    });
    let outcome;
    const refreshing = app.refreshScYieldStaging(dates).then(
      (value) => { outcome = { value }; },
      (error) => { outcome = { error }; }
    );
    await weeklyStarted.promise;
    monthly.reject(failure);
    try {
      const transition = await switchMode(app, 'live');
      expect(transition.status).toBe(202);
      expect(transition.body.data).toMatchObject({ mode: 'staging', requestedMode: 'live', transitioning: true });
      expect(outcome).toBeUndefined();
      expect(await app.refreshScYieldStaging(dates)).toMatchObject({ status: 'SKIPPED' });
    } finally {
      weekly.resolve(rows);
      await refreshing;
    }
    expect(outcome.error).toBe(failure);
    expect((await request(app).get('/api/data-mode')).body.data).toMatchObject({ mode: 'live', transitioning: false });
    expect(getYieldRows).toHaveBeenCalledTimes(2);
    if (phase === 'source reads') expect(replaceYieldRows).not.toHaveBeenCalled();
    else expect(replaceYieldRows).toHaveBeenCalledTimes(2);
  });
});
