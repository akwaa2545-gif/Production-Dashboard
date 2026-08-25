import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('Data source control', () => {
  it('groups dashboards clearly and uses the enhanced selector treatment', () => {
    const html = read('public/index.html');
    const styles = read('public/styles.css');

    expect(html).toContain('<span class="source-control-label">Data source</span>');
    expect(html).toContain('<optgroup label="Production reports">');
    expect(html).toContain('<optgroup label="Yield analysis">');
    expect(styles).toContain('.source-control{position:relative;gap:5px;padding:9px 10px');
    expect(styles).toContain('.source-control::after');
    expect(styles).toContain('.source-control select optgroup{background:#28358c;color:#fff');
    expect(styles).toContain('.source-control select option:checked{background:#4c5bb5;color:#fff');
  });

  it('limits 901 zero-value rows to the selected series', () => {
    const app = read('public/app.js');

    expect(app).toContain("const selectedSerieNames = selectedSeries();");
    expect(app).toContain("selectedSerieNames.length ? selectedSerieNames : [...byId('serie').options].map((option) => option.value).filter(Boolean)");
  });
});
