import { describe, expect, it } from 'vitest';
import { readTaYieldActions, TA_YIELD_ACTION_WORKBOOK } from '../scripts/import-ta-yield-actions.mjs';

describe('TA Yield action import', () => {
  it('reads the supplied TA Yield comments workbook without corrupting rich text', async () => {
    const actions = await readTaYieldActions();
    const august20 = actions.find((action) => action.actionDate === '2026-08-20' && action.serie === 'FPSA08\n(A081C226)');

    expect(TA_YIELD_ACTION_WORKBOOK).toBe('TA/TA yiled comment.xlsx');
    expect(actions).toHaveLength(113);
    expect(august20).toEqual(expect.objectContaining({ dueDate: '2026-08-18' }));
    expect(august20.problem).toContain('CAM3 Dimension');
    expect(august20.analysisAction).not.toContain('[object Object]');
    expect(actions.flatMap(Object.values).join('\n')).not.toContain('[object Object]');
  });

  it('carries each merged date forward to the following action rows', async () => {
    const actions = await readTaYieldActions();
    const secondAugust20Action = actions.find((action) => action.actionDate === '2026-08-20' && action.serie === 'PSGB2\n(B20E337)');

    expect(secondAugust20Action).toEqual(expect.objectContaining({ problem: 'ESR' }));
  });
});
