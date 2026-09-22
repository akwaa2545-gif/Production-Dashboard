import { EventEmitter, once } from 'node:events';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createDashboardDataMode, registerDashboardDataModeRoutes } from '../src/dashboardDataMode.js';

const token = 'mode-control-test-token-with-32-characters';
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function api(environment = {}) {
  const controller = createDashboardDataMode({});
  const app = express();
  app.use(express.json());
  app.use(controller.middleware);
  registerDashboardDataModeRoutes(app, { controller, environment });
  return { app, controller };
}

describe('dashboard data mode controller', () => {
  it('defaults to staging and applies idle changes synchronously exactly once', () => {
    const onChange = vi.fn();
    const controller = createDashboardDataMode({ onChange });
    expect(controller.status()).toEqual({ mode: 'staging', requestedMode: 'staging', transitioning: false, revision: 0, activeWork: 0, startupMode: 'staging' });
    expect(controller.setMode('live').mode).toBe('live');
    expect(controller.isLive()).toBe(true);
    expect(controller.canStartBackgroundWork()).toBe(false);
    controller.setMode('live');
    expect(onChange).toHaveBeenCalledExactlyOnceWith('live');
    expect(controller.status().revision).toBe(1);
    controller.setMode('staging');
    expect(controller.canStartBackgroundWork()).toBe(true);
    expect(controller.status().startupMode).toBe('staging');
  });

  it('drains existing work and nested tasks while refusing new background work', async () => {
    const gate = deferred();
    const nested = deferred();
    const onChange = vi.fn();
    const controller = createDashboardDataMode({ onChange });
    const work = controller.runBackground(async () => {
      await gate.promise;
      await controller.track(() => nested.promise);
    });
    expect(controller.setMode('live').transitioning).toBe(true);
    const skipped = vi.fn();
    expect(await controller.runBackground(skipped)).toEqual({ status: 'SKIPPED', reason: 'MODE_SWITCH' });
    expect(skipped).not.toHaveBeenCalled();
    gate.resolve();
    await Promise.resolve();
    expect(controller.status().activeWork).toBe(2);
    expect(onChange).not.toHaveBeenCalled();
    nested.resolve();
    await work;
    expect(controller.status()).toMatchObject({ mode: 'live', activeWork: 0, transitioning: false, revision: 1 });
    expect(await controller.runBackground(skipped)).toEqual({ status: 'SKIPPED', reason: 'LIVE_MODE' });
  });

  it('releases failed tasks and rejects conflicting transition requests', async () => {
    const gate = deferred();
    const controller = createDashboardDataMode({});
    const work = controller.track(async () => { await gate.promise; throw new Error('query failed'); });
    controller.setMode('live');
    expect(controller.setMode('live').transitioning).toBe(true);
    expect(() => controller.setMode('staging')).toThrow();
    gate.resolve();
    await expect(work).rejects.toThrow('query failed');
    expect(controller.status().mode).toBe('live');
    expect(() => controller.setMode('invalid')).toThrow();
    expect(() => createDashboardDataMode({ initialMode: 'invalid' })).toThrow();
  });

  it('counts a response once across finish and close and blocks new requests during drain', () => {
    const controller = createDashboardDataMode({});
    const response = new EventEmitter();
    const next = vi.fn();
    controller.middleware({ path: '/api/wip' }, response, next);
    expect(next).toHaveBeenCalledOnce();
    controller.setMode('live');
    const blocked = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    controller.middleware({ path: '/API/Production' }, blocked, vi.fn());
    expect(blocked.status).toHaveBeenCalledWith(503);
    expect(blocked.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'DATA_MODE_TRANSITION' }));
    response.emit('finish');
    response.emit('close');
    expect(controller.status()).toMatchObject({ activeWork: 0, mode: 'live' });
  });

  it('leaves control, status, health, config and static requests accessible while draining', () => {
    const controller = createDashboardDataMode({});
    controller.middleware({ path: '/api/wip' }, new EventEmitter(), vi.fn());
    controller.setMode('live');
    for (const path of ['/api/data-mode', '/api/data-mode/local-token', '/api/staging-status', '/api/health', '/api/config', '/API/DATA-MODE', '/']) {
      const next = vi.fn();
      controller.middleware({ path }, {}, next);
      expect(next).toHaveBeenCalledOnce();
    }
    expect(controller.status().activeWork).toBe(1);
  });

  it('retains the original mode when the change callback fails', async () => {
    const controller = createDashboardDataMode({ onChange: () => { throw new Error('secret failure'); } });
    expect(() => controller.setMode('live')).toThrow('Unable to switch dashboard data mode.');
    expect(controller.status()).toMatchObject({ mode: 'staging', requestedMode: 'staging', transitioning: false, revision: 0 });
    const gate = deferred();
    const work = controller.track(() => gate.promise);
    controller.setMode('live');
    gate.resolve();
    await work;
    expect(controller.status().mode).toBe('staging');
    expect(controller.status().error).toBe('Unable to switch dashboard data mode.');
  });

  it('supports live startup, synchronous failures and aborted responses without leaked work', async () => {
    const controller = createDashboardDataMode({ initialMode: 'live' });
    expect(controller.status().startupMode).toBe('live');
    await expect(controller.track(() => { throw new Error('synchronous task failed'); })).rejects.toThrow('synchronous task failed');
    const response = new EventEmitter();
    controller.middleware({ path: '/api/production' }, response, vi.fn());
    controller.setMode('staging');
    response.emit('close');
    expect(controller.status()).toMatchObject({ activeWork: 0, mode: 'staging' });
  });
});

