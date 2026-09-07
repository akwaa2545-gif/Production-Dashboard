import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';

const environment = {
  SQL_SERVER: 'mes', SQL_DATABASE: 'OneMES', DB_AUTH: 'ActiveDirectoryInteractive',
  DB_VIEW: 'PowerBIThailand.ClosedBatch_v', DATE_COLUMN: 'CloseDate', PROCESS_COLUMN: 'ProdType',
  SERIE_COLUMN: 'Series', PN_COLUMN: 'From_ItemName', QUANTITY_COLUMN: 'CompleteQty',
  STAGING_SQL_SERVER: 'staging', STAGING_SQL_DATABASE: 'ProductionMES', STAGING_SQL_USER: 'user',
  STAGING_SQL_PASSWORD: 'password', DASHBOARD_901_STAGING_ENABLED: 'true',
  DASHBOARD_901_REPAIR_TOKEN: 'test-only-901-repair-token-that-is-long-enough'
};

const activity = { rowCount: 10, firstDataDate: '2026-01-01', lastDataDate: '2026-09-06', lastRefreshedAt: '2026-09-06T00:00:00.000Z' };
const staging = () => ({ getActivity: vi.fn().mockResolvedValue(activity) });
const authorizedRepair = (app, body) => request(app)
  .post('/api/staging/901-repair')
  .set('Origin', 'http://localhost:3000')
  .set('Authorization', `Bearer ${environment.DASHBOARD_901_REPAIR_TOKEN}`)
  .send(body);

describe('901 staging repair', () => {
  it.each([
    [{}, 'valid startDate and endDate'],
    [{ startDate: '2026-02-30', endDate: '2026-02-30' }, 'valid startDate and endDate'],
    [{ startDate: '2026-09-04', endDate: '2026-09-03' }, 'on or before'],
    [{ startDate: '2026-08-01', endDate: '2026-08-09' }, 'cannot exceed 7 days']
  ])('rejects an unsafe repair range: %o', async (body, message) => {
    const operation = vi.fn();
    const response = await authorizedRepair(createApp({ environment, staging901Repository: staging(), repository: {}, refresh901StagingOperation: operation }), body);
    expect(response.status).toBe(400);
    expect(response.body.error).toContain(message);
    expect(operation).not.toHaveBeenCalled();
  });

  it('starts an exact repair asynchronously and reports completion', async () => {
    let finish;
    const operation = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const app = createApp({ environment, staging901Repository: staging(), repository: {}, refresh901StagingOperation: operation });
    const accepted = await authorizedRepair(app, { startDate: '2026-09-03', endDate: '2026-09-03' });

    expect(accepted.status).toBe(202);
    expect(accepted.body.data).toMatchObject({ status: 'RUNNING', startDate: '2026-09-03', endDate: '2026-09-03' });
    expect(operation).toHaveBeenCalledWith(expect.objectContaining({ startDate: '2026-09-03', endDate: '2026-09-03' }));
    const running = await request(app).get('/api/staging-status');
    expect(running.body.pipelines.completion901).toMatchObject({ status: 'RUNNING', startDate: '2026-09-03', endDate: '2026-09-03' });

    finish({ rows: 16, startDate: '2026-09-03', endDate: '2026-09-03' });
    await vi.waitFor(async () => {
      const completed = await request(app).get('/api/staging-status');
      expect(completed.body.pipelines.completion901).toMatchObject({ status: 'SUCCEEDED', result: { rows: 16 } });
    });
  });

  it('shares the scheduler lock and rejects a second repair while running', async () => {
    let finish;
    const operation = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const app = createApp({ environment, staging901Repository: staging(), repository: {}, refresh901StagingOperation: operation });
    await authorizedRepair(app, { startDate: '2026-09-03', endDate: '2026-09-03' });

    const duplicate = await authorizedRepair(app, { startDate: '2026-09-02', endDate: '2026-09-02' });
    expect(duplicate.status).toBe(409);
    expect(operation).toHaveBeenCalledTimes(1);
    await expect(app.refresh901Staging()).resolves.toMatchObject({ status: 'SKIPPED' });
    finish({ rows: 1, startDate: '2026-09-03', endDate: '2026-09-03' });
  });

  it('rejects a cross-origin browser request', async () => {
    const operation = vi.fn();
    const response = await request(createApp({ environment, staging901Repository: staging(), repository: {}, refresh901StagingOperation: operation }))
      .post('/api/staging/901-repair')
      .set('Origin', 'https://untrusted.example')
      .set('Authorization', `Bearer ${environment.DASHBOARD_901_REPAIR_TOKEN}`)
      .send({ startDate: '2026-09-03', endDate: '2026-09-03' });
    expect(response.status).toBe(403);
    expect(operation).not.toHaveBeenCalled();
  });

  it.each(['', 'too-short'])('fails closed when the operator token is missing or too short', async (configuredToken) => {
    const operation = vi.fn();
    const app = createApp({ environment: { ...environment, DASHBOARD_901_REPAIR_TOKEN: configuredToken }, staging901Repository: staging(), repository: {}, refresh901StagingOperation: operation });
    const response = await request(app).post('/api/staging/901-repair').set('Origin', 'http://localhost:3000').send({ startDate: '2026-09-03', endDate: '2026-09-03' });
    expect(response.status).toBe(503);
    expect(operation).not.toHaveBeenCalled();
  });

  it.each([undefined, 'Bearer ', 'Bearer wrong', `Bearer ${'x'.repeat(96)}`])('rejects missing or invalid operator authorization: %s', async (authorization) => {
    const operation = vi.fn();
    let pending = request(createApp({ environment, staging901Repository: staging(), repository: {}, refresh901StagingOperation: operation }))
      .post('/api/staging/901-repair').set('Origin', 'http://localhost:3000');
    if (authorization !== undefined) pending = pending.set('Authorization', authorization);
    const response = await pending.send({ startDate: '2026-09-03', endDate: '2026-09-03' });
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ success: false, code: 'OPERATOR_AUTH_REQUIRED' });
    expect(JSON.stringify(response.body)).not.toContain(environment.DASHBOARD_901_REPAIR_TOKEN);
    expect(operation).not.toHaveBeenCalled();
  });
});
