import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

describe('TA Yield actions table', () => {
  it('uses status tabs and a compact scrollable table instead of action cards', () => {
    expect(app).toContain('data-ta-action-filter="IN_PROGRESS"');
    expect(app).toContain('data-ta-action-filter="CLOSED"');
    expect(app).toContain('class="ta-action-table-wrap"');
    expect(app).toContain('<th scope="col">Problem</th><th scope="col">Analysis / action</th><th scope="col">Progress</th>');
    expect(app).not.toContain('class="ta-action-grid"');
  });

  it('merges consecutive action rows that share an action date', () => {
    expect(app).toContain('rowspan="${dateRowCounts[actionDate]}"');
    expect(app).toContain('class="ta-action-date-cell"');
  });

  it('keeps every action column within the available dashboard width', () => {
    expect(styles).toContain('.ta-action-table-wrap{max-height:calc(100vh - 245px);min-height:300px;overflow-y:auto;overflow-x:hidden');
    expect(styles).toContain('.ta-action-table-wrap table{width:100%;table-layout:fixed');
    expect(styles).toContain('overflow-wrap:anywhere');
    expect(app).toContain('data-action-label="Problem"');
    expect(app).toContain('<th scope="col">Problem</th>');
    expect(styles).toContain('@media(max-width:900px)');
    expect(styles).toContain('.ta-action-table-wrap table,.ta-action-table-wrap tbody,.ta-action-table-wrap tr,.ta-action-table-wrap td{display:block}');
    expect(styles).toContain('content:attr(data-action-date)');
    expect(styles).toContain('.ta-action-table-wrap thead{position:absolute;width:1px;height:1px;overflow:hidden');
  });
});
