import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('SC weekly yield disclosure', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

  it('starts collapsed and exposes an accessible switch toggle', () => {
    expect(app).toContain('let scYieldWeeklyVisible = false');
    expect(app).toContain('id="scYieldWeeklyToggle"');
    expect(app).toContain('aria-expanded="false"');
    expect(app).toContain('role="switch"');
    expect(app).toContain('aria-label="Weekly yield tendency"');
    expect(app).toContain('aria-checked="false"');
    expect(app).toContain('aria-controls="scYieldWeeklyCharts"');
    expect(app).toContain('class="sc-yield-weekly-toggle-track"');
    expect(app).toContain('class="sc-yield-weekly-toggle-state" aria-hidden="true">Off</span>');
    expect(app).toContain('id="scYieldWeeklyCharts" class="sc-yield-series-section" hidden');
    expect(styles).toContain('#scYieldWeeklyCharts[hidden] { display: none; }');
  });

  it('toggles the weekly section and synchronized switch state', () => {
    expect(app).toContain('holder.hidden = !scYieldWeeklyVisible');
    expect(app).toContain("toggle.setAttribute('aria-expanded', String(scYieldWeeklyVisible))");
    expect(app).toContain("toggle.setAttribute('aria-checked', String(scYieldWeeklyVisible))");
    expect(app).toContain("toggle.querySelector('.sc-yield-weekly-toggle-state').textContent = scYieldWeeklyVisible ? 'On' : 'Off'");
    expect(app).toContain('setScYieldWeeklyVisibility(!scYieldWeeklyVisible)');
    expect(app).toContain('renderScYieldWeeklyCharts(rows, event.currentTarget.id)');
    expect(app).toContain('if (focusTargetId) byId(focusTargetId)?.focus()');
    expect(styles).toContain('outline: 3px solid #28358c');
    expect(styles).toContain('.sc-yield-weekly-toggle[aria-checked="true"] .sc-yield-weekly-toggle-track');
  });
});
