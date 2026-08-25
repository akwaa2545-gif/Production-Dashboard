export class TtlCache {
  constructor({ maxEntries = 500, now = () => Date.now() } = {}) {
    this.maxEntries = Math.max(10, maxEntries);
    this.now = now;
    this.entries = new Map();
    this.inFlight = new Map();
    this.invalidatedRequests = new WeakSet();
  }

  async getOrSet(key, ttlMs, loader, refreshBeforeMs = 0) {
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > this.now() + refreshBeforeMs) return { value: existing.value, status: 'HIT' };
    if (this.inFlight.has(key)) return { value: await this.inFlight.get(key), status: 'COALESCED' };
    const request = Promise.resolve().then(loader);
    this.inFlight.set(key, request);
    try {
      const value = await request;
      if (!this.invalidatedRequests.has(request)) {
        this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
        this.trim();
      }
      return { value, status: 'MISS' };
    } finally {
      if (this.inFlight.get(key) === request) this.inFlight.delete(key);
    }
  }

  invalidate(prefix) {
    for (const key of new Set([...this.entries.keys(), ...this.inFlight.keys()])) {
      if (!key.startsWith(prefix)) continue;
      this.entries.delete(key);
      const request = this.inFlight.get(key);
      if (request) this.invalidatedRequests.add(request);
      this.inFlight.delete(key);
    }
  }

  clear() {
    this.entries.clear();
    for (const request of this.inFlight.values()) this.invalidatedRequests.add(request);
    this.inFlight.clear();
  }

  trim() {
    const now = this.now();
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
  }
}
