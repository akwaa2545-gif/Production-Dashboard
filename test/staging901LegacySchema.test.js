import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { Staging901Repository } from '../src/staging901Repository.js';
import { createApp } from '../src/app.js';

const filters = {
  startDate: '2026-11-01', endDate: '2026-11-11', product: 'SC',
  serie: ['FC', 'FM'], pn: ['PART-ONE'],
};
const missingColumn = (column = 'JobName') => Object.assign(
  new Error(`Invalid column name '${column}'.`), { number: 207, code: 'EREQUEST' },
);

function fixture(responses, config = {}) {
  const inputs = [];
  const query = vi.fn();
  for (const response of responses) {
    if (response instanceof Error) query.mockRejectedValueOnce(response);
    else query.mockResolvedValueOnce({ recordset: response });
  }
  const repository = new Staging901Repository({ table: 'dbo.Dashboard901Daily', ...config });
  repository.pool = { request: () => ({ input: (...args) => inputs.push(args), query }) };
  return { repository, inputs, query };
}

const errorForms = [
  ['top-level', () => missingColumn()],
  ['driver info', () => Object.assign(new Error('SQL request failed'), {
    code: 'EREQUEST', originalError: { info: { number: 207, message: "Invalid column name 'JobName'." } },
  })],
  ['preceding errors', () => Object.assign(new Error('SQL request failed'), {
    code: 'EREQUEST', precedingErrors: [missingColumn()],
  })],
];

describe('Completion 901 older summary schema', () => {
  describe.each(['getQuantity', 'getDailyOutput'])('%s', (method) => {
    it.each(errorForms)('keeps quantities and marks lot count unavailable for %s errors', async (_shape, error) => {
      const row = { bucketDate: '2026-11-10', itemName: 'FC', quantityMoved: '1200.0003', lotCount: null };
      const { repository, query, inputs } = fixture([error(), [row]]);

      await expect(repository[method](filters)).resolves.toEqual([
        { ...row, quantityMoved: 1200.0003, lotCount: null },
      ]);

      expect(query).toHaveBeenCalledTimes(2);
      const [original] = query.mock.calls[0];
      const [fallback] = query.mock.calls[1];
      expect(original).toContain('CAST([JobName] AS nvarchar(4000))');
      expect(fallback).toContain('CAST(NULL AS int) AS lotCount');
      expect(fallback).not.toContain('[JobName]');
      expect(fallback).toContain('SUM(QuantityMoved) AS quantityMoved');
      expect(fallback).toContain('ReportingDate >= @startDate');
      expect(fallback).toContain('Product = @product');
      expect(fallback).toContain('Serie IN (@serie0, @serie1)');
      expect(fallback).toContain('PartNumber IN (@pn0)');
      expect(inputs.map(([name]) => name)).toEqual(['startDate', 'endDate', 'product', 'serie0', 'serie1', 'pn0']);
      expect(inputs.map(([name, , value]) => [name, value])).toContainEqual(['serie0', 'FC']);
      expect(inputs.map(([name, , value]) => [name, value])).toContainEqual(['serie1', 'FM']);
      expect(fallback).toContain(method === 'getQuantity' ? 'GROUP BY ReportingDate, Serie' : 'GROUP BY Serie');
    });

    it('supports a configured lot identifier instead of assuming JobName', async () => {
      const { repository, query } = fixture([
        missingColumn('LotIdentifier'), [{ itemName: 'FM', quantityMoved: '60', lotCount: null }],
      ], { lotColumn: 'LotIdentifier' });

      await expect(repository[method](filters)).resolves.toEqual([{ itemName: 'FM', quantityMoved: 60, lotCount: null }]);
      expect(query.mock.calls[0][0]).toContain('[LotIdentifier]');
      expect(query.mock.calls[1][0]).not.toContain('[LotIdentifier]');
    });

    it('keeps actual lot counts when the lot column exists', async () => {
      const { repository, query } = fixture([[{ itemName: 'FC', quantityMoved: '1200', lotCount: '3' }]]);

      await expect(repository[method](filters)).resolves.toEqual([{ itemName: 'FC', quantityMoved: 1200, lotCount: 3 }]);
      expect(query).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['another missing column', () => missingColumn('PartNumber')],
      ['permission denied', () => Object.assign(new Error("Invalid column name 'JobName'."), { number: 229 })],
      ['connection failure', () => Object.assign(new Error('Connection lost'), { code: 'ESOCKET' })],
      ['message without SQL error number', () => new Error("Invalid column name 'JobName'.")],
    ])('propagates %s without hiding the failure', async (_label, makeError) => {
      const error = makeError();
      const { repository, query } = fixture([error]);

      await expect(repository[method](filters)).rejects.toBe(error);
      expect(query).toHaveBeenCalledTimes(1);
    });

    it('propagates a failed compatibility query', async () => {
      const failure = Object.assign(new Error('Connection lost during retry'), { code: 'ESOCKET' });
      const { repository, query } = fixture([missingColumn(), failure]);

      await expect(repository[method](filters)).rejects.toBe(failure);
      expect(query).toHaveBeenCalledTimes(2);
    });

    it('handles an empty legacy result without inventing quantities or lots', async () => {
      const { repository } = fixture([missingColumn(), []]);
      await expect(repository[method](filters)).resolves.toEqual([]);
    });
  });
});

describe('Completion 901 API compatibility with older summary tables', () => {
  it.each(['/api/quantity', '/api/mtd-quantity'])('serves %s while preserving the selected SC series', async (endpoint) => {
    const { repository, query } = fixture([
      missingColumn(), [{ bucketDate: '2026-11-10', itemName: 'FC', quantityMoved: '1200', lotCount: null }],
    ]);
    const direct = { getQuantity: vi.fn(async () => { throw new Error('Unexpected direct MES request'); }) };
    const app = createApp({
      environment: {
        SQL_SERVER: 'fixture', SQL_DATABASE: 'fixture', DB_VIEW: 'dbo.ClosedBatch',
        DATE_COLUMN: 'CloseDate', PROCESS_COLUMN: 'ProdType', SERIE_COLUMN: 'Series',
        PN_COLUMN: 'PartNumber', DASHBOARD_DATA_MODE: 'staging', DASHBOARD_901_STAGING_ENABLED: 'true',
      },
      repository: direct, staging901Repository: repository,
    });

    const response = await request(app).get(endpoint).query({ dataset: 'closed', ...filters });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, data: [
      { itemName: 'FC', quantityMoved: 1200, lotCount: null },
    ] });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toContain('Serie IN (@serie0, @serie1)');
    expect(direct.getQuantity).not.toHaveBeenCalled();
  });
});
