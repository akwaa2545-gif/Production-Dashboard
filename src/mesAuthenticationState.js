const sessions = new Map();
export function updateMesAuthenticationState(tenantId, state) {
  const key = tenantId || 'common';
  const previous = sessions.get(key);
  sessions.set(key, { state, updatedAt: previous?.state === state ? previous.updatedAt : new Date().toISOString() });
}
export function readMesAuthenticationState(tenantId) {
  return { ...(sessions.get(tenantId || 'common') || { state: 'UNKNOWN' }) };
}
