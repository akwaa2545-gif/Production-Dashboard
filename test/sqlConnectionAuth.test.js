import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ credentials: [], pools: [], token: undefined, silentError: undefined, authenticate: undefined, getToken: undefined, authenticateCredential: undefined }));
vi.mock('@azure/identity', () => ({
  useIdentityPlugin: vi.fn(),
  InteractiveBrowserCredential: class {
    constructor(options) {
      this.options = options;
      this.getToken = vi.fn(async () => {
        if (mocks.getToken) return mocks.getToken(this);
        if (mocks.silentError) throw mocks.silentError;
        return mocks.token;
      });
      this.authenticate = vi.fn(async () => {
        if (mocks.authenticateCredential) return mocks.authenticateCredential(this);
        await mocks.authenticate?.();
        mocks.silentError = undefined;
      });
      mocks.credentials.push(this);
    }
  }
}));
vi.mock('@azure/identity-cache-persistence', () => ({ cachePersistencePlugin: {} }));
vi.mock('mssql', () => ({ default: {
  ConnectionPool: class {
    constructor() {
      this.connected = false;
      this.on = vi.fn();
      this.connect = vi.fn(async () => { this.connected = true; return this; });
      this.close = vi.fn(async () => { this.connected = false; });
      mocks.pools.push(this);
    }
  }
} }));

const config = { server: 'test-server', database: 'mes', auth: 'ActiveDirectoryInteractive', tenantId: 'test-tenant', appUrl: 'http://localhost:3000' };
const interactionRequired = () => Object.assign(new Error('Sign in required'), { name: 'AuthenticationRequiredError' });
let SqlRepository;
beforeEach(async () => {
  vi.resetModules();
  mocks.credentials = [];
  mocks.pools = [];
  mocks.silentError = undefined;
  mocks.authenticate = undefined;
  mocks.getToken = undefined;
  mocks.authenticateCredential = undefined;
  mocks.token = { token: 'fake-token', expiresOnTimestamp: Date.now() + 3600000 };
  ({ SqlRepository } = await import('../src/sqlRepository.js'));
});

