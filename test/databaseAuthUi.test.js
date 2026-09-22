import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const response = (status, payload) => ({ status, ok: status < 400, headers: { get: () => null }, json: async () => payload });
const denied = () => response(401, { success: false, code: 'AUTH_REQUIRED', error: 'Sign-in required.' });
const success = () => response(200, { success: true, data: ['MES'] });
function deferred() { let resolve; const promise = new Promise((finish) => { resolve = finish; }); return { promise, resolve }; }
function harness(fetch) {
  const elements = new Map();
  const status = { after: (element) => elements.set(element.id, element) };
  elements.set('status', status);
  for (const [id, value] of Object.entries({ process: 'Taping', case: 'All', product: 'NEO', startDate: '2026-09-19', endDate: '2026-09-20' })) elements.set(id, { value });
  const context = vm.createContext({
    fetch, URLSearchParams, Date, clientResponseCache: new Map(), clientCacheLimit: 20,
    stagingWipCompletedAt: undefined, isWipCacheRequest: () => true,
    readApiPayload: (value) => value.json(), selectedDataset: () => 'closed',
    setStatus: vi.fn(), loadData: vi.fn().mockResolvedValue(), initialize: vi.fn().mockResolvedValue(),
    selectedSeries: () => ['TA'], selectedPartNumbers: () => ['PART-1'], populateOptions: vi.fn(),
    pnState: { requestId: 0, selected: [] }, resetPartNumbers: vi.fn(), renderPartNumberSelection: vi.fn(),
    currentConfig: { dataset: 'closed' }, byId: (id) => elements.get(id),
    document: { createElement: () => ({ addEventListener(name, handler) { this[name] = handler; } }) }
  });
  const authenticationStart = source.indexOf('async function refreshDatabaseAuthentication(');
  if (authenticationStart < source.indexOf('async function request(')) {
    vm.runInContext(source.slice(authenticationStart, source.indexOf('async function readApiPayload', authenticationStart)), context);
  }
  vm.runInContext(source.slice(source.indexOf('async function request('), source.indexOf('async function loadData()')), context);
  return { context, elements };
}

