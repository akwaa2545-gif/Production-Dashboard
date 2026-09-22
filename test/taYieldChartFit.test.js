import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('TA yield trend sizing', () => {
  it('fits short weekly and monthly series to their chart panel', () => {
    const app = read('public/app.js');
    const styles = read('public/styles.css');

    expect(app).toContain("const taYieldFitsPanel = taYieldInterval !== 'day' && buckets.length <= 12;");
    expect(app).toContain("taYieldFitsPanel ? ' ta-yield-fit-panel' : ''");
    expect(styles).toContain('.ta-yield-tendency-panel .sc-yield-chart-scroll.ta-yield-fit-panel svg');
    expect(styles).toContain('height:auto !important');
  });
});
