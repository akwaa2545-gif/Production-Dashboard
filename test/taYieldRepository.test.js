import { describe, expect, it } from 'vitest';
import { TaYieldRepository } from '../src/taYieldRepository.js';

function mockPool(...recordsets) {
  const calls = [];
  return {
    calls,
    request() {
      const inputs = [];
      return {
        input(name, _type, value) { inputs.push([name, value]); return this; },
        async query(statement) {
          calls.push({ statement, inputs });
          return { recordset: recordsets[calls.length - 1] || [] };
        }
      };
    }
  };
}

function createRepository() {
  return new TaYieldRepository({
    server: 'server', database: 'database', auth: 'ActiveDirectoryInteractive',
    view: 'PowerBIThailand.ClosedBatch_v', defectView: 'PowerBIThailand.CompleteAction_v',
    productValue: 'NEO', linePrefix: 'Ta NEO Capacitor%',
    finalGoodDispositionCode: 'To rteTaping_ALL'
  });
}

describe('TaYieldRepository action-date population', () => {
  it('uses the workbook reconciliation CompleteAction conditions', async () => {
    const repository = createRepository(); const pool = mockPool([]); repository.pool = pool;
    await repository.getWorkbookReconciliationRows({ startDate: '2026-08-01', endDate: '2026-08-07' });
    expect(pool.calls[0].statement).toContain('[final].[CatMajor]');
    expect(pool.calls[0].statement).toContain('[action].[From_OperationName]');
    expect(pool.calls[0].statement).toContain('DATEADD(month, -3, @startDate)');
    expect(pool.calls[0].statement).toContain("N'SH pulse defective'");
    expect(pool.calls[0].statement).toContain('[parameters].[ParameterValue]');
    expect(pool.calls[0].statement).toContain('OPENJSON(@taDescriptions)');
  });
  it('uses the SH fallback when the optional TA parameter view is unavailable', async () => {
    const repository = createRepository();
    const unavailableParameterView = Object.assign(new Error("Invalid object name 'PowerBIThailand.ParametersECP_v'."), { code: 'EREQUEST' });
    const pool = mockPool(
      unavailableParameterView,
      [{ lotNo: '6G15N08661', occuredOn: '2026-08-03T04:00:00.000Z', finalGoodQ: '90', dispositionCode: 'To rteTaping_ALL', quantity: '90', dispositionType: 'GOOD', partTypeExists: false, shAccVoltZero: false }],
      [{ lotNo: '6G15N08661', line: 'FPS', closeDate: '2026-07-30', jobType: 'Standard', inputQ: '100' }]
    );
    const query = pool.request;
    pool.request = () => {
      const request = query.call(pool);
      const execute = request.query;
      request.query = async (statement) => {
        const result = await execute.call(request, statement);
        if (result.recordset instanceof Error) throw result.recordset;
        return result;
      };
      return request;
    };
    repository.pool = pool;

    await expect(repository.getYieldRows({ startDate: '2026-08-03', endDate: '2026-08-03' })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ lotNo: '6G15N08661', finalGoodQ: 90 })
    ]));

    expect(pool.calls).toHaveLength(3);
    expect(pool.calls[0].statement).toContain('[PowerBIThailand].[ParametersECP_v]');
    expect(pool.calls[1].statement).not.toContain('[PowerBIThailand].[ParametersECP_v]');
    expect(pool.calls[1].statement).toContain('CAST(0 AS bit) AS partTypeExists');
  });

  it('selects qualifying Complete Action lots within Thailand date boundaries before loading their Closed Batch metadata', async () => {
    const repository = createRepository();
    const pool = mockPool(
      [{ lotNo: '6G15N08661', occuredOn: '2026-08-03T04:00:00.000Z', finalGoodQ: '90', dispositionCode: 'To rteTaping_ALL', quantity: '90', dispositionType: 'GOOD' }],
      [{ lotNo: '6G15N08661', line: 'FPS', closeDate: '2026-07-30', jobType: 'Standard', inputQ: '100' }]
    );
    repository.pool = pool;

    await repository.getYieldRows({ startDate: '2026-08-03', endDate: '2026-08-03', serie: ['FPS'] });

    expect(pool.calls).toHaveLength(2);
    expect(pool.calls[0].statement).toContain('FROM [PowerBIThailand].[CompleteAction_v] AS [action]');
    expect(pool.calls[0].statement).toContain('[action].[OccuredOn] >= CAST((CAST(@startDate AS datetime2) AT TIME ZONE \'SE Asia Standard Time\' AT TIME ZONE \'UTC\') AS datetime2)');
    expect(pool.calls[0].statement).toContain('[action].[OccuredOn] < CAST((CAST(DATEADD(day, 1, @endDate) AS datetime2) AT TIME ZONE \'SE Asia Standard Time\' AT TIME ZONE \'UTC\') AS datetime2)');
    expect(pool.calls[0].statement).toContain('@taFinalGoodDisposition');
    expect(pool.calls[0].inputs).toContainEqual(['startDate', '2026-08-03']);
    expect(pool.calls[0].inputs).toContainEqual(['endDate', '2026-08-03']);

    expect(pool.calls[1].statement).toContain('FROM [PowerBIThailand].[ClosedBatch_v] AS [closed]');
    expect(pool.calls[1].statement).toContain('OPENJSON(@taLots)');
    expect(pool.calls[1].inputs).toContainEqual(['taLots', JSON.stringify(['6G15N08661'])]);
    expect(pool.calls[1].statement).not.toMatch(/\[closed\]\.\[CloseDate\]\s*(?:>=|<)/);
  });

  it('returns both Closed Batch input and in-range Complete Action final-good rows for the action-selected lot', async () => {
    const repository = createRepository();
    const pool = mockPool(
      [{ lotNo: '6G15N08661', occuredOn: '2026-08-03T04:00:00.000Z', finalGoodQ: '90', dispositionCode: 'To rteTaping_ALL', quantity: '90', dispositionType: 'GOOD' }],
      [{ lotNo: '6G15N08661', line: 'FPS', closeDate: '2026-07-30', jobType: 'Standard', inputQ: '100' }]
    );
    repository.pool = pool;

    await expect(repository.getYieldRows({ startDate: '2026-08-03', endDate: '2026-08-03' })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ lotNo: '6G15N08661', inputQ: 100, finalGoodQ: 0 }),
      expect.objectContaining({ lotNo: '6G15N08661', inputQ: 0, finalGoodQ: 90, occuredOn: '2026-08-03T04:00:00.000Z' })
    ]));
  });
});
