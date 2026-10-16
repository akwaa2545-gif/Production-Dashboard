import { beforeEach, describe, expect, it, vi } from 'vitest';

const writes = vi.hoisted(() => []);
const bulkState = vi.hoisted(() => ({ writes: [], batches: [], transactions: [], failureTable: undefined, insertedRows: 2 }));
vi.mock('mssql', async (importOriginal) => {
  const original = await importOriginal();
  class Transaction {
    constructor() { bulkState.transactions.push(this); }
    async begin() { this.began = true; }
    async commit() { this.committed = true; }
    async rollback() { this.rolledBack = true; }
  }
  class Request {
    constructor(transaction) { this.inputs = {}; this.transaction = transaction; }
    input(name, _type, value) { this.inputs[name] = value; return this; }
    async query(statement) { writes.push({ statement, inputs: this.inputs, transaction: this.transaction }); return { recordset: statement.includes('AS insertedRows') ? [{ insertedRows: bulkState.insertedRows }] : [] }; }
    async batch(statement) { bulkState.batches.push({ statement, transaction: this.transaction }); return { recordset: [] }; }
    async bulk(table) {
      bulkState.writes.push({ table, transaction: this.transaction });
      if (bulkState.failureTable === table.name) throw new Error('Bulk insert failed');
    }
  }
  return { default: { ...original.default, Transaction, Request } };
});

import { TaYieldRepository } from '../src/taYieldRepository.js';
import { TaYieldStagingRepository } from '../src/taYieldStagingRepository.js';
import sql from 'mssql';

const filters = { startDate: '2026-09-01', endDate: '2026-09-30' };
const config = { lotStartLogView: 'dbo.Log', machineTable: 'dbo.Snapshot', machineRowTable: 'dbo.Events', machineLotTable: 'dbo.Lots' };
const event = (operationName, lotNo = 'TA-1', occuredOn = '2026-09-10T00:00:00Z') => ({ lotNo, operationName, machineName: 'M1', occuredOn });
function setup(Repository, rows = []) {
  const calls = [];
  const repository = new Repository(config);
  repository.pool = { request() {
    const inputs = {};
    const types = {};
    return {
      input(name, type, value) { inputs[name] = value; types[name] = type; return this; },
      async query(statement) { calls.push({ statement, inputs, types }); return { recordset: rows }; }
    };
  } };
  return { repository, calls };
}
const snapshot = (end, refreshed, events) => ({ ScopeStart: '2026-09-01', ScopeEnd: end, RefreshedAt: refreshed, Payload: JSON.stringify(events) });

