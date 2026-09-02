import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('MTD target product selector', () => {
  it('offers TA for 901 target parameters', () => {
    expect(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')).toContain('<option value="TA">TA</option>');
  });
});
