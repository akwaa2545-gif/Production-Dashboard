import { describe, expect, it } from 'vitest';
import { SqlRepository } from '../src/sqlRepository.js';
import { readDatasetConfig } from '../src/config.js';
import { loadWipStagingRows, refreshWipStaging } from '../src/stagingWipRefresh.js';
import request from 'supertest';
import { createApp } from '../src/app.js';

const config = {
  dataset: 'lot', view: 'PowerBIThailand.LotCompleteLog', dateColumn: 'OccuredOn',
  quantityColumn: 'QuantityMoved', processColumn: 'To_OperationName', chartColumn: 'From_OperationName',
  pnColumn: 'From_ItemName', groupColumn: 'Series', serieColumn: 'Series',
  serieLookupView: 'PowerBIThailand.ClosedBatch_v', serieSourceJoinColumn: 'JobName',
  serieLookupJoinColumn: 'JobName', productLookupColumn: 'ProdType',
  serieBlankProduct: 'SC', serieBlankValue: 'Element', serieBlankSourceProduct: 'NEO',
  serieBlankSourceColumn: 'ProdLine', serieBlankSourceFormat: 'neo-capacitor',
  dispositionColumn: 'DispositionType', dispositionValue: 'Good',
  reportingTimeZone: 'SE Asia Standard Time', requestTimeout: 15000,
  wipMovementFallback: true, wipActionView: 'PowerBIThailand.CompleteAction_v',
  wipReleasedView: 'KMESV3.ReleasedJob', linkedSeriesLookupBatchSize: 128,
  fromRouteStepColumn: 'From_RouteStepName', toRouteStepColumn: 'To_RouteStepName',
  fromRouteSequenceColumn: 'From_RouteSeq', toRouteSequenceColumn: 'To_RouteSeq',
  chartExcludedValues: ['RouteDecisionPoint']
};
const filters = { startDate: '2026-09-30', endDate: '2026-09-30', product: 'NEO' };
function movement(overrides = {}) {
  return { eventId: 100, transactionId: 200, plantId: 3, jobName: 'OPEN-GPS',
    occurredOn: new Date('2026-09-30T13:47:49.650Z'), bucketDate: '2026-09-30',
    chartName: 'Resin_coating', processName: 'Tape_mount', partNumber: 'TEGPSP20J476M1508RKT',
    quantityMoved: 24313, dispositionCode: 'To Tape_mount', dispositionType: 'Good',
    fromRouteStepName: '12', toRouteStepName: '13', fromRouteSequence: 12, toRouteSequence: 13,
    ...overrides };
}
function candidate(row, overrides = {}) {
  return { eventIndex: 0, product: 'NEO', prodLine: 'Ta NEO Capacitor GPS series P2 case',
    seriesName: 'GPS P2', supportedNeoLine: 1, releaseIdentityCount: 1, ...overrides };
}
function repository(rows, { closed = [], actions, failure } = {}) {
  const calls = []; let active = 0; let maxActive = 0;
  const pool = { calls, get maxActive() { return maxActive; }, request() {
    const inputs = []; return { input(name, type, value) { inputs.push([name, value]); return this; },
      async query(statement) {
        calls.push({ statement, inputs, timeout: this.timeout }); active++; maxActive = Math.max(active, maxActive);
        try {
          await new Promise(resolve => setImmediate(resolve));
          if (statement.includes('wip:action-metadata')) {
            if (failure) throw failure;
            return { recordset: typeof actions === 'function' ? actions(inputs, statement) : actions ?? rows.map((row, eventIndex) => candidate(row, { eventIndex })) };
          }
          if (statement.includes('ClosedBatch_v')) return { recordset: closed };
          return { recordset: rows };
        } finally { active--; }
      } };
  } };
  const repo = new SqlRepository(config); repo.pool = pool;
  return { repo, pool };
}