describe('MES authentication recovery in the browser', () => {
  it('shares one sign-in across simultaneous report failures and authenticates the failed dataset', async () => {
    const login = deferred();
    const attempts = new Map();
    const fetch = vi.fn(async (url) => {
      if (url.startsWith('/api/auth/login')) return login.promise;
      const count = attempts.get(url) || 0;
      attempts.set(url, count + 1);
      return count ? success() : denied();
    });
    const { context } = harness(fetch);
    const pending = ['/api/sc-yield?dataset=yield', '/api/sc-yield-weekly?dataset=yield', '/api/quantity?dataset=lot'].map((url) => context.request(url));
    await vi.waitFor(() => expect(fetch.mock.calls.filter(([url]) => url.startsWith('/api/auth/login'))).toHaveLength(1));
    expect(fetch).toHaveBeenCalledWith('/api/auth/login?dataset=yield', expect.objectContaining({ cache: 'no-store' }));
    login.resolve(success());
    await expect(Promise.all(pending)).resolves.toEqual([['MES'], ['MES'], ['MES']]);
  });

  it('reuses a completed sign-in for an old request whose 401 arrives late', async () => {
    const late = deferred();
    let earlyAttempts = 0;
    let lateAttempts = 0;
    const fetch = vi.fn(async (url) => {
      if (url.startsWith('/api/auth/login')) return success();
      if (url.includes('weekly')) return lateAttempts++ ? success() : late.promise;
      return earlyAttempts++ ? success() : denied();
    });
    const { context } = harness(fetch);
    const early = context.request('/api/sc-yield?dataset=yield');
    const pending = context.request('/api/sc-yield-weekly?dataset=yield');
    await early;
    late.resolve(denied());
    await expect(pending).resolves.toEqual(['MES']);
    expect(fetch.mock.calls.filter(([url]) => url.startsWith('/api/auth/login'))).toHaveLength(1);
  });

  it('stops automatic sign-in after failure and exposes an explicit retry that reloads the report', async () => {
    let loginSucceeds = false;
    const fetch = vi.fn(async (url) => url.startsWith('/api/auth/login')
      ? loginSucceeds ? success() : response(503, { success: false, error: 'Sign-in cancelled.' })
      : loginSucceeds ? success() : denied());
    const { context, elements } = harness(fetch);
    await expect(context.request('/api/quantity?dataset=lot')).rejects.toThrow('Sign-in cancelled.');
    await expect(context.request('/api/chart?dataset=lot')).rejects.toThrow(/Sign in to MES/);
    expect(fetch.mock.calls.filter(([url]) => url.startsWith('/api/auth/login'))).toHaveLength(1);
    const button = elements.get('databaseAuthRetry');
    expect(button.textContent).toBe('Sign in to MES');
    expect(button.hidden).toBe(false);
    loginSucceeds = true;
    await button.click();
    expect(context.loadData).toHaveBeenCalledOnce();
    expect(context.populateOptions).toHaveBeenCalledWith(['MES'], { process: 'Taping', serie: ['TA'], case: 'All' });
    expect(context.pnState.selected).toEqual(['PART-1']);
    expect(elements.get('startDate').value).toBe('2026-09-19');
    expect(elements.get('endDate').value).toBe('2026-09-20');
    expect(fetch).toHaveBeenCalledWith('/api/config?dataset=closed', expect.any(Object));
    expect(fetch).toHaveBeenCalledWith('/api/options?dataset=closed&product=NEO', expect.any(Object));
    expect(button.hidden).toBe(true);
    expect(fetch.mock.calls.filter(([url]) => url.startsWith('/api/auth/login'))).toHaveLength(2);
  });

  it('does not reopen sign-in when authentication succeeded but MES still rejects the query', async () => {
    const fetch = vi.fn(async (url) => url.startsWith('/api/auth/login') ? success() : denied());
    const { context, elements } = harness(fetch);
    await expect(context.request('/api/quantity?dataset=lot')).rejects.toThrow();
    await expect(context.request('/api/ta-yield?dataset=ta-yield')).rejects.toThrow(/Sign in to MES/);
    expect(fetch.mock.calls.filter(([url]) => url.startsWith('/api/auth/login'))).toHaveLength(1);
    expect(elements.get('databaseAuthRetry').hidden).toBe(false);
  });

  it('infers the dataset from dedicated routes without using the selected report', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(denied()).mockResolvedValueOnce(success()).mockResolvedValueOnce(success());
    const { context } = harness(fetch);
    await context.request('/api/ta-yield-machine');
    expect(fetch).toHaveBeenCalledWith('/api/auth/login?dataset=ta-yield', expect.any(Object));
  });

  it('reuses recent authentication but permits a new sign-in for a later token expiry', async () => {
    let now = 100000;
    const attempts = new Map();
    const fetch = vi.fn(async (url) => {
      if (url.startsWith('/api/auth/login')) return success();
      const count = attempts.get(url) || 0;
      attempts.set(url, count + 1);
      return count ? success() : denied();
    });
    const { context } = harness(fetch);
    context.Date = { now: () => now };
    await context.request('/api/quantity?dataset=lot');
    now += 1000;
    await context.request('/api/chart?dataset=lot');
    expect(fetch.mock.calls.filter(([url]) => url.startsWith('/api/auth/login'))).toHaveLength(1);
    now += 31000;
    await context.request('/api/ta-yield?dataset=ta-yield');
    expect(fetch.mock.calls.filter(([url]) => url.startsWith('/api/auth/login'))).toHaveLength(2);
  });

  it('retains the retry control after an explicit sign-in fails', async () => {
    const fetch = vi.fn(async (url) => url.startsWith('/api/auth/login')
      ? response(503, { success: false, error: 'Sign-in cancelled.' }) : denied());
    const { context, elements } = harness(fetch);
    await expect(context.request('/api/quantity?dataset=lot')).rejects.toThrow();
    await elements.get('databaseAuthRetry').click();
    expect(elements.get('databaseAuthRetry').hidden).toBe(false);
    expect(elements.get('databaseAuthRetry').disabled).toBe(false);
    expect(context.loadData).not.toHaveBeenCalled();
    expect(context.setStatus).toHaveBeenLastCalledWith('Sign-in cancelled.');
  });

  it('places the retry control outside the hidden report view and refreshes the active secondary view', async () => {
    const fetch = vi.fn(async (url) => url.startsWith('/api/auth/login')
      ? response(503, { success: false, error: 'Sign-in cancelled.' }) : denied());
    const { context, elements } = harness(fetch);
    const before = vi.fn((element) => elements.set(element.id, element));
    elements.set('dashboardView', { before, hidden: true });
    context.document.querySelector = () => ({ dataset: { view: 'ta-yield-machine' } });
    context.showView = vi.fn();
    await expect(context.request('/api/ta-yield-machine')).rejects.toThrow();
    expect(before).toHaveBeenCalledWith(elements.get('databaseAuthRetry'));
    fetch.mockResolvedValue(success());
    await elements.get('databaseAuthRetry').click();
    expect(context.showView).toHaveBeenCalledWith('ta-yield-machine');
  });

  it('discards delayed source reloads when the selected report changes', async () => {
    const config = deferred();
    const fetch = vi.fn(async (url) => url.startsWith('/api/config') ? config.promise : success());
    const { context } = harness(fetch);
    const pending = context.reloadDashboardSourceData();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    context.selectedDataset = () => 'yield';
    context.currentConfig = { dataset: 'yield' };
    config.resolve(response(200, { success: true, data: { dataset: 'closed' } }));
    await pending;
    expect(context.currentConfig.dataset).toBe('yield');
    expect(context.populateOptions).not.toHaveBeenCalled();
    expect(context.loadData).not.toHaveBeenCalled();
  });
});