describe('MES credential persistence lock recovery', () => {
  const persistentConfig = { ...config, tokenCachePersistence: true };
  const lockError = () => Object.assign(new Error('Not able to acquire lock. Exceeded amount of retries set in options'), { name: 'CrossPlatformLockError' });
  const isPersistent = (credential) => credential.options.tokenCachePersistenceOptions?.enabled === true;

  it('falls back silently after a persistent cache lock without opening a browser', async () => {
    mocks.getToken = async (credential) => { throw isPersistent(credential) ? lockError() : interactionRequired(); };
    await expect(new SqlRepository(persistentConfig).getPool()).rejects.toMatchObject({ name: 'AuthenticationRequiredError' });
    expect(mocks.credentials).toHaveLength(2);
    expect(isPersistent(mocks.credentials[0])).toBe(true);
    expect(isPersistent(mocks.credentials[1])).toBe(false);
    for (const credential of mocks.credentials) {
      expect(credential.options.disableAutomaticAuthentication).toBe(true);
      expect(credential.authenticate).not.toHaveBeenCalled();
    }
  });

  it('retries an explicit sign-in once with memory-only credentials after a cache lock', async () => {
    const signedIn = new Set();
    mocks.getToken = async (credential) => {
      if (!signedIn.has(credential)) throw interactionRequired();
      return mocks.token;
    };
    mocks.authenticateCredential = async (credential) => {
      if (isPersistent(credential)) throw lockError();
      signedIn.add(credential);
    };
    await expect(new SqlRepository(persistentConfig).authenticate()).resolves.toBeUndefined();
    expect(mocks.credentials).toHaveLength(2);
    expect(mocks.credentials[0].authenticate).toHaveBeenCalledTimes(1);
    expect(mocks.credentials[1].authenticate).toHaveBeenCalledTimes(1);
    expect(isPersistent(mocks.credentials[1])).toBe(false);
    expect(mocks.credentials[1].options.disableAutomaticAuthentication).toBe(true);
    expect(mocks.pools).toHaveLength(1);
  });

  it('shares one fallback credential and sign-in across concurrent report databases', async () => {
    const signedIn = new Set();
    let release;
    mocks.getToken = async (credential) => {
      if (isPersistent(credential)) throw lockError();
      if (!signedIn.has(credential)) throw interactionRequired();
      return mocks.token;
    };
    mocks.authenticateCredential = async (credential) => {
      await new Promise((resolve) => { release = resolve; });
      signedIn.add(credential);
    };
    const repositories = ['mes', 'reporting', 'yield'].map((database) => new SqlRepository({ ...persistentConfig, database }));
    const requests = Promise.all(repositories.map((repository) => repository.authenticate()));
    requests.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      expect(mocks.credentials).toHaveLength(2);
      expect(mocks.credentials[0].authenticate).not.toHaveBeenCalled();
      expect(mocks.credentials[1].authenticate).toHaveBeenCalledTimes(1);
    } finally {
      release?.();
    }
    await requests;
    expect(mocks.pools).toHaveLength(3);
  });

  it('retries the complete explicit sign-in when the lock occurs during post-auth token acquisition', async () => {
    const signedIn = new Set();
    mocks.getToken = async (credential) => {
      if (!signedIn.has(credential)) throw interactionRequired();
      if (isPersistent(credential)) throw lockError();
      return mocks.token;
    };
    mocks.authenticateCredential = async (credential) => { signedIn.add(credential); };
    await expect(new SqlRepository(persistentConfig).authenticate()).resolves.toBeUndefined();
    expect(mocks.credentials).toHaveLength(2);
    expect(mocks.credentials[0].authenticate).toHaveBeenCalledTimes(1);
    expect(mocks.credentials[1].authenticate).toHaveBeenCalledTimes(1);
    expect(mocks.pools).toHaveLength(1);
  });

  it('retains memory-only credentials when the same tenant reconnects and renews its token', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    mocks.getToken = async (credential) => {
      if (isPersistent(credential)) throw lockError();
      return mocks.token;
    };
    const repository = new SqlRepository(persistentConfig);
    await repository.getPool();
    Date.now.mockReturnValue(now + 3500000);
    mocks.token = { token: 'renewed-memory-token', expiresOnTimestamp: now + 7100000 };
    await new SqlRepository({ ...persistentConfig, database: 'reporting' }).getPool();
    const memoryReadsAfterRenewal = mocks.credentials[1].getToken.mock.calls.length;
    expect(memoryReadsAfterRenewal).toBeGreaterThan(1);
    await repository.getPool();
    expect(mocks.credentials).toHaveLength(2);
    expect(mocks.credentials[0].getToken).toHaveBeenCalledTimes(1);
    expect(mocks.credentials[1].getToken.mock.calls.length).toBeGreaterThanOrEqual(memoryReadsAfterRenewal);
    expect(mocks.credentials[1].authenticate).not.toHaveBeenCalled();
  });

  it.each([
    new Error('Not able to acquire lock. Exceeded amount of retries set in options'),
    Object.assign(new Error('Access denied to token cache'), { name: 'CredentialUnavailableError' })
  ])('does not fall back or sign in for unrelated token errors: %s', async (error) => {
    mocks.getToken = async () => { throw error; };
    await expect(new SqlRepository(persistentConfig).authenticate()).rejects.toBe(error);
    expect(mocks.credentials).toHaveLength(1);
    expect(mocks.credentials[0].authenticate).not.toHaveBeenCalled();
  });

  it('propagates a canceled sign-in without replacing persistent credentials', async () => {
    const error = new Error('User canceled');
    mocks.silentError = interactionRequired();
    mocks.authenticateCredential = async () => { throw error; };
    await expect(new SqlRepository(persistentConfig).authenticate()).rejects.toBe(error);
    expect(mocks.credentials).toHaveLength(1);
    expect(mocks.credentials[0].authenticate).toHaveBeenCalledTimes(1);
  });

  it('does not retry indefinitely when the memory-only sign-in also fails', async () => {
    const fallbackError = lockError();
    mocks.silentError = interactionRequired();
    mocks.authenticateCredential = async (credential) => { throw isPersistent(credential) ? lockError() : fallbackError; };
    await expect(new SqlRepository(persistentConfig).authenticate()).rejects.toBe(fallbackError);
    expect(mocks.credentials).toHaveLength(2);
    expect(mocks.credentials[0].authenticate).toHaveBeenCalledTimes(1);
    expect(mocks.credentials[1].authenticate).toHaveBeenCalledTimes(1);
  });

  it('does not replace an already nonpersistent credential on a lock error', async () => {
    const error = lockError();
    mocks.getToken = async () => { throw error; };
    await expect(new SqlRepository(config).getPool()).rejects.toBe(error);
    expect(mocks.credentials).toHaveLength(1);
    expect(mocks.credentials[0].authenticate).not.toHaveBeenCalled();
  });
});
afterEach(() => vi.restoreAllMocks());

