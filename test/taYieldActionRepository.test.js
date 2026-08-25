import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const repository = readFileSync(new URL('../src/taYieldActionRepository.js', import.meta.url), 'utf8');

describe('TA Yield action repository', () => {
  it('lists actions from newest to oldest action date', () => {
    expect(repository).toContain('ORDER BY actionDate DESC, id DESC;');
  });
});
