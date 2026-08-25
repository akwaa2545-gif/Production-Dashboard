import { describe, expect, it } from 'vitest';
import { readTaYieldCy26Targets } from '../scripts/import-ta-yield-cy26-targets.mjs';

describe('TA Yield CY26 target import', () => {
  it('reads the fixed Total target from row 53 of the CY26 workbook', async () => {
    const targets = await readTaYieldCy26Targets('TA/1. Target yield CY26.xlsx');
    const totalTargets = targets.filter((target) => target.serie === 'Total');

    expect(totalTargets).toHaveLength(12);
    expect(totalTargets[0]).toEqual(expect.objectContaining({ serie: 'Total', period: '2026-01' }));
    expect(totalTargets[0].target).toBeCloseTo(91.76108711630063, 8);
    expect(totalTargets[11]).toEqual(expect.objectContaining({ serie: 'Total', period: '2026-12' }));
    expect(totalTargets[11].target).toBeCloseTo(94.01175828402143, 8);
  });

  it('does not treat formula result cells as series names', async () => {
    const targets = await readTaYieldCy26Targets('TA/1. Target yield CY26.xlsx');
    const series = new Set(targets.map((target) => target.serie));

    expect(series).toContain('FPS A08');
    expect(series).toContain('Total');
    expect(series).not.toContain('[object Object]');
    expect(series).not.toContain('91.76108711630063');
  });
});
