import { describe, expect, it, vi } from 'vitest';
import { backfillTaYieldMachineProcesses, parseTaYieldMachineBackfillArguments } from '../src/taYieldMachineProcessBackfill.js';

const lot = (line = 'PSG') => ({ line, lotNo: 'TA-1', itemName: 'PART', tapingDate: '2026-09-12', categories: { SH: 3, Good: 90 } });
function fixture(rows = [lot()]) {
  const staging = {
    getLatestWorkbookSnapshotForMonth: vi.fn(async () => ({ scopeStart: '2026-09-01', scopeEnd: '2026-09-30', rows })),
    replaceMachineRows: vi.fn(async () => {})
  };
  const source = { getMachineEvents: vi.fn(async () => [{ lotNo: 'TA-1', operationName: 'Molding' }, { lotNo: 'OTHER', operationName: 'EI' }]) };
  return { staging, source, loadMapping: vi.fn(async () => new Map()), now: () => new Date('2026-10-16T01:00:00Z') };
}
const options = { start: '2026-09', end: '2026-09' };

describe('TA machine process backfill arguments', () => {
  it('requires an explicit bounded month range and defaults to inventory', () => {
    expect(parseTaYieldMachineBackfillArguments(['--start=2026-09', '--end=2026-10'])).toEqual({ start: '2026-09', end: '2026-10', apply: false });
    expect(parseTaYieldMachineBackfillArguments(['--start=2026-09', '--end=2026-09', '--apply']).apply).toBe(true);
  });
  it.each([[], ['--start=2026-09'], ['--start=2026-13', '--end=2026-13'], ['--start=2026-10', '--end=2026-09'], ['--start=2025-01', '--end=2026-01'], ['--start=2026-09', '--end=2026-09', '--yes'], ['--start=2026-09', '--start=2026-09', '--end=2026-09']])('rejects invalid or unknown arguments %j', (args) => {
    expect(() => parseTaYieldMachineBackfillArguments(args)).toThrow();
  });
});

describe('TA machine process backfill', () => {
  it('inventories staged calculated lots without querying MES or writing', async () => {
    const deps = fixture([lot(), lot('PSL')]);
    const result = await backfillTaYieldMachineProcesses(options, deps);
    expect(result).toMatchObject({ apply: false, months: [{ month: '2026-09', startDate: '2026-09-01', endDate: '2026-09-30', lotRows: 2, lotCount: 1, status: 'DRY_RUN' }] });
    expect(deps.staging.getLatestWorkbookSnapshotForMonth).toHaveBeenCalledWith({ startDate: '2026-09-01', endDate: '2026-09-30' });
    expect(deps.source.getMachineEvents).not.toHaveBeenCalled();
    expect(deps.staging.replaceMachineRows).not.toHaveBeenCalled();
    expect(deps.loadMapping).not.toHaveBeenCalled();
  });
  it('loads all processes for unique calculated IDs and preserves separate series', async () => {
    const deps = fixture([lot(), lot('PSL')]);
    await backfillTaYieldMachineProcesses({ ...options, apply: true }, deps);
    const scope = { startDate: '2026-09-01', endDate: '2026-09-30' };
    expect(deps.source.getMachineEvents).toHaveBeenCalledWith(scope, { lotNumbers: ['TA-1'] });
    expect(deps.staging.replaceMachineRows).toHaveBeenCalledWith([{ lotNo: 'TA-1', operationName: 'Molding' }], expect.arrayContaining([expect.objectContaining({ line: 'PSG' }), expect.objectContaining({ line: 'PSL' })]), scope);
    expect(deps.staging.replaceMachineRows.mock.calls[0][1]).toHaveLength(2);
  });
  it('maps legacy action aliases only through the existing reconciliation mapping', async () => {
    const deps = fixture([{ line: 'PSG', lotNo: 'TA-1', itemName: 'PART', tapingDate: '2026-09-12', dispositionDescription: 'Custom alias', quantity: 4 }]);
    deps.loadMapping.mockResolvedValue(new Map([['Custom alias', 'SH']]));
    await backfillTaYieldMachineProcesses({ ...options, apply: true }, deps);
    expect(deps.loadMapping).toHaveBeenCalledOnce();
    expect(deps.staging.replaceMachineRows.mock.calls[0][1][0].categories.SH).toBe(4);
  });
  it('does not replace anything when source retrieval fails', async () => {
    const deps = fixture();
    deps.source.getMachineEvents.mockRejectedValue(new Error('MES unavailable'));
    await expect(backfillTaYieldMachineProcesses({ ...options, apply: true }, deps)).rejects.toThrow('MES unavailable');
    expect(deps.staging.replaceMachineRows).not.toHaveBeenCalled();
  });
  it.each([undefined, { scopeStart: '2026-09-02', scopeEnd: '2026-09-30', rows: [lot()] }, { scopeStart: '2026-09-01', scopeEnd: '2026-09-29', rows: [lot()] }, { scopeStart: '2026-09-01', scopeEnd: '2026-10-01', rows: [lot()] }])('rejects missing or incomplete historical staging before any writes', async (snapshot) => {
    const deps = fixture(); deps.staging.getLatestWorkbookSnapshotForMonth.mockResolvedValue(snapshot);
    await expect(backfillTaYieldMachineProcesses({ ...options, apply: true }, deps)).rejects.toThrow(/staging|scope/i);
    expect(deps.source.getMachineEvents).not.toHaveBeenCalled();
    expect(deps.staging.replaceMachineRows).not.toHaveBeenCalled();
  });
  it('preflights all months before writing an earlier valid month', async () => {
    const deps = fixture(); deps.staging.getLatestWorkbookSnapshotForMonth.mockResolvedValueOnce({ scopeStart: '2026-09-01', scopeEnd: '2026-09-30', rows: [lot()] }).mockResolvedValueOnce(undefined);
    await expect(backfillTaYieldMachineProcesses({ start: '2026-09', end: '2026-10', apply: true }, deps)).rejects.toThrow();
    expect(deps.staging.replaceMachineRows).not.toHaveBeenCalled();
  });
  it('uses current Bangkok coverage and rejects future coverage', async () => {
    const deps = fixture(); deps.now = () => new Date('2026-09-30T18:00:00Z');
    deps.staging.getLatestWorkbookSnapshotForMonth.mockResolvedValue({ scopeStart: '2026-10-01', scopeEnd: '2026-10-01', rows: [lot()] });
    await backfillTaYieldMachineProcesses({ start: '2026-10', end: '2026-10', apply: true }, deps);
    expect(deps.source.getMachineEvents).toHaveBeenCalledWith({ startDate: '2026-10-01', endDate: '2026-10-01' }, { lotNumbers: ['TA-1'] });
    deps.staging.getLatestWorkbookSnapshotForMonth.mockResolvedValue({ scopeStart: '2026-10-01', scopeEnd: '2026-10-02', rows: [lot()] });
    await expect(backfillTaYieldMachineProcesses({ start: '2026-10', end: '2026-10' }, deps)).rejects.toThrow(/scope/i);
  });
  it('clears stale Machine rows when the staged calculated population is empty without reading MES', async () => {
    const deps = fixture([]);
    const result = await backfillTaYieldMachineProcesses({ ...options, apply: true }, deps);
    expect(result.months[0]).toMatchObject({ status: 'REPLACED', eventRows: 0, lotRows: 0, lotCount: 0 });
    expect(deps.source.getMachineEvents).not.toHaveBeenCalled();
    expect(deps.staging.replaceMachineRows).toHaveBeenCalledWith([], [], { startDate: '2026-09-01', endDate: '2026-09-30' });
  });
});
