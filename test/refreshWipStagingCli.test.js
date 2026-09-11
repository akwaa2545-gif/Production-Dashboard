import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('WIP staging CLI lifecycle', () => {
  it('terminates after success or failure', async () => {
    const source = await readFile(new URL('../src/refreshWipStaging.js', import.meta.url), 'utf8');

    expect(source).toMatch(/process\.exit\(0\)/);
    expect(source).toMatch(/process\.exit\(1\)/);
  });
});
