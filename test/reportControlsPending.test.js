import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('Report controls pending state', () => {
  it('provides one date-range picker that supports presets and a same-day selection', () => {
    const html = read('public/index.html');
    const app = read('public/app.js');

    expect(html).toContain('id="reportDateRangeTrigger"');
    expect(html).toContain('id="reportDateRangePopover"');
    expect(html).toContain('data-date-range-preset="month-to-date"');
    expect(html).toContain('class="serie-field" hidden aria-hidden="true"');
    expect(read('public/styles.css')).toContain('.filter-toolbar .serie-field { display: none !important; }');
    expect(app).toContain('function setReportDateRange(');
    expect(app).toContain('function renderReportDateRangeCalendar(');
    expect(app).toContain('function applyReportDateRangePreset(');
    expect(app).toContain('function positionReportDateRangePicker(');
    expect(app).toContain('function scheduleReportDateRangeClose(');
    expect(app).toContain('function previewReportDateRange(');
    expect(app).toContain('const reportDateRangeAnimationDurationMs = 180;');
    expect(app).toContain("addEventListener('pointerover', (event) => { const date = event.target.closest('[data-date-range-date]')");
    expect(app).toContain("button.setAttribute('aria-current', 'date')");
    expect(app).toContain("byId('reportDateRangePopover').addEventListener('click', (event) => { event.stopPropagation();");
    expect(app).toContain("window.addEventListener('resize', () => { if (!byId('reportDateRangePopover').hidden) positionReportDateRangePicker(); });");
  });

  it('calculates inclusive preset ranges for the custom picker', () => {
    const app = read('public/app.js');
    const start = app.indexOf('function reportDateFromValue(');
    const end = app.indexOf('async function latestTaYieldStagingDate', start);
    const dateRangeHelpers = new Function(`${app.slice(start, end)}\nreturn { formatDateRange, reportDateRangeForPreset };`)();

    expect(dateRangeHelpers.reportDateRangeForPreset('last-7-days', '2026-09-21')).toEqual({ startDate: '2026-09-15', endDate: '2026-09-21' });
    expect(dateRangeHelpers.reportDateRangeForPreset('month-to-date', '2026-09-21')).toEqual({ startDate: '2026-09-01', endDate: '2026-09-21' });
    expect(dateRangeHelpers.reportDateRangeForPreset('year-to-date', '2026-09-21')).toEqual({ startDate: '2026-01-01', endDate: '2026-09-21' });
    expect(dateRangeHelpers.formatDateRange('2026-09-21', '2026-09-21')).toContain('Sep 21, 2026');
  });

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
