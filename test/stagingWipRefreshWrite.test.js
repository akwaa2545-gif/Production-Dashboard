import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqlState = vi.hoisted(() => ({ bulkTables: [], transactions: [], requests: [], bulkFailure: null }));

vi.mock('mssql', () => {
  class Table {
    constructor(name) {
      this.name = name;
      this.columns = { values: [], add: (columnName, type, options) => this.columns.values.push({ columnName, type, options }) };
      this.rows = { values: [], add: (...values) => this.rows.values.push(values) };
    }
  }
  class Transaction {
    constructor(pool) { this.pool = pool; sqlState.transactions.push(this); }
    async begin() { this.began = true; }
    async commit() { this.committed = true; }
    async rollback() { this.rolledBack = true; }
  }
  class Request {
    constructor(transaction) {
      this.transaction = transaction;
      this.inputs = [];
      sqlState.requests.push(this);
    }
    input(name, type, value) { this.inputs.push({ name, type, value }); return this; }
    async query(statement) { this.statement = statement; return { recordset: [] }; }
    async bulk(table) {
      this.table = table;
      sqlState.bulkTables.push(table);
      if (sqlState.bulkFailure?.table === table.name) throw sqlState.bulkFailure.error;
    }
  }
  const type = (name) => (size, scale) => `${name}(${[size, scale].filter((value) => value !== undefined).join(',')})`;
  return { default: { Table, Transaction, Request, Date: 'Date', NVarChar: type('NVarChar'), Decimal: type('Decimal') } };
});

import { refreshWipStaging } from '../src/stagingWipRefresh.js';

