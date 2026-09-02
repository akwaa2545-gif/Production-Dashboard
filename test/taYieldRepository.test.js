import { describe, expect, it } from 'vitest';
import { TaYieldRepository } from '../src/taYieldRepository.js';
import { mapTaWorkbookReconciliationRows } from '../src/taYieldMapping.js';

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
    releasedJobView: 'KMESV3.ReleasedJob',
    productValue: 'NEO', linePrefix: 'Ta NEO Capacitor%',
    finalGoodDispositionCode: 'To rteTaping_ALL'
  });
}

describe('TaYieldRepository action-date population', () => {
  it('uses the workbook reconciliation CompleteAction conditions', async () => {
    const repository = createRepository(); const pool = mockPool([{ lotNo: '6H01N00001', tapingDate: '2026-08-01T00:00:00.000Z' }], []); repository.pool = pool;
    await repository.getWorkbookReconciliationRows({ startDate: '2026-08-01', endDate: '2026-08-07' });
    expect(pool.calls[0].statement).toContain('[final].[CatMajor]');
    expect(pool.calls[1].statement).toContain('[action].[From_OperationName]');
    expect(pool.calls[1].statement).toContain('DATEADD(month, -3, @startDate)');
    expect(pool.calls[1].statement).toContain('OPENJSON(@taDescriptions)');
  });

  it('retains the final Taping route as Good while continuing to exclude other Taping actions', async () => {
    const repository = createRepository();
    const pool = mockPool(
      [{ lotNo: '6H16N08980', itemName: 'TEFPSA081C226MTHF8R', tapingDate: '2026-08-25T18:21:35.920Z' }],
      [{
        line: 'Ta NEO Capacitor FPS series A08 case',
        lotNo: '6H16N08980',
        itemName: 'TEFPSA081C226MTHF8R',
        tapingDate: '2026-08-25T18:21:35.920Z',
        dispositionDescription: 'To rteTaping_ALL',
        quantity: '17556'
      }]
    );
    repository.pool = pool;

    const actions = await repository.getWorkbookReconciliationRows(
      { startDate: '2026-08-26', endDate: '2026-08-26' },
      { descriptions: ['To rteTaping_ALL'] }
    );

    expect(actions).toEqual([expect.objectContaining({
      lotNo: '6H16N08980',
      dispositionDescription: 'To rteTaping_ALL',
      quantity: 17556
    })]);
    expect(mapTaWorkbookReconciliationRows(actions, new Map([['To rteTaping_ALL', 'Good']]))).toEqual([
      expect.objectContaining({ lotNo: '6H16N08980', categories: { ACC: 0, Good: 17556 } })
    ]);

    const actionStatement = pool.calls[1].statement;
    expect(actionStatement).toContain("[action].[From_OperationName] AS nvarchar(4000)))) <> N'Taping'");
    expect(actionStatement).toContain("LTRIM(RTRIM(CAST([action].[DispositionCode] AS nvarchar(4000)))) <> @taFinalGoodDisposition");
    expect(pool.calls[0].statement).toContain('ROW_NUMBER() OVER (PARTITION BY [final].[JobName] ORDER BY [final].[OccuredOn] DESC)');
    expect(pool.calls[0].statement).toContain('ROW_NUMBER() OVER');
    expect(actionStatement).toContain('[lots].[itemName] AS itemName');
    expect(actionStatement).toContain("[itemName] nvarchar(4000) '$.itemName'");
    expect(pool.calls[1].inputs).toContainEqual(['taLots', JSON.stringify([{
      lotNo: '6H16N08980', itemName: 'TEFPSA081C226MTHF8R', tapingDate: '2026-08-25T18:21:35.920Z'
    }])]);
  });

  it('carries final Good from the selected final-lot query without timestamp round-tripping', async () => {
    const repository = createRepository();
    const pool = mockPool([{
      lotNo: '6H23N12187',
      line: 'Ta NEO Capacitor FPS series A08 case',
      itemName: 'TEFPSA081C226MTN8RFL',
      tapingDate: '2026-08-26T14:07:33.183Z',
      finalGoodQ: '16000'
    }], []);
    repository.pool = pool;

    const rows = await repository.getWorkbookReconciliationRows(
      { startDate: '2026-08-26', endDate: '2026-08-26' },
      { descriptions: ['To rteTaping_ALL'] }
    );

    expect(rows).toContainEqual(expect.objectContaining({
      lotNo: '6H23N12187',
      dispositionDescription: 'To rteTaping_ALL',
      quantity: 16000
    }));
  });

  it('can limit workbook reconciliation actions to the requested resume dates', async () => {
    const repository = createRepository(); const pool = mockPool([]); repository.pool = pool;

    await repository.getWorkbookReconciliationRows({ startDate: '2026-08-29', endDate: '2026-08-31' }, { actionLookbackMonths: 0 });

    expect(pool.calls[0].statement).toContain("[final].[OccuredOn] >= CAST((CAST(@startDate AS datetime2) AT TIME ZONE 'SE Asia Standard Time' AT TIME ZONE 'UTC') AS datetime2)");
    expect(pool.calls[0].statement).toContain("[final].[OccuredOn] < CAST((CAST(DATEADD(day, 1, @endDate) AS datetime2) AT TIME ZONE 'SE Asia Standard Time' AT TIME ZONE 'UTC') AS datetime2)");
  });

  it('excludes E-class lots from workbook reconciliation using ReleasedJob.JobClass, while keeping N and unclassified lots eligible', async () => {
    const repository = createRepository();
    const pool = mockPool([]);
    repository.pool = pool;

    await repository.getWorkbookReconciliationRows({ startDate: '2026-08-18', endDate: '2026-08-18' });

    const statement = pool.calls[0].statement;
    expect(statement).toContain('NOT EXISTS (');
    expect(statement).toContain('FROM [KMESV3].[ReleasedJob] AS [releasedJob]');
    expect(statement).toContain('[releasedJob].[LotID] = [final].[JobName]');
    expect(statement).toContain("UPPER(LTRIM(RTRIM(CAST([releasedJob].[JobClass] AS nvarchar(100))))) = N'E'");
  });

  it('uses the workbook ACC/SH parameter rule for SH pulse defective', async () => {
    const repository = createRepository(); const pool = mockPool([{ lotNo: '6H01N00001', tapingDate: '2026-08-01T00:00:00.000Z' }], [{ dispositionDescription: 'SH pulse defective', quantity: '99' }]); repository.pool = pool;

    const rows = await repository.getWorkbookReconciliationRows({ startDate: '2026-08-01', endDate: '2026-08-17' });

    expect(pool.calls[1].statement).toContain("LOWER(LTRIM(RTRIM(CAST([parameters].[ParameterName] AS nvarchar(4000))))) = N'acc_volt'");
    expect(pool.calls[1].statement).toContain('TRY_CONVERT(decimal(19, 4), LTRIM(RTRIM(CAST([parameters].[ParameterValue] AS nvarchar(4000))))) > 0');
    expect(pool.calls[1].statement).toContain("THEN N'ACC'");
    expect(rows).toEqual([{ dispositionDescription: 'SH pulse defective', quantity: 99 }]);
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

  it('uses ReleasedJob.JobClass matched by LotID for the N/E TA Yield classification', async () => {
    const repository = createRepository();
    const pool = mockPool(
      [{ lotNo: '6H31N09428', occuredOn: '2026-08-03T04:00:00.000Z', finalGoodQ: '90', dispositionCode: 'To rteTaping_ALL', quantity: '90', dispositionType: 'GOOD' }],
      [{ lotNo: '6H31N09428', line: 'FPS', closeDate: '2026-07-30', jobType: 'N', inputQ: '100' }]
    );
    repository.pool = pool;

    await expect(repository.getYieldRows({ startDate: '2026-08-03', endDate: '2026-08-03' })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ lotNo: '6H31N09428', jobType: 'N' })
    ]));

    expect(pool.calls[1].statement).toContain('FROM [PowerBIThailand].[ClosedBatch_v] AS [closed]');
    expect(pool.calls[1].statement).toMatch(/LEFT JOIN \[KMESV3\]\.\[ReleasedJob\] AS \[\w+\]\s+ON CAST\(\[\w+\]\.\[LotID\] AS nvarchar\(4000\)\) = CAST\(\[closed\]\.\[JobName\] AS nvarchar\(4000\)\)/);
    expect(pool.calls[1].statement).toContain('MAX(NULLIF(LTRIM(RTRIM(CAST([releasedJob].[JobClass] AS nvarchar(100)))), N\'\'))');
    expect(pool.calls[1].statement).toContain('MAX(CAST([closed].[JobType] AS nvarchar(100)))');
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
