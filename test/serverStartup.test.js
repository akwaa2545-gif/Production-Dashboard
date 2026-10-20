import fs from 'node:fs';
import vm from 'node:vm';
import net from 'node:net';
import express from 'express';
import { describe, expect, it, vi } from 'vitest';

const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8').replace(/^import[^\r\n]*\r?\n/gm, '');

function startServer({ error, env = {}, listen } = {}) {
  const timers = [];
  const schedule = vi.fn((callback, delay) => {
    const timer = { callback, delay, unref: vi.fn() };
    timers.push(timer);
    return timer;
  });
  const process = { env, exitCode: undefined };
  const console = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const app = { listen: vi.fn(listen || ((_port, _host, callback) => callback(error))) };
  vm.runInNewContext(source, {
    createApp: () => app, process, console, setTimeout: schedule, setInterval: schedule,
  }, { filename: 'server-startup.js' });
  return { app, process, console, timers, schedule };
}

describe('Dashboard server startup', () => {
  it('reports an occupied port as a failure without claiming to listen or starting background jobs', () => {
    const error = Object.assign(new Error('listen EADDRINUSE: address already in use 0.0.0.0:3000'), { code: 'EADDRINUSE' });
    const result = startServer({ error });
    expect(result.process.exitCode).toBe(1);
    expect(result.console.log).not.toHaveBeenCalled();
    expect(result.schedule).not.toHaveBeenCalled();
    const diagnostic = result.console.error.mock.calls.flat().join(' ');
    expect(diagnostic).toContain('3000');
    expect(diagnostic).toMatch(/already.{0,30}(?:use|running)|EADDRINUSE/i);
  });

  it('fails clearly for other listen errors without scheduling background work', () => {
    const error = Object.assign(new Error('permission denied while binding socket'), { code: 'EACCES' });
    const result = startServer({ error, env: { HOST: '127.0.0.1', PORT: '4200' } });
    expect(result.process.exitCode).toBe(1);
    expect(result.console.log).not.toHaveBeenCalled();
    expect(result.timers).toHaveLength(0);
    expect(result.console.error.mock.calls.flat().join(' ')).toMatch(/permission denied|EACCES/i);
  });

  it('announces successful listening and retains the existing unreferenced background jobs', () => {
    const result = startServer({ env: { HOST: '127.0.0.1', PORT: '4200' } });
    expect(result.app.listen).toHaveBeenCalledWith(4200, '127.0.0.1', expect.any(Function));
    expect(result.process.exitCode).not.toBe(1);
    expect(result.console.error).not.toHaveBeenCalled();
    expect(result.console.log.mock.calls.flat().join(' ')).toContain('listening on http://127.0.0.1:4200');
    expect(result.timers).toHaveLength(16);
    expect(result.timers.every((timer) => timer.unref.mock.calls.length === 1)).toBe(true);
    expect(result.timers.map((timer) => timer.delay)).toContain(3600000);
  });

  it('continues honoring the disabled cache-warmer setting after successful startup', () => {
    const result = startServer({ env: { DASHBOARD_CACHE_WARMER_ENABLED: 'false' } });
    expect(result.timers).toHaveLength(14);
    expect(result.timers.every((timer) => timer.unref.mock.calls.length === 1)).toBe(true);
    expect(result.process.exitCode).not.toBe(1);
  });

  it('handles the actual Express listen callback when an ephemeral local port is occupied', async () => {
    const occupied = net.createServer();
    let attempted;
    try {
      await new Promise((resolve, reject) => { occupied.once('error', reject); occupied.listen(0, '127.0.0.1', resolve); });
      const port = occupied.address().port;
      let finish;
      const completed = new Promise((resolve) => { finish = resolve; });
      const result = startServer({
        env: { PORT: String(port), HOST: '127.0.0.1' },
        listen: (requestedPort, host, callback) => {
          attempted = express().listen(requestedPort, host, (error) => { callback(error); finish(error); });
          return attempted;
        },
      });
      const error = await completed;
      expect(error.code).toBe('EADDRINUSE');
      expect(result.process.exitCode).toBe(1);
      expect(result.console.log).not.toHaveBeenCalled();
      expect(result.timers).toHaveLength(0);
    } finally {
      if (attempted?.listening) await new Promise((resolve) => attempted.close(resolve));
      if (occupied.listening) await new Promise((resolve) => occupied.close(resolve));
    }
  });
});