describe('refreshWipStaging process writes', () => {
  beforeEach(() => {
    sqlState.bulkTables.length = 0;
    sqlState.transactions.length = 0;
    sqlState.requests.length = 0;
    sqlState.bulkFailure = null;
  });

  it('preserves each supplied job and its quantity when jobs share a daily series', async () => {
    const snapshot = {
      rows: [
        { bucketDate: '2026-09-30', product: 'NEO', itemName: 'GPS P2', jobName: 'NEO-JOB-1', quantityMoved: 30 },
        { bucketDate: '2026-09-30', product: 'NEO', itemName: 'GPS P2', jobName: 'NEO-JOB-2', quantityMoved: 30 },
        { bucketDate: '2026-09-30', product: 'SC', itemName: 'SC SERIES', jobName: 'SC-JOB-1', quantityMoved: 20 }
      ],
      processRows: [
        { bucketDate: '2026-09-30', product: 'NEO', chartName: 'Welding', seriesName: 'GPS P2', partNumber: 'NEO-PN', quantityMoved: 60 },
        { bucketDate: '2026-09-30', product: 'SC', chartName: 'Taping', seriesName: 'SC SERIES', partNumber: 'SC-PN', quantityMoved: 20 }
      ]
    };
    const source = { getWipStagingSnapshot: async () => snapshot };
    const schemaQuery = vi.fn(async () => ({ recordset: [{ jobNameLength: 8000 }] }));
    const target = { getPool: async () => ({ request: () => ({ query: schemaQuery }) }) };
    const targetConfig = { table: 'dbo.DashboardWipDaily', processTable: 'dbo.DashboardWipProcessDaily' };

    await refreshWipStaging({ source, target, targetConfig, startDate: '2026-09-30', endDate: '2026-09-30' });

    const daily = sqlState.bulkTables[0];
    expect(daily.columns.values.map(column => column.columnName)).toEqual(['ReportingDate', 'Product', 'Serie', 'JobName', 'QuantityMoved']);
    expect(daily.rows.values).toEqual([
      ['2026-09-30', 'NEO', 'GPS P2', 'NEO-JOB-1', 30],
      ['2026-09-30', 'NEO', 'GPS P2', 'NEO-JOB-2', 30],
      ['2026-09-30', 'SC', 'SC SERIES', 'SC-JOB-1', 20]
    ]);
    expect(daily.rows.values.reduce((sum, row) => sum + row[4], 0)).toBe(80);
    expect(sqlState.bulkTables[1].rows.values).toEqual([
      ['2026-09-30', 'NEO', 'Welding', 'GPS P2', 'NEO-PN', 60],
      ['2026-09-30', 'SC', 'Taping', 'SC SERIES', 'SC-PN', 20]
    ]);
    expect(sqlState.transactions[0]).toMatchObject({ began: true, committed: true });
    expect(schemaQuery.mock.calls[0][0]).not.toMatch(/ADD\s+\[?JobName\]?/i);
  });

  it.each([undefined, null, '', '   '])('preserves existing snapshots when job-aware staging receives an aggregate without identity (%s)', async (jobName) => {
    const source = { getWipStagingSnapshot: async () => ({
      rows: [{ bucketDate: '2026-09-30', product: 'NEO', itemName: 'GPS P2', jobName, quantityMoved: 60 }],
      processRows: []
    }) };
    const target = { getPool: async () => ({ request: () => ({ query: async () => ({ recordset: [{ jobNameLength: 8000 }] }) }) }) };
    const targetConfig = { table: 'dbo.DashboardWipDaily', processTable: 'dbo.DashboardWipProcessDaily' };

    await expect(refreshWipStaging({ source, target, targetConfig, startDate: '2026-09-30', endDate: '2026-09-30' })).rejects.toMatchObject({ code: 'WIP_STAGING_JOB_IDENTITY_REQUIRED' });

    expect(sqlState.transactions).toEqual([]);
    expect(sqlState.requests).toEqual([]);
    expect(sqlState.bulkTables).toEqual([]);
  });

  it('retains series-grained writes when the existing table has no JobName column', async () => {
    const source = { getWipStagingSnapshot: async () => ({
      rows: [
        { bucketDate: '2026-09-30', product: 'NEO', itemName: 'GPS P2', jobName: 'JOB-1', quantityMoved: 30.0001 },
        { bucketDate: '2026-09-30', product: 'NEO', itemName: 'GPS P2', jobName: 'JOB-2', quantityMoved: 30.0002 },
        { bucketDate: '2026-09-30', product: 'SC', itemName: 'GPS P2', jobName: 'SC-JOB', quantityMoved: 20 }
      ], processRows: []
    }) };
    const target = { getPool: async () => ({ request: () => ({ query: async () => ({ recordset: [{ jobNameLength: null }] }) }) }) };
    const targetConfig = { table: 'dbo.DashboardWipDaily', processTable: 'dbo.DashboardWipProcessDaily' };

    const result = await refreshWipStaging({ source, target, targetConfig, startDate: '2026-09-30', endDate: '2026-09-30' });

    expect(sqlState.bulkTables[0].rows.values).toEqual([
      ['2026-09-30', 'NEO', 'GPS P2', 60.0003],
      ['2026-09-30', 'SC', 'GPS P2', 20]
    ]);
    expect(result.rows).toBe(2);
  });

  it('bulk writes nullable part numbers in the process table without changing daily rows', async () => {
    const source = {
      getQuantity: async ({ product }) => [{ bucketDate: '2026-09-08', itemName: `${product}-SERIES`, quantityMoved: 10 }],
      getChartData: async ({ product }) => [
        { bucketDate: '2026-09-08', chartName: 'Taping', seriesName: `${product}-SERIES`, partNumber: `${product}-PN`, quantityMoved: 9 },
        { bucketDate: '2026-09-08', chartName: 'Taping', seriesName: `${product}-SERIES`, partNumber: '   ', quantityMoved: 1 }
      ]
    };
    const schemaQuery = vi.fn(async () => ({ recordset: [] }));
    const target = { getPool: async () => ({ request: () => ({ query: schemaQuery }) }) };
    const targetConfig = { table: 'dbo.DashboardWipDaily', processTable: 'dbo.DashboardWipProcessDaily' };

    await refreshWipStaging({ source, target, targetConfig, startDate: '2026-09-08', endDate: '2026-09-08' });

    expect(schemaQuery.mock.calls[0][0]).toContain("COL_LENGTH('dbo.DashboardWipProcessDaily', 'PartNumber') IS NULL");
    expect(sqlState.bulkTables[0].columns.values.map((column) => column.columnName)).toEqual(['ReportingDate', 'Product', 'Serie', 'QuantityMoved']);
    expect(sqlState.bulkTables[1].columns.values).toEqual(expect.arrayContaining([
      expect.objectContaining({ columnName: 'PartNumber', options: { nullable: true } })
    ]));
    expect(sqlState.bulkTables[1].rows.values).toContainEqual(['2026-09-08', 'NEO', 'Taping', 'NEO-SERIES', 'NEO-PN', 9]);
    expect(sqlState.bulkTables[1].rows.values).toContainEqual(['2026-09-08', 'NEO', 'Taping', 'NEO-SERIES', null, 1]);
    expect(sqlState.transactions[0]).toMatchObject({ began: true, committed: true });
  });

  it('limits both transactional deletes to the parameterized inclusive selected dates', async () => {
    const source = { getQuantity: vi.fn(async () => []), getChartData: vi.fn(async () => []) };
    const schemaQuery = vi.fn(async () => ({ recordset: [] }));
    const target = { getPool: async () => ({ request: () => ({ query: schemaQuery }) }) };
    const targetConfig = { table: 'dbo.DashboardWipDaily', processTable: 'dbo.DashboardWipProcessDaily' };

    await refreshWipStaging({ source, target, targetConfig, startDate: '2026-09-19', endDate: '2026-09-20' });

    expect(sqlState.transactions).toHaveLength(1);
    expect(sqlState.requests).toHaveLength(2);
    for (const [index, tableName] of ['DashboardWipDaily', 'DashboardWipProcessDaily'].entries()) {
      const request = sqlState.requests[index];
      expect(request.transaction).toBe(sqlState.transactions[0]);
      expect(request.statement).toBe(`DELETE FROM [dbo].[${tableName}] WHERE ReportingDate >= @startDate AND ReportingDate < DATEADD(day, 1, @endDate)`);
      expect(request.inputs).toEqual([
        { name: 'startDate', type: 'Date', value: '2026-09-19' },
        { name: 'endDate', type: 'Date', value: '2026-09-20' }
      ]);
    }
    for (const product of ['NEO', 'SC']) {
      expect(source.getQuantity).toHaveBeenCalledWith({ startDate: '2026-09-19', endDate: '2026-09-20', product });
      expect(source.getChartData).toHaveBeenCalledWith({ startDate: '2026-09-19', endDate: '2026-09-20', product }, true, true);
    }
    expect(sqlState.bulkTables).toEqual([]);
    expect(sqlState.transactions[0]).toMatchObject({ began: true, committed: true });
    expect(sqlState.transactions[0].rolledBack).toBeUndefined();
  });

  it.each(['getQuantity', 'getChartData'])('does not access staging when the later product %s source read fails', async (method) => {
    const sourceError = new Error('MES unavailable');
    const source = {
      getQuantity: vi.fn(async () => [{ bucketDate: '2026-09-19', itemName: 'SERIES', quantityMoved: 10 }]),
      getChartData: vi.fn(async () => [{ bucketDate: '2026-09-19', chartName: 'Taping', seriesName: 'SERIES', quantityMoved: 10 }])
    };
    // Fail after NEO has been read, so a partial source result cannot replace staging.
    source[method].mockReset().mockResolvedValueOnce([]).mockRejectedValueOnce(sourceError);
    const target = { getPool: vi.fn() };
    const targetConfig = { table: 'dbo.DashboardWipDaily', processTable: 'dbo.DashboardWipProcessDaily' };

    await expect(refreshWipStaging({ source, target, targetConfig, startDate: '2026-09-19', endDate: '2026-09-20' })).rejects.toBe(sourceError);

    expect(target.getPool).not.toHaveBeenCalled();
    expect(sqlState.transactions).toEqual([]);
    expect(sqlState.requests).toEqual([]);
    expect(sqlState.bulkTables).toEqual([]);
  });

  it('rolls back the shared transaction after a process bulk failure, including daily replacement', async () => {
    const source = {
      getQuantity: async () => [{ bucketDate: '2026-09-19', itemName: 'SERIES', quantityMoved: 10 }],
      getChartData: async () => [{ bucketDate: '2026-09-19', chartName: 'Taping', seriesName: 'SERIES', quantityMoved: 10 }]
    };
    const schemaQuery = vi.fn(async () => ({ recordset: [] }));
    const target = { getPool: async () => ({ request: () => ({ query: schemaQuery }) }) };
    const targetConfig = { table: 'dbo.DashboardWipDaily', processTable: 'dbo.DashboardWipProcessDaily' };
    const bulkError = new Error('Process bulk failed');
    sqlState.bulkFailure = { table: targetConfig.processTable, error: bulkError };

    await expect(refreshWipStaging({ source, target, targetConfig, startDate: '2026-09-19', endDate: '2026-09-20' })).rejects.toBe(bulkError);

    expect(sqlState.transactions).toHaveLength(1);
    const transaction = sqlState.transactions[0];
    expect(transaction).toMatchObject({ began: true, rolledBack: true });
    expect(transaction.committed).toBeUndefined();
    expect(sqlState.requests).toHaveLength(4);
    expect(sqlState.requests.every((request) => request.transaction === transaction)).toBe(true);
    expect(sqlState.requests[0].statement).toContain('DELETE FROM [dbo].[DashboardWipDaily]');
    expect(sqlState.requests[1].table.name).toBe(targetConfig.table);
    expect(sqlState.requests[2].statement).toContain('DELETE FROM [dbo].[DashboardWipProcessDaily]');
    expect(sqlState.requests[3].table.name).toBe(targetConfig.processTable);
    expect(sqlState.bulkTables.map((table) => table.name)).toEqual([targetConfig.table, targetConfig.processTable]);
  });
});
