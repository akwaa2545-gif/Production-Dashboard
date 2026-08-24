function cleanRevision(value) {
  return String(value || '').trim();
}

function rollbackError(revision, cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new Error(`Deployment failed (${message}) and was rolled back to ${revision}.`);
}

/**
 * Keeps a dedicated deployment clone aligned with one Git branch.
 * The caller owns command execution and the dashboard process so this class
 * can be tested without touching a real deployment machine.
 */
export class DeploymentSupervisor {
  constructor({ command, processManager, healthCheck, logger = console, remote = 'origin', branch = 'main' }) {
    if (typeof command !== 'function') throw new Error('A command runner is required.');
    if (!processManager || typeof processManager.start !== 'function' || typeof processManager.stop !== 'function' || typeof processManager.isRunning !== 'function') throw new Error('A process manager with start, stop, and isRunning methods is required.');
    if (typeof healthCheck !== 'function') throw new Error('A health check function is required.');
    this.command = command;
    this.processManager = processManager;
    this.healthCheck = healthCheck;
    this.logger = logger;
    this.remote = remote;
    this.branch = branch;
  }

  async checkForUpdate() {
    await this.command('git', ['fetch', this.remote, this.branch]);
    const currentRevision = cleanRevision(await this.command('git', ['rev-parse', 'HEAD']));
    const nextRevision = cleanRevision(await this.command('git', ['rev-parse', `${this.remote}/${this.branch}`]));
    if (!currentRevision || !nextRevision) throw new Error('Git did not return a deployment revision.');
    if (currentRevision === nextRevision) {
      if (this.processManager.isRunning()) return { updated: false, revision: currentRevision };
      this.logger.error(`Dashboard process is not running; restarting ${currentRevision}.`);
      await this.processManager.start(currentRevision);
      if (!await this.healthCheck(currentRevision) || !this.processManager.isRunning()) throw new Error('Dashboard restart did not pass its health check.');
      return { updated: false, restarted: true, revision: currentRevision };
    }

    const changes = cleanRevision(await this.command('git', ['status', '--porcelain']));
    if (changes) throw new Error('Deployment clone has local changes; refusing to overwrite it.');

    this.logger.info(`Deploying ${nextRevision} (replacing ${currentRevision}).`);
    try {
      await this.processManager.stop();
      await this.command('git', ['reset', '--hard', nextRevision]);
      await this.command('npm', ['ci', '--omit=dev']);
      await this.command('git', ['restore', '--', 'package-lock.json']);
      await this.processManager.start(nextRevision);
      if (!await this.healthCheck(nextRevision) || !this.processManager.isRunning()) throw new Error('Dashboard health check did not succeed.');
      this.logger.info(`Deployment ${nextRevision} is healthy.`);
      return { updated: true, revision: nextRevision };
    } catch (error) {
      await this.rollback(currentRevision, error);
    }
  }

  async rollback(revision, cause) {
    this.logger.error(`Deployment failed; restoring ${revision}.`);
    try {
      await this.processManager.stop();
      await this.command('git', ['reset', '--hard', revision]);
      await this.command('git', ['clean', '-fd']);
      await this.command('npm', ['ci', '--omit=dev']);
      await this.command('git', ['restore', '--', 'package-lock.json']);
      await this.processManager.start(revision);
      if (!await this.healthCheck(revision) || !this.processManager.isRunning()) throw new Error('The restored dashboard did not pass its health check.');
    } catch (rollbackFailure) {
      const detail = rollbackFailure instanceof Error ? rollbackFailure.message : String(rollbackFailure);
      throw new Error(`Deployment failed and rollback to ${revision} also failed: ${detail}`);
    }
    throw rollbackError(revision, cause);
  }
}
