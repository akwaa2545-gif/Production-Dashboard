import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadWipStagingRows } from '../src/stagingWipRefresh.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

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
      getChartData: ({ product }, daily, includePartNumber) => {
        expect(daily).toBe(true);
        expect(includePartNumber).toBe(true);
        return delayed(`process:${product}`, { bucketDate: '2026-09-01', chartName: 'Process', seriesName: product, partNumber: `${product}-PN`, quantityMoved: 1 });
      }
    };

    await expect(loadWipStagingRows(source, { startDate: '2026-09-01', endDate: '2026-09-01' })).resolves.toEqual({
      rows: [
        { bucketDate: '2026-09-01', itemName: 'NEO', quantityMoved: 1, product: 'NEO' },
        { bucketDate: '2026-09-01', itemName: 'SC', quantityMoved: 1, product: 'SC' }
      ],
      processRows: [
        { bucketDate: '2026-09-01', chartName: 'Process', seriesName: 'NEO', partNumber: 'NEO-PN', quantityMoved: 1, product: 'NEO' },
        { bucketDate: '2026-09-01', chartName: 'Process', seriesName: 'SC', partNumber: 'SC-PN', quantityMoved: 1, product: 'SC' }
      ]
    });
    expect(calls).toEqual(['quantity:NEO', 'process:NEO', 'quantity:SC', 'process:SC']);
    expect(maximumInFlight).toBe(1);
  });

  it('adds and populates a nullable PartNumber column only in process staging', () => {
    const refresh = read('src/stagingWipRefresh.js');
    const repository = read('src/stagingWipRepository.js');
    const migration = read('scripts/migrate-wip-process-part-number.mjs');
    const packageJson = JSON.parse(read('package.json'));

    expect(refresh).toContain("COL_LENGTH('${targetConfig.processTable}', 'PartNumber')");
    expect(refresh).toContain("['ReportingDate', 'Product', 'OperationName', 'Serie', 'PartNumber', 'QuantityMoved']");
    expect(refresh).toContain("String(row.partNumber || '').trim() || null");
    expect(repository).not.toContain('PartNumber');
    expect(migration).toContain("ADD PartNumber nvarchar(4000) NULL");
    expect(packageJson.scripts['migrate:wip-process-part-number']).toBe('node scripts/migrate-wip-process-part-number.mjs');
  });
});
