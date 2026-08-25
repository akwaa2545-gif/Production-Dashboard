import { describe, expect, it } from 'vitest';
import { SqlRepository } from '../src/sqlRepository.js';
import { ScYieldRepository } from '../src/scYieldRepository.js';

const config = {
  server: 'server', database: 'database', auth: 'ActiveDirectoryInteractive', view: 'dbo.LotCompleteLog',
  dateColumn: 'completedAt', processColumn: 'processName', serieColumn: 'serie', caseColumn: 'caseNumber',
  pnColumn: 'from_itemName', quantityColumn: 'quantityMoved', trustServerCertificate: false
};

function mockPool(recordsets) {
  const calls = [];
  return {
    calls,
    request() {
      const inputs = [];
      return {
        input(name, _type, value) { inputs.push([name, value]); return this; },
        async query(statement) { calls.push({ statement, inputs }); return { recordset: recordsets.shift() || [] }; }
      };
    }
  };
}

describe('SqlRepository', () => {
  it('reconnects after an authentication error without forcing a new interactive token', async () => {
    const repository = new SqlRepository(config);
    const calls = [];
    repository.resetConnection = async () => { calls.push('reset'); };
    repository.getPool = async (forceRefresh) => { calls.push(forceRefresh); return mockPool([]); };

    await repository.authenticate();

    expect(calls).toEqual(['reset', undefined]);
  });

  it('parameterizes quantity filters while allowlisting configured identifiers', async () => {
    const repository = new SqlRepository(config);
    const pool = mockPool([[{ bucketDate: '2026-01-01', itemName: 'PN-1', quantityMoved: '5.5' }]]);
    repository.pool = pool;
    const rows = await repository.getQuantity({ startDate: '2026-01-01', endDate: '2026-01-02', process: "A' OR 1=1--", pn: 'PN-1' });
    expect(rows).toEqual([{ bucketDate: '2026-01-01', itemName: 'PN-1', quantityMoved: 5.5 }]);
    expect(pool.calls[0].statement).toContain('FROM [dbo].[LotCompleteLog]');
    expect(pool.calls[0].statement).not.toContain("A' OR 1=1--");
    expect(pool.calls[0].inputs).toContainEqual(['process', "A' OR 1=1--"]);
    expect(pool.calls[0].inputs).toContainEqual(['pn', 'PN-1']);
  });

  it('labels blank quantity series as Unspecified for the dashboard', async () => {
    const repository = new SqlRepository(config);
    const pool = mockPool([[{ bucketDate: '2026-01-01', itemName: '', quantityMoved: '5' }]]);
    repository.pool = pool;
    await expect(repository.getQuantity({ startDate: '2026-01-01', endDate: '2026-01-01' })).resolves.toEqual([
      { bucketDate: '2026-01-01', itemName: 'Unspecified', quantityMoved: 5 }
    ]);
  });

  it('uses ProdLine for blank NEO series while retaining the configured SC fallback', async () => {
    const repository = new SqlRepository({
      ...config,
      processColumn: 'ProdType',
      groupColumn: 'serie',
      serieBlankProduct: 'SC',
      serieBlankValue: 'Element',
      serieBlankSourceProduct: 'NEO',
      serieBlankSourceColumn: 'ProdLine',
      serieBlankSourceFormat: 'neo-capacitor'
    });
    const pool = mockPool([[]]);
    repository.pool = pool;
    await repository.getQuantity({ startDate: '2026-01-01', endDate: '2026-01-01' });
    expect(pool.calls[0].statement).toContain('[source].[ProdLine]');
    expect(pool.calls[0].statement).toContain("N'Ta NEO Capacitor '");
    expect(pool.calls[0].statement).toContain("N' series '");
    expect(pool.calls[0].statement).toContain('@serieBlankSourceProduct');
    expect(pool.calls[0].inputs).toContainEqual(['serieBlankProduct', 'SC']);
    expect(pool.calls[0].inputs).toContainEqual(['serieBlankSourceProduct', 'NEO']);
  });

  it('excludes generated blank NEO Series rows from Completion 901 quantities', async () => {
    const repository = new SqlRepository({ ...config, processColumn: 'ProdType', groupColumn: 'serie', serieBlankSourceProduct: 'NEO', serieBlankSourceColumn: 'ProdLine', serieBlankSourceFormat: 'neo-capacitor' });
    const pool = mockPool([[]]); repository.pool = pool;
    await repository.getQuantity({ startDate: '2026-01-01', endDate: '2026-01-01', product: 'NEO' });
    expect(pool.calls[0].statement).toContain('CASE WHEN [source].[ProdType] = @serieBlankSourceProduct');
    expect(pool.calls[0].statement).toContain('[source].[ProdLine]');
  });

  it('excludes the configured semi-finished production line from Completion 901 quantities', async () => {
    const repository = new SqlRepository({ ...config, processColumn: 'ProdType', excludedProdLineColumn: 'ProdLine', excludedProdLineValue: 'Semi-Finished Good apply in Racking (BoI)' });
    const pool = mockPool([[{ bucketDate: '2026-01-01', itemName: 'FPS A3', quantityMoved: '5' }]]);
    repository.pool = pool;
    await repository.getQuantity({ startDate: '2026-01-01', endDate: '2026-01-01', product: 'NEO' });
    expect(pool.calls[0].statement).toContain('[source].[ProdLine]');
    expect(pool.calls[0].statement).toContain('NOT LIKE @excludedProdLinePrefix');
    expect(pool.calls[0].inputs).toContainEqual(['excludedProdLinePrefix', 'Semi-Finished Good apply in Racking%']);
  });

  it('groups Lot Complete Log quantities by the linked Closed Batch series when configured', async () => {
    const repository = new SqlRepository({
      ...config,
      groupColumn: 'serie',
      serieLookupView: 'PowerBIThailand.ClosedBatch_v',
      serieSourceJoinColumn: 'JobName',
      serieLookupJoinColumn: 'JobName'
    });
    const pool = mockPool([[{ bucketDate: '2026-01-01', jobName: 'J-1', quantityMoved: '5' }], [{ jobName: 'J-1', serieName: 'CAN' }]]);
    repository.pool = pool;
    await repository.getQuantity({ startDate: '2026-01-01', endDate: '2026-01-01' });
    expect(pool.calls[0].statement).toContain('GROUP BY CAST([source].[completedAt] AS date), CAST([source].[JobName] AS nvarchar(4000))');
    expect(pool.calls[1].statement).toContain('FROM [PowerBIThailand].[ClosedBatch_v] AS [seriesLookup]');
    expect(pool.calls[1].statement).toContain('OPENJSON(@lookupJobs)');
  });

  it('excludes configured process values from Lot Complete Log charts', async () => {
    const repository = new SqlRepository({ ...config, chartColumn: 'processName', chartExcludedValues: ['RouteDecisionPoint'] });
    const pool = mockPool([[{ chartName: 'SCRAP', quantityMoved: '25' }]]);
    repository.pool = pool;
    await repository.getChartData({ startDate: '2026-01-01', endDate: '2026-01-01' });
    expect(pool.calls[0].statement).toContain('CAST([source].[processName] AS nvarchar(4000)) <> @excludedChartValue0');
    expect(pool.calls[0].inputs).toContainEqual(['excludedChartValue0', 'RouteDecisionPoint']);
  });

  it('returns Series segments for Lot Complete Log process charts', async () => {
    const repository = new SqlRepository({
      ...config,
      chartColumn: 'From_OperationName',
      serieLookupView: 'PowerBIThailand.ClosedBatch_v',
      serieSourceJoinColumn: 'JobName',
      serieLookupJoinColumn: 'JobName'
    });
    const pool = mockPool([[{ chartName: 'Assembly', seriesName: 'CAN', quantityMoved: '25' }]]);
    repository.pool = pool;
    const rows = await repository.getChartData({ startDate: '2026-01-01', endDate: '2026-01-01' });
    expect(rows[0]).toMatchObject({ chartName: 'Assembly', seriesName: 'CAN', quantityMoved: 25 });
    expect(pool.calls[0].statement).toContain('AS seriesName');
    expect(pool.calls[0].statement).toContain('INNER JOIN (SELECT [seriesLookup].[JobName] AS [joinValue]');
    expect(pool.calls[0].statement).toContain('GROUP BY CAST([source].[From_OperationName] AS nvarchar(4000)), CAST(COALESCE([seriesLookup].[serieName], N\'Unspecified\') AS nvarchar(4000))');
  });

  it('parameterizes multiple selected Series values', async () => {
    const repository = new SqlRepository(config); const pool = mockPool([[]]); repository.pool = pool;
    await repository.getQuantity({ startDate: '2026-01-01', endDate: '2026-01-01', serie: ['CAN', 'FPS'] });
    expect(pool.calls[0].statement).toContain('[source].[serie] IN (@serie0, @serie1)');
    expect(pool.calls[0].inputs).toContainEqual(['serie0', 'CAN']);
    expect(pool.calls[0].inputs).toContainEqual(['serie1', 'FPS']);
  });

  it('groups quantity by selected part numbers and parameterizes every PN value', async () => {
    const repository = new SqlRepository({ ...config, groupColumn: 'serie' });
    const pool = mockPool([[{ bucketDate: '2026-01-01', itemName: 'PN-1', quantityMoved: '5' }]]);
    repository.pool = pool;
    await repository.getQuantity({ startDate: '2026-01-01', endDate: '2026-01-01', pn: ['PN-1', 'PN-2'] });
    expect(pool.calls[0].statement).toContain('CAST([source].[serie] AS nvarchar(4000)) AS itemName');
    expect(pool.calls[0].statement).toContain('source.from_itemName = @pn');
    expect(pool.calls[0].inputs).toContainEqual(['pn', ['PN-1', 'PN-2']]);
  });

  it('keeps database connection state isolated from data-source configuration', async () => {
    const first = new SqlRepository({ ...config, view: 'dbo.ClosedBatch' });
    const second = new SqlRepository({ ...config, view: 'dbo.LotCompleteLog' });
    expect(first.config.database).toBe(second.config.database);
    expect(first.config.view).not.toBe(second.config.view);
  });

  it('limits linked Series options by the selected Product', async () => {
    const repository = new SqlRepository({ ...config, serieLookupView: 'PowerBIThailand.ClosedBatch_v', serieSourceJoinColumn: 'JobName', serieLookupJoinColumn: 'JobName', productLookupColumn: 'ProdType' });
    const pool = mockPool([[{ value: 'CAN' }]]); repository.pool = pool;
    expect(await repository.getSeriesOptions(pool, 'SC')).toEqual(['CAN']);
    expect(pool.calls[0].inputs).toContainEqual(['product', 'SC']);
    expect(pool.calls[0].statement).toContain('[seriesLookup].[ProdType] = @product');
  });

  it('limits Closed Batch Series options by the selected Product', async () => {
    const repository = new SqlRepository({ ...config, processColumn: 'ProdType' });
    const pool = mockPool([[{ value: 'SC' }], [{ value: 'CAN' }], [{ value: 'C1' }], [{ value: 'PN-1' }]]); repository.pool = pool;
    await repository.getOptions({ product: 'SC' });
    expect(pool.calls[1].inputs).toContainEqual(['product', 'SC']);
    expect(pool.calls[1].statement).toContain('[source].[ProdType] = @product');
  });

  it('does not offer the NEO blank-series placeholder as a selectable 901 Series', async () => {
    const repository = new SqlRepository({ ...config, processColumn: 'ProdType', serieBlankSourceProduct: 'NEO', serieBlankSourceColumn: 'ProdLine', serieBlankSourceFormat: 'neo-capacitor' });
    const pool = mockPool([[{ value: 'NEO' }], [{ value: 'PSL A' }], [{ value: 'C1' }], [{ value: 'PN-1' }]]); repository.pool = pool;
    const options = await repository.getOptions({ product: 'NEO' });
    expect(options.serie).toEqual(['PSL A']);
    expect(pool.calls[1].statement).toContain('CASE WHEN [source].[ProdType] = @serieBlankSourceProduct');
    expect(pool.calls[1].statement).toContain('[source].[ProdLine]');
  });

  it('retains a literal Unspecified Series outside the NEO blank-series fallback', async () => {
    const repository = new SqlRepository({ ...config, processColumn: 'ProdType', serieBlankSourceProduct: 'NEO', serieBlankSourceColumn: 'ProdLine', serieBlankSourceFormat: 'neo-capacitor' });
    const pool = mockPool([[{ value: 'SC' }], [{ value: 'CAN' }, { value: 'Unspecified' }], [{ value: 'C1' }], [{ value: 'PN-1' }]]); repository.pool = pool;
    const options = await repository.getOptions({ product: 'SC' });
    expect(options.serie).toEqual(['CAN', 'Unspecified']);
  });

  it('retains a literal Unspecified Series for NEO when the raw Series is not blank', async () => {
    const repository = new SqlRepository({ ...config, processColumn: 'ProdType', serieBlankSourceProduct: 'NEO', serieBlankSourceColumn: 'ProdLine', serieBlankSourceFormat: 'neo-capacitor' });
    const pool = mockPool([[{ value: 'NEO' }], [{ value: 'PSL A' }, { value: 'Unspecified' }], [{ value: 'C1' }], [{ value: 'PN-1' }]]); repository.pool = pool;
    const options = await repository.getOptions({ product: 'NEO' });
    expect(options.serie).toEqual(['PSL A', 'Unspecified']);
  });

  it('reads metadata using schema and view parameters', async () => {
    const repository = new SqlRepository(config);
    const pool = mockPool([[]]);
    pool.request = () => ({
      async query(statement) {
        pool.calls.push({ statement, inputs: [] });
        return { recordset: Object.assign([], { columns: { completedAt: { name: 'completedAt', type: { name: 'DateTime2' } } } }) };
      }
    });
    repository.pool = pool;
    expect(await repository.getColumns()).toEqual([{ name: 'completedAt', type: 'datetime2' }]);
    expect(pool.calls[0].statement).toBe('SELECT TOP (0) * FROM [dbo].[LotCompleteLog]');
  });

  it('lists close object names when the configured view does not exist', async () => {
    const repository = new SqlRepository(config);
    const pool = mockPool([[{ schemaName: 'report', objectName: 'LotCompleteLogArchive', objectType: 'BASE TABLE' }]]);
    let callCount = 0;
    const originalRequest = pool.request.bind(pool);
    pool.request = () => {
      callCount += 1;
      if (callCount === 1) return { query: async () => { throw new Error("Invalid object name 'dbo.LotCompleteLog'."); } };
      return originalRequest();
    };
    repository.pool = pool;
    expect(await repository.getColumns()).toEqual({ columns: [], matchingObjects: [{ schemaName: 'report', objectName: 'LotCompleteLogArchive', objectType: 'BASE TABLE' }] });
    expect(pool.calls[0].inputs).toContainEqual(['objectName', 'LotCompleteLog']);
  });

  it('finds database objects through a parameterized search', async () => {
    const repository = new SqlRepository(config);
    const pool = mockPool([[{ schemaName: 'PowerBIThailand', objectName: 'ClosedBatch', objectType: 'VIEW' }]]); repository.pool = pool;
    expect(await repository.findObjects('Closed')).toEqual([{ schemaName: 'PowerBIThailand', objectName: 'ClosedBatch', objectType: 'VIEW' }]);
    expect(pool.calls[0].inputs).toContainEqual(['search', 'Closed']);
  });

  it('returns bounded option values for each configured filter', async () => {
    const repository = new SqlRepository(config);
    const pool = mockPool([[{ value: 'Assembly' }], [{ value: 'S1' }], [{ value: 'C1' }], [{ value: 'PN-1' }]]); repository.pool = pool;
    expect(await repository.getOptions()).toEqual({ process: ['Assembly'], serie: ['S1'], case: ['C1'], pn: ['PN-1'] });
    expect(pool.calls).toHaveLength(4);
    expect(pool.calls[0].statement).toContain('TOP (1000)');
  });

  it('limits downstream series and PN options to the selected process', async () => {
    const repository = new SqlRepository(config);
    const pool = mockPool([[{ value: 'Assembly' }], [{ value: 'S1' }], [{ value: 'C1' }], [{ value: 'PN-1' }]]); repository.pool = pool;
    await repository.getOptions({ process: 'SC' });
    expect(pool.calls[1].inputs).toContainEqual(['process', 'SC']);
    expect(pool.calls[3].inputs).toContainEqual(['process', 'SC']);
    expect(pool.calls[0].inputs).not.toContainEqual(['process', 'SC']);
  });

  it('also limits PN options to the selected series', async () => {
    const repository = new SqlRepository(config);
    const pool = mockPool([[{ value: 'Assembly' }], [{ value: 'S1' }], [{ value: 'C1' }], [{ value: 'PN-1' }]]); repository.pool = pool;
    await repository.getOptions({ process: 'SC', serie: 'CAN' });
    expect(pool.calls[3].inputs).toContainEqual(['process', 'SC']);
    expect(pool.calls[3].inputs).toContainEqual(['serie0', 'CAN']);
  });

  it('returns the mapped Series with normalized PN search results', async () => {
    const repository = new SqlRepository(config);
    const pool = mockPool([[{ value: 'TEP-SLB 2/0J', serie: 'PSL B2' }]]);
    repository.pool = pool;
    await expect(repository.getPartNumbers({}, 'TEPSLB20J')).resolves.toEqual({ items: ['TEP-SLB 2/0J'], hasMore: false });
    expect(pool.calls[0].inputs).toContainEqual(['pnSearch', 'TEPSLB20J']);
  });

  it('provides blank-series fallback parameters when mapping part numbers to Series', async () => {
    const repository = new SqlRepository({
      ...config,
      processColumn: 'ProdType',
      serieBlankProduct: 'SC',
      serieBlankValue: 'Element',
      serieBlankSourceProduct: 'NEO',
      serieBlankSourceColumn: 'ProdLine'
    });
    const pool = mockPool([[]]);
    repository.pool = pool;
    await repository.getPartNumbers();
    expect(pool.calls[0].inputs).toContainEqual(['offset', 0]);
  });

  it('omits unavailable filter columns from option queries and rejects unsupported authentication', async () => {
    const repository = new SqlRepository({ ...config, processColumn: undefined, auth: 'SQLPassword' });
    repository.pool = mockPool([[{ value: 'S1' }], [{ value: 'C1' }], [{ value: 'PN-1' }]]);
    expect((await repository.getOptions()).process).toEqual([]);
    expect(repository.pool.calls).toHaveLength(3);
    const unauthenticated = new SqlRepository({ ...config, auth: 'SQLPassword' });
    await expect(unauthenticated.getPool()).rejects.toThrow('Unsupported database authentication mode.');
  });
});

