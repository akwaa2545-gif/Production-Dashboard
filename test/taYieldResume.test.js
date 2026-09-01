import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { deleteMachineLotsForScope } from '../src/taYieldStagingRepository.js';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

describe('TA Yield staging resume', () => {
  it('uses a dedicated resume command with a bounded manual timeout', () => {
    const script = read('src/refreshTaYieldStaging.js');
    const app = read('src/app.js');
    const repository = read('src/taYieldStagingRepository.js');

    expect(script).toContain("process.argv.includes('--resume')");
    expect(script).toContain("--timeout-ms=");
    expect(app).toContain('app.refreshTaYieldStagingResume');
    expect(app).toContain('Resume range resolved: ${scope}.');
    expect(app).toContain('getLatestWorkbookSnapshotForMonth(fullFilters)');
    expect(app).toContain('replaceWorkbookRows(mergedLots, fullFilters)');
    expect(app).toContain('replaceMachineRowsForLots(machineEvents, freshLots, fullFilters, { lotNumbersToRemove:');
    const resume = app.slice(app.indexOf('app.refreshTaYieldStagingResume'), app.indexOf('app.refreshTaYieldStagingHistory'));
    expect(resume).toContain('const resumeLotKey');
    expect(resume).toContain('taYieldRepository instanceof TaYieldRepository');
    expect(resume).toContain('new TaYieldRepository({ ...taYieldConfig, requestTimeout })');
    expect(resume).toContain('actionLookbackMonths: 0');
    expect(resume).toContain('refreshCurrent');
    expect(resume).toContain('startDate: fullFilters.endDate');
    expect(resume.indexOf('replaceMachineRowsForLots(machineEvents, freshLots, fullFilters, { lotNumbersToRemove:')).toBeLessThan(resume.indexOf('replaceWorkbookRows(mergedLots, fullFilters)'));
    expect(repository).toContain('getLatestWorkbookSnapshotForMonth(filters)');
    expect(repository).toContain('replaceMachineRowsForLots(events, lots, filters, { lotNumbersToRemove = [] } = {})');
  });

  it('removes resumed machine lots with SQL parameters instead of OPENJSON', () => {
    const repository = read('src/taYieldStagingRepository.js');
    expect(repository).not.toContain('OPENJSON');
    expect(repository).toContain('LotNo IN (${parameters.join(\', \')})');
  });

  it('batches more than 500 resumed lots into parameterized transactional deletes', async () => {
    const calls = [];
    class Request {
      constructor(transaction) { this.transaction = transaction; this.inputs = []; }
      input(name, _type, value) { this.inputs.push([name, value]); return this; }
      query(statement) { calls.push({ transaction: this.transaction, inputs: this.inputs, statement }); return Promise.resolve(); }
    }
    const transaction = {};

    await deleteMachineLotsForScope(transaction, '2026-09-01', Array.from({ length: 501 }, (_value, index) => `LOT-${index}`), { machineRowTable: 'dbo.MachineRows', machineLotTable: 'dbo.MachineLots' }, Request);

    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.transaction === transaction && call.inputs.length <= 501)).toBe(true);
    expect(calls.map((call) => call.inputs.filter(([name]) => name.startsWith('lot')).length)).toEqual([500, 1]);
    expect(calls.every((call) => call.statement.includes('[dbo].[MachineRows]') && call.statement.includes('[dbo].[MachineLots]'))).toBe(true);
  });
});
