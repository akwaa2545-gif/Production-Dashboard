import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('MTD target product selector', () => {
  it('offers TA for 901 target parameters', () => {
    expect(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')).toContain('<option value="TA">TA</option>');
  });

  it('loads the complete TA MTD series catalogue from code without an options request', () => {
    const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    const loader = source.slice(source.indexOf('async function loadParameterSeries()'), source.indexOf('function ensureScYieldLogView()'));
    const catalogSource = source.match(/const taMtdSeries = Object\.freeze\(\[(.*?)\]\);/)?.[1] || '';
    const catalog = [...catalogSource.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    expect(catalog).toEqual(['FPS', 'FPS A08', 'FPS A2', 'FPS A3', 'FPS B10', 'FPS B2', 'FPS B3', 'FPU A2', 'GPS', 'GPS P2', 'PSG', 'PSG B2', 'PSH B2', 'PSL', 'PSL A', 'PSL B15', 'PSL B2', 'PSL B3', 'PSU B2']);
    expect(new Set(catalog).size).toBe(catalog.length);
    expect(loader).toContain("if (product === 'TA') values = taMtdSeries");
    expect(loader).not.toContain("dataset: 'ta-yield'");
  });

  it('uses TA targets for the 901 NEO reporting context', () => {
    const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

    expect(source).toContain("function mtdTargetProduct(product) { return product === 'NEO' ? 'TA' : product; }");
    expect(source).toContain('readTargetSettings()[mtdTargetProduct(product)]?.[serie]');
  });
});
