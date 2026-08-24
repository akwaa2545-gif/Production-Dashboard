import { describe, expect, it, vi } from 'vitest';
import { DeploymentSupervisor } from '../src/deploymentSupervisor.js';

function commandStub(responses) {
  const command = vi.fn(async (file, args) => {
    const key = `${file} ${args.join(' ')}`;
    const response = responses[key];
    if (response instanceof Error) throw response;
    return response ?? '';
  });
  return command;
}

describe('DeploymentSupervisor', () => {
  it('leaves the running dashboard alone when origin has no newer commit', async () => {
    const command = commandStub({
      'git fetch origin main': '',
      'git rev-parse HEAD': 'current-sha',
      'git rev-parse origin/main': 'current-sha'
    });
    const processManager = { stop: vi.fn(), start: vi.fn(), isRunning: vi.fn().mockReturnValue(true) };
    const supervisor = new DeploymentSupervisor({ command, processManager, healthCheck: vi.fn(), logger: { info: vi.fn(), error: vi.fn() } });

    await expect(supervisor.checkForUpdate()).resolves.toEqual({ updated: false, revision: 'current-sha' });
    expect(processManager.stop).not.toHaveBeenCalled();
    expect(processManager.start).not.toHaveBeenCalled();
  });

  it('installs, restarts, and records a verified newer revision', async () => {
    const command = commandStub({
      'git fetch origin main': '',
      'git rev-parse HEAD': 'old-sha',
      'git rev-parse origin/main': 'new-sha',
      'git status --porcelain': '',
      'git reset --hard new-sha': '',
      'npm ci --omit=dev': ''
    });
    const processManager = { stop: vi.fn(), start: vi.fn(), isRunning: vi.fn().mockReturnValue(true) };
    const healthCheck = vi.fn().mockResolvedValue(true);
    const supervisor = new DeploymentSupervisor({ command, processManager, healthCheck, logger: { info: vi.fn(), error: vi.fn() } });

    await expect(supervisor.checkForUpdate()).resolves.toEqual({ updated: true, revision: 'new-sha' });
    expect(command).toHaveBeenCalledWith('git', ['reset', '--hard', 'new-sha']);
    expect(command).toHaveBeenCalledWith('npm', ['ci', '--omit=dev']);
    expect(command).toHaveBeenCalledWith('git', ['restore', '--', 'package-lock.json']);
    expect(processManager.stop).toHaveBeenCalledTimes(1);
    expect(processManager.start).toHaveBeenCalledTimes(1);
    expect(healthCheck).toHaveBeenCalledTimes(1);
  });

  it('rolls back to the previous revision when the updated dashboard fails its health check', async () => {
    const command = commandStub({
      'git fetch origin main': '',
      'git rev-parse HEAD': 'old-sha',
      'git rev-parse origin/main': 'new-sha',
      'git status --porcelain': '',
      'git reset --hard new-sha': '',
      'git reset --hard old-sha': '',
      'npm ci --omit=dev': ''
    });
    const processManager = { stop: vi.fn(), start: vi.fn(), isRunning: vi.fn().mockReturnValue(true) };
    const healthCheck = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const supervisor = new DeploymentSupervisor({ command, processManager, healthCheck, logger: { info: vi.fn(), error: vi.fn() } });

    await expect(supervisor.checkForUpdate()).rejects.toThrow('rolled back');
    expect(command).toHaveBeenCalledWith('git', ['reset', '--hard', 'old-sha']);
    expect(command).toHaveBeenCalledWith('git', ['clean', '-fd']);
    expect(processManager.start).toHaveBeenCalledTimes(2);
    expect(processManager.stop).toHaveBeenCalledTimes(2);
  });

  it('refuses to overwrite a deployment clone that has local changes', async () => {
    const command = commandStub({
      'git fetch origin main': '',
      'git rev-parse HEAD': 'old-sha',
      'git rev-parse origin/main': 'new-sha',
      'git status --porcelain': ' M src/server.js'
    });
    const processManager = { stop: vi.fn(), start: vi.fn(), isRunning: vi.fn().mockReturnValue(true) };
    const supervisor = new DeploymentSupervisor({ command, processManager, healthCheck: vi.fn(), logger: { info: vi.fn(), error: vi.fn() } });

    await expect(supervisor.checkForUpdate()).rejects.toThrow('local changes');
    expect(processManager.stop).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalledWith('git', ['reset', '--hard', 'new-sha']);
  });
});
