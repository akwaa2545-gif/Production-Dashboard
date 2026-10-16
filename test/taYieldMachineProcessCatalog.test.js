import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { TaYieldStagingRepository } from '../src/taYieldStagingRepository.js';
import { createApp } from '../src/app.js';

vi.mock('../src/taYieldMapping.js', async (original) => ({ ...await original(), loadTaWorkbookReconciliationMapping: async () => new Map() }));
const dates = { startDate: '2026-10-01', endDate: '2026-10-16' };

describe('TA calculated-lot process catalog', () => {
  it('selects distinct process names in SQL with calculated-lot and date boundaries on SQL Server 2014', async () => {
    const repository = new TaYieldStagingRepository({ machineRowTable: 'dbo.MachineEvents' });
    const inputs = {};
    let statement;
    repository.pool = { request: () => ({ input(name, _type, value) { inputs[name] = value; }, async query(query) { statement = query; return { recordset: [{ process: 'Pressing' }, { process: 'Molding' }] }; } }) };
    await expect(repository.getMachineProcesses(dates, { lotNumbers: ['TA&1', 'TA<2', 'TA&1'] })).resolves.toEqual(['Pressing', 'Molding']);
    expect(inputs).toMatchObject({ start: dates.startDate, end: dates.endDate, lots: '<lots><lot>TA&amp;1</lot><lot>TA&lt;2</lot></lots>' });
    expect(statement).toContain('SELECT DISTINCT');
    expect(statement).toContain('CAST(@lots AS xml)');
    expect(statement).toContain("@selectedLots.nodes('/lots/lot')");
    expect(statement).toContain('event.EventDate>=@start');
    expect(statement).toContain('event.EventDate<=@end');
    expect(statement).not.toContain('OPENJSON');
    expect(statement).not.toContain('TA&1');
  });

  it('never loads unscoped process names when no calculated lots are supplied', async () => {
    const repository = new TaYieldStagingRepository({ machineRowTable: 'dbo.MachineEvents' });
    repository.getPool = vi.fn(() => { throw new Error('Must not query'); });
    await expect(repository.getMachineProcesses(dates, { lotNumbers: [] })).resolves.toEqual([]);
    await expect(repository.getMachineProcesses(dates)).resolves.toEqual([]);
    expect(repository.getPool).not.toHaveBeenCalled();
  });

  it('uses the scoped SQL catalog instead of transferring every machine event to the API', async () => {
    const getMachineProcesses = vi.fn(async () => ['Pressing', 'Molding']);
    const getMachineEvents = vi.fn(() => { throw new Error('Large event list must not be loaded for the dropdown'); });
    const app = createApp({
      environment: { SQL_SERVER: 'fixture', SQL_DATABASE: 'fixture' },
      taYieldStagingRepository: {
        getWorkbookRows: async () => [{ lotNo: 'ELIGIBLE', line: 'FPS', itemName: 'PN', tapingDate: '2026-10-08', categories: { Input: 100, Good: 100 } }],
        getMachineProcesses, getMachineEvents
      }
    });
    const response = await request(app).get('/api/ta-yield-machine-processes').query({ dataset: 'ta-yield', ...dates, serie: 'FPS', pn: 'PN' });
    expect(response.status).toBe(200);
    expect(response.body.data.processes).toEqual(['Molding', 'Pressing']);
    expect(getMachineProcesses).toHaveBeenCalledWith(expect.objectContaining({ ...dates, serie: 'FPS', pn: 'PN' }), { lotNumbers: ['ELIGIBLE'] });
    expect(getMachineEvents).not.toHaveBeenCalled();
  });
});
