import request from 'supertest';
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { createApp } from '../src/app.js';

const configuredEnvironment = {
  SQL_SERVER: 'apaz-sqlinstprod3.d9dee625aa38.database.windows.net',
  SQL_DATABASE: 'OneMES_Report_THR',
  DB_AUTH: 'ActiveDirectoryInteractive',
  DB_VIEW: 'dbo.LotCompleteLog',
  DATE_COLUMN: 'completedAt',
  PROCESS_COLUMN: 'processName',
  SERIE_COLUMN: 'serie',
  CASE_COLUMN: 'caseNumber',
  PN_COLUMN: 'from_itemName'
};

describe('dashboard API', () => {
  it('uses ProductionMES staging settings for TA Yield target storage', async () => {
    const { readTaYieldTargetConfig } = await import('../src/config.js');
    expect(readTaYieldTargetConfig({ STAGING_SQL_SERVER: 'server', STAGING_SQL_DATABASE: 'ProductionMES', STAGING_SQL_USER: 'user', STAGING_SQL_PASSWORD: 'password' })).toMatchObject({ database: 'ProductionMES', table: 'dbo.DashboardTaYieldTarget', ready: true });
  });

  it('reports health without exposing database settings', async () => {
    const response = await request(createApp({ environment: configuredEnvironment }))
      .get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, data: { status: 'ok' } });
  });

  it('reports TA workbook, machine, and monthly-summary staging activity separately', async () => {
    const activity = { rowCount: 3, firstDataDate: '2026-08-01', lastDataDate: '2026-08-15', lastRefreshedAt: '2026-08-15T01:00:00.000Z' };
    const taYieldStagingRepository = {
      getActivity: () => Promise.resolve(activity),
      getMachineActivity: () => Promise.resolve({ ...activity, rowCount: 48 }),
      getMonthlySummaryActivity: () => Promise.resolve({ ...activity, rowCount: 24 })
    };
    const response = await request(createApp({
      environment: { ...configuredEnvironment, DASHBOARD_TA_YIELD_STAGING_ENABLED: 'true', STAGING_SQL_SERVER: 'staging', STAGING_SQL_DATABASE: 'ProductionMES', STAGING_SQL_USER: 'user', STAGING_SQL_PASSWORD: 'password' },
      taYieldStagingRepository,
      yieldDefectSettingRepository: { list: () => Promise.resolve([]) }
    })).get('/api/staging-status');

    expect(response.status).toBe(200);
    expect(response.body.data.map((row) => row.name)).toEqual(expect.arrayContaining(['TA Yield DataTable', 'TA Yield Machine events', 'TA Yield Monthly summary']));
    expect(response.body.data.find((row) => row.name === 'TA Yield Monthly summary')).toMatchObject({ rowCount: 24, table: 'dbo.DashboardTaYieldMonthlySummary' });
    expect(response.body.data.find((row) => row.name === 'TA Yield Machine events')).toMatchObject({ rowCount: 48, table: 'dbo.DashboardTaYieldMachineEventRow' });
  });

  it('identifies a missing normalized Machine staging table instead of reporting a database outage', async () => {
    const activity = { rowCount: 3, firstDataDate: '2026-08-01', lastDataDate: '2026-08-15', lastRefreshedAt: '2026-08-15T01:00:00.000Z' };
    const taYieldStagingRepository = {
      getActivity: () => Promise.resolve(activity),
      getMachineActivity: () => Promise.reject(Object.assign(new Error("Invalid object name 'dbo.DashboardTaYieldMachineEventRow'."), { number: 208 })),
      getMonthlySummaryActivity: () => Promise.resolve(activity)
    };
    const response = await request(createApp({
      environment: { ...configuredEnvironment, DASHBOARD_TA_YIELD_STAGING_ENABLED: 'true', STAGING_SQL_SERVER: 'staging', STAGING_SQL_DATABASE: 'ProductionMES', STAGING_SQL_USER: 'user', STAGING_SQL_PASSWORD: 'password' },
      taYieldStagingRepository,
      yieldDefectSettingRepository: { list: () => Promise.resolve([]) }
    })).get('/api/staging-status');

    expect(response.status).toBe(200);
    expect(response.body.data.find((row) => row.name === 'TA Yield Machine events')).toMatchObject({ activityAvailable: false, activityError: 'Normalized Machine staging tables are not installed. Run npm run migrate:ta-yield-machine-rows.' });
  });

  it('reports a Machine staging activity timeout as an in-progress refresh', async () => {
    const activity = { rowCount: 3, firstDataDate: '2026-08-01', lastDataDate: '2026-08-15', lastRefreshedAt: '2026-08-15T01:00:00.000Z' };
    const taYieldStagingRepository = {
      getActivity: () => Promise.resolve(activity),
      getMachineActivity: () => Promise.reject(Object.assign(new Error('Timeout: Request failed to complete in 15000ms'), { code: 'ETIMEOUT' })),
      getMonthlySummaryActivity: () => Promise.resolve(activity)
    };
    const response = await request(createApp({
      environment: { ...configuredEnvironment, DASHBOARD_TA_YIELD_STAGING_ENABLED: 'true', STAGING_SQL_SERVER: 'staging', STAGING_SQL_DATABASE: 'ProductionMES', STAGING_SQL_USER: 'user', STAGING_SQL_PASSWORD: 'password' },
      taYieldStagingRepository,
      yieldDefectSettingRepository: { list: () => Promise.resolve([]) }
    })).get('/api/staging-status');

    expect(response.status).toBe(200);
    expect(response.body.data.find((row) => row.name === 'TA Yield Machine events')).toMatchObject({ activityAvailable: false, activityError: 'Machine staging refresh is still in progress. Check again shortly.' });
  });

  it('does not label a non-Machine staging timeout as a Machine refresh', async () => {
    const activity = { rowCount: 3, firstDataDate: '2026-08-01', lastDataDate: '2026-08-15', lastRefreshedAt: '2026-08-15T01:00:00.000Z' };
    const taYieldStagingRepository = {
      getActivity: () => Promise.resolve(activity),
      getMachineActivity: () => Promise.resolve(activity),
      getMonthlySummaryActivity: () => Promise.reject(Object.assign(new Error('Timeout: Request failed to complete in 15000ms'), { code: 'ETIMEOUT' }))
    };
    const response = await request(createApp({
      environment: { ...configuredEnvironment, DASHBOARD_TA_YIELD_STAGING_ENABLED: 'true', STAGING_SQL_SERVER: 'staging', STAGING_SQL_DATABASE: 'ProductionMES', STAGING_SQL_USER: 'user', STAGING_SQL_PASSWORD: 'password' },
      taYieldStagingRepository,
      yieldDefectSettingRepository: { list: () => Promise.resolve([]) }
    })).get('/api/staging-status');

    expect(response.status).toBe(200);
    expect(response.body.data.find((row) => row.name === 'TA Yield Monthly summary')).toMatchObject({ activityAvailable: false, activityError: 'Staging database is unreachable.' });
  });

  it('serves TA Machine defect views without reading staged Machine or workbook data', async () => {
    const taYieldStagingRepository = {
      getMachineLots: () => Promise.reject(new Error('Machine rows must not be loaded for the defect-view dropdown')),
      getMachineEvents: () => Promise.reject(new Error('Machine events must not be loaded for the defect-view dropdown'))
    };
    const response = await request(createApp({
      environment: { ...configuredEnvironment, DASHBOARD_TA_YIELD_STAGING_ENABLED: 'true', STAGING_SQL_SERVER: 'staging', STAGING_SQL_DATABASE: 'ProductionMES', STAGING_SQL_USER: 'user', STAGING_SQL_PASSWORD: 'password' },
      taYieldStagingRepository,
      yieldDefectSettingRepository: { list: () => Promise.resolve([]) }
    })).get('/api/ta-yield-machine-options?dataset=ta-yield&startDate=2026-08-01&endDate=2026-08-15&process=1.1stAnodization');

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ machines: [], categories: expect.arrayContaining(['Inproc Dw']) });
  });

  it('falls back to existing Machine snapshots while normalized Machine rows are backfilled', async () => {
    const taYieldStagingRepository = {
      getMachineLots: () => Promise.reject(new Error('Normalized Machine rows are still backfilling')),
      getWorkbookRows: () => Promise.resolve([{ line: 'Ta NEO Capacitor FPS series B3 case', lotNo: '6H01N00001', itemName: 'TEFPS', tapingDate: '2026-08-01', categories: { ACC: 0, 'Inproc Dw': 12 } }]),
      getMachineEventsSnapshot: () => Promise.resolve([{ lotNo: '6H01N00001', machineName: 'AN-01', operationName: '1.1stAnodization', occuredOn: '2026-08-01T00:00:00.000Z' }])
    };
    const response = await request(createApp({
      environment: { ...configuredEnvironment, DASHBOARD_TA_YIELD_STAGING_ENABLED: 'true', STAGING_SQL_SERVER: 'staging', STAGING_SQL_DATABASE: 'ProductionMES', STAGING_SQL_USER: 'user', STAGING_SQL_PASSWORD: 'password' },
      taYieldStagingRepository,
      yieldDefectSettingRepository: { list: () => Promise.resolve([]) }
    })).get('/api/ta-yield-machine?dataset=ta-yield&startDate=2026-08-01&endDate=2026-08-15&process=1.1stAnodization&machine=__ALL__&defectType=code&defect=1304_Welding_Def');

    expect(response.status).toBe(200);
    expect(response.body.data.rows).toEqual([expect.objectContaining({ date: '2026-08-01', machineName: 'AN-01', mode: '1304_Welding_Def', quantity: 12 })]);
  });

  it('returns only safe database metadata from config', async () => {
    const response = await request(createApp({ environment: configuredEnvironment }))
      .get('/api/config');

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      server: configuredEnvironment.SQL_SERVER,
      database: configuredEnvironment.SQL_DATABASE,
      view: configuredEnvironment.DB_VIEW,
      filters: { process: true, serie: true, case: true, pn: true },
      ready: true
    });
    expect(response.body.data.dataset).toBe('closed');
    expect(response.body.data.datasets).toHaveLength(4);
    expect(response.body.data.datasets).toContainEqual({ id: 'ta-yield', label: 'TA Yield' });
    expect(response.body.data.datasets).toContainEqual({ id: 'yield', label: 'SC Yield (Complete Action)' });
    expect(response.body.data.dataModels.closed).toEqual(expect.objectContaining({ view: configuredEnvironment.DB_VIEW }));
  });

  it('uses the source-operation chart for Lot Complete Log when configured', async () => {
    const response = await request(createApp({
      environment: {
        ...configuredEnvironment,
        LOT_DB_VIEW: 'PowerBIThailand.LotCompleteLog',
        LOT_DATE_COLUMN: 'OccuredOn',
        LOT_SERIE_COLUMN: 'Series',
        LOT_CHART_COLUMN: 'From_OperationName'
      }
    })).get('/api/config?dataset=lot');
    expect(response.body.data.chartAxis).toBe('process');
  });

  it('returns mapped SC Yield data only for the SC Yield source', async () => {
    const scYieldRepository = {
      getYieldRows: () => Promise.resolve({
        inputs: [{ bucketMonth: '2026-07', line: 'FM', quantity: 100 }],
        defects: [{ bucketMonth: '2026-07', line: 'FM', dispositionCode: '1212', quantity: 2 }, { bucketMonth: '2026-07', line: 'FM', dispositionCode: '1111', quantity: 4 }]
      })
    };
    const app = createApp({ environment: configuredEnvironment, scYieldRepository });
    const response = await request(app).get('/api/sc-yield?dataset=yield&startDate=2026-07-01&endDate=2026-07-31');
    expect(response.status).toBe(200);
    expect(response.body.data[0]).toMatchObject({ month: '2026-07', line: 'FM', input: 100, defect: 2, yield: 98, excluded: 4, unmapped: 0, groups: [{ group: 'Assembly', quantity: 2, rate: 2 }] });
    expect(response.body.data[0]).not.toHaveProperty('jobName');
    expect(response.body.data[0]).not.toHaveProperty('job');
    expect(response.body.data[0]).not.toHaveProperty('lot');
    const wrongSource = await request(app).get('/api/sc-yield?dataset=closed&startDate=2026-07-01&endDate=2026-07-31');
    expect(wrongSource.status).toBe(400);
  });

  it('falls back to direct MES SC Yield rows when the requested range is not staged exactly', async () => {
    const scYieldRepository = { getYieldRows: () => Promise.resolve({ inputs: [{ bucketMonth: '2026-07', line: 'FM', quantity: 100 }], defects: [] }) };
    const scYieldStagingRepository = { getYieldRows: () => Promise.reject(new Error('SC Yield staging snapshot does not exactly match the requested end date.')) };
    const response = await request(createApp({ environment: configuredEnvironment, scYieldRepository, scYieldStagingRepository }))
      .get('/api/sc-yield?dataset=yield&startDate=2026-07-02&endDate=2026-07-10');

    expect(response.status).toBe(200);
    expect(response.body.data[0]).toMatchObject({ input: 100, defect: 0, yield: 100 });
  });

  it('returns workbook-reconciliation rows only for the TA Yield source', async () => {
    const stagedRows = [{ line: 'Ta NEO Capacitor FPS series B3 case', lotNo: '6H01N00002', itemName: 'TEFPS', tapingDate: '2026-08-01', dispositionDescription: 'Cam1 defective for GPS', quantity: 13 }];
    const taYieldRepository = { getWorkbookReconciliationRows: () => Promise.reject(new Error('MES must not be queried when the workbook snapshot exists')) };
    const taYieldStagingRepository = { getWorkbookRows: (filters) => Promise.resolve(filters.endDate === '2026-08-13' ? stagedRows : []) };
    const app = createApp({ environment: { ...configuredEnvironment, DASHBOARD_TA_YIELD_STAGING_ENABLED: 'true', STAGING_SQL_SERVER: 'svr120a', STAGING_SQL_DATABASE: 'ProductionMES', STAGING_SQL_USER: 'test', STAGING_SQL_PASSWORD: 'test' }, taYieldRepository, taYieldStagingRepository });
    const response = await request(app).get('/api/ta-yield-workbook-reconciliation?dataset=ta-yield&startDate=2026-08-01&endDate=2026-08-13');
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([expect.objectContaining({ lotNo: '6H01N00002', categories: expect.objectContaining({ App: 13, ACC: 0 }) })]);
    expect((await request(app).get('/api/ta-yield-workbook-reconciliation?dataset=closed&startDate=2026-08-01&endDate=2026-08-13')).status).toBe(400);
  });

  it('uses date-filtered TA workbook rows for partial-month KPI ranges', async () => {
    const taYieldStagingRepository = {
      getMonthlySummary: () => Promise.resolve([{ month: '2026-08', line: 'FPS', group: 'ESR', input: 1000, finalGood: 900, defect: 100 }]),
      getMonthlyPartNumbers: () => Promise.resolve([]),
      getWorkbookRows: () => Promise.resolve([{ line: 'FPS', lotNo: '6H01N00021', itemName: 'TEFPS', tapingDate: '2026-08-03', categories: { Input: 100, Good: 90, ESR: 10 } }])
    };
    const app = createApp({
      environment: { ...configuredEnvironment, DASHBOARD_TA_YIELD_STAGING_ENABLED: 'true', STAGING_SQL_SERVER: 'staging', STAGING_SQL_DATABASE: 'ProductionMES', STAGING_SQL_USER: 'user', STAGING_SQL_PASSWORD: 'password' },
      taYieldStagingRepository
    });

    const response = await request(app).get('/api/ta-yield?dataset=ta-yield&startDate=2026-08-01&endDate=2026-08-16');

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([expect.objectContaining({ month: '2026-08', line: 'FPS', input: 100, finalGood: 90, defect: 10, yield: 90 })]);
  });

  it('rejects invalid quantity date ranges before accessing SQL', async () => {
    const response = await request(createApp({ environment: configuredEnvironment }))
      .get('/api/quantity?startDate=invalid&endDate=2026-01-01');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ success: false, error: 'Provide valid startDate and endDate values in YYYY-MM-DD format.' });
  });

  it('rejects reversed and excessively long date ranges', async () => {
    const app = createApp({ environment: configuredEnvironment });
    const reversed = await request(app).get('/api/quantity?startDate=2026-01-02&endDate=2026-01-01');
    const longRange = await request(app).get('/api/quantity?startDate=2024-01-01&endDate=2026-01-01');
    expect(reversed.body.error).toBe('startDate must be on or before endDate.');
    expect(longRange.body.error).toBe('Date range cannot exceed 366 days.');
  });

  it('uses a repository for columns, options, and quantity data', async () => {
    const repository = {
      getColumns: () => Promise.resolve([{ name: 'completedAt', type: 'datetime2' }]),
      getOptions: () => Promise.resolve({ process: ['Assembly'], serie: [], case: [], pn: ['PN-01'] }),
      getQuantity: () => Promise.resolve([{ bucketDate: '2026-01-01', itemName: 'PN-01', quantityMoved: 8 }])
    };
    const app = createApp({ environment: configuredEnvironment, repository });
    expect((await request(app).get('/api/columns')).body.data[0].name).toBe('completedAt');
    const optionsResponse = await request(app).get('/api/options');
    expect(optionsResponse.body.data.process).toEqual(['Assembly']);
    expect(optionsResponse.headers['cache-control']).toBe('no-store');
    expect((await request(app).get('/api/quantity?startDate=2026-01-01&endDate=2026-01-01')).body.data[0].quantityMoved).toBe(8);
  });

  it('exports the filtered series completion table as an Excel workbook', async () => {
    const repository = { getQuantity: () => Promise.resolve([{ bucketDate: '2026-01-01', itemName: 'FPS A3', quantityMoved: 8 }]) };
    const response = await request(createApp({ environment: configuredEnvironment, repository }))
      .get('/api/export/completion?startDate=2026-01-01&endDate=2026-01-01')
      .buffer(true)
      .parse((stream, callback) => { const chunks = []; stream.on('data', (chunk) => chunks.push(chunk)); stream.on('end', () => callback(null, Buffer.concat(chunks))); });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(response.headers['content-disposition']).toContain('901-series-completion-2026-01-01-to-2026-01-01.xlsx');
    expect(response.body.subarray(0, 2).toString()).toBe('PK');
  });

  it('exports the TA Yield DataTable as a formatted Excel workbook', async () => {
    const stagedRows = [{ line: 'Ta NEO Capacitor FPS series A08 case', lotNo: '6H01N00021', itemName: 'TEFPSA081C226MTHF8R-T', tapingDate: '2026-08-03', categories: { ACC: 38, App: 209, Good: 17443 }, calculation: { defect: 247, other1: 0, inputF: 17690, other2: 0, goodRate: 98.6048615, defectRate: 1.3951385, ttl: 100, check: 0 } }];
    const taYieldStagingRepository = { getWorkbookRows: () => Promise.resolve(stagedRows) };
    const response = await request(createApp({ environment: { ...configuredEnvironment, DASHBOARD_TA_YIELD_STAGING_ENABLED: 'true', STAGING_SQL_SERVER: 'svr120a', STAGING_SQL_DATABASE: 'ProductionMES', STAGING_SQL_USER: 'test', STAGING_SQL_PASSWORD: 'test' }, taYieldStagingRepository }))
      .get('/api/export/ta-yield-datatable?dataset=ta-yield&startDate=2026-08-01&endDate=2026-08-13')
      .buffer(true)
      .parse((stream, callback) => { const chunks = []; stream.on('data', (chunk) => chunks.push(chunk)); stream.on('end', () => callback(null, Buffer.concat(chunks))); });

    expect(response.status).toBe(200);
    expect(response.headers['content-disposition']).toContain('ta-yield-datatable-2026-08-01-to-2026-08-13.xlsx');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(response.body);
    const worksheet = workbook.getWorksheet('TA Yield DataTable');
    expect(worksheet.getCell('A1').value).toBe('TA Yield DataTable');
    expect(worksheet.getCell('A4').value).toBe('ProdLine');
    expect(worksheet.getCell('A5').value).toBe(stagedRows[0].line);
    expect(worksheet.getCell('A4').fill.fgColor.argb).toBe('FF28358C');
    const goodRateColumn = [...worksheet.getRow(4).values].indexOf('%Good');
    expect(worksheet.getCell(5, goodRateColumn)).toMatchObject({ value: 0.986048615, numFmt: '0.000000%' });
  }, 15000);

  it('uses the MTD-only quantity path for Completion 901', async () => {
    let receivedOptions;
    const repository = { getQuantity: (_filters, options) => { receivedOptions = options; return Promise.resolve([]); } };
    const app = createApp({ environment: configuredEnvironment, repository });
    const closed = await request(app).get('/api/mtd-quantity?dataset=closed&product=NEO&startDate=2026-01-01&endDate=2026-01-01');
    const lot = await request(app).get('/api/mtd-quantity?dataset=lot&startDate=2026-01-01&endDate=2026-01-01');
    expect(closed.status).toBe(200);
    expect(receivedOptions).toEqual({ mtd: true });
    expect(lot.status).toBe(400);
  });

  it('returns a safe availability error when the repository fails', async () => {
    const app = createApp({ environment: configuredEnvironment, repository: { getOptions: () => Promise.reject(new Error('token details')) } });
    const response = await request(app).get('/api/options');
    expect(response.status).toBe(503);
    expect(response.body.error).toContain('Database data is currently unavailable');
    expect(JSON.stringify(response.body)).not.toContain('token details');
  });

  it('requests interactive sign-in when the database token has expired', async () => {
    const app = createApp({ environment: configuredEnvironment, repository: { getOptions: () => Promise.reject(Object.assign(new Error('Access token expired'), { code: 'ELOGIN' })) } });
    const response = await request(app).get('/api/options');
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTH_REQUIRED');
  });

  it('recognizes SQL Server token-expiration wording and requests sign-in', async () => {
    const app = createApp({ environment: configuredEnvironment, repository: { getOptions: () => Promise.reject(new Error("Login failed for user '<token-identified principal>'. Token is expired.")) } });
    const response = await request(app).get('/api/options?dataset=lot');
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTH_REQUIRED');
  });

  it('starts interactive sign-in through the authentication endpoint', async () => {
    let authenticated = false;
    const app = createApp({ environment: configuredEnvironment, repository: { authenticate: () => { authenticated = true; return Promise.resolve(); } } });
    const response = await request(app).get('/api/auth/login');
    expect(response.body.data.authenticated).toBe(true);
    expect(authenticated).toBe(true);
  });

  it('explains missing database configuration without returning secrets', async () => {
    const response = await request(createApp({ environment: {} })).get('/api/config');

    expect(response.status).toBe(200);
    expect(response.body.data.ready).toBe(false);
    expect(response.body.data.missing).toContain('DATE_COLUMN');
    expect(JSON.stringify(response.body)).not.toContain('SQL_PASSWORD');
  });

  it('allows safe column inspection before the date column is configured', async () => {
    const repository = { getColumns: () => Promise.resolve([{ name: 'eventTime', type: 'datetime2' }]) };
    const response = await request(createApp({ environment: { ...configuredEnvironment, DATE_COLUMN: '' }, repository }))
      .get('/api/columns');
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([{ name: 'eventTime', type: 'datetime2' }]);
  });

  it('validates object discovery searches', async () => {
    const response = await request(createApp({ environment: configuredEnvironment })).get('/api/objects?search=;DROP');
    expect(response.status).toBe(400);
  });

  it('forwards valid process option filters to the repository', async () => {
    let receivedFilters;
    const repository = { getOptions: (filters) => { receivedFilters = filters; return Promise.resolve({}); } };
    const response = await request(createApp({ environment: configuredEnvironment, repository })).get('/api/options?process=SC');
    expect(response.status).toBe(200);
    expect(receivedFilters).toEqual({ process: 'SC' });
  });

  it('forwards multiple Series filters to the repository', async () => {
    let receivedFilters;
    const repository = { getQuantity: (filters) => { receivedFilters = filters; return Promise.resolve([]); } };
    const response = await request(createApp({ environment: configuredEnvironment, repository })).get('/api/quantity?startDate=2026-01-01&endDate=2026-01-01&serie=CAN&serie=FPS');
    expect(response.status).toBe(200);
    expect(receivedFilters.serie).toEqual(['CAN', 'FPS']);
  });

  it('forwards the selected Product to the quantity repository filter', async () => {
    let receivedFilters;
    const repository = { getQuantity: (filters) => { receivedFilters = filters; return Promise.resolve([]); } };
    const response = await request(createApp({ environment: configuredEnvironment, repository })).get('/api/quantity?startDate=2026-01-01&endDate=2026-01-01&product=SC');
    expect(response.status).toBe(200);
    expect(receivedFilters.product).toBe('SC');
  });

  it('caches repeated report queries but keeps Closed Batch and Lot Complete Log separate', async () => {
    let calls = 0;
    const repository = { getQuantity: () => { calls += 1; return Promise.resolve([]); } };
    const app = createApp({ environment: { ...configuredEnvironment, LOT_DB_VIEW: 'dbo.LotCompleteLog', LOT_DATE_COLUMN: 'completedAt' }, repository });
    const closed = await request(app).get('/api/quantity?dataset=closed&startDate=2026-01-01&endDate=2026-01-01');
    const repeatClosed = await request(app).get('/api/quantity?dataset=closed&startDate=2026-01-01&endDate=2026-01-01');
    const lot = await request(app).get('/api/quantity?dataset=lot&startDate=2026-01-01&endDate=2026-01-01');
    expect(closed.headers['x-dashboard-cache']).toBe('MISS');
    expect(repeatClosed.headers['x-dashboard-cache']).toBe('HIT');
    expect(lot.headers['x-dashboard-cache']).toBe('MISS');
    expect(repeatClosed.headers['cache-control']).toBe('private, max-age=120');
    expect(calls).toBe(2);
  });

  it('returns paginated part-number results using the selected process and series', async () => {
    let argumentsReceived;
    const repository = { getPartNumbers: (...args) => { argumentsReceived = args; return Promise.resolve({ items: ['PN-01'], hasMore: false }); } };
    const response = await request(createApp({ environment: configuredEnvironment, repository }))
      .get('/api/part-numbers?process=SC&serie=CAN&search=FA&offset=100');
    expect(response.body.data.items).toEqual(['PN-01']);
    expect(argumentsReceived).toEqual([{ process: 'SC', serie: 'CAN' }, 'FA', 100]);
  });

  it('passes multiple selected part numbers to report queries', async () => {
    let receivedFilters;
    const repository = { getQuantity: (filters) => { receivedFilters = filters; return Promise.resolve([]); } };
    const response = await request(createApp({ environment: configuredEnvironment, repository }))
      .get('/api/quantity?startDate=2026-01-01&endDate=2026-01-01&pn=PN-1&pn=PN-2');
    expect(response.status).toBe(200);
    expect(receivedFilters.pn).toEqual(['PN-1', 'PN-2']);
  });

  it('returns chart aggregates for the selected data source and date range', async () => {
    let receivedFilters;
    const repository = { getChartData: (filters) => { receivedFilters = filters; return Promise.resolve([{ chartName: 'SCRAP', quantityMoved: 25 }]); } };
    const response = await request(createApp({ environment: configuredEnvironment, repository }))
      .get('/api/chart?dataset=lot&startDate=2026-01-01&endDate=2026-01-02');
    expect(response.body.data).toEqual([{ chartName: 'SCRAP', quantityMoved: 25 }]);
    expect(receivedFilters.startDate).toBe('2026-01-01');
  });

  it('returns Lot Complete Log disposition diagnostics only', async () => {
    const repository = { getDispositionSummary: () => Promise.resolve([{ disposition: 'good', quantityMoved: 50, rowCount: 2 }]) };
    const app = createApp({ environment: { ...configuredEnvironment, LOT_DB_VIEW: 'dbo.LotCompleteLog', LOT_DATE_COLUMN: 'completedAt' }, repository });
    const lot = await request(app).get('/api/dispositions?dataset=lot&startDate=2026-01-01&endDate=2026-01-02');
    const closed = await request(app).get('/api/dispositions?dataset=closed&startDate=2026-01-01&endDate=2026-01-02');
    expect(lot.body.data).toEqual([expect.objectContaining({ disposition: 'good' })]);
    expect(closed.status).toBe(400);
  });

  it('returns Lot Complete Log operation transitions only', async () => {
    const repository = { getOperationTransitions: () => Promise.resolve([{ fromOperation: 'Sintering', toOperation: 'CVCheck', quantityMoved: 25 }]) };
    const app = createApp({ environment: { ...configuredEnvironment, LOT_DB_VIEW: 'dbo.LotCompleteLog', LOT_DATE_COLUMN: 'completedAt' }, repository });
    const lot = await request(app).get('/api/operation-transitions?dataset=lot&startDate=2026-01-01&endDate=2026-01-02');
    const closed = await request(app).get('/api/operation-transitions?dataset=closed&startDate=2026-01-01&endDate=2026-01-02');
    expect(lot.body.data).toEqual([expect.objectContaining({ fromOperation: 'Sintering', toOperation: 'CVCheck' })]);
    expect(closed.status).toBe(400);
  });

  it('returns WIP flow and yield analyses for Lot Complete Log only', async () => {
    const repository = { getWipFlow: () => Promise.resolve([{ operationName: 'PRINTING', netQuantity: 100 }]), getYieldSummary: () => Promise.resolve([{ operationName: 'PRINTING', disposition: 'good', quantityMoved: 50 }]) };
    const app = createApp({ environment: { ...configuredEnvironment, LOT_DB_VIEW: 'dbo.LotCompleteLog', LOT_DATE_COLUMN: 'completedAt', LOT_DISPOSITION_COLUMN: 'DispositionType', LOT_DISPOSITION_VALUE: 'good' }, repository });
    const flow = await request(app).get('/api/wip-flow?dataset=lot&startDate=2026-01-01&endDate=2026-01-02');
    const yieldData = await request(app).get('/api/yield?dataset=lot&startDate=2026-01-01&endDate=2026-01-02');
    const closed = await request(app).get('/api/wip-flow?dataset=closed&startDate=2026-01-01&endDate=2026-01-02');
    expect(flow.body.data).toEqual([expect.objectContaining({ operationName: 'PRINTING' })]);
    expect(yieldData.body.data).toEqual(expect.objectContaining({ goodDisposition: 'good' }));
    expect(closed.status).toBe(400);
  });

  it('reads and writes shared MTD targets through the settings repository', async () => {
    const targets = [];
    const mtdTargetRepository = {
      list: () => Promise.resolve(targets),
      upsert: (target) => { targets.push(target); return Promise.resolve(); },
      remove: () => Promise.resolve()
    };
    const app = createApp({ environment: configuredEnvironment, mtdTargetRepository });
    const saved = await request(app).put('/api/mtd-targets').send({ product: 'NEO', serie: 'FPS A3', period: '2026-07', monthlyPlan: 5000000, workingDay: 22 });
    expect(saved.status).toBe(200);
    const inactive = await request(app).put('/api/mtd-targets').send({ product: 'NEO', serie: 'FPS B2', period: '2026-07', monthlyPlan: 0, workingDay: 22 });
    expect(inactive.status).toBe(200);
    expect((await request(app).get('/api/mtd-targets')).body.data).toEqual(expect.arrayContaining([expect.objectContaining({ serie: 'FPS A3' }), expect.objectContaining({ serie: 'FPS B2', monthlyPlan: 0 })]));
  });

  it('creates, updates, lists, and soft-deletes scoped cell comments', async () => {
    const comments = [];
    const cellCommentRepository = {
      list: (scope) => Promise.resolve(comments.filter((comment) => comment.product === scope.product && comment.reportingDate >= scope.startDate && comment.reportingDate <= scope.endDate && (comment.pn || '') === scope.pn && (comment.process || '') === scope.process && !comment.deletedAt)),
      listAll: () => Promise.resolve(comments.filter((comment) => !comment.deletedAt)),
      create: (comment) => { const stored = { ...comment, id: comments.length + 1, createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' }; comments.push(stored); return Promise.resolve(stored); },
      update: (id, commentText) => { const comment = comments.find((entry) => entry.id === id); comment.commentText = commentText; comment.updatedAt = '2026-07-02T00:00:00.000Z'; return Promise.resolve(comment); },
      remove: (id) => { comments.find((comment) => comment.id === id).deletedAt = '2026-07-03T00:00:00.000Z'; return Promise.resolve(); }
    };
    const app = createApp({ environment: configuredEnvironment, cellCommentRepository });
    const created = await request(app).post('/api/comments').send({ product: 'NEO', serie: 'FPS A3', pn: '', process: '', reportingDate: '2026-07-01', dataset: 'closed', commentText: 'Check output variance.' });
    expect(created.status).toBe(200);
    const updated = await request(app).patch('/api/comments/1').send({ commentText: 'Variance reviewed.' });
    expect(updated.status).toBe(200);
    const listed = await request(app).get('/api/comments?product=NEO&pn=&process=&startDate=2026-07-01&endDate=2026-07-01');
    expect(listed.body.data).toEqual([expect.objectContaining({ serie: 'FPS A3', commentText: 'Variance reviewed.', createdBy: '901' })]);
    const allComments = await request(app).get('/api/comments/all');
    expect(allComments.body.data).toEqual([expect.objectContaining({ product: 'NEO', serie: 'FPS A3' })]);
    const removed = await request(app).delete('/api/comments/1');
    expect(removed.body.data).toEqual({ removed: true });
    
    const afterDelete = await request(app).get('/api/comments?product=NEO&pn=&process=&startDate=2026-07-01&endDate=2026-07-01');
    expect(afterDelete.body.data).toEqual([]);
  });

  it('creates, updates, lists, and closes TA Yield action records', async () => {
    const actions = [];
    const taYieldActionRepository = {
      list: () => Promise.resolve(actions.filter((action) => !action.deletedAt)),
      create: (action) => { const stored = { ...action, id: actions.length + 1, createdAt: '2026-08-14T00:00:00.000Z', updatedAt: null }; actions.push(stored); return Promise.resolve(stored); },
      update: (id, action) => { const existing = actions.find((item) => item.id === id); Object.assign(existing, action, { updatedAt: '2026-08-15T00:00:00.000Z' }); return Promise.resolve(existing); },
      remove: (id) => { actions.find((action) => action.id === id).deletedAt = '2026-08-15T00:00:00.000Z'; return Promise.resolve(true); }
    };
    const app = createApp({ environment: configuredEnvironment, taYieldActionRepository });
    const payload = { actionDate: '2026-08-14', serie: 'FPS A08', problem: 'High ESR variation', analysisAction: 'Check dicing and P&P conditions.', pic: 'Ms. Sasitorn', progress: 'Investigation started.', dueDate: '2026-08-18', status: 'IN_PROGRESS' };
    const created = await request(app).post('/api/ta-yield-actions').send(payload);
    expect(created.status).toBe(200);
    expect(created.body.data).toMatchObject({ id: 1, serie: 'FPS A08', status: 'IN_PROGRESS' });
    const updated = await request(app).patch('/api/ta-yield-actions/1').send({ ...payload, progress: 'Corrective action scheduled.', status: 'CLOSED' });
    expect(updated.body.data).toMatchObject({ progress: 'Corrective action scheduled.', status: 'CLOSED' });
    expect((await request(app).get('/api/ta-yield-actions')).body.data).toHaveLength(1);
    expect((await request(app).delete('/api/ta-yield-actions/1')).body.data).toEqual({ removed: true });
    expect((await request(app).get('/api/ta-yield-actions')).body.data).toEqual([]);
  });
});
