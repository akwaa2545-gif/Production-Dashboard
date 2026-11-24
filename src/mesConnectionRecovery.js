const allowedStates = new Set(['UNKNOWN', 'RECONNECTING', 'SIGNING_IN', 'AUTH_REQUIRED', 'UNAVAILABLE', 'CONNECTED']);
export function createMesConnectionRecovery(sources) {
  let pending;
  let lastAttemptAt;
  const results = new Map();
  function status() {
    const connections = sources().filter(source => source.config.metadataReady).map(({ dataset, database, config }) => {
      const raw = database.getAuthenticationStatus?.() || results.get(dataset) || {};
      const state = allowedStates.has(raw.state) ? raw.state : 'UNKNOWN';
      return { dataset, state, persistenceEnabled: config.tokenCachePersistence === true };
    });
    const selected = ['AUTH_REQUIRED', 'SIGNING_IN', 'UNAVAILABLE', 'RECONNECTING', 'UNKNOWN', 'CONNECTED']
      .map(state => connections.find(connection => connection.state === state)).find(Boolean);
    return { state: selected?.state || 'NOT_CONFIGURED', needsAuthentication: selected?.state === 'AUTH_REQUIRED',
      dataset: selected?.dataset, reconnecting: Boolean(pending), lastAttemptAt, retryIntervalSeconds: 60, connections };
  }
  function reconnect() {
    if (pending) return pending;
    lastAttemptAt = new Date().toISOString();
    const work = Promise.resolve().then(async () => {
      const checked = new Set();
      await Promise.all(sources().filter(source => source.config.metadataReady).map(async ({ dataset, database }) => {
        if (checked.has(database) || (typeof database.checkConnection !== 'function' && typeof database.getPool !== 'function')) return;
        checked.add(database);
        try {
          if (typeof database.checkConnection === 'function') await database.checkConnection();
          else await database.getPool();
          results.set(dataset, { state: 'CONNECTED' });
        } catch (error) {
          results.set(dataset, { state: error.name === 'AuthenticationRequiredError' ? 'AUTH_REQUIRED' : 'UNAVAILABLE' });
        }
      }));
    }).finally(() => { pending = undefined; });
    pending = work;
    return work;
  }
  return { status, reconnect };
}