describe('ScYieldRepository', () => {
  it('limits SC Yield rows to Completion 901 eligible JobName records with parameterized values', async () => {
    const repository = new ScYieldRepository({
      ...config,
      view: 'PowerBIThailand.CompleteAction_v', dateColumn: 'OccuredOn', jobColumn: 'JobName', productColumn: 'ProdType', productValue: 'SC', lineColumn: 'ProdLine', operationColumn: 'To_OperationName', dispositionTypeColumn: 'DispositionType', dispositionCodeColumn: 'DispositionCode', quantityColumn: 'QuantityMoved', closedView: 'PowerBIThailand.ClosedBatch_v', closedJobColumn: 'JobName', closedProductColumn: 'ProdType', closedSerieColumn: 'Series', closedDateColumn: 'CloseDate', closedCategoryColumn: 'Category', closedCategoryValue: 'FG', closedGrossQuantityColumn: 'GrossQty', closedEndOperationColumn: 'EndOperation', closedEndOperationValue: 'dummyEnd', closedProdLineColumn: 'ProdLine', closedProdLineValue: 'Semi-Finished Good apply in Racking (BoL)'
    });
    const pool = mockPool([[{ bucketMonth: '2026-07', line: 'FM', quantity: '10' }], [{ bucketMonth: '2026-07', line: 'FM', dispositionCode: '1212', quantity: '2' }]]);
    repository.pool = pool;
    const rows = await repository.getYieldRows({ startDate: '2026-07-01', endDate: '2026-07-31', serie: ['FM'] });
    expect(rows.inputs[0].quantity).toBe(10);
    expect(rows.defects[0].quantity).toBe(2);
    expect(pool.calls[0].statement).toContain('FROM [PowerBIThailand].[ClosedBatch_v] AS [closed]');
    expect(pool.calls[0].statement).toContain('CAST([closed].[Category] AS nvarchar(4000)) = @inputCategory');
    expect(pool.calls[0].statement).toContain('[closed].[GrossQty]');
    expect(pool.calls[0].statement).not.toContain('CompleteAction_v');
    expect(pool.calls[0].inputs).toContainEqual(['inputCategory', 'FG']);
    expect(pool.calls[1].inputs).toContainEqual(['scrapDisposition', 'SCRAP']);
    expect(pool.calls[1].statement).not.toContain('>= 1');
    expect(pool.calls[1].statement).toContain('CAST([closed].[Category] AS nvarchar(4000)) = @completionCategory');
    expect(pool.calls[1].statement).toContain('[closed].[CloseDate] >= @closedStartDate');
    expect(pool.calls[1].statement).toContain('[closed].[CloseDate] < DATEADD(day, 1, @closedEndDate)');
    expect(pool.calls[1].statement).not.toContain('[source].[OccuredOn] >= @startDate');
    expect(pool.calls[1].statement).toContain('COALESCE(SUM(TRY_CONVERT(decimal(19, 4), [source].[QuantityMoved])), 0)');
    expect(pool.calls[1].inputs).toContainEqual(['completionCategory', 'FG']);
  });

  it('maps defects only through an eligible Completion 901 JobName', async () => {
    const repository = new ScYieldRepository({
      ...config,
      view: 'PowerBIThailand.CompleteAction_v', dateColumn: 'OccuredOn', jobColumn: 'JobName', productColumn: 'ProdType', productValue: 'SC', lineColumn: 'ProdLine', operationColumn: 'To_OperationName', dispositionTypeColumn: 'DispositionType', dispositionCodeColumn: 'DispositionCode', quantityColumn: 'QuantityMoved', closedView: 'PowerBIThailand.ClosedBatch_v', closedJobColumn: 'JobName', closedProductColumn: 'ProdType', closedSerieColumn: 'Series', closedDateColumn: 'CloseDate', closedCategoryColumn: 'Category', closedCategoryValue: 'FG', closedGrossQuantityColumn: 'GrossQty'
    });
    const pool = mockPool([[{ bucketMonth: '2026-07', line: 'CAN', quantity: '10' }], [{ bucketMonth: '2026-07', line: 'CAN', dispositionCode: '1212', quantity: '2' }]]);
    repository.pool = pool;

    await repository.getYieldRows({ startDate: '2026-07-01', endDate: '2026-07-31', serie: ['CAN'] });

    expect(pool.calls[1].statement).toContain('INNER JOIN');
    expect(pool.calls[1].statement).toContain('AS [closed]');
    expect(pool.calls[1].statement).toContain('[source].[JobName] = [closed].[jobName]');
    expect(pool.calls[1].statement).toContain('[closed].[serieName] AS line');
    expect(pool.calls[1].statement).not.toContain('partClosed');
    expect(pool.calls[1].statement).not.toContain('From_ItemName');
  });
});
