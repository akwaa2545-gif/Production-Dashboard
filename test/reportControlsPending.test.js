import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('Report controls pending state', () => {
  it('notifies users when selected report filters have not been applied', () => {
    const html = read('public/index.html');
    const app = read('public/app.js');
    const styles = read('public/styles.css');

    expect(html).toContain('id="reportPendingNotice"');
    expect(html).toContain('Filters changed. Click Apply to update the report.');
    expect(app).toContain('function reportControlSnapshot()');
    expect(app).toContain('function updateReportPendingNotice()');
    expect(app).toContain('function markReportControlsApplied()');
    expect(app).toContain("byId('reportControls').addEventListener('change', updateReportPendingNotice)");
    expect(styles).toContain('.report-pending-notice');
  });

  it('shows pending state for changed controls and clears it after they are applied', () => {
    const app = read('public/app.js');
    const start = app.indexOf("let appliedReportControlSnapshot =");
    const end = app.indexOf("let mtdChartStyle", start);
    const createPendingState = new Function(
      'byId',
      'selectedDataset',
      'selectedSeries',
      'selectedPartNumbers',
      `${app.slice(start, end)}\nreturn { markReportControlsApplied, updateReportPendingNotice };`,
    );
    const activeClasses = new Set();
    const elements = {
      apply: { classList: { toggle: (name, active) => active ? activeClasses.add(name) : activeClasses.delete(name) } },
      reportPendingNotice: { hidden: true },
      product: { value: 'NEO' },
      startDate: { value: '2026-08-01' },
      endDate: { value: '2026-08-31' },
      process: { value: 'Paint' },
      case: { value: 'all' },
    };
    let series = ['A'];
    let partNumbers = ['PN-100'];
    const pendingState = createPendingState(
      (id) => elements[id],
      () => 'closed',
      () => series,
      () => partNumbers,
    );

    pendingState.markReportControlsApplied();
    expect(elements.reportPendingNotice.hidden).toBe(true);
    expect(activeClasses.has('has-pending-changes')).toBe(false);

    elements.startDate.value = '2026-08-02';
    pendingState.updateReportPendingNotice();
    expect(elements.reportPendingNotice.hidden).toBe(false);
    expect(activeClasses.has('has-pending-changes')).toBe(true);

    pendingState.markReportControlsApplied();
    series = ['B'];
    pendingState.updateReportPendingNotice();
    expect(elements.reportPendingNotice.hidden).toBe(false);

    pendingState.markReportControlsApplied();
    partNumbers = ['PN-200'];
    pendingState.updateReportPendingNotice();
    expect(elements.reportPendingNotice.hidden).toBe(false);

    pendingState.markReportControlsApplied();
    expect(elements.reportPendingNotice.hidden).toBe(true);
    expect(activeClasses.has('has-pending-changes')).toBe(false);
  });
});
