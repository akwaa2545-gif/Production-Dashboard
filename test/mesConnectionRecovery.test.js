import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createMesConnectionRecovery } from '../src/mesConnectionRecovery.js';
const config = { server: 'fixture', database: 'fixture', tenantId: 'fixture-tenant', auth: 'ActiveDirectoryInteractive', metadataReady: true };
const source = (database, dataset = 'closed') => ({ dataset, config, database });
const required = () => Object.assign(new Error('private credential message'), { name: 'AuthenticationRequiredError' });

describe('automatic silent MES reconnection', () => {
  it('checks status without connecting or opening sign-in', () => {
    const database = { getPool: vi.fn(), authenticate: vi.fn(), getAuthenticationStatus: () => ({ state: 'AUTH_REQUIRED', privateToken: 'never expose' }) };
    const recovery = createMesConnectionRecovery(() => [source(database)]);
    expect(recovery.status()).toMatchObject({ state: 'AUTH_REQUIRED', needsAuthentication: true, dataset: 'closed' });
    expect(JSON.stringify(recovery.status())).not.toMatch(/privateToken|never expose|fixture-tenant/);
    expect(database.getPool).not.toHaveBeenCalled();
    expect(database.authenticate).not.toHaveBeenCalled();
  });
  it('shares a pending silent reconnect and recovers after failure', async () => {
    let release;
    let state = 'AUTH_REQUIRED';
    const database = {
      getPool: vi.fn().mockRejectedValueOnce(required()).mockImplementationOnce(() => new Promise(resolve => { release = () => { state = 'CONNECTED'; resolve({ connected: true }); }; })),
      authenticate: vi.fn(), getAuthenticationStatus: () => ({ state })
    };
    const recovery = createMesConnectionRecovery(() => [source(database)]);
    await recovery.reconnect();
    expect(recovery.status().needsAuthentication).toBe(true);
    const first = recovery.reconnect();
    const second = recovery.reconnect();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    await Promise.all([first, second]);
    expect(database.getPool).toHaveBeenCalledTimes(2);
    expect(database.authenticate).not.toHaveBeenCalled();
    expect(recovery.status().state).toBe('CONNECTED');
  });
  it('exposes background failures even when report data can be cached', async () => {
    const repository = { getPool: vi.fn().mockRejectedValue(required()), getAuthenticationStatus: () => ({ state: 'AUTH_REQUIRED' }) };
    const app = createApp({ environment: { SQL_SERVER: 'fixture', SQL_DATABASE: 'fixture', DATE_COLUMN: 'completedAt' }, repository });
    const response = await request(app).get('/api/auth/status');
    expect(response.status).toBe(200);
    expect(response.body.data.needsAuthentication).toBe(true);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(repository.getPool).not.toHaveBeenCalled();
    expect(response.text).not.toContain('private credential message');
  });
  it('reports disabled configuration without touching a database', async () => {
    const response = await request(createApp({ environment: {} })).get('/api/auth/status');
    expect(response.status).toBe(200);
    expect(response.body.data.state).toBe('NOT_CONFIGURED');
  });
  it('does not classify a network failure as a request to sign in', async () => {
    const database = { getPool: vi.fn().mockRejectedValue(new Error('private network detail')), authenticate: vi.fn() };
    const recovery = createMesConnectionRecovery(() => [source(database)]);
    await recovery.reconnect();
    expect(recovery.status()).toMatchObject({ state: 'UNAVAILABLE', needsAuthentication: false });
    expect(database.authenticate).not.toHaveBeenCalled();
    expect(JSON.stringify(recovery.status())).not.toContain('private network detail');
  });
});
