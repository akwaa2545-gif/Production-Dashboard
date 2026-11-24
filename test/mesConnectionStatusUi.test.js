import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
describe('MES status in Staging status', () => {
  function markup(status) {
    const start = source.indexOf('function mesConnectionMarkup(');
    const end = source.indexOf('async function renderMesConnectionStatus(', start);
    expect(start).toBeGreaterThan(-1);
    const context = vm.createContext({ escapeHtml: value => String(value).replaceAll('<', '&lt;') });
    vm.runInContext(source.slice(start, end), context);
    return context.mesConnectionMarkup(status);
  }
  it.each([
    ['CONNECTED', 'Connected'], ['AUTH_REQUIRED', 'Sign-in required'],
    ['RECONNECTING', 'Reconnecting'], ['SIGNING_IN', 'Signing in'],
    ['UNAVAILABLE', 'Connection unavailable'], ['NOT_CONFIGURED', 'Not configured']
  ])('shows %s without exposing account metadata', (state, text) => {
    const html = markup({ state, username: 'private-user', token: 'DUMMY' });
    expect(html).toContain(text);
    expect(html).not.toMatch(/private-user|DUMMY/);
    expect(html).toContain('mesConnectionControls');
  });
  it('explains automatic retries and where a required login completes', () => {
    expect(markup({ state: 'AUTH_REQUIRED' })).toContain('server computer');
    expect(markup({ state: 'UNAVAILABLE' })).toContain('automatically');
  });
});
