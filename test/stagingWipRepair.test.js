import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';

const environment = {
  SQL_SERVER: 'mes', SQL_DATABASE: 'OneMES', DATE_COLUMN: 'OccuredOn',
  STAGING_SQL_SERVER: 'staging', STAGING_SQL_DATABASE: 'ProductionMES',
  STAGING_SQL_USER: 'user', STAGING_SQL_PASSWORD: 'test-password',
  DASHBOARD_WIP_STAGING_ENABLED: 'true',
  DASHBOARD_WIP_REPAIR_TOKEN: 'test-only-wip-repair-token-longer-than-32-characters'
};
const range = { startDate: '2026-09-19', endDate: '2026-09-20' };
const staging = () => ({ getActivity: vi.fn().mockResolvedValue({ lastDataDate: '2026-09-21' }) });
const setup = (overrides = {}) => {
  const operation = vi.fn().mockResolvedValue({ rows: 27, ...range });
  const cache = { invalidate: vi.fn() };
  const app = createApp({ environment, repository: {}, stagingWipRepository: staging(), refreshWipStagingOperation: operation, cache, ...overrides });
  return { app, operation, cache };
};
const repair = (app, body = range) => request(app).post('/api/staging/wip-repair')
  .set('Origin', 'http://localhost:3000')
  .set('Authorization', `Bearer ${environment.DASHBOARD_WIP_REPAIR_TOKEN}`).send(body);

describe('WIP historical staging repair', () => {
  it.each([
    [{}, 'valid startDate'],
    [{ startDate: '2026-02-30', endDate: '2026-03-01' }, 'valid startDate'],
    [{ startDate: '2026-09-20', endDate: '2026-09-19' }, 'on or before'],
    [{ startDate: '2999-01-01', endDate: '2999-01-01' }, 'future date'],
    [{ startDate: '2026-09-01', endDate: '2026-09-08' }, '7 days']
  ])('rejects invalid scope %o before querying MES', async (body, error) => {
    const { app, operation } = setup();
    const response = await repair(app, body);
    expect(response.status).toBe(400);
    expect(response.body.error).toContain(error);
    expect(operation).not.toHaveBeenCalled();
  });

  it('repairs the exact range asynchronously and invalidates only WIP cache on success', async () => {
    let finish;
    const operation = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const { app, cache } = setup({ refreshWipStagingOperation: operation });
    const accepted = await repair(app);
    expect(accepted.status).toBe(202);
    expect(accepted.body.data).toEqual({ status: 'RUNNING', ...range });
    expect(operation).toHaveBeenCalledWith(expect.objectContaining(range));
    expect((await request(app).get('/api/staging-status')).body.pipelines.wip)
      .toMatchObject({ status: 'RUNNING', ...range });
    expect(cache.invalidate).not.toHaveBeenCalled();
    finish({ rows: 27, ...range });
    await vi.waitFor(async () => {
      expect((await request(app).get('/api/staging-status')).body.pipelines.wip)
        .toMatchObject({ status: 'SUCCEEDED', result: { rows: 27 }, ...range });
    });
    expect(cache.invalidate.mock.calls).toEqual([['lot:']]);
  });

  it('accepts exactly seven days across a month boundary', async () => {
    const { app, operation } = setup();
    const filters = { startDate: '2026-08-29', endDate: '2026-09-04' };
    expect((await repair(app, filters)).status).toBe(202);
    expect(operation).toHaveBeenCalledWith(expect.objectContaining(filters));
  });

  it('blocks duplicate repairs and the scheduler during a repair', async () => {
    let finish;
    const operation = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const { app } = setup({ refreshWipStagingOperation: operation });
    expect((await repair(app)).status).toBe(202);
    expect((await repair(app)).status).toBe(409);
    await expect(app.refreshWipStaging()).resolves.toEqual({ status: 'SKIPPED' });
    expect(operation).toHaveBeenCalledTimes(1);
    finish({ rows: 1 });
  });

  it('blocks repair while the scheduled refresh holds the same lock', async () => {
    let finish;
    const operation = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const { app } = setup({ refreshWipStagingOperation: operation });
    const scheduled = app.refreshWipStaging();
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(1));
    expect((await repair(app)).status).toBe(409);
    finish({ rows: 1 });
    await scheduled;
  });

  it('reports a safe failure, preserves cached data, and releases the lock for retry', async () => {
    const operation = vi.fn().mockRejectedValueOnce(new Error('private database detail')).mockResolvedValue({ rows: 1 });
    const { app, cache } = setup({ refreshWipStagingOperation: operation });
    expect((await repair(app)).status).toBe(202);
    await vi.waitFor(async () => {
      const status = (await request(app).get('/api/staging-status')).body.pipelines.wip;
      expect(status.status).toBe('FAILED');
      expect(JSON.stringify(status)).not.toContain('private database detail');
      expect(JSON.stringify(status)).not.toContain(environment.DASHBOARD_WIP_REPAIR_TOKEN);
    });
    expect(cache.invalidate).not.toHaveBeenCalled();
    expect((await repair(app)).status).toBe(202);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('releases the scheduler lock after an activity failure', async () => {
    const { app, operation } = setup({ stagingWipRepository: { getActivity: vi.fn().mockRejectedValue(new Error('offline')) } });
    await expect(app.refreshWipStaging()).rejects.toThrow('offline');
    expect((await repair(app)).status).toBe(202);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it.each(['', 'short'])('fails closed with an unconfigured operator token', async (token) => {
    const { app, operation } = setup({ environment: { ...environment, DASHBOARD_WIP_REPAIR_TOKEN: token } });
    expect((await repair(app)).status).toBe(503);
    expect(operation).not.toHaveBeenCalled();
  });

  it.each([undefined, 'Bearer wrong', 'Bearer '])('rejects invalid bearer authorization', async (authorization) => {
    const { app, operation } = setup();
    let pending = request(app).post('/api/staging/wip-repair').set('Origin', 'http://localhost:3000');
    if (authorization) pending = pending.set('Authorization', authorization);
    expect((await pending.send(range)).status).toBe(401);
    expect(operation).not.toHaveBeenCalled();
  });

  it.each([undefined, 'https://untrusted.example'])('rejects missing or disallowed origins', async (origin) => {
    const { app, operation } = setup();
    let pending = request(app).post('/api/staging/wip-repair').set('Authorization', `Bearer ${environment.DASHBOARD_WIP_REPAIR_TOKEN}`);
    if (origin) pending = pending.set('Origin', origin);
    expect((await pending.send(range)).status).toBe(403);
    expect(operation).not.toHaveBeenCalled();
  });

  it('does not trust a spoofed forwarding header to bypass the socket IP allowlist', async () => {
    const { app, operation } = setup({ environment: { ...environment, DASHBOARD_WIP_REPAIR_ALLOWED_IPS: '192.0.2.8' } });
    const response = await request(app).post('/api/staging/wip-repair').set('Origin', 'http://localhost:3000')
      .set('Authorization', `Bearer ${environment.DASHBOARD_WIP_REPAIR_TOKEN}`).set('X-Forwarded-For', '192.0.2.8').send(range);
    expect(response.status).toBe(403);
    expect(operation).not.toHaveBeenCalled();
  });

  it('rejects repair when WIP staging is disabled', async () => {
    const { app, operation } = setup({ environment: { ...environment, DASHBOARD_WIP_STAGING_ENABLED: 'false' }, stagingWipRepository: undefined });
    expect((await repair(app)).status).toBe(503);
    expect(operation).not.toHaveBeenCalled();
  });
});
