import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isChildRunning } from '../src/dashboardProcessManager.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('isChildRunning', () => {
  it('does not treat a child already terminated by SIGTERM as running', () => {
    expect(isChildRunning({ exitCode: null, killed: true })).toBe(false);
  });

  it('recognizes an active child process', () => {
    expect(isChildRunning({ exitCode: null, killed: false })).toBe(true);
  });

  it('allows the supervisor to restart a child that has been killed but has not reported an exit code yet', () => {
    const supervisor = read('scripts/dashboard-supervisor.mjs');

    expect(supervisor).toContain('if (this.isRunning()) throw new Error');
    expect(supervisor).not.toContain("if (dashboard && dashboard.exitCode === null) throw new Error('Dashboard is already running.')");
  });
});
