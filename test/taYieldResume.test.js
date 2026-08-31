import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

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
    expect(app).toContain('replaceMachineRowsForLots(machineEvents, freshLots, fullFilters)');
    const resume = app.slice(app.indexOf('app.refreshTaYieldStagingResume'), app.indexOf('app.refreshTaYieldStagingHistory'));
    expect(resume).toContain('const resumeLotKey');
    expect(resume).toContain('taYieldRepository instanceof TaYieldRepository');
    expect(resume).toContain('new TaYieldRepository({ ...taYieldConfig, requestTimeout })');
    expect(resume).toContain('actionLookbackMonths: 0');
    expect(resume.indexOf('replaceMachineRowsForLots(machineEvents, freshLots, fullFilters)')).toBeLessThan(resume.indexOf('replaceWorkbookRows(mergedLots, fullFilters)'));
    expect(repository).toContain('getLatestWorkbookSnapshotForMonth(filters)');
    expect(repository).toContain('replaceMachineRowsForLots(events, lots, filters)');
  });
});
