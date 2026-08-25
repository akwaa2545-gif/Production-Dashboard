import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

describe('TA Yield actions table', () => {
  it('uses status tabs and a compact scrollable table instead of action cards', () => {
    expect(app).toContain('data-ta-action-filter="IN_PROGRESS"');
    expect(app).toContain('data-ta-action-filter="CLOSED"');
    expect(app).toContain('class="ta-action-table-wrap"');
    expect(app).toContain('<th>Problem</th><th>Analysis / action</th><th>Progress</th>');
    expect(app).not.toContain('class="ta-action-grid"');
  });

  it('merges consecutive action rows that share an action date', () => {
    expect(app).toContain('rowspan="${dateRowCounts[actionDate]}"');
    expect(app).toContain('class="ta-action-date-cell"');
  });
});