describe('WIP verified movement classification', () => {
  it('restores a missing NEO movement in daily totals and its original operation/date', async () => {
    const { repo } = repository([movement()]);
    expect(await repo.getStagingQuantityRows(filters)).toEqual([
      { bucketDate: '2026-09-30', jobName: 'OPEN-GPS', itemName: 'GPS P2', quantityMoved: 24313 }
    ]);
    const chart = await repo.getChartData({ ...filters, serie: ['GPS P2'], pn: 'TEGPSP20J476M1508RKT', process: 'Tape_mount' }, true, true);
    expect(chart).toEqual([expect.objectContaining({ bucketDate: '2026-09-30', chartName: 'Resin_coating', seriesName: 'GPS P2', partNumber: 'TEGPSP20J476M1508RKT', quantityMoved: 24313, fromRouteStepName: '12' })]);
  });
  it('counts distinct original events once even when action metadata is repeated', async () => {
    const rows = [movement(), movement({ eventId: 101, transactionId: 201 })];
    const { repo } = repository(rows, { actions: [candidate(rows[0]), candidate(rows[0]), candidate(rows[1], { eventIndex: 1 })] });
    expect(await repo.getQuantity(filters)).toEqual([{ bucketDate: '2026-09-30', itemName: 'GPS P2', quantityMoved: 48626 }]);
  });
  it('retains the source decimal precision when aggregating separate movements', async () => {
    const { repo } = repository([movement({ quantityMoved: 0.1 }), movement({ eventId: 101, quantityMoved: 0.2 })]);
    expect(await repo.getQuantity(filters)).toEqual([{ bucketDate: '2026-09-30', itemName: 'GPS P2', quantityMoved: 0.3 }]);
  });
  it('preserves ClosedBatch eligibility when the matching product has a null series', async () => {
    const { repo } = repository([movement({ jobName: 'CLOSED' })], { closed: [
      { jobName: 'CLOSED', neoSeries: null, neoMatched: 1, allSeries: null, closedMatches: 1 }
    ] });
    expect(await repo.getQuantity(filters)).toEqual([{ bucketDate: '2026-09-30', itemName: 'Unspecified', quantityMoved: 24313 }]);
  });
  it('restores the eighteen sampled movement shapes under all three operations', async () => {
    const quantities = [24313,23717,22726,22205,23721,23588,23222,23054,23248,22590,11569,11487,11581,11222,11605,15123,11230,11500];
    const rows = quantities.map((quantityMoved, i) => movement({ eventId: i + 1, transactionId: i + 100, jobName: 'SAMPLE-' + i,
      quantityMoved, chartName: i < 6 ? 'Resin_coating' : i < 10 ? 'Tape_mount' : 'Welding' }));
    const { repo } = repository(rows);
    const snapshot = await loadWipStagingRows(repo, { startDate: filters.startDate, endDate: filters.endDate });
    expect(snapshot.rows).toHaveLength(18);
    expect(snapshot.processRows.map(row => [row.chartName,row.quantityMoved])).toEqual([
      ['Resin_coating',140270],['Tape_mount',92114],['Welding',95317]
    ]);
    expect(snapshot.diagnostics).toMatchObject({ fallbackResolved: 18, unresolved: 0 });
  });
  it('bounds action batches and keeps their reads serial', async () => {
    const rows = Array.from({ length: 129 }, (_, i) => movement({ eventId: i, jobName: 'JOB-' + i }));
    const { repo, pool } = repository(rows);
    expect(await repo.getStagingQuantityRows(filters)).toHaveLength(129);
    const actions = pool.calls.filter(call => call.statement.includes('wip:action-metadata'));
    expect(actions).toHaveLength(2);
    expect(actions.map(call => call.inputs.filter(([name]) => /^plant\d+$/.test(name)).length)).toEqual([128,1]);
    expect(pool.maxActive).toBe(1);
  });
  it('does not classify two source rows with the same plant/event identity', async () => {
    const { repo } = repository([movement(), movement()]);
    expect(await repo.getQuantity(filters)).toEqual([]);
    expect(repo.lastWipMovementDiagnostics).toMatchObject({ unresolved: 2, reasons: { ambiguousSourceIdentity: 2 } });
  });
  it('does not turn an unsupported requested product into unfiltered NEO totals', async () => {
    const { repo } = repository([movement()]);
    expect(await repo.getQuantity({ ...filters, product: 'OTHER' })).toEqual([]);
    expect(await repo.getChartData({ ...filters, product: 'OTHER' })).toEqual([]);
  });
  it('retains explicit ClosedBatch chart series eligibility independently of displayed global series', async () => {
    const { repo } = repository([movement({ jobName: 'CLOSED' })], { closed: [
      { jobName: 'CLOSED', neoSeries: 'Z GPS', allSeries: 'A FPS', closedMatches: 2, selectedSeriesMatched: 1 }
    ] });
    expect(await repo.getChartData({ ...filters, serie: ['Z GPS'] })).toEqual([
      expect.objectContaining({ seriesName: 'A FPS', quantityMoved: 24313 })
    ]);
  });
  it('separates plant/event identities and never promotes fallback metadata to every event of a job', async () => {
    const rows = [movement(), movement({ plantId: 7 }), movement({ eventId: 101, chartName: 'Welding' })];
    const { repo } = repository(rows, { actions: [candidate(rows[0])] });
    expect(await repo.getQuantity(filters)).toEqual([{ bucketDate: '2026-09-30', itemName: 'GPS P2', quantityMoved: 24313 }]);
    expect(repo.lastWipMovementDiagnostics).toMatchObject({ fallbackResolved: 1, unresolved: 2 });
  });
  it('leaves duplicate release identities unresolved even when their metadata agrees', async () => {
    const row = movement();
    const { repo, pool } = repository([row], { actions: [candidate(row, { releaseIdentityCount: 2 })] });
    expect(await repo.getQuantity(filters)).toEqual([]);
    expect(repo.lastWipMovementDiagnostics).toMatchObject({ unresolved: 1, reasons: { ambiguousReleaseIdentity: 1 } });
    expect(pool.calls.find(call => call.statement.includes('wip:action-metadata')).statement).toContain('COUNT_BIG(*) AS releaseIdentityCount');
  });
  it('ignores null route metadata while retaining a later route value in either source order', async () => {
    const first = movement({ fromRouteStepName: null, toRouteStepName: null });
    const second = movement({ eventId: 101 });
    for (const rows of [[first, second], [second, first]]) {
      const { repo } = repository(rows);
      expect(await repo.getChartData(filters)).toEqual([expect.objectContaining({ fromRouteStepName: '12', toRouteStepName: '13' })]);
    }
  });
  it('retains SQL chart exclusion eligibility without dropping daily quantities', async () => {
    const rows = [movement({ chartName: null, chartEligible: 0 }), movement({ eventId: 101, chartName: 'routedecisionpoint ', chartEligible: 0 })];
    const { repo, pool } = repository(rows);
    expect(await repo.getChartData(filters)).toEqual([]);
    expect(await repo.getQuantity(filters)).toEqual([{ bucketDate: '2026-09-30', itemName: 'GPS P2', quantityMoved: 48626 }]);
    expect(pool.calls.find(call => call.statement.includes('wip:movements')).statement).toContain('AS chartEligible');
  });
  it('preserves ClosedBatch daily and global chart series and never falls back to another product', async () => {
    const rows = [movement({ jobName: 'CLOSED', eventId: 1 }), movement({ jobName: 'OTHER', eventId: 2 })];
    const { repo, pool } = repository(rows, { closed: [
      { jobName: 'CLOSED', neoSeries: 'PSL B3', scSeries: null, allSeries: 'AAA', closedMatches: 2, serieName: 'PSL B3' },
      { jobName: 'OTHER', neoSeries: null, scSeries: 'Element', allSeries: 'Element', closedMatches: 1 }
    ] });
    expect(await repo.getStagingQuantityRows(filters)).toEqual([{ bucketDate: '2026-09-30', jobName: 'CLOSED', itemName: 'PSL B3', quantityMoved: 24313 }]);
    expect(await repo.getChartData(filters)).toEqual([expect.objectContaining({ chartName: 'Resin_coating', seriesName: 'AAA', quantityMoved: 24313 })]);
    expect(pool.calls.some(c => c.statement.includes('wip:action-metadata'))).toBe(false);
  });
  it('excludes ambiguous, absent, unsupported SC and unsupported NEO series without assigning a product', async () => {
    const rows = ['AMBIGUOUS','MISSING','SC-FG','BAD-LINE'].map((jobName,i) => movement({ jobName, eventId: i }));
    const { repo } = repository(rows, { actions: [
      candidate(rows[0]), candidate(rows[0], { product: 'SC', seriesName: null, supportedNeoLine: 0 }),
      candidate(rows[2], { eventIndex: 2, product: 'SC', seriesName: null, supportedNeoLine: 0 }),
      candidate(rows[3], { eventIndex: 3, prodLine: 'Unknown line', supportedNeoLine: 0 })
    ] });
    expect(await repo.getQuantity(filters)).toEqual([]);
    expect(repo.lastWipMovementDiagnostics).toMatchObject({ fallbackResolved: 0, unresolved: 4, reasons: { ambiguous: 1, missingVerifiedAction: 1, unsupportedScSeries: 1, unsupportedNeoSeries: 1 } });
  });
  it('matches event metadata and plant-qualified release identity with parameters and bounded serial reads', async () => {
    const row = movement({ jobName: "J' OR 1=1--", plantId: 7 });
    const { repo, pool } = repository([row]);
    await repo.getQuantity(filters);
    const action = pool.calls.find(c => c.statement.includes('wip:action-metadata'));
    expect(action).toBeDefined();
    expect(action.statement).toContain('[released].[OrganizationByPlantID] = [events].[plantId]');
    expect(action.statement).toContain('[released].[LotID] = [events].[jobName]');
    expect(action.statement).toContain('[action].[OccuredOn] = [events].[occurredOn]');
    expect(action.statement).toContain('[action].[QuantityMoved]');
    expect(action.statement).toContain('[released].[ProdLine]');
    expect(action.statement).not.toContain(row.jobName);
    expect(action.inputs.some(([,value]) => value === 7)).toBe(true);
    expect(action.inputs.some(([,value]) => value === row.jobName)).toBe(true);
    expect(action.timeout).toBeLessThanOrEqual(60000);
    expect(pool.maxActive).toBe(1);
  });
  it('rejects an action-query failure instead of returning partial classified totals', async () => {
    const failure = new Error('source timeout');
    const { repo } = repository([movement()], { failure });
    await expect(repo.getStagingQuantityRows(filters)).rejects.toBe(failure);
    let targetOpened = false;
    await expect(refreshWipStaging({ source: repo, target: { getPool() { targetOpened = true; } }, targetConfig: {}, startDate: filters.startDate, endDate: filters.endDate })).rejects.toBe(failure);
    expect(targetOpened).toBe(false);
  });
  it('keeps route exclusion and selected series after classification', async () => {
    const { repo } = repository([movement(), movement({ eventId: 101, chartName: 'RouteDecisionPoint' })]);
    expect(await repo.getChartData({ ...filters, serie: ['GPS P2'] })).toHaveLength(1);
    expect(await repo.getChartData({ ...filters, serie: ['PSL B3'] })).toEqual([]);
  });
  it('uses one classified snapshot for both NEO/SC staging tables', async () => {
    const { repo, pool } = repository([movement()]);
    const snapshot = await loadWipStagingRows(repo, { startDate: filters.startDate, endDate: filters.endDate });
    expect(snapshot.rows).toEqual([{ bucketDate: '2026-09-30', jobName: 'OPEN-GPS', itemName: 'GPS P2', quantityMoved: 24313, product: 'NEO' }]);
    expect(snapshot.processRows).toEqual([expect.objectContaining({ chartName: 'Resin_coating', seriesName: 'GPS P2', quantityMoved: 24313, product: 'NEO' })]);
    expect(pool.calls.filter(c => c.statement.includes('wip:movements'))).toHaveLength(1);
    expect(snapshot.diagnostics).toMatchObject({ fallbackResolved: 1, unresolved: 0 });
  });
  it('retains classification diagnostics after a connection recovery', async () => {
    let attempts = 0;
    const row = movement();
    const { repo } = repository([row], { actions: () => {
      if (++attempts === 1) throw Object.assign(new Error('Transient source connection'), { code: 'ESOCKET' });
      return [candidate(row)];
    } });
    repo.resetConnection = async () => {};
    const app = createApp({ environment: { SQL_SERVER: 'offline', SQL_DATABASE: 'offline', DATE_COLUMN: 'OccuredOn', DASHBOARD_DATA_MODE: 'live' }, repository: repo });
    const response = await request(app).get('/api/quantity').query({ dataset: 'lot', ...filters });
    expect(response.status).toBe(200);
    expect(response.headers['x-wip-fallback-movements']).toBe('1');
    expect(response.headers['x-wip-unresolved-movements']).toBe('0');
    expect(attempts).toBe(2);
  });
  it('keeps fallback classification on live filtered chart and quantity API requests', async () => {
    const { repo, pool } = repository([movement()]);
    const environment = { SQL_SERVER: 'offline', SQL_DATABASE: 'offline', DATE_COLUMN: 'OccuredOn',
      LOT_DB_VIEW: config.view, LOT_PROCESS_COLUMN: config.processColumn, LOT_CHART_COLUMN: config.chartColumn,
      LOT_PN_COLUMN: config.pnColumn, LOT_GROUP_COLUMN: 'Series', LOT_SERIE_COLUMN: 'Series',
      LOT_SERIE_LOOKUP_VIEW: config.serieLookupView, LOT_SERIE_SOURCE_JOIN_COLUMN: 'JobName', LOT_SERIE_LOOKUP_JOIN_COLUMN: 'JobName', LOT_PRODUCT_LOOKUP_COLUMN: 'ProdType' };
    const app = createApp({ environment, repository: repo, stagingWipRepository: {
      getQuantity() { throw new Error('Filtered quantity must use live movement source'); },
      getChartData() { throw new Error('Filtered chart must use live movement source'); }
    } });
    const query = { dataset: 'lot', ...filters, serie: 'GPS P2', process: 'Tape_mount', pn: 'TEGPSP20J476M1508RKT' };
    const chart = await request(app).get('/api/chart').query(query);
    expect(chart.status).toBe(200);
    expect(chart.headers['x-wip-fallback-movements']).toBe('1');
    expect(chart.headers['x-wip-unresolved-movements']).toBe('0');
    expect(chart.body.data).toEqual([expect.objectContaining({ chartName: 'Resin_coating', seriesName: 'GPS P2', quantityMoved: 24313 })]);
    const quantity = await request(app).get('/api/quantity').query(query);
    expect(quantity.status).toBe(200);
    expect(quantity.body.data).toEqual([{ bucketDate: '2026-09-30', itemName: 'GPS P2', quantityMoved: 24313 }]);
    const cached = await request(app).get('/api/chart').query(query);
    expect(cached.headers['x-wip-fallback-movements']).toBe('1');
    expect(cached.headers['x-dashboard-cache']).toBe('HIT');
    const rawReads = pool.calls.filter(c => c.statement.includes('wip:movements'));
    expect(rawReads).toHaveLength(2);
    for (const call of rawReads) {
      expect(call.statement).toContain('source.To_OperationName = @process');
      expect(call.statement).toContain('source.From_ItemName = @pn');
      expect(call.inputs).toContainEqual(['process', 'Tape_mount']);
      expect(call.inputs).toContainEqual(['pn', 'TEGPSP20J476M1508RKT']);
    }
  });
});

