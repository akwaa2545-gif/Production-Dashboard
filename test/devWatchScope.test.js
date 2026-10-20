import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { developmentWatchArguments } from '../scripts/dev-server.mjs';

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(predicate, diagnostics, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Watch fixture timed out: ${diagnostics()}`);
    await pause(50);
  }
}

async function stopWatcher(watcher) {
  if (!watcher?.pid || watcher.exitCode !== null) return;
  if (process.platform === 'win32') {
    execFileSync('taskkill.exe', ['/PID', String(watcher.pid), '/T', '/F'], {
      windowsHide: true, stdio: 'ignore', timeout: 5000,
    });
  } else {
    process.kill(-watcher.pid, 'SIGTERM');
  }
  await waitFor(() => watcher.exitCode !== null || watcher.signalCode !== null, () => 'Watcher did not stop', 5000);
}

describe('development server watch scope', () => {
  it.each(['win32', 'darwin'])('scopes source watching on %s', (platform) => {
    expect(developmentWatchArguments(platform)).toEqual(['--watch-path=src', '--watch-preserve-output', 'src/server.js']);
  });

  it.each(['linux', 'freebsd'])('uses portable dependency watching on %s', (platform) => {
    expect(developmentWatchArguments(platform)).toEqual(['--watch', '--watch-preserve-output', 'src/server.js']);
  });

  it.skipIf(!['win32', 'darwin'].includes(process.platform))('ignores frontend and artifact changes but restarts once for backend changes', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'dashboard-dev-watch-'));
    let watcher;
    try {
      await Promise.all(['src', 'public', 'artifacts', 'scripts'].map((directory) => mkdir(path.join(temporaryRoot, directory))));
      const source = "import { chartState } from '../public/chart-state.mjs';\nconsole.log(`[watch-fixture-ready]${process.pid}:${chartState}`);\nsetInterval(() => {}, 1000);\n";
      await Promise.all([
        writeFile(path.join(temporaryRoot, 'package.json'), '{"type":"module"}'),
        writeFile(path.join(temporaryRoot, 'src/server.js'), source),
        writeFile(path.join(temporaryRoot, 'public/chart-state.mjs'), 'export const chartState = 1;\n'),
        readFile(new URL('../scripts/dev-server.mjs', import.meta.url)).then((runner) => writeFile(path.join(temporaryRoot, 'scripts/dev-server.mjs'), runner)),
      ]);
      const { scripts } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
      const [executable, ...arguments_] = scripts.dev.trim().split(/\s+/);
      expect(executable).toBe('node');
      watcher = spawn(process.execPath, arguments_, {
        cwd: temporaryRoot, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      let spawnError;
      watcher.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
      watcher.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
      watcher.on('error', (error) => { spawnError = error; });
      const readyPids = () => [...output.matchAll(/\[watch-fixture-ready\](\d+):/g)].map((match) => Number(match[1]));
      const diagnostics = () => spawnError?.message || output;
      await waitFor(() => readyPids().length === 1 || spawnError, diagnostics);
      if (spawnError) throw spawnError;
      const initialPid = readyPids()[0];
      await pause(250);

      await writeFile(path.join(temporaryRoot, 'public/chart-state.mjs'), 'export const chartState = 2;\n');
      await writeFile(path.join(temporaryRoot, 'artifacts/chart-result.txt'), 'Chart verification result\n');
      await pause(2000);
      expect(readyPids(), diagnostics()).toEqual([initialPid]);

      await writeFile(path.join(temporaryRoot, 'src/server.js'), `${source}// backend change\n`);
      await waitFor(() => readyPids().length >= 2, diagnostics);
      await pause(1000);
      expect(readyPids(), diagnostics()).toHaveLength(2);
      expect(readyPids()[1]).not.toBe(initialPid);
      expect(output).toContain(':2');
    } finally {
      await stopWatcher(watcher);
      const resolvedRoot = path.resolve(temporaryRoot);
      if (path.dirname(resolvedRoot) !== path.resolve(tmpdir()) || !path.basename(resolvedRoot).startsWith('dashboard-dev-watch-')) {
        throw new Error('Refusing to remove an unexpected fixture directory');
      }
      await rm(resolvedRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }, 30000);
});
