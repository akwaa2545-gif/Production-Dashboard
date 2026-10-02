import { describe, expect, it } from 'vitest';
import { mapTaDailyOutput } from '../src/dailyOutput.js';

describe('TA daily output totals', () => {
  it('sums all selected output quantities and counts distinct trimmed JobName codes', () => {
    const summary = [{ line: 'FPS', finalGood: 1200000 }, { line: 'FPS', finalGood: 1205110 }];
    const lots = [{ line: 'FPS', lotNo: '6K01N00052' }, { line: 'FPS', lotNo: ' 6K01N00052 ' }, { line: 'FPS', lotNo: '6K01N00053' }, { line: 'FPS', lotNo: '' }];
    expect(mapTaDailyOutput(summary, lots)).toEqual([
      { itemName: 'FPS', quantityMoved: 2405110, lotCount: 2, jobNames: ['6K01N00052', '6K01N00053'] }
    ]);
  });

  it('preserves summary output quantities even when lot data has different quantity fields', () => {
    expect(mapTaDailyOutput([{ line: 'PSL', finalGood: 2500 }], [{ line: 'PSL', lotNo: '6K01N00052', finalGoodQ: 9999, categories: { Good: 1000 } }]))
      .toEqual([{ itemName: 'PSL', quantityMoved: 2500, lotCount: 1, jobNames: ['6K01N00052'] }]);
  });

  it('returns zero lots for an empty result and does not count unrelated series', () => {
    expect(mapTaDailyOutput([], [])).toEqual([]);
    expect(mapTaDailyOutput([{ line: 'FPS', finalGood: 0 }], [{ line: 'PSL', lotNo: '6K01N00052' }]))
      .toEqual([{ itemName: 'FPS', quantityMoved: 0, lotCount: 0, jobNames: [] }]);
  });
});
