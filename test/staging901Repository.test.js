import { describe, expect, it } from 'vitest';
import { Staging901Repository } from '../src/staging901Repository.js';
import { TaYieldStagingRepository } from '../src/taYieldStagingRepository.js';

describe('Staging901Repository options', () => {
  it('returns series in the dashboard option-list shape', async () => {
    const repository = new Staging901Repository({ table: 'dbo.Dashboard901Daily' });
    repository.pool = {
      request: () => ({
        input: () => undefined,
        query: () => Promise.resolve({ recordset: [
          { process: 'NEO', product: 'NEO', serie: 'FPS A3' },
          { process: 'NEO', product: 'NEO', serie: 'FPS B2' },
          { process: 'SC', product: 'SC', serie: 'Element' }
        ] })
      })
    };

    await expect(repository.getOptions()).resolves.toEqual({
      process: ['NEO', 'SC'],
      serie: ['Element', 'FPS A3', 'FPS B2'],
      case: [],
      pn: []
    });
  });

  it('uses parameterized series filters without OPENJSON', async () => {
    const calls = { inputs: [], statement: '' };
    const repository = new Staging901Repository({ table: 'dbo.Dashboard901Daily' });
    repository.pool = {
      request: () => ({
        input: (...input) => { calls.inputs.push(input); },
        query: (statement) => { calls.statement = statement; return Promise.resolve({ recordset: [] }); }
      })
    };

    await repository.getQuantity({ startDate: '2026-08-01', endDate: '2026-08-18', product: 'NEO', serie: ['FPS A3', 'FPS B2'] });

    expect(calls.statement).not.toContain('OPENJSON');
    expect(calls.statement).toContain('Serie IN (@serie0, @serie1)');
    expect(calls.inputs).toContainEqual(['serie0', expect.anything(), 'FPS A3']);
    expect(calls.inputs).toContainEqual(['serie1', expect.anything(), 'FPS B2']);
  });
});

describe('TaYieldStagingRepository workbook dates', () => {
  it('filters DataTable rows by the Thailand taping date', async () => {
    const repository = new TaYieldStagingRepository({ workbookTable: 'dbo.DashboardTaYieldWorkbook' });
    repository.pool = {
      request: () => {
        const request = {
          input: () => request,
          query: () => Promise.resolve({ recordset: [
            { ScopeStart: '2026-08-01', ScopeEnd: '2026-08-16', RefreshedAt: '2026-08-16T12:00:00.000Z', Payload: JSON.stringify([{ lotNo: 'STALE', tapingDate: '2026-08-16T17:00:00.000Z' }]) },
            { ScopeStart: '2026-08-01', ScopeEnd: '2026-08-17', RefreshedAt: '2026-08-17T12:00:00.000Z', Payload: JSON.stringify([
              { lotNo: 'TH-17', tapingDate: '2026-08-16T17:00:00.000Z' },
              { lotNo: 'TH-16', tapingDate: '2026-08-16T16:00:00.000Z' }
            ]) }
          ] })
        };
        return request;
      }
    };

    await expect(repository.getWorkbookRows({ startDate: '2026-08-17', endDate: '2026-08-17' })).resolves.toEqual([
      expect.objectContaining({ lotNo: 'TH-17' })
    ]);
  });

  it('does not report an earlier monthly snapshot as coverage for a later date', async () => {
    const repository = new TaYieldStagingRepository({ workbookTable: 'dbo.DashboardTaYieldWorkbook' });
    repository.pool = {
      request: () => {
        const request = {
          input: () => request,
          query: () => Promise.resolve({ recordset: [{ ScopeStart: '2026-08-01', ScopeEnd: '2026-08-16' }] })
        };
        return request;
      }
    };

    await expect(repository.hasWorkbookCoverage({ startDate: '2026-08-17', endDate: '2026-08-17' })).resolves.toBe(false);
  });
});
