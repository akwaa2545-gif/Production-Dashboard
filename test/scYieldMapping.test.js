import { describe, expect, it } from 'vitest';
import { loadScYieldMapping, loadScYieldSourceModes, mapScYieldRows } from '../src/scYieldMapping.js';

describe('mapScYieldRows', () => {
  it('exposes every SC source mode in the reference workbook, including modes excluded from calculation', async () => {
    const modes = await loadScYieldSourceModes('SC/Yield Calculation SC.xlsx');

    expect(modes).toHaveLength(192);
    expect(modes).toContain('1111_Element NG');
    expect(modes).toContain('3611_ESR NG');
  });

  it('keeps 2411_Marking NG included but outside the Assembly column', async () => {
    const mapping = await loadScYieldMapping('SC/Yield Calculation SC.xlsx');

    expect(mapping.get('2411')).toMatchObject({
      included: true,
      group: 'Other'
    });
  });

  it('keeps every Calculate Yield = Y Excel mode at zero when SCRAP has no matching disposition row', () => {
    const mapping = new Map([
      ['1212', { mode: '1212_Element Expose', included: true, group: 'Assembly' }],
      ['1221', { mode: '1221_Incomplete molding', included: true, group: 'Assembly' }],
      ['1111', { mode: '1111_Element NG', included: false, group: 'Other' }]
    ]);

    const [row] = mapScYieldRows({
      inputs: [{ bucketMonth: '2026-07', line: 'FM', quantity: 100 }],
      defects: [{ bucketMonth: '2026-07', line: 'FM', dispositionCode: '1212', quantity: 2 }]
    }, mapping);

    expect(row).toMatchObject({ input: 100, defect: 2, yield: 98 });
    expect(row.modes).toEqual([
      { mode: '1212_Element Expose', group: 'Assembly', quantity: 2, rate: 2 },
      { mode: '1221_Incomplete molding', group: 'Assembly', quantity: 0, rate: 0 }
    ]);
  });

  it('keeps defect-only rows auditable when no input quantity exists', () => {
    const mapping = new Map([['1212', { mode: '1212_Element Expose', included: true, group: 'Assembly' }]]);
    const [row] = mapScYieldRows({ inputs: [], defects: [{ bucketMonth: '2026-07', line: 'FM', dispositionCode: '1212', quantity: 2 }] }, mapping);

    expect(row).toMatchObject({ input: 0, defect: 2, yield: undefined });
    expect(row.modes[0]).toMatchObject({ quantity: 2, rate: undefined });
  });

});
