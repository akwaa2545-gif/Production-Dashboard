import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MesAuthenticationRecordStore } from '../src/mesAuthenticationRecord.js';

const account = { authority: 'login.windows.net', homeAccountId: 'fixture-home', clientId: 'fixture-client', tenantId: 'fixture-tenant', username: 'fixture@example.invalid', version: '1.0' };
let directory;
beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), 'mes-session-test-')); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('remembering the MES account across server restarts', () => {
  it('restores the saved account from a fresh store instance', async () => {
    expect(await new MesAuthenticationRecordStore(directory).save('fixture-tenant', account)).toBe(true);
    expect(await new MesAuthenticationRecordStore(directory).load('fixture-tenant')).toEqual(account);
  });
  it('stores only account metadata, never access or refresh tokens', async () => {
    await new MesAuthenticationRecordStore(directory).save('fixture-tenant', { ...account, accessToken: 'fake-access', refreshToken: 'fake-refresh' });
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain('fixture');
    const saved = await readFile(path.join(directory, files[0]), 'utf8');
    expect(JSON.parse(saved)).toEqual(account);
    expect(saved).not.toMatch(/fake-access|fake-refresh|accessToken|refreshToken/);
  });
  it('isolates tenants and accepts a missing record', async () => {
    const store = new MesAuthenticationRecordStore(directory);
    expect(await store.load('fixture-tenant')).toBeUndefined();
    await store.save('fixture-tenant', account);
    expect(await store.load('another-tenant')).toBeUndefined();
  });
  it('ignores corrupt records without exposing their contents', async () => {
    const store = new MesAuthenticationRecordStore(directory);
    await store.save('fixture-tenant', account);
    const [file] = await readdir(directory);
    await writeFile(path.join(directory, file), 'private malformed contents');
    expect(await store.load('fixture-tenant')).toBeUndefined();
    expect(JSON.stringify(console.warn.mock.calls)).not.toContain('private malformed contents');
  });
  it('rejects records for a different configured tenant', async () => {
    const store = new MesAuthenticationRecordStore(directory);
    expect(await store.save('different-tenant', account)).toBe(false);
    expect(await readdir(directory)).toEqual([]);
  });
  it('keeps sign-in usable when the account record cannot be saved', async () => {
    const blocker = path.join(directory, 'not-a-directory');
    await writeFile(blocker, 'fixture');
    expect(await new MesAuthenticationRecordStore(blocker).save('fixture-tenant', account)).toBe(false);
    expect(console.warn).toHaveBeenCalled();
  });
});