async function withLocalApi(run, environment = {}) {
  const { app, controller } = api({ DASHBOARD_DATA_MODE_LOCAL_AUTOFILL: 'true', ...environment });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ client: request(server), origin, controller, port: server.address().port });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function localRouteFixture(environment = {}) {
  const handlers = new Map();
  const app = Object.fromEntries(['get', 'post', 'put'].map((method) => [method, (path, handler) => handlers.set(`${method} ${path}`, handler)]));
  registerDashboardDataModeRoutes(app, { controller: createDashboardDataMode(), environment });
  const invoke = (method, path, overrides = {}) => {
    const req = { socket: { remoteAddress: '::ffff:127.0.0.1', localPort: 3000 }, headers: { host: 'localhost:3000', origin: 'http://localhost:3000' }, get(name) { return this.headers[name.toLowerCase()]; }, ...overrides };
    const res = { set: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
    handlers.get(`${method} ${path}`)(req, res);
    return { status: res.status.mock.calls[0]?.[0] || 200, body: res.json.mock.calls[0]?.[0], response: res };
  };
  return { invoke };
}

describe('local data mode credentials', () => {
  it('keeps local autofill disabled until an operator explicitly enables it', () => {
    const { invoke } = localRouteFixture();
    expect(invoke('get', '/api/data-mode').body.data.localAutofillAvailable).toBe(false);
    expect(invoke('post', '/api/data-mode/local-token').status).toBe(403);
  });

  it('advertises local autofill and issues a short-lived one-use credential when explicitly enabled', async () => {
    await withLocalApi(async ({ client, origin }) => {
      const status = await client.get('/api/data-mode').expect(200);
      expect(status.body.data).toMatchObject({ controlConfigured: false, localAutofillAvailable: true });
      const issued = await client.post('/api/data-mode/local-token').set('Origin', origin).expect(200);
      expect(issued.headers['cache-control']).toBe('no-store');
      expect(issued.body.data.token.length).toBeGreaterThanOrEqual(43);
      expect(Date.parse(issued.body.data.expiresAt)).toBeGreaterThan(Date.now());
      const put = () => client.put('/api/data-mode').set('Origin', origin).set('Authorization', `Bearer ${issued.body.data.token}`).send({ mode: 'live' });
      await put().expect(200);
      await put().expect(401);
      await client.put('/api/data-mode').set('Origin', origin).send({ mode: 'staging' }).expect(503);
    });
  });

  it('rejects nonlocal hosts, incorrect ports, absent or foreign origins, and proxy headers', async () => {
    await withLocalApi(async ({ client, origin, port }) => {
      for (const host of [`dashboard.example:${port}`, `127.0.0.1:${port + 1}`, `localhost.evil.example:${port}`]) {
        await client.post('/api/data-mode/local-token').set('Host', host).set('Origin', `http://${host}`).expect(403);
        expect((await client.get('/api/data-mode').set('Host', host)).body.data.localAutofillAvailable).toBe(false);
      }
      for (const badOrigin of ['', 'null', 'https://evil.example', `${origin}/`]) {
        await client.post('/api/data-mode/local-token').set('Origin', badOrigin).expect(403);
      }
      for (const header of ['Forwarded', 'Via', 'X-Forwarded-For', 'X-Forwarded-Host', 'X-Forwarded-Proto', 'X-Real-IP']) {
        await client.post('/api/data-mode/local-token').set('Origin', origin).set(header, '127.0.0.1').expect(403);
      }
      const foreignGet = await client.get('/api/data-mode').set('Origin', 'https://evil.example');
      expect(foreignGet.body.data.localAutofillAvailable).toBe(false);
    });
  });

  it('binds a credential to its origin and consumes it on unsuccessful attempts', async () => {
    await withLocalApi(async ({ client, origin, port }) => {
      const issue = () => client.post('/api/data-mode/local-token').set('Origin', origin);
      const issued = await issue();
      const authorization = `Bearer ${issued.body.data.token}`;
      await client.put('/api/data-mode').set('Host', `localhost:${port}`).set('Origin', `http://localhost:${port}`).set('Authorization', authorization).send({ mode: 'live' }).expect(403);
      await client.put('/api/data-mode').set('Origin', origin).set('Authorization', authorization).send({ mode: 'live' }).expect(401);
      const invalid = await issue();
      const put = (mode) => client.put('/api/data-mode').set('Origin', origin).set('Authorization', `Bearer ${invalid.body.data.token}`).send({ mode });
      await put('INVALID').expect(400);
      await put('live').expect(401);
    });
  });

  it('expires credentials after two minutes and issues while a transition drains', async () => {
    await withLocalApi(async ({ client, origin, controller }) => {
      const gate = deferred();
      const work = controller.track(() => gate.promise);
      controller.setMode('live');
      const issued = await client.post('/api/data-mode/local-token').set('Origin', origin).expect(200);
      expect(controller.status().activeWork).toBe(1);
      gate.resolve();
      await work;
      const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(issued.body.data.expiresAt));
      try {
        await client.put('/api/data-mode').set('Origin', origin).set('Authorization', `Bearer ${issued.body.data.token}`).send({ mode: 'staging' }).expect(401);
      } finally {
        now.mockRestore();
      }
    });
  });

  it('rejects a spoofed loopback host when the actual socket is remote', () => {
    const handlers = new Map();
    const app = { get: (path, handler) => handlers.set(`GET ${path}`, handler), post: (path, handler) => handlers.set(`POST ${path}`, handler), put: () => {} };
    registerDashboardDataModeRoutes(app, { controller: createDashboardDataMode(), environment: {} });
    const req = { socket: { remoteAddress: '192.0.2.20', localPort: 3000 }, headers: { host: 'localhost:3000', origin: 'http://localhost:3000' }, get(name) { return this.headers[name.toLowerCase()]; } };
    const res = { set: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), json: vi.fn() };
    handlers.get('POST /api/data-mode/local-token')(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    handlers.get('GET /api/data-mode')(req, res);
    expect(res.json).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ localAutofillAvailable: false }) }));
  });

  it('respects existing credentials, explicit opt-in/disable, and configured allowlists', () => {
    for (const environment of [
      { DASHBOARD_DATA_MODE_TOKEN: token },
      { DASHBOARD_DATA_MODE_TOKEN: 'weak-token' },
      { DASHBOARD_DATA_MODE_LOCAL_AUTOFILL: 'false' },
      { DASHBOARD_DATA_MODE_ALLOWED_IPS: '192.0.2.20' },
      { DASHBOARD_DATA_MODE_ALLOWED_ORIGINS: 'https://dashboard.example' }
    ]) {
      const { invoke } = localRouteFixture(environment);
      expect(invoke('get', '/api/data-mode').body.data.localAutofillAvailable).toBe(false);
      const issued = invoke('post', '/api/data-mode/local-token');
      expect(issued.status).toBe(403);
      expect(issued.response.set).toHaveBeenCalledWith('Cache-Control', 'no-store');
    }
    const { invoke } = localRouteFixture({ DASHBOARD_DATA_MODE_TOKEN: token, DASHBOARD_DATA_MODE_LOCAL_AUTOFILL: 'true', DASHBOARD_DATA_MODE_ALLOWED_ORIGINS: 'http://localhost:3000', DASHBOARD_DATA_MODE_ALLOWED_IPS: '127.0.0.1' });
    const issued = invoke('post', '/api/data-mode/local-token');
    expect(issued.status).toBe(200);
    expect(issued.body.data.token).not.toBe(token);
    expect(invoke('put', '/api/data-mode', { headers: { host: 'localhost:3000', origin: 'http://localhost:3000', authorization: `Bearer ${issued.body.data.token}` }, body: { mode: 'live' } }).status).toBe(200);
    expect(JSON.stringify(invoke('get', '/api/data-mode').body)).not.toContain(token);
  });

  it('bounds outstanding credentials and frees capacity when they expire', () => {
    const { invoke } = localRouteFixture({ DASHBOARD_DATA_MODE_LOCAL_AUTOFILL: 'true' });
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      for (let index = 0; index < 128; index += 1) expect(invoke('post', '/api/data-mode/local-token').status).toBe(200);
      expect(invoke('post', '/api/data-mode/local-token').status).toBe(429);
      now.mockReturnValue(121_000);
      expect(invoke('post', '/api/data-mode/local-token').status).toBe(200);
    } finally {
      now.mockRestore();
    }
  });

  it('binds to the raw socket IP and rejects proxy headers on consumption', () => {
    const { invoke } = localRouteFixture({ DASHBOARD_DATA_MODE_LOCAL_AUTOFILL: 'true' });
    for (const overrides of [
      { socket: { remoteAddress: '::1', localPort: 3000 } },
      { headers: { 'x-forwarded-for': '127.0.0.1' } }
    ]) {
      const issued = invoke('post', '/api/data-mode/local-token').body.data.token;
      const headers = { host: 'localhost:3000', origin: 'http://localhost:3000', authorization: `Bearer ${issued}`, ...overrides.headers };
      expect(invoke('put', '/api/data-mode', { ...overrides, headers, body: { mode: 'live' } }).status).toBe(403);
      expect(invoke('put', '/api/data-mode', { headers: { host: 'localhost:3000', origin: 'http://localhost:3000', authorization: `Bearer ${issued}` }, body: { mode: 'live' } }).status).toBe(401);
    }
  });
});

