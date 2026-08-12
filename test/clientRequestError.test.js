import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

describe('client API response handling', () => {
  it('reports a non-JSON server response without exposing a JSON parsing error', () => {
    expect(app).toContain('const responseText = await response.text();');
    expect(app).toContain('async function readApiPayload(response, url)');
    expect(app).toContain("readApiPayload(response, '/api/auth/login')");
    expect(app).toContain('The dashboard server returned a non-JSON response');
    expect(app).toContain('Restart the dashboard server and refresh the browser.');
  });
});
