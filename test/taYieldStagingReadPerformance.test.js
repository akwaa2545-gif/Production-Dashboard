import { describe, expect, it } from 'vitest';
import { TaYieldStagingRepository } from '../src/taYieldStagingRepository.js';

const snapshot = (scopeStart, scopeEnd, refreshedAt, rows) => ({
  ScopeStart: scopeStart, ScopeEnd: scopeEnd, RefreshedAt: refreshedAt, Payload: JSON.stringify(rows)
});

const repositoryWith = (records) => {
  const calls = { statement: '', inputs: [] };
  const repository = new TaYieldStagingRepository({ workbookTable: 'dbo.DashboardTaYieldWorkbook' });
  repository.pool = {
    request: () => ({
      input: (...input) => { calls.inputs.push(input); },
      query: async (statement) => { calls.statement = statement; return { recordset: records }; }
    })
  };
  return { repository, calls };
};

describe('TA Yield staging workbook read performance', () => {
  it('selects one latest snapshot per month in SQL before fetching its large payload', async () => {
    const { repository, calls } = repositoryWith([
      snapshot('2026-09-01', '2026-09-30', '2026-10-01T00:00:00Z', [{ lotNo: 'LATEST', tapingDate: '2026-09-30' }])
    ]);
    await expect(repository.getWorkbookRows({ startDate: '2026-09-01', endDate: '2026-09-30' })).resolves.toEqual([
      { lotNo: 'LATEST', tapingDate: '2026-09-30' }
    ]);
    expect(calls.statement).toMatch(/ROW_NUMBER\(\) OVER\s*\(\s*PARTITION BY DATEFROMPARTS\(YEAR\(ScopeStart\), MONTH\(ScopeStart\), 1\)\s*ORDER BY ScopeEnd DESC, RefreshedAt DESC\s*\)/i);
    const rankedMetadata = calls.statement.slice(0, calls.statement.indexOf('SELECT snapshot.'));
    expect(rankedMetadata).not.toContain('Payload');
    expect(calls.statement).toContain('snapshot.Payload');
    expect(calls.statement).toContain('latest.SnapshotRank=1');
    expect(calls.statement).toContain('snapshot.ScopeStart=latest.ScopeStart AND snapshot.ScopeEnd=latest.ScopeEnd');
    expect(calls.statement).toContain('ScopeStart >= DATEFROMPARTS(YEAR(@start), MONTH(@start), 1)');
    expect(calls.statement).toContain('ScopeStart <= DATEFROMPARTS(YEAR(@end), MONTH(@end), 1)');
  });

  it('preserves greatest scope end and latest refresh semantics even with extra mocked records', async () => {
    const { repository } = repositoryWith([
      snapshot('2026-08-01', '2026-08-30', '2026-09-03T00:00:00Z', [{ lotNo: 'SHORTER', tapingDate: '2026-08-20' }]),
      snapshot('2026-08-01', '2026-08-31', '2026-09-01T00:00:00Z', [{ lotNo: 'OLDER', tapingDate: '2026-08-20' }]),
      snapshot('2026-08-01', '2026-08-31', '2026-09-02T00:00:00Z', [{ lotNo: 'NEWER', tapingDate: '2026-08-20' }]),
      snapshot('2026-09-01', '2026-09-30', '2026-10-01T00:00:00Z', [{ lotNo: 'SEPTEMBER', tapingDate: '2026-09-10' }])
    ]);
    await expect(repository.getWorkbookRows({ startDate: '2026-08-01', endDate: '2026-09-30' })).resolves.toEqual([
      { lotNo: 'NEWER', tapingDate: '2026-08-20' }, { lotNo: 'SEPTEMBER', tapingDate: '2026-09-10' }
    ]);
  });

  it('keeps partial-range Bangkok date boundaries and filter values out of SQL text', async () => {
    const { repository, calls } = repositoryWith([
      snapshot('2026-08-01', '2026-08-31', '2026-09-01T00:00:00Z', [
        { lotNo: 'BEFORE', tapingDate: '2026-08-16T16:59:59Z' },
        { lotNo: 'IN', tapingDate: '2026-08-16T17:00:00Z' },
        { lotNo: 'AFTER', tapingDate: '2026-08-17T17:00:00Z' }
      ])
    ]);
    const filters = { startDate: '2026-08-17', endDate: '2026-08-17', serie: ["FPS'; DROP TABLE workbook;--"], pn: ['PN1'] };
    await expect(repository.getWorkbookRows(filters)).resolves.toEqual([{ lotNo: 'IN', tapingDate: '2026-08-16T17:00:00Z' }]);
    expect(calls.inputs).toContainEqual(['start', expect.anything(), filters.startDate]);
    expect(calls.inputs).toContainEqual(['end', expect.anything(), filters.endDate]);
    expect(calls.statement).not.toContain(filters.startDate);
    expect(calls.statement).not.toContain(filters.serie[0]);
    expect(calls.inputs).toHaveLength(2);
  });

  it('retains no-snapshot error and available-month behavior without expanding coverage', async () => {
    const empty = repositoryWith([]).repository;
    await expect(empty.getWorkbookRows({ startDate: '2026-08-01', endDate: '2026-08-31' })).rejects.toThrow('TA Yield DataTable staging data is not ready');
    const { repository } = repositoryWith([
      snapshot('2026-08-01', '2026-08-31', '2026-09-01T00:00:00Z', [{ lotNo: 'AVAILABLE', tapingDate: '2026-08-20' }])
    ]);
    const filters = { startDate: '2026-08-01', endDate: '2026-09-30' };
    await expect(repository.getWorkbookRows(filters)).resolves.toHaveLength(1);
    await expect(repository.hasWorkbookCoverage(filters)).resolves.toBe(false);
  });
});
