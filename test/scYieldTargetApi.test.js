import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';

describe('SC Total target storage API', () => {
  it('saves, reads, and removes Total independently for each month', async () => {
    let saved = [{ serie: 'SCA', period: '2026-09', target: 85 }];
    const repository = {
      list: async () => saved,
      upsert: async (target) => { saved = [...saved.filter((row) => row.serie !== target.serie || row.period !== target.period), target]; },
      remove: async (target) => { saved = saved.filter((row) => row.serie !== target.serie || row.period !== target.period); },
    };
    const app = createApp({ environment: {}, scYieldTargetRepository: repository });
    await request(app).put('/api/sc-yield-targets').send({ serie: 'Total', period: '2026-09', target: 92 }).expect(200);
    await request(app).put('/api/sc-yield-targets').send({ serie: 'Total', period: '2027-01', target: 94 }).expect(200);
    const response = await request(app).get('/api/sc-yield-targets').expect(200);
    expect(response.body.data).toEqual([
      { serie: 'SCA', period: '2026-09', target: 85 },
      { serie: 'Total', period: '2026-09', target: 92 },
      { serie: 'Total', period: '2027-01', target: 94 },
    ]);
    await request(app).delete('/api/sc-yield-targets').query({ serie: 'Total', period: '2026-09' }).expect(200);
    expect(saved).toEqual([{ serie: 'SCA', period: '2026-09', target: 85 }, { serie: 'Total', period: '2027-01', target: 94 }]);
  });

  it.each([{ period: '2026-13', target: 92 }, { period: '2026-09', target: 101 }])('rejects invalid Total settings: %j', async (target) => {
    const upsert = vi.fn();
    const app = createApp({ environment: {}, scYieldTargetRepository: { upsert } });
    await request(app).put('/api/sc-yield-targets').send({ serie: 'Total', ...target }).expect(400);
    expect(upsert).not.toHaveBeenCalled();
  });
});
