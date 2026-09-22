import request from 'supertest';
import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';

// Authentication fixtures do not need the production reconciliation workbook.
vi.mock('../src/taYieldMapping.js', async (importOriginal) => ({
  ...await importOriginal(),
  loadTaWorkbookReconciliationMapping: async () => new Map()
}));

const environment = {
  SQL_SERVER: 'fixture.database.windows.net',
  SQL_DATABASE: 'FixtureMES',
  DB_AUTH: 'ActiveDirectoryInteractive',
  DB_VIEW: 'dbo.LotCompleteLog',
  DATE_COLUMN: 'completedAt',
  PROCESS_COLUMN: 'processName',
  SERIE_COLUMN: 'serie',
  CASE_COLUMN: 'caseNumber',
  PN_COLUMN: 'from_itemName',
  DASHBOARD_DATA_MODE: 'live'
};
const quantityPath = '/api/quantity?startDate=2026-09-19&endDate=2026-09-20';
const databaseError = (code, name = 'RequestError', number) => Object.assign(new Error('Private SQL diagnostic'), { code, name, ...(number === undefined ? {} : { number }) });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

describe('live database authentication and error recovery', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['closed', 'closed'],
    ['closed', 'lot'],
    ['yield', 'ta-yield']
  ])('shares one interactive sign-in for concurrent %s / %s requests using the same repository', async (first, second) => {
    const gate = deferred();
    const repository = { authenticate: vi.fn(() => gate.promise) };
    const app = createApp({ environment, repository, scYieldRepository: repository, taYieldRepository: repository });
    const received = [];
    const server = createServer((req, res) => {
      received.push(req);
      app(req, res);
    });
    const pending = [first, second].map((dataset) => request(server).get(`/api/auth/login?dataset=${dataset}`).then((response) => response));
    try {
      // Static-file middleware can delay route entry after the socket is accepted.
      await vi.waitFor(() => {
        expect(received).toHaveLength(2);
        expect(received.every((incoming) => incoming.route?.path === '/api/auth/login')).toBe(true);
      });
    } finally {
      gate.resolve();
    }
    const responses = await Promise.all(pending);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(repository.authenticate).toHaveBeenCalledTimes(1);
  });

  it('does not reopen sign-in immediately after an unsuccessful attempt', async () => {
    const repository = { authenticate: vi.fn().mockRejectedValue(databaseError('ELOGIN')) };
    const app = createApp({ environment, repository });
    const first = await request(app).get('/api/auth/login?dataset=closed');
    const second = await request(app).get('/api/auth/login?dataset=lot');
    expect(first.status).toBe(401);
    expect(second.status).toBe(401);
    expect(first.body.code).toBe('AUTH_REQUIRED');
    expect(second.body.code).toBe('AUTH_REQUIRED');
    expect(repository.authenticate).toHaveBeenCalledTimes(1);
  });

  it('reports a query timeout without resetting the connection or requesting sign-in', async () => {
    const repository = { getQuantity: vi.fn().mockRejectedValue(databaseError('ETIMEOUT')), resetConnection: vi.fn(), authenticate: vi.fn() };
    const response = await request(createApp({ environment, repository })).get(quantityPath);
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('DATABASE_QUERY_TIMEOUT');
    expect(repository.getQuantity).toHaveBeenCalledTimes(1);
    expect(repository.resetConnection).not.toHaveBeenCalled();
    expect(repository.authenticate).not.toHaveBeenCalled();
    expect(response.body.error).not.toContain('Private SQL diagnostic');
  });

  it('retries a connection timeout once after silently resetting the connection', async () => {
    const repository = { getQuantity: vi.fn().mockRejectedValueOnce(databaseError('ETIMEOUT', 'ConnectionError')).mockResolvedValue([{ quantityMoved: 42 }]), resetConnection: vi.fn().mockResolvedValue(), authenticate: vi.fn() };
    const response = await request(createApp({ environment, repository })).get(quantityPath);
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([{ quantityMoved: 42 }]);
    expect(repository.getQuantity).toHaveBeenCalledTimes(2);
    expect(repository.resetConnection).toHaveBeenCalledTimes(1);
    expect(repository.authenticate).not.toHaveBeenCalled();
  });

  it('recovers an expired SQL login silently before asking for interactive sign-in', async () => {
    const repository = { getQuantity: vi.fn().mockRejectedValueOnce(databaseError('ELOGIN')).mockResolvedValue([]), resetConnection: vi.fn().mockResolvedValue(), authenticate: vi.fn() };
    const response = await request(createApp({ environment, repository })).get(quantityPath);
    expect(response.status).toBe(200);
    expect(repository.getQuantity).toHaveBeenCalledTimes(2);
    expect(repository.resetConnection).toHaveBeenCalledTimes(1);
    expect(repository.authenticate).not.toHaveBeenCalled();
  });

  it('requests sign-in only after one silent ELOGIN recovery also fails', async () => {
    const repository = { getQuantity: vi.fn().mockRejectedValue(databaseError('ELOGIN')), resetConnection: vi.fn().mockResolvedValue(), authenticate: vi.fn() };
    const response = await request(createApp({ environment, repository })).get(quantityPath);
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTH_REQUIRED');
    expect(repository.getQuantity).toHaveBeenCalledTimes(2);
    expect(repository.resetConnection).toHaveBeenCalledTimes(1);
    expect(repository.authenticate).not.toHaveBeenCalled();
  });

  it('recognizes an explicit authentication-required error even without diagnostic text', async () => {
    const repository = { getQuantity: vi.fn().mockRejectedValue(databaseError(undefined, 'AuthenticationRequiredError')) };
    const response = await request(createApp({ environment, repository })).get(quantityPath);
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTH_REQUIRED');
  });

  it.each([229, 230])('reports SQL permission error %i as a data access problem', async (number) => {
    const repository = { getQuantity: vi.fn().mockRejectedValue(databaseError('EREQUEST', 'RequestError', number)), resetConnection: vi.fn(), authenticate: vi.fn() };
    const response = await request(createApp({ environment, repository })).get(quantityPath);
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('DATABASE_PERMISSION_DENIED');
    expect(response.body.error).not.toContain('Private SQL diagnostic');
    expect(repository.resetConnection).not.toHaveBeenCalled();
    expect(repository.authenticate).not.toHaveBeenCalled();
  });

  it.each([207, 208])('reports missing SQL object/column %i without asking for sign-in', async (number) => {
    const repository = { getQuantity: vi.fn().mockRejectedValue(databaseError('EREQUEST', 'RequestError', number)), resetConnection: vi.fn(), authenticate: vi.fn() };
    const response = await request(createApp({ environment, repository })).get(quantityPath);
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('DATABASE_QUERY_INVALID');
    expect(response.body.error).not.toContain('Private SQL diagnostic');
    expect(repository.resetConnection).not.toHaveBeenCalled();
    expect(repository.authenticate).not.toHaveBeenCalled();
  });

  it('resets the TA repository even when its internal configuration is a separate object', async () => {
    const repository = { getQuantity: vi.fn().mockResolvedValue([]), resetConnection: vi.fn() };
    const taYieldRepository = {
      config: { server: environment.SQL_SERVER, database: environment.SQL_DATABASE },
      getMtdSeriesOptions: vi.fn().mockRejectedValueOnce(databaseError('ESOCKET', 'ConnectionError')).mockResolvedValue({ serie: ['TA fixture'] }),
      resetConnection: vi.fn().mockResolvedValue()
    };
    const app = createApp({ environment, repository, taYieldRepository });
    await request(app).get(quantityPath);
    const response = await request(app).get('/api/options?dataset=ta-yield&product=TA');
    expect(response.status).toBe(200);
    expect(response.body.data.serie).toEqual(['TA fixture']);
    expect(taYieldRepository.resetConnection).toHaveBeenCalledTimes(1);
    expect(taYieldRepository.getMtdSeriesOptions).toHaveBeenCalledTimes(2);
    expect(repository.resetConnection).not.toHaveBeenCalled();
  });
});
