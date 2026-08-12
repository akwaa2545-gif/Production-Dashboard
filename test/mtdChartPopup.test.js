import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('MTD chart popup', () => {
  it('provides an accessible control and dialog for an enlarged chart', async () => {
    const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

    expect(html).toContain('id="expandMtdChart"');
    expect(html).toContain('aria-label="Expand MTD chart"');
    expect(html).toContain('<svg aria-hidden="true"');
    expect(html).toContain('id="mtdChartModal"');
    expect(html).toContain('aria-modal="true"');
  });
});
