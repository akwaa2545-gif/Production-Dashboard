import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chdir } from 'node:process';
import { describe, expect, it } from 'vitest';
import { loadTaYieldMapping, mapTaYieldLotDetails, mapTaYieldRows } from '../src/taYieldMapping.js';

const mapping = new Map([
  ['0301_Sample_CV', { main: 'Inprocess Upstream' }],
  ['1815_ESR_Def', { main: 'ESR' }],
  ['1816_ESR_Def2', { main: 'ESR' }]
]);

describe('mapTaYieldRows', () => {
  it('keeps raw TA series in table rows so charts can group them independently', () => {
    const rows = mapTaYieldRows([
      { line: 'PS A08', lotNo: '4H03N03840', closeDate: '2026-07-02', jobType: 'Standard', inputQ: 100, finalGoodQ: 98, dispositionCode: '1815_ESR_Def', quantity: 2 },
      { line: 'FP A2', lotNo: '4H03N03841', closeDate: '2026-07-02', jobType: 'Standard', inputQ: 100, finalGoodQ: 97, dispositionCode: '1815_ESR_Def', quantity: 3 },
      { line: 'GPS P2', lotNo: '4H03N03842', closeDate: '2026-07-02', jobType: 'Standard', inputQ: 100, finalGoodQ: 96, dispositionCode: '1815_ESR_Def', quantity: 4 }
    ], new Map([['1815_ESR_Def', { main: 'ESR' }]]));

    expect(rows.map((row) => row.line)).toEqual(['FP A2', 'GPS P2', 'PS A08']);
  });
  it('reads the MES disposition-code columns and defect graph groups from the supplied TA workbook', async () => {
    const maps = await loadTaYieldMapping('TA/Direction and guidance for TA Yield report.xlsx');
    expect(maps.neo.get('0301_Sample_CV')).toEqual({ main: 'Inproc Up', category: 'Inproc Up' });
    expect(maps.gps.get('0301_Sample_CV')).toEqual({ main: 'Inproc Up', category: 'Inproc Up' });
  });

  it('resolves the TA workbook relative to the project root even when the working directory changes', async () => {
    const previousCwd = process.cwd();
    const tempDir = path.join(os.tmpdir(), `ta-yield-workbook-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    chdir(tempDir);

    try {
      const maps = await loadTaYieldMapping('TA/Direction and guidance for TA Yield report.xlsx');
      expect(maps.neo.get('0301_Sample_CV')).toEqual({ main: 'Inproc Up', category: 'Inproc Up' });
    } finally {
      chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('deduplicates lot input and final good, deducts input modes, and groups mapped defects', () => {
    const [row] = mapTaYieldRows([
      { line: 'Ta NEO Capacitor FPS series B3 case', lotNo: '4H03N03842', closeDate: '2026-07-02', occuredOn: '2026-07-03', jobType: 'Standard', inputQ: 1000, finalGoodQ: 900, dispositionCode: '0201_Inp_Pellet_Assy', quantity: 100 },
      { line: 'Ta NEO Capacitor FPS series B3 case', lotNo: '4H03N03842', closeDate: '2026-07-02', occuredOn: '2026-07-03', jobType: 'Standard', inputQ: 1000, finalGoodQ: 900, dispositionCode: '0301_Sample_CV', quantity: 20 },
      { line: 'Ta NEO Capacitor FPS series B3 case', lotNo: '4H03N03842', closeDate: '2026-07-02', occuredOn: '2026-07-03', jobType: 'Standard', inputQ: 1000, finalGoodQ: 900, dispositionCode: '1815_ESR_Def', quantity: 10 }
    ], mapping);

    expect(row).toMatchObject({ month: '2026-07', line: 'Ta NEO Capacitor FPS series B3 case', input: 900, finalGood: 900, yield: 100 });
    expect(row.groups).toEqual([{ group: 'ESR', quantity: 10, rate: 10 / 900 * 100 }, { group: 'Inprocess Upstream', quantity: 20, rate: 20 / 900 * 100 }]);
  });

  it('deducts X01 and applies the confirmed Other balancing adjustment', () => {
    const [row] = mapTaYieldRows([
      { line: 'FPS', lotNo: '4H03N03850', closeDate: '2026-07-02', occuredOn: '2026-07-03', jobType: 'Standard', inputQ: 2000, finalGoodQ: 900, dispositionCode: '0201_Inp_Pellet_Assy', quantity: 50 },
      { line: 'FPS', lotNo: '4H03N03850', closeDate: '2026-07-02', occuredOn: '2026-07-03', jobType: 'Standard', inputQ: 2000, finalGoodQ: 900, dispositionCode: 'X01_Machine_Sample', quantity: 50 },
      { line: 'FPS', lotNo: '4H03N03850', closeDate: '2026-07-02', occuredOn: '2026-07-03', jobType: 'Standard', inputQ: 2000, finalGoodQ: 900, dispositionCode: '0301_Sample_CV', quantity: 100 }
    ], mapping);
    expect(row).toMatchObject({ input: 1000, finalGood: 900, yield: 90, defect: 100 });
  });

  it('normalizes source disposition codes before matching the workbook map', () => {
    const [row] = mapTaYieldRows([
      { line: 'FPS', lotNo: '4H03N03851', closeDate: '2026-07-02', occuredOn: '2026-07-03', jobType: 'Standard', inputQ: 1000, finalGoodQ: 400, dispositionCode: '1704_CO_SH1 ', quantity: 600 }
    ], new Map([['1704_CO_SH1', { main: 'CO' }]]));

    expect(row).toMatchObject({ input: 1000, finalGood: 400, defect: 600, yield: 40 });
    expect(row.groups).toEqual([{ group: 'CO', quantity: 600, rate: 60 }]);
  });

  it('includes configured zero-quantity graph categories for the TA chart and summary table', () => {
    const [row] = mapTaYieldRows([
      { line: 'FPS', lotNo: '4H03N03849', closeDate: '2026-07-02', occuredOn: '2026-07-03', jobType: 'Standard', inputQ: 100, finalGoodQ: 90, dispositionCode: '1704_CO_SH1', quantity: 10 }
    ], new Map([
      ['1704_CO_SH1', { main: 'CO' }],
      ['1815_ESR_Def', { main: 'ESR' }]
    ]));

    expect(row.groups).toEqual([
      { group: 'CO', quantity: 10, rate: 10 },
      { group: 'ESR', quantity: 0, rate: 0 }
    ]);
    expect(row.defect).toBe(10);
  });

  it('includes normal 1812_SH_PLS ACC quantity in the ACC defect group and yield', () => {
    const [row] = mapTaYieldRows([
      { line: 'FPS', lotNo: '4H03N03850', closeDate: '2026-07-02', occuredOn: '2026-07-03', jobType: 'Standard', inputQ: 100, finalGoodQ: 90, dispositionCode: '1812_SH_PLS', quantity: 5 }
    ], new Map([['1812_SH_PLS', { main: '', category: 'ACC' }]]));

    expect(row.groups).toEqual([{ group: 'ACC', quantity: 5, rate: 5 }]);
    expect(row.defect).toBe(5);
    expect(row.yield).toBe(90);
  });

  it('excludes NON-STANDARD, invalid lot dates, and yield at or below 30 percent', () => {
    const rows = mapTaYieldRows([
      { line: 'FPS', lotNo: '4H03N03842', closeDate: '2026-07-02', occuredOn: '2026-07-03', jobType: 'NON-STANDARD', inputQ: 100, finalGoodQ: 90, dispositionCode: '0301_Sample_CV', quantity: 1 },
      { line: 'FPS', lotNo: '4H04N03842', closeDate: '2026-07-02', occuredOn: '2026-07-03', jobType: 'E', inputQ: 100, finalGoodQ: 90, dispositionCode: '0301_Sample_CV', quantity: 1 },
      { line: 'FPS', lotNo: '4H32N03842', closeDate: '2026-07-02', occuredOn: '2026-07-03', jobType: 'Standard', inputQ: 100, finalGoodQ: 90, dispositionCode: '0301_Sample_CV', quantity: 1 },
      { line: 'FPS', lotNo: '4H03N03843', closeDate: '2026-07-02', occuredOn: '2026-07-03', jobType: 'Standard', inputQ: 100, finalGoodQ: 30, dispositionCode: '0301_Sample_CV', quantity: 1 }
    ], mapping);
    expect(rows).toEqual([]);
  });

  it('uses the MES CloseDate lot period for input, final good, and GPS defect mapping', () => {
    const rows = mapTaYieldRows([
      { line: 'Ta NEO Capacitor GPS series P2 case', lotNo: '4H03N03844', closeDate: '2026-06-30', occuredOn: '2026-07-02', jobType: 'Standard', inputQ: 100, finalGoodQ: 90, dispositionCode: '1815_ESR_Def', quantity: 10 }
    ], { neo: new Map(), gps: new Map([['1815_ESR_Def', { main: 'ESR' }]]) });
    expect(rows).toEqual([expect.objectContaining({ month: '2026-06', input: 100, finalGood: 90, defect: 10 })]);
  });

  it('groups TA weekly tendency by the ISO week of the MES CloseDate', () => {
    const rows = mapTaYieldRows([
      { line: 'FPS', lotNo: '4H03N03846', closeDate: '2026-07-05', occuredOn: '2026-07-06', jobType: 'Standard', inputQ: 100, finalGoodQ: 90, dispositionCode: '1815_ESR_Def', quantity: 10 },
      { line: 'FPS', lotNo: '4H03N03847', closeDate: '2026-07-06', occuredOn: '2026-07-07', jobType: 'Standard', inputQ: 100, finalGoodQ: 80, dispositionCode: '1815_ESR_Def', quantity: 20 }
    ], new Map([['1815_ESR_Def', { main: 'ESR' }]]), 'week');

    expect(rows).toEqual([
      expect.objectContaining({ month: '2026-W27', input: 100, finalGood: 90, defect: 10, yield: 90 }),
      expect.objectContaining({ month: '2026-W28', input: 100, finalGood: 80, defect: 20, yield: 80 })
    ]);
  });

  it('groups the chart data by the MES CloseDate when the day interval is selected', () => {
    const rows = mapTaYieldRows([
      { line: 'FPS', lotNo: '4H03N03846', closeDate: '2026-07-05', occuredOn: '2026-07-06', jobType: 'Standard', inputQ: 100, finalGoodQ: 90, dispositionCode: '1815_ESR_Def', quantity: 10 }
    ], new Map([['1815_ESR_Def', { main: 'ESR' }]]), 'day');

    expect(rows).toEqual([expect.objectContaining({ month: '2026-07-05', input: 100, finalGood: 90, defect: 10, yield: 90 })]);
  });

  it('uses the Thailand calendar day and ISO week for UTC CloseDate values after local midnight', () => {
    const source = { line: 'FPS', lotNo: '4H03N03848', closeDate: new Date('2026-07-05T18:30:00.000Z'), occuredOn: '2026-07-06', jobType: 'Standard', inputQ: 100, finalGoodQ: 90, dispositionCode: '1815_ESR_Def', quantity: 10 };
    const mapping = new Map([['1815_ESR_Def', { main: 'ESR' }]]);

    expect(mapTaYieldRows([source], mapping, 'day')[0]).toEqual(expect.objectContaining({ month: '2026-07-06' }));
    expect(mapTaYieldRows([source], mapping, 'week')[0]).toEqual(expect.objectContaining({ month: '2026-W28' }));
  });

  it('uses the Thailand calendar month and close-date label for UTC values after local midnight', () => {
    const source = { line: 'FPS', lotNo: '4H03N03849', closeDate: new Date('2026-06-30T18:30:00.000Z'), occuredOn: '2026-07-01', jobType: 'Standard', inputQ: 100, finalGoodQ: 90, dispositionCode: '1815_ESR_Def', quantity: 10 };
    const mapping = new Map([['1815_ESR_Def', { main: 'ESR' }]]);

    expect(mapTaYieldRows([source], mapping)[0]).toEqual(expect.objectContaining({ month: '2026-07' }));
    expect(mapTaYieldLotDetails([source], mapping)[0]).toEqual(expect.objectContaining({ closeDate: '2026-07-01' }));
  });

  it('uses the ISO week-year at a calendar-year boundary', () => {
    const rows = mapTaYieldRows([
      { line: 'FPS', lotNo: '4H03N03846', closeDate: '2027-01-01', occuredOn: '2027-01-01', jobType: 'Standard', inputQ: 100, finalGoodQ: 90, dispositionCode: '1815_ESR_Def', quantity: 10 }
    ], new Map([['1815_ESR_Def', { main: 'ESR' }]]), 'week');

    expect(rows[0]).toEqual(expect.objectContaining({ month: '2026-W53', input: 100, finalGood: 90, defect: 10, yield: 90 }));
  });

  it('provides an Excel-style eligible lot detail row', () => {
    const [detail] = mapTaYieldLotDetails([
      { line: 'FPS', lotNo: '4H03N03844', closeDate: '2026-07-02', occuredOn: '2026-07-03', jobType: 'Standard', inputQ: 1000, finalGoodQ: 900, dispositionCode: '0201_Inp_Pellet_Assy', quantity: 100 },
      { line: 'FPS', lotNo: '4H03N03844', closeDate: '2026-07-02', occuredOn: '2026-07-03', jobType: 'Standard', inputQ: 0, finalGoodQ: 0, dispositionCode: '1815_ESR_Def', quantity: 10 },
      { line: 'FPS', lotNo: '4H03N03844', closeDate: '2026-07-02', occuredOn: '2026-07-03', jobType: 'Standard', inputQ: 0, finalGoodQ: 0, dispositionCode: '1816_ESR_Def2', quantity: 5 }
    ], mapping);
    expect(detail).toMatchObject({ series: 'FPS', lotNo: '4H03N03844', closeDate: '2026-07-02', input: 900, finalGood: 900, defect: 15, yield: 100 });
    expect(detail.groups).toEqual([{ group: 'ESR', quantity: 15 }]);
  });

  it('marks 1812_SH_PLS with acc_volt zero as SH and keeps the missing-PartType SH fallback visible in TA evidence', () => {
    const [detail] = mapTaYieldLotDetails([
      { line: 'FPS', lotNo: '4H03N03845', closeDate: '2026-07-02', occuredOn: '2026-07-03', jobType: 'Standard', inputQ: 1000, finalGoodQ: 900, dispositionCode: '1812_SH_PLS', quantity: 2 },
      { line: 'FPS', lotNo: '4H03N03845', closeDate: '2026-07-02', occuredOn: '2026-07-03', jobType: 'Standard', inputQ: 0, finalGoodQ: 0, dispositionCode: '1812_SH_PLS::SH_ACC_VOLT_ZERO', quantity: 4 },
      { line: 'FPS', lotNo: '4H03N03845', closeDate: '2026-07-02', occuredOn: '2026-07-03', jobType: 'Standard', inputQ: 0, finalGoodQ: 0, dispositionCode: '1812_SH_PLS::SH_FALLBACK', quantity: 3 }
    ], new Map([['1812_SH_PLS', { main: '', category: 'ACC' }]]));

    expect(detail.modes).toEqual(expect.arrayContaining([
      expect.objectContaining({ mode: '1812_SH_PLS', category: 'ACC', quantity: 2, shFallback: false, accParameterMatch: true }),
      expect.objectContaining({ mode: '1812_SH_PLS', category: 'SH', quantity: 4, shAccVoltZero: true, shFallback: false, accParameterMatch: false }),
      expect.objectContaining({ mode: '1812_SH_PLS', category: 'SH', quantity: 3, shFallback: true })
    ]));
    expect(detail.groups).toEqual([{ group: 'ACC', quantity: 2 }, { group: 'SH', quantity: 7 }]);
    expect(detail.defect).toBe(9);
  });
});
