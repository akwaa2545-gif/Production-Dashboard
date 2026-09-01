import { describe, expect, it } from 'vitest';
import { loadWipStagingRows } from '../src/stagingWipRefresh.js';

describe('loadWipStagingRows', () => {
  it('loads daily and process data sequentially for each product', async () => {
    const calls = []; let inFlight = 0; let maximumInFlight = 0;
    const delayed = async (label, row) => {
      calls.push(label); inFlight += 1; maximumInFlight = Math.max(maximumInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
      return [row];
    };
    const source = {
      getQuantity: ({ product }) => delayed(`quantity:${product}`, { bucketDate: '2026-09-01', itemName: product, quantityMoved: 1 }),
      getChartData: ({ product }) => delayed(`process:${product}`, { bucketDate: '2026-09-01', chartName: 'Process', seriesName: product, quantityMoved: 1 })
    };

    await expect(loadWipStagingRows(source, { startDate: '2026-09-01', endDate: '2026-09-01' })).resolves.toEqual({
      rows: [
        { bucketDate: '2026-09-01', itemName: 'NEO', quantityMoved: 1, product: 'NEO' },
        { bucketDate: '2026-09-01', itemName: 'SC', quantityMoved: 1, product: 'SC' }
      ],
      processRows: [
        { bucketDate: '2026-09-01', chartName: 'Process', seriesName: 'NEO', quantityMoved: 1, product: 'NEO' },
        { bucketDate: '2026-09-01', chartName: 'Process', seriesName: 'SC', quantityMoved: 1, product: 'SC' }
      ]
    });
    expect(calls).toEqual(['quantity:NEO', 'process:NEO', 'quantity:SC', 'process:SC']);
    expect(maximumInFlight).toBe(1);
  });
});
