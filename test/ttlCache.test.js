import { describe, expect, it } from 'vitest';
import { TtlCache } from '../src/ttlCache.js';

describe('TtlCache', () => {
  it('invalidates only entries belonging to the refreshed dashboard source', async () => {
    const cache = new TtlCache();
    await cache.getOrSet('closed:quantity:{"product":"NEO"}', 60000, () => 'closed');
    await cache.getOrSet('lot:quantity:{"product":"NEO"}', 60000, () => 'lot');

    cache.invalidate('closed:');

    expect((await cache.getOrSet('closed:quantity:{"product":"NEO"}', 60000, () => 'new closed')).status).toBe('MISS');
    expect((await cache.getOrSet('lot:quantity:{"product":"NEO"}', 60000, () => 'new lot'))).toMatchObject({ status: 'HIT', value: 'lot' });
  });

  it('does not restore an invalidated result that was still loading', async () => {
    let finish;
    const pending = new Promise((resolve) => { finish = resolve; });
    const cache = new TtlCache();
    const first = cache.getOrSet('closed:quantity:{}', 60000, () => pending);

    cache.invalidate('closed:');
    finish('stale');
    await first;

    await expect(cache.getOrSet('closed:quantity:{}', 60000, () => 'fresh')).resolves.toMatchObject({ status: 'MISS', value: 'fresh' });
  });
});
