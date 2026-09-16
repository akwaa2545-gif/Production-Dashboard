import { describe, expect, it } from 'vitest';
import { loadScYieldMapping, loadScYieldSourceModes, mapScYieldRows, mergeScYieldMapping } from '../src/scYieldMapping.js';

describe('mergeScYieldMapping', () => {
  it('adds saved SC modes using normalized exact and numeric keys without duplicating totals', () => {
    const mapping = mergeScYieldMapping(new Map(), [
      { dataset: 'SC', mode: ' 2615_Cap NG Re ', group: 'CAP', included: true },
      { dataset: 'SC', mode: '2616_LC NG Re', group: 'LC', included: true },
      { dataset: 'TA', mode: '9999_TA only', group: 'CAP', included: true }
    ]);

    expect(mapping.get('2615_CAP NG RE')).toMatchObject({ mode: '2615_Cap NG Re', group: 'CAP', included: true });
    expect(mapping.get('2615')).toEqual(mapping.get('2615_CAP NG RE'));
    expect(mapping.get('9999')).toBeUndefined();
    const [row] = mapScYieldRows({
      inputs: [{ bucketMonth: '2026-08', line: 'CAN', quantity: 772300 }],
      defects: [
        { bucketMonth: '2026-08', line: 'CAN', dispositionCode: '2615_cap ng re', quantity: 75 },
        { bucketMonth: '2026-08', line: 'CAN', dispositionCode: '2616', quantity: 118 }
      ]
    }, mapping);

    expect(row).toMatchObject({ defect: 193, excluded: 0, unmapped: 0 });
    expect(row.modes).toHaveLength(2);
    expect(row.groups).toEqual([
      expect.objectContaining({ group: 'CAP', quantity: 75 }),
      expect.objectContaining({ group: 'LC', quantity: 118 })
    ]);
  });

  it('overrides existing included and excluded modes without changing the workbook mapping or settings', () => {
    const excluded = Object.freeze({ mode: '1111_Element NG', group: 'Other', included: false });
    const included = Object.freeze({ mode: '2511_Cap NG', group: 'CAP', included: true });
    const base = new Map([
      ['1111', excluded], ['1111_ELEMENT NG', excluded],
      ['2511', included], ['2511_CAP NG', included]
    ]);
    const overrides = Object.freeze([
      Object.freeze({ dataset: 'SC', mode: ' 1111_element ng ', group: 'CAP', included: true }),
      Object.freeze({ dataset: 'SC', mode: '2511_Cap NG', group: 'CAP', included: false })
    ]);

    const mapping = mergeScYieldMapping(base, overrides);

    expect(mapping).not.toBe(base);
    expect(base.get('1111')).toEqual(excluded);
    expect(base.get('2511')).toEqual(included);
    expect(mapping.get('1111')).toMatchObject({ mode: '1111_Element NG', group: 'CAP', included: true });
    expect(mapping.get('2511_CAP NG')).toMatchObject({ included: false });
    const [row] = mapScYieldRows({
      inputs: [{ bucketMonth: '2026-08', line: 'FM', quantity: 100 }],
      defects: [
        { bucketMonth: '2026-08', line: 'FM', dispositionCode: '1111', quantity: 3 },
        { bucketMonth: '2026-08', line: 'FM', dispositionCode: '2511', quantity: 2 }
      ]
    }, mapping);
    expect(row).toMatchObject({ defect: 3, excluded: 2, unmapped: 0 });
    expect(row.modes).toHaveLength(1);
  });

  it('preserves base mappings when no SC settings exist', () => {
    const base = new Map([['2511', { mode: '2511_Cap NG', group: 'CAP', included: true }]]);
    expect(mergeScYieldMapping(base, [])).toEqual(base);
    expect(mergeScYieldMapping(new Map(), [])).toEqual(new Map());
  });
});

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