describe('WIP fallback configuration', () => {
  const env = { SQL_SERVER: 'offline', SQL_DATABASE: 'offline', DATE_COLUMN: 'OccuredOn', LOT_DB_VIEW: 'PowerBIThailand.LotCompleteLog',
    LOT_CHART_COLUMN: 'From_OperationName', LOT_PROCESS_COLUMN: 'To_OperationName', LOT_PN_COLUMN: 'From_ItemName', LOT_QUANTITY_COLUMN: 'QuantityMoved',
    LOT_SERIE_COLUMN: 'Series', LOT_GROUP_COLUMN: 'Series', LOT_SERIE_SOURCE_JOIN_COLUMN: 'JobName', LOT_SERIE_LOOKUP_JOIN_COLUMN: 'JobName',
    LOT_SERIE_LOOKUP_VIEW: 'PowerBIThailand.ClosedBatch_v', LOT_PRODUCT_LOOKUP_COLUMN: 'ProdType' };
  it('enables verified movement fallback only for the configured WIP dataset', () => {
    expect(readDatasetConfig(env, 'lot')).toMatchObject({ wipMovementFallback: true, wipActionView: 'PowerBIThailand.CompleteAction_v', wipReleasedView: 'KMESV3.ReleasedJob' });
    expect(readDatasetConfig(env, 'closed').wipMovementFallback).toBeFalsy();
    expect(readDatasetConfig({ ...env, LOT_MOVEMENT_FALLBACK_ENABLED: 'false' }, 'lot').wipMovementFallback).toBe(false);
  });
  it('rejects unsafe fallback view identifiers', () => {
    const result = readDatasetConfig({ ...env, LOT_MOVEMENT_ACTION_VIEW: 'dbo.Bad; DROP TABLE Jobs' }, 'lot');
    expect(result.ready).toBe(false);
    expect(result.invalid).toContain('LOT_MOVEMENT_ACTION_VIEW');
  });
  it('leaves noncanonical or incomplete dataset configurations on their existing flow', () => {
    expect(readDatasetConfig({ ...env, LOT_DATE_COLUMN: 'AnotherDate' }, 'lot').wipMovementFallback).toBe(false);
    expect(readDatasetConfig({ ...env, LOT_CHART_COLUMN: 'ProdType' }, 'lot').wipMovementFallback).toBe(false);
  });
});
