import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('SC input ratio disclosure', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

  it('starts hidden behind an accessible switch', () => {
    expect(app).toContain('let scYieldInputRatioVisible = false');
    expect(app).toContain('id="scYieldInputRatioToggle"');
    expect(app).toContain('aria-label="Input Ratio of Super Capacitor"');
    expect(app).toContain('aria-controls="scYieldInputRatioSection"');
    expect(app).toContain('aria-checked="false"');
    expect(app).toContain("section.id = 'scYieldInputRatioSection'");
    expect(styles).toContain('#scYieldInputRatioSection[hidden] { display: none; }');
    expect(styles).toContain('.sc-yield-input-ratio-section:not(.is-disclosure-ready) { display: none; }');
  });

  it('synchronizes chart visibility and switch state', () => {
    expect(app).toContain('section.hidden = !scYieldInputRatioVisible');
    expect(app).toContain("toggle.setAttribute('aria-checked', String(scYieldInputRatioVisible))");
    expect(app).toContain("toggle.setAttribute('aria-expanded', String(scYieldInputRatioVisible))");
    expect(app).toContain("toggle.querySelector('.sc-yield-weekly-toggle-state').textContent = scYieldInputRatioVisible ? 'On' : 'Off'");
    expect(app).toContain('setScYieldInputRatioVisibility(!scYieldInputRatioVisible)');
    expect(app).toContain("column.className = 'sc-yield-input-ratio-column'");
    expect(app).toContain('column.append(section)');
    expect(styles).toContain('.sc-yield-input-ratio-column { display: grid; grid-column: 1 / -1;');
    expect(styles).toContain('.sc-yield-input-ratio-disclosure { width: 100%; margin: 0; justify-content: flex-end;');
  });
});
