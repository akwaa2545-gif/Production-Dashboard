import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqlState = vi.hoisted(() => ({ bulkTables: [], transactions: [] }));

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
    input() { return this; }
    async query() { return { recordset: [] }; }
    async bulk(table) { sqlState.bulkTables.push(table); }
  }
  const type = (name) => (size, scale) => `${name}(${[size, scale].filter((value) => value !== undefined).join(',')})`;
  return { default: { Table, Transaction, Request, Date: 'Date', NVarChar: type('NVarChar'), Decimal: type('Decimal') } };
});

import { refreshWipStaging } from '../src/stagingWipRefresh.js';

describe('refreshWipStaging process writes', () => {
  beforeEach(() => {
    sqlState.bulkTables.length = 0;
    sqlState.transactions.length = 0;
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
});
