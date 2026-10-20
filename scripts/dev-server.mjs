import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function developmentWatchArguments(platform = process.platform) {
  const watch = ['win32', 'darwin'].includes(platform) ? '--watch-path=src' : '--watch';
  return [watch, '--watch-preserve-output', 'src/server.js'];
}

function runDevelopmentServer() {
  const projectDirectory = fileURLToPath(new URL('../', import.meta.url));
  const watcher = spawn(process.execPath, developmentWatchArguments(), {
    cwd: projectDirectory, stdio: 'inherit', windowsHide: true, detached: process.platform !== 'win32',
  });
  let stopSignal;
  const reportError = (error) => {
    console.error(`Development server failed: ${error.message}`);
    process.exitCode = 1;
  };
  const stop = (signal) => {
    if (stopSignal || !watcher.pid || watcher.exitCode !== null || watcher.signalCode !== null) return;
    stopSignal = signal;
    if (process.platform === 'win32') {
      // Windows signal emulation terminates only one PID; stop this watcher's whole tree.
      execFile('taskkill.exe', ['/PID', String(watcher.pid), '/T', '/F'], { windowsHide: true }, (error) => {
        if (error && watcher.exitCode === null && watcher.signalCode === null) reportError(error);
      });
    } else {
      try { process.kill(-watcher.pid, signal); } catch (error) { if (error.code !== 'ESRCH') reportError(error); }
    }
  };
  const interrupt = () => stop('SIGINT');
  const terminate = () => stop('SIGTERM');
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  watcher.once('error', reportError);
  watcher.once('close', (code, signal) => {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    const endedBy = stopSignal || signal;
    process.exitCode = endedBy === 'SIGINT' ? 130 : endedBy === 'SIGTERM' ? 143 : code ?? 1;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runDevelopmentServer();
