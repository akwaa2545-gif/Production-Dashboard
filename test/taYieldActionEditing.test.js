import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { TaYieldActionRepository } from '../src/taYieldActionRepository.js';

describe('reading an individual TA Yield action', () => {
  it('returns the requested record', async () => {
    const action = { id: 124, problem: 'Investigate variation' };
    const getById = vi.fn().mockResolvedValue(action);
    const response = await request(createApp({ environment: {}, taYieldActionRepository: { getById } }))
      .get('/api/ta-yield-actions/124');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, data: action });
    expect(getById).toHaveBeenCalledWith(124);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it.each(['0', '-1', '1.5', 'abc', '2147483648', '9007199254740992'])('rejects invalid id %s before storage access', async (id) => {
    const getById = vi.fn();
    const response = await request(createApp({ environment: {}, taYieldActionRepository: { getById } }))
      .get(`/api/ta-yield-actions/${id}`);
    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(getById).not.toHaveBeenCalled();
  });

  it('returns JSON 404 when the record is missing or deleted', async () => {
    const response = await request(createApp({ environment: {}, taYieldActionRepository: { getById: async () => undefined } }))
      .get('/api/ta-yield-actions/124');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ success: false, error: 'TA Yield action was not found.' });
  });

  it('handles unconfigured storage', async () => {
    const response = await request(createApp({ environment: {} })).get('/api/ta-yield-actions/124');
    expect(response.status).toBe(503);
    expect(response.body.success).toBe(false);
  });

  it('does not expose storage errors', async () => {
    const response = await request(createApp({ environment: {}, taYieldActionRepository: {
      getById: async () => { throw new Error('Private database detail'); }
    } })).get('/api/ta-yield-actions/124');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ success: false, error: 'TA Yield action is currently unavailable.' });
  });

  it('uses a parameterized lookup and excludes deleted records', async () => {
    const record = { id: 124 };
    const query = vi.fn().mockResolvedValue({ recordset: [record] });
    const input = vi.fn();
    const repository = new TaYieldActionRepository({ table: 'dbo.Actions' });
    repository.pool = { request: () => ({ query, input }) };
    expect(await repository.getById(124)).toEqual(record);
    expect(input).toHaveBeenCalledWith('id', expect.anything(), 124);
    expect(query.mock.calls[0][0]).toMatch(/FROM \[dbo\]\.\[Actions\] WHERE id = @id AND deletedAt IS NULL/);
  });
});

describe('TA Yield edit form dates', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function openTaYieldActionModal(');
  const end = source.indexOf('async function saveTaYieldAction(', start);

  it.each([
    ['2026-11-13T00:00:00.000Z', '2026-11-20T00:00:00.000Z', '2026-11-13', '2026-11-20'],
    ['2026-11-13', null, '2026-11-13', '']
  ])('preserves saved dates as valid date input values', (actionDate, dueDate, expectedDate, expectedDue) => {
    const elements = {};
    const modal = { hidden: true };
    const context = vm.createContext({
      ensureTaYieldActionModal: () => modal,
      byId: (id) => elements[id] ||= { value: '', focus: vi.fn() }
    });
    vm.runInContext(source.slice(start, end), context);
    context.openTaYieldActionModal({ id: 124, actionDate, dueDate, problem: 'Review variation', status: 'IN_PROGRESS' });
    expect(elements.taActionDate.value).toBe(expectedDate);
    expect(elements.taActionDueDate.value).toBe(expectedDue);
    expect(elements.taActionId.value).toBe(124);
    expect(modal.hidden).toBe(false);
  });
});
