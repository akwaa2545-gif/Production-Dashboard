import { describe, expect, it } from 'vitest';
import { npmCommandForPlatform } from '../src/deploymentCommand.js';

describe('npmCommandForPlatform', () => {
  it('uses npm.cmd on Windows so Node can launch npm directly', () => {
    expect(npmCommandForPlatform('win32')).toBe('npm.cmd');
  });

  it('uses npm on non-Windows hosts', () => {
    expect(npmCommandForPlatform('linux')).toBe('npm');
  });
});
