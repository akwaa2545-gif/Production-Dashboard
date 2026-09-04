import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

describe('SC Yield corrective action tracker', () => {
  it('uses separate SC action state, UI IDs, and API endpoints', () => {
    expect(app).toContain("let latestScYieldActions = []");
    expect(app).toContain("request('/api/sc-yield-actions').catch(() => [])");
    expect(app).toContain('function ensureScYieldActionsView()');
    expect(app).toContain('<h3>SC Yield actions</h3>');
    expect(app).toContain('data-edit-sc-action');
    expect(app).toContain('function saveScYieldAction(event)');
    expect(app).toContain('/api/sc-yield-actions/${id}');
    expect(app).not.toContain("latestScYieldActions = await request('/api/ta-yield-actions')");
  });
});
