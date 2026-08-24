import { describe, expect, it } from 'vitest';
import { isChildRunning } from '../src/dashboardProcessManager.js';

describe('isChildRunning', () => {
  it('does not treat a child already terminated by SIGTERM as running', () => {
    expect(isChildRunning({ exitCode: null, killed: true })).toBe(false);
  });

  it('recognizes an active child process', () => {
    expect(isChildRunning({ exitCode: null, killed: false })).toBe(true);
  });
});
