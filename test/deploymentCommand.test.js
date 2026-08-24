import { describe, expect, it } from 'vitest';
import { commandInvocation } from '../src/deploymentCommand.js';

describe('commandInvocation', () => {
  it('runs npm through cmd.exe on Windows', () => {
    expect(commandInvocation('npm', ['ci', '--omit=dev'], 'win32')).toEqual({ file: 'cmd.exe', args: ['/d', '/s', '/c', 'npm', 'ci', '--omit=dev'] });
  });

  it('runs commands directly on non-Windows hosts', () => {
    expect(commandInvocation('npm', ['ci'], 'linux')).toEqual({ file: 'npm', args: ['ci'] });
  });
});
