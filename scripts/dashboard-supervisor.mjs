import 'dotenv/config';
import { execFile, spawn } from 'node:child_process';
import http from 'node:http';
import { promisify } from 'node:util';
import { DeploymentSupervisor } from '../src/deploymentSupervisor.js';

const execFileAsync = promisify(execFile);
const projectDirectory = process.cwd();
const branch = process.env.DEPLOY_BRANCH || 'main';
const intervalMs = Math.max(Number(process.env.DEPLOY_INTERVAL_MS) || 300000, 60000);
const healthUrl = process.env.DEPLOY_HEALTH_URL || `http://127.0.0.1:${process.env.PORT || 5000}/api/health`;
const healthTimeoutMs = Math.max(Number(process.env.DEPLOY_HEALTH_TIMEOUT_MS) || 60000, 10000);

function command(file, args) {
  return execFileAsync(file, args, { cwd: projectDirectory, windowsHide: true }).then(({ stdout }) => stdout);
}

function requestHealth(expectedRevision) {
  return new Promise((resolve) => {
    const request = http.get(healthUrl, { timeout: 5000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          const payload = JSON.parse(body);
          resolve(response.statusCode === 200 && payload?.success === true && payload?.data?.status === 'ok' && payload?.data?.revision === expectedRevision);
        } catch {
          resolve(false);
        }
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

async function waitForHealth(expectedRevision) {
  const deadline = Date.now() + healthTimeoutMs;
  while (Date.now() < deadline) {
    if (await requestHealth(expectedRevision)) return true;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return false;
}

let dashboard;
const processManager = {
  async start(revision) {
    if (dashboard && dashboard.exitCode === null) throw new Error('Dashboard is already running.');
    dashboard = spawn(process.execPath, ['src/server.js'], {
      cwd: projectDirectory,
      env: { ...process.env, HOST: process.env.HOST || '0.0.0.0', PORT: process.env.PORT || '5000', DEPLOY_REVISION: revision },
      stdio: 'inherit',
      windowsHide: true
    });
    dashboard.once('exit', (code, signal) => console.warn(`Dashboard process exited (code ${code}, signal ${signal || 'none'}).`));
    dashboard.once('error', (error) => console.error(`Dashboard process failed to start: ${error.message}`));
  },
  async stop() {
    if (!dashboard || dashboard.exitCode !== null) return;
    const exiting = new Promise((resolve) => dashboard.once('exit', resolve));
    dashboard.kill();
    const stopped = await Promise.race([exiting.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 15000))]);
    if (!stopped) throw new Error('Dashboard did not stop within 15 seconds.');
  },
  isRunning() {
    return Boolean(dashboard && dashboard.exitCode === null && !dashboard.killed);
  }
};

const supervisor = new DeploymentSupervisor({ command, processManager, healthCheck: waitForHealth, branch });
let checking = false;
async function checkForUpdate() {
  if (checking) return;
  checking = true;
  try {
    const result = await supervisor.checkForUpdate();
    if (!result.updated) console.log(`No deployment needed; running ${result.revision}.`);
  } catch (error) {
    console.error(`Deployment check failed: ${error.message}`);
  } finally {
    checking = false;
  }
}

const initialRevision = String(await command('git', ['rev-parse', 'HEAD'])).trim();
await processManager.start(initialRevision);
if (!await waitForHealth(initialRevision) || !processManager.isRunning()) {
  await processManager.stop();
  throw new Error(`Dashboard did not become healthy at ${healthUrl}.`);
}
console.log(`Deployment supervisor is running. Checking ${branch} every ${Math.round(intervalMs / 60000)} minute(s).`);
await checkForUpdate();
const timer = setInterval(checkForUpdate, intervalMs);

async function shutdown() {
  clearInterval(timer);
  await processManager.stop();
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