describe('dashboard data mode routes', () => {
  it('provides safe no-store status and requires configured operator authorization', async () => {
    const { app } = api();
    const status = await request(app).get('/api/data-mode').expect(200);
    expect(status.headers['cache-control']).toBe('no-store');
    expect(status.body).toMatchObject({ success: true, data: { mode: 'staging', controlConfigured: false } });
    await request(app).put('/api/data-mode').send({ mode: 'live' }).expect(503);
    const configured = api({ DASHBOARD_DATA_MODE_TOKEN: token });
    await request(configured.app).put('/api/data-mode').send({ mode: 'live' }).expect(401);
    await request(configured.app).put('/api/data-mode').set('Authorization', 'Bearer wrong-token').send({ mode: 'live' }).expect(401);
    const safe = await request(configured.app).get('/api/data-mode');
    expect(JSON.stringify(safe.body)).not.toContain(token);
  });

  it('requires an exact allowed origin and raw socket IP, ignoring forwarded IPs', async () => {
    const { app } = api({ DASHBOARD_DATA_MODE_TOKEN: token });
    for (const origin of ['', 'http://localhost:3000.evil.example', 'https://example.com']) {
      await request(app).put('/api/data-mode').set('Authorization', `Bearer ${token}`).set('Origin', origin).send({ mode: 'live' }).expect(403);
    }
    const restricted = api({ DASHBOARD_DATA_MODE_TOKEN: token, DASHBOARD_DATA_MODE_ALLOWED_IPS: '192.0.2.1' });
    await request(restricted.app).put('/api/data-mode').set('Authorization', `Bearer ${token}`).set('Origin', 'http://localhost:3000').set('X-Forwarded-For', '192.0.2.1').send({ mode: 'live' }).expect(403);
  });

  it('validates exact modes and returns applied or draining status', async () => {
    const { app, controller } = api({ DASHBOARD_DATA_MODE_TOKEN: token });
    const put = (mode) => request(app).put('/api/data-mode').set('Authorization', `Bearer ${token}`).set('Origin', 'http://localhost:3000').send({ mode });
    await put('LIVE').expect(400);
    const applied = await put('live').expect(200);
    expect(applied.body.data.mode).toBe('live');
    const gate = deferred();
    const work = controller.track(() => gate.promise);
    const draining = await put('staging').expect(202);
    expect(draining.body.data).toMatchObject({ mode: 'live', requestedMode: 'staging', transitioning: true });
    await put('live').expect(409);
    gate.resolve();
    await work;
    expect(controller.status().mode).toBe('staging');
  });

  it('honors configured origins and reports callback failures without internal details', async () => {
    const environment = { DASHBOARD_DATA_MODE_TOKEN: token, DASHBOARD_DATA_MODE_ALLOWED_ORIGINS: 'https://dashboard.example' };
    const app = express();
    app.use(express.json());
    const controller = createDashboardDataMode({ onChange: () => { throw new Error('private connection details'); } });
    registerDashboardDataModeRoutes(app, { controller, environment });
    const result = await request(app).put('/api/data-mode').set('Authorization', `Bearer ${token}`).set('Origin', 'https://dashboard.example').send({ mode: 'live' }).expect(500);
    expect(result.body.error).toBe('Unable to switch dashboard data mode.');
    expect(controller.status().mode).toBe('staging');
  });
});