describe('shared MES connection authentication', () => {
  it('disables automatic browser sign-in for ordinary dashboard queries', async () => {
    mocks.silentError = interactionRequired();
    await expect(new SqlRepository(config).getPool()).rejects.toMatchObject({ name: 'AuthenticationRequiredError' });
    expect(mocks.credentials[0].options.disableAutomaticAuthentication).toBe(true);
    expect(mocks.credentials[0].authenticate).not.toHaveBeenCalled();
  });

  it('does not redirect successful sign-in to another dashboard tab', async () => {
    await new SqlRepository(config).getPool();
    const html = mocks.credentials[0].options.browserCustomizationOptions.successMessage;
    expect(html).not.toMatch(/http-equiv|window\.location|<script/i);
    expect(html).toMatch(/close.*return/i);
  });

  it('reuses healthy shared connections when several reports authenticate', async () => {
    const first = new SqlRepository(config);
    const pool = await first.getPool();
    await Promise.all([first.authenticate(), new SqlRepository(config).authenticate(), first.authenticate()]);
    expect(mocks.pools).toHaveLength(1);
    expect(pool.close).not.toHaveBeenCalled();
    expect(mocks.credentials[0].authenticate).not.toHaveBeenCalled();
  });

  it('shares one explicit interactive sign-in across connections for a tenant', async () => {
    mocks.silentError = interactionRequired();
    let release;
    mocks.authenticate = () => new Promise((resolve) => { release = resolve; });
    const repositories = [new SqlRepository(config), new SqlRepository(config), new SqlRepository({ ...config, database: 'reporting' })];
    const requests = repositories.map((repository) => repository.authenticate());
    const completed = Promise.all(requests);
    completed.catch(() => undefined);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(mocks.credentials).toHaveLength(1);
    expect(mocks.credentials[0].authenticate).toHaveBeenCalledTimes(1);
    release();
    await completed;
    expect(mocks.pools).toHaveLength(2);
  });

  it('queues silent report token acquisition behind an active sign-in for the same tenant', async () => {
    let release;
    let authenticating = false;
    let signedIn = false;
    const overlappingTokenReads = vi.fn();
    mocks.getToken = async () => {
      if (authenticating) overlappingTokenReads();
      if (!signedIn) throw interactionRequired();
      return mocks.token;
    };
    mocks.authenticateCredential = async () => {
      authenticating = true;
      await new Promise((resolve) => { release = resolve; });
      signedIn = true;
      authenticating = false;
    };
    const signIn = new SqlRepository(config).authenticate();
    signIn.catch(() => undefined);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const credential = mocks.credentials[0];
    const readsBeforeReport = credential.getToken.mock.calls.length;
    const report = new SqlRepository({ ...config, database: 'another-report' }).getPool();
    report.catch(() => undefined);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect(credential.getToken).toHaveBeenCalledTimes(readsBeforeReport);
      expect(overlappingTokenReads).not.toHaveBeenCalled();
    } finally {
      release();
    }
    const [, pool] = await Promise.all([signIn, report]);
    expect(pool.connected).toBe(true);
    expect(overlappingTokenReads).not.toHaveBeenCalled();
    expect(credential.authenticate).toHaveBeenCalledTimes(1);
    expect(mocks.credentials).toHaveLength(1);
  });

  it('does not open a browser for unrelated credential or database failures', async () => {
    mocks.silentError = new Error('Tenant unavailable');
    await expect(new SqlRepository(config).authenticate()).rejects.toThrow('Tenant unavailable');
    expect(mocks.credentials[0].authenticate).not.toHaveBeenCalled();
  });

  it('refreshes a nearly expired pool once, even through repository fast paths', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const first = new SqlRepository(config);
    const second = new SqlRepository(config);
    const oldPool = await first.getPool();
    await second.getPool();
    Date.now.mockReturnValue(now + 3500000);
    mocks.token = { token: 'refreshed', expiresOnTimestamp: now + 7100000 };
    const pools = await Promise.all([first.getPool(), second.getPool(), first.getPool()]);
    expect(mocks.pools).toHaveLength(2);
    expect(oldPool.close).toHaveBeenCalledTimes(1);
    expect(new Set(pools).size).toBe(1);
    expect(pools[0]).not.toBe(oldPool);
    expect(mocks.credentials[0].authenticate).not.toHaveBeenCalled();
  });

  it('replaces disconnected pools instead of returning a stale local reference', async () => {
    const repository = new SqlRepository(config);
    const oldPool = await repository.getPool();
    oldPool.connected = false;
    expect(await repository.getPool()).not.toBe(oldPool);
  });

  it('a late reset from another repository does not close the recovered pool', async () => {
    const first = new SqlRepository(config);
    const second = new SqlRepository(config);
    const oldPool = await first.getPool();
    await second.getPool();
    await first.resetConnection();
    const recoveredPool = await first.getPool();
    await second.resetConnection();
    expect(recoveredPool.close).not.toHaveBeenCalled();
    expect(oldPool.close).toHaveBeenCalledTimes(1);
    expect(await second.getPool()).toBe(recoveredPool);
  });

  it('a late failure on the same repository cannot reset a newer connection generation', async () => {
    const repository = new SqlRepository(config);
    await repository.getPool();
    const generation = repository.getConnectionGeneration();
    await repository.resetConnection(generation);
    const recoveredPool = await repository.getPool();
    await repository.resetConnection(generation);
    expect(recoveredPool.close).not.toHaveBeenCalled();
    expect(await repository.getPool()).toBe(recoveredPool);
  });

  it('allows a later explicit sign-in after a canceled attempt', async () => {
    mocks.silentError = interactionRequired();
    mocks.authenticate = vi.fn().mockRejectedValueOnce(new Error('User canceled')).mockResolvedValueOnce(undefined);
    const repository = new SqlRepository(config);
    await expect(repository.authenticate()).rejects.toThrow('User canceled');
    await expect(repository.authenticate()).resolves.toBeUndefined();
    expect(mocks.credentials[0].authenticate).toHaveBeenCalledTimes(2);
  });
});
