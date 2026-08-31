import { describe, expect, it } from 'vitest';
import { TaYieldRepository } from '../src/taYieldRepository.js';

describe('TA Yield SQL timeout configuration', () => {
  it('enables a finite pool-level timeout for TA Yield when no SQL timeout is configured', () => {
    const config = new TaYieldRepository({}).config;

    expect(config.requestTimeout).toBe(120000);
  });

  it('keeps a longer explicitly configured SQL timeout', () => {
    const config = new TaYieldRepository({ requestTimeout: 180000 }).config;

    expect(config.requestTimeout).toBe(180000);
  });

  it('rejects an infinite configured timeout in favor of the finite default', () => {
    const config = new TaYieldRepository({ requestTimeout: Infinity }).config;

    expect(config.requestTimeout).toBe(120000);
  });
});