describe('TA machine process repository scope', () => {
  beforeEach(() => { writes.length = 0; bulkState.writes.length = 0; bulkState.batches.length = 0; bulkState.transactions.length = 0; bulkState.failureTable = undefined; });

  it('loads all MES operations only for explicitly eligible lots and retained dates', async () => {
    const { repository, calls } = setup(TaYieldRepository);
    await repository.getMachineEvents(filters, { lotNumbers: ['TA-1', 'TA-1'] });
    expect(calls[0].statement).not.toContain('LIKE @processPattern');
    expect(calls[0].inputs).not.toHaveProperty('processPattern');
    expect(calls[0].inputs.lots).toBe('["TA-1"]');
    expect(calls[0].statement).toContain('INNER JOIN [selectedLots]');
    expect(calls[0].statement).toContain('@startDate');
    expect(calls[0].statement).toContain('@endDate');
  });

  it('never queries MES without eligible lots', async () => {
    const { repository, calls } = setup(TaYieldRepository);
    await expect(repository.getMachineEvents(filters)).resolves.toEqual([]);
    await expect(repository.getMachineEvents(filters, { lotNumbers: [] })).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });

  it.each([{ name: 'MES', Repository: TaYieldRepository }, { name: 'staging', Repository: TaYieldStagingRepository }])('uses parameterized exact operations before legacy patterns in $name', async ({ Repository }) => {
    const { repository, calls } = setup(Repository);
    const processName = "1stAnodization';--";
    await repository.getMachineEvents(filters, { lotNumbers: ['TA-1'], processName, processPattern: '%Anodization%', machine: 'M1' });
    expect(calls[0].inputs.processName).toBe(processName);
    expect(calls[0].inputs).not.toHaveProperty('processPattern');
    expect(calls[0].statement).toMatch(/=\s*@processName/);
    expect(calls[0].statement).not.toContain(processName);
    expect(calls[0].inputs.machine).toBe('M1');
  });

  it('retains legacy MES patterns', async () => {
    const { repository, calls } = setup(TaYieldRepository);
    await repository.getMachineEvents(filters, { lotNumbers: ['TA-1'], processPattern: '%Anodization%' });
    expect(calls[0].statement).toContain('LIKE @processPattern');
    expect(calls[0].inputs.processPattern).toBe('%Anodization%');
  });

  it('uses authoritative eligible lots without requiring defect rows for zero-defect calculated lots', async () => {
    const { repository, calls } = setup(TaYieldStagingRepository);
    await repository.getMachineEvents({ ...filters, serie: ['FPS'], pn: 'PART' }, { lotNumbers: ['TA-1'] });
    expect(calls[0].inputs.lots).toBe('<lots><lot>TA-1</lot></lots>');
    expect(calls[0].types.lots).toEqual(sql.NVarChar(sql.MAX));
    expect(calls[0].statement).toContain('DECLARE @selectedLots xml = CAST(@lots AS xml);');
    expect(calls[0].statement).toContain("@selectedLots.nodes('/lots/lot')");
    expect(calls[0].statement).not.toContain('OPENJSON');
    expect(calls[0].statement).not.toContain('EXISTS');
    expect(calls[0].statement).not.toContain('[dbo].[Lots]');
    expect(calls[0].statement).not.toContain('LIKE @processPattern');
    await expect(repository.getMachineEvents(filters, { lotNumbers: [] })).resolves.toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('binds over 2100 calculated lots in one SQL Server 2014 XML parameter with escaped lot identifiers', async () => {
    const { repository, calls } = setup(TaYieldStagingRepository);
    const unusualLot = `TA&<lot>"'; DROP TABLE Events;--`;
    const lotNumbers = [unusualLot, ...Array.from({ length: 2200 }, (_unused, index) => `TA-${index}`), unusualLot];
    await repository.getMachineEvents(filters, { lotNumbers });
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0].inputs).sort()).toEqual(['end', 'lots', 'start']);
    expect(calls[0].types.lots).toEqual(sql.NVarChar(sql.MAX));
    expect(calls[0].inputs.lots).toContain('<lot>TA&amp;&lt;lot&gt;&quot;&apos;; DROP TABLE Events;--</lot>');
    expect(calls[0].inputs.lots.match(/<lot>/g)).toHaveLength(2201);
    expect(calls[0].statement).not.toContain(unusualLot);
    expect(calls[0].statement).not.toContain('OPENJSON');
    expect(calls[0].statement).toContain('DECLARE @selectedLots xml = CAST(@lots AS xml);');
    expect(calls[0].statement).toContain("@selectedLots.nodes('/lots/lot')");
    expect(calls[0].statement).toContain(".value('(text())[1]', 'nvarchar(4000)')");
  });

  it('retains normalized analysis lot, taping-date, series and part scope without an explicit lot list', async () => {
    const { repository, calls } = setup(TaYieldStagingRepository);
    await repository.getMachineEvents({ ...filters, serie: ['FPS'], pn: 'PART' });
    expect(calls[0].statement).toContain('EXISTS');
    expect(calls[0].statement).toContain('lot.TapingDate>=@start');
    expect(calls[0].statement).toContain('lot.ScopeMonth=event.ScopeMonth');
    expect(calls[0].statement).toContain('lot.Serie=@serie0');
    expect(calls[0].statement).toContain('lot.PartNumber=@pn0');
    expect(calls[0].statement).not.toContain('OPENJSON');
  });

  it('selects latest machine snapshot scope per month and matches exact operations with trimmed case-insensitive names', async () => {
    const matched = event(' 1STANODIZATION ');
    const { repository, calls } = setup(TaYieldStagingRepository, [
      snapshot('2026-09-29', '2026-10-04', [event('1stAnodization', 'SHORTER')]),
      snapshot('2026-09-30', '2026-10-01', [event('1stAnodization', 'OBSOLETE')]),
      snapshot('2026-09-30', '2026-10-02', [matched, event('2ndAnodization'), event('1stAnodization', 'UNRELATED')])
    ]);
    await expect(repository.getMachineEventsSnapshot(filters, { lotNumbers: ['TA-1', 'SHORTER', 'OBSOLETE'], processName: '1stAnodization' })).resolves.toEqual([matched]);
    expect(calls[0].statement).toContain('ScopeStart');
    expect(calls[0].statement).toContain('ScopeEnd');
    expect(calls[0].statement).toContain('RefreshedAt');
  });

  it('keeps snapshot alias patterns, machine and Bangkok date boundaries', async () => {
    const matched = event('2ndAnodization', 'TA-1', '2026-09-01T17:00:00Z');
    const { repository } = setup(TaYieldStagingRepository, [snapshot('2026-09-30', '2026-10-01', [
      matched, event('1stAnodization', 'TA-1', '2026-09-01T16:59:59Z'), { ...matched, machineName: 'M2' }, event('Welding')
    ])]);
    await expect(repository.getMachineEventsSnapshot({ startDate: '2026-09-02', endDate: '2026-09-02' }, { lotNumbers: ['TA-1'], processPattern: '%Anodization%', machine: 'M1' })).resolves.toEqual([matched]);
  });

  it('returns every snapshot operation for eligible lots when no process is selected', async () => {
    const events = [event('Pressing'), event('Welding'), event('Taping')];
    const { repository } = setup(TaYieldStagingRepository, [snapshot('2026-09-30', '2026-10-01', [...events, event('Pressing', 'UNRELATED')])]);
    await expect(repository.getMachineEventsSnapshot(filters, { lotNumbers: ['TA-1'] })).resolves.toEqual(events);
    await expect(repository.getMachineEventsSnapshot(filters, { lotNumbers: [] })).resolves.toEqual([]);
  });

  it('matches first-anodization aliases with internal SQL LIKE wildcards without matching second anodization', async () => {
    const first = [event('1stAnodization'), event('1stA_Anodization'), event('rte1st_Anodization')];
    const { repository } = setup(TaYieldStagingRepository, [snapshot('2026-09-30', '2026-10-01', [...first, event('2ndAnodization'), event('2ndA_Anodization')])]);
    await expect(repository.getMachineEventsSnapshot(filters, { lotNumbers: ['TA-1'], processPattern: '%1st%Anodization%' })).resolves.toEqual(first);
    await expect(repository.getMachineEventsSnapshot(filters, { lotNumbers: ['TA-1'], processName: '1stAnodization' })).resolves.toEqual([first[0]]);
  });

  it('escapes regex punctuation, anchors LIKE patterns and supports underscore as one character', async () => {
    const matched = event('dIP.(A)+1x');
    const exact = event('Dip.(A)+_x');
    const { repository } = setup(TaYieldStagingRepository, [snapshot('2026-09-30', '2026-10-01', [
      matched, exact, event('DipZAAAA1x'), event('prefixDip.(A)+1x'), event('Dip.(A)+12x'), event('Dip.(A)+x')
    ])]);
    await expect(repository.getMachineEventsSnapshot(filters, { lotNumbers: ['TA-1'], processPattern: 'Dip.(A)+_x' })).resolves.toEqual([matched, exact]);
    await expect(repository.getMachineEventsSnapshot(filters, { lotNumbers: ['TA-1'], processName: 'Dip.(A)+_x', processPattern: '%' })).resolves.toEqual([exact]);
  });

  it.each(['replaceMachineRows', 'replaceMachineRowsForLots'])('%s never writes events for unrelated lots', async (method) => {
    const { repository } = setup(TaYieldStagingRepository);
    await repository[method]([event('Pressing'), event('Welding', 'UNRELATED')], [{ lotNo: 'TA-1', categories: { Welding: 2 }, tapingDate: '2026-09-20' }], filters);
    if (method === 'replaceMachineRows') {
      const inserted = bulkState.writes.find(({ table }) => table.name === 'Events').table.rows;
      expect(inserted.map((row) => row[2])).toEqual(['TA-1']);
      expect(inserted[0][3]).toBe('Pressing');
    } else {
      const inserted = writes.filter(({ statement }) => statement.startsWith('INSERT INTO [dbo].[Events]'));
      expect(inserted.map(({ inputs }) => inputs.lotNo)).toEqual(['TA-1']);
      expect(inserted[0].inputs.operationName).toBe('Pressing');
    }
  });

  it('bulk replaces the full month transactionally with deduplicated events and every original lot category row', async () => {
    const { repository } = setup(TaYieldStagingRepository);
    const lots = [
      { lotNo: 'TA-1', line: 'FPS', itemName: 'PART', tapingDate: '2026-09-20T18:00:00Z', categories: { Input: 100, 'Input-': 1, Good: 80, Welding: '2.5', Dip: -1, Empty: 0 } },
      { lotNo: 'TA-1', line: 'PSH', itemName: 'PART2', tapingDate: '2026-09-22', categories: { Welding: 3 } }
    ];
    await repository.replaceMachineRows([
      event('Pressing'), { ...event('Pressing'), machineName: ' M1 ', occuredOn: '2026-09-10T01:00:00Z' },
      { ...event('Pressing'), machineName: 'M2' }, event('Welding', 'UNRELATED')
    ], lots, filters);
    expect(writes).toHaveLength(1);
    expect(writes[0].statement).toContain('DELETE FROM [dbo].[Events] WHERE ScopeMonth=@scopeMonth');
    expect(bulkState.writes).toHaveLength(2);
    const [events, defects] = bulkState.writes.map(({ table }) => table);
    expect(events.schema).toBe('dbo');
    expect(events.name).toBe('Events');
    expect(events.columns.map((column) => column.name)).toEqual(['ScopeMonth', 'EventDate', 'LotNo', 'OperationName', 'MachineName']);
    expect(events.rows.map((row) => [...row])).toEqual([
      [new Date('2026-09-01'), new Date('2026-09-10'), 'TA-1', 'Pressing', 'M1'],
      [new Date('2026-09-01'), new Date('2026-09-10'), 'TA-1', 'Pressing', 'M2']
    ]);
    expect(defects.name).toBe('Lots');
    expect(defects.columns.map((column) => column.name)).toEqual(['ScopeMonth', 'LotNo', 'Serie', 'PartNumber', 'TapingDate', 'YieldCategory', 'DefectMode', 'Quantity']);
    expect(defects.rows.map((row) => [...row])).toEqual([
      [new Date('2026-09-01'), 'TA-1', 'FPS', 'PART', new Date('2026-09-21'), 'Welding', 'Welding', 2.5],
      [new Date('2026-09-01'), 'TA-1', 'FPS', 'PART', new Date('2026-09-21'), 'Dip', 'Dip', -1],
      [new Date('2026-09-01'), 'TA-1', 'PSH', 'PART2', new Date('2026-09-22'), 'Welding', 'Welding', 3]
    ]);
    const transaction = bulkState.transactions[0];
    expect(bulkState.writes.every((write) => write.transaction === transaction)).toBe(true);
    expect(transaction).toMatchObject({ began: true, committed: true });
    expect(transaction.rolledBack).toBeUndefined();
  });

  it('skips empty bulk tables while deleting and committing an empty month', async () => {
    const { repository } = setup(TaYieldStagingRepository);
    await repository.replaceMachineRows([event('Pressing', 'UNRELATED')], [], filters);
    expect(writes).toHaveLength(1);
    expect(bulkState.writes).toEqual([]);
    expect(bulkState.transactions[0]).toMatchObject({ began: true, committed: true });
  });

  it('rolls back the full month replacement without committing when a bulk write fails', async () => {
    const { repository } = setup(TaYieldStagingRepository);
    bulkState.failureTable = 'Lots';
    await expect(repository.replaceMachineRows([event('Pressing')], [{ lotNo: 'TA-1', tapingDate: '2026-09-20', categories: { Welding: 2 } }], filters)).rejects.toThrow('Bulk insert failed');
    expect(bulkState.writes).toHaveLength(2);
    expect(bulkState.transactions[0]).toMatchObject({ began: true, rolledBack: true });
    expect(bulkState.transactions[0].committed).toBeUndefined();
  });

  it('merges only eligible distinct machine events without deleting or rewriting defect lots', async () => {
    const { repository } = setup(TaYieldStagingRepository);
    const insertedRows = await repository.mergeMachineEvents([
      event('Pressing'), { ...event('Pressing'), machineName: ' M1 ', occuredOn: '2026-09-10T01:00:00Z' },
      event('Welding'), event('Pressing', 'UNRELATED')
    ], [{ lotNo: 'TA-1' }], filters);
    expect(insertedRows).toBe(2);
    expect(bulkState.writes).toHaveLength(1);
    const [{ table, transaction }] = bulkState.writes;
    expect(table.name).toBe('#TaYieldMachineEventMerge');
    expect(table.temporary).toBe(true);
    expect(table.create).toBe(false);
    expect(bulkState.batches).toHaveLength(1);
    expect(bulkState.batches[0].transaction).toBe(transaction);
    expect(bulkState.batches[0].statement).toContain('CREATE TABLE #TaYieldMachineEventMerge');
    expect(bulkState.batches[0].statement.match(/COLLATE DATABASE_DEFAULT/g)).toHaveLength(3);
    expect(table.columns.map((column) => column.name)).toEqual(['ScopeMonth', 'EventDate', 'LotNo', 'OperationName', 'MachineName']);
    expect(table.rows.map((row) => [...row])).toEqual([
      [new Date('2026-09-01'), new Date('2026-09-10'), 'TA-1', 'Pressing', 'M1'],
      [new Date('2026-09-01'), new Date('2026-09-10'), 'TA-1', 'Welding', 'M1']
    ]);
    expect(writes).toHaveLength(1);
    expect(writes[0].transaction).toBe(transaction);
    expect(writes[0].statement).toContain('INSERT INTO [dbo].[Events]');
    expect(writes[0].statement).toContain('NOT EXISTS');
    expect(writes[0].statement).toContain('SELECT DISTINCT');
    expect(writes[0].statement).toContain('WITH (UPDLOCK, HOLDLOCK)');
    for (const column of ['ScopeMonth', 'EventDate', 'LotNo', 'OperationName', 'MachineName']) expect(writes[0].statement).toContain(`existing.${column}=incoming.${column}`);
    expect(writes[0].statement).not.toContain('DELETE');
    expect(writes[0].statement).not.toContain('[dbo].[Lots]');
    expect(writes[0].statement).toContain('DROP TABLE #TaYieldMachineEventMerge');
    expect(transaction).toMatchObject({ began: true, committed: true });
  });

  it('skips an event merge with no eligible events before opening a transaction', async () => {
    const { repository } = setup(TaYieldStagingRepository);
    await expect(repository.mergeMachineEvents([event('Pressing', 'UNRELATED')], [{ lotNo: 'TA-1' }], filters)).resolves.toBe(0);
    expect(writes).toEqual([]);
    expect(bulkState.writes).toEqual([]);
    expect(bulkState.transactions).toEqual([]);
  });

  it('excludes eligible-lot events outside Bangkok report date boundaries during additive merge', async () => {
    const { repository } = setup(TaYieldStagingRepository);
    const first = event('Pressing', 'TA-1', '2026-08-31T17:00:00Z');
    const last = event('Welding', 'TA-1', '2026-09-30T16:59:59Z');
    await repository.mergeMachineEvents([
      event('Pressing', 'TA-1', '2026-08-31T16:59:59Z'), first, last,
      event('Welding', 'TA-1', '2026-09-30T17:00:00Z')
    ], [{ lotNo: 'TA-1' }], filters);
    expect(bulkState.writes[0].table.rows.map((row) => [row[1], row[3]])).toEqual([
      [new Date('2026-09-01'), 'Pressing'], [new Date('2026-09-30'), 'Welding']
    ]);
  });

  it('rolls back additive event merge when bulk staging fails', async () => {
    const { repository } = setup(TaYieldStagingRepository);
    bulkState.failureTable = '#TaYieldMachineEventMerge';
    await expect(repository.mergeMachineEvents([event('Pressing')], [{ lotNo: 'TA-1' }], filters)).rejects.toThrow('Bulk insert failed');
    expect(bulkState.transactions[0]).toMatchObject({ began: true, rolledBack: true });
    expect(bulkState.transactions[0].committed).toBeUndefined();
    expect(writes).toEqual([]);
  });
});
