# Deployment Agent Runbook

Use this runbook to add a safe, self-updating deployment agent to a Node.js project on a dedicated Windows computer. The agent keeps a clean deployment clone aligned with one Git branch, verifies every release, and rolls back if the new version is unhealthy.

## What the agent does

1. Starts the application at the current Git revision.
2. Polls the configured remote branch on a fixed interval.
3. When a new commit appears, stops the application, checks out that revision, installs production dependencies, and starts the application again.
4. Calls a revision-aware health endpoint.
5. If the new version is not healthy, restores the previous revision and restarts it.

Keep the deployment clone separate from development folders and uploaded files. The agent deliberately refuses to overwrite a clone with local changes.

## Required application contract

Every project using this pattern needs the following pieces.

| Requirement | Purpose |
| --- | --- |
| A dedicated deployment branch, normally `main` | Defines the revision that production follows. |
| Lockfile | Lets the agent install reproducible production dependencies with `npm ci --omit=dev`. |
| Health endpoint | Confirms that the new process is serving the expected revision. |
| Revision environment variable | Allows the health endpoint to prove that the process matches the deployed commit. |
| Start and stop process manager | Ensures only one application process runs at a time. |
| Clean deployment clone | Prevents release automation from modifying developer work. |

For a Node.js application, expose a health response similar to this:

```json
{
  "success": true,
  "data": {
    "status": "ok",
    "revision": "<DEPLOY_REVISION>"
  }
}
```

The deployment agent must set `DEPLOY_REVISION` when it starts the app and require the health response to return the same value.

## Files to copy into a new project

Adapt these files from this project:

| File | Responsibility |
| --- | --- |
| `scripts/dashboard-supervisor.mjs` | Polling, deployment, health check, and rollback loop. Rename for the new project if preferred. |
| `src/deploymentSupervisor.js` | Testable deployment and rollback workflow. |
| `src/dashboardProcessManager.js` | Child-process running-state check. |
| `src/deploymentCommand.js` | Windows-safe `npm` command invocation. |
| `run-deployment-supervisor.cmd` | Windows entry point for the scheduled task. |
| `test/deploymentSupervisor.test.js` | Deployment, rollback, and unchanged-revision tests. |
| `test/dashboardProcessManager.test.js` | Restart-state regression tests. |

Update the application command, health URL, port, branch, and environment variables for the new project. Do not copy `.env` files, access tokens, or credential caches between machines or projects.

## First-time setup on the deployment computer

Run these commands in Command Prompt under the Windows account that will run the scheduled task:

```cmd
git clone <REPOSITORY_URL> C:\Deploy\<PROJECT_NAME>
cd /d C:\Deploy\<PROJECT_NAME>
copy .env.example .env
npm ci --omit=dev
run-deployment-supervisor.cmd
```

Configure `.env` with deployment-machine values only. Keep secrets in that file or the approved secret store; never commit them.

After the first successful health check, create a Windows Scheduled Task with these settings:

- Trigger: **At log on** for the dedicated deployment user.
- Action: run `run-deployment-supervisor.cmd`.
- Start in: `C:\Deploy\<PROJECT_NAME>`.
- Run only while that dedicated user is logged on when interactive authentication is required.
- Keep the task running continuously.

## Normal release procedure

1. Run the project test suite locally.
2. Commit the release change.
3. Push the tested commit to the deployment branch.
4. Watch the deployment-agent log for the new revision and a healthy result.

The default polling interval is five minutes. Set `DEPLOY_INTERVAL_MS` to change it; keep it at 60,000 milliseconds or higher.

## Test the deployment agent

After first-time setup or any deployment-agent change, push a harmless empty commit:

```cmd
git commit --allow-empty -m "chore: trigger deployment verification"
git push origin main
```

The log should show the new revision being deployed, a successful health check, and the supervisor staying alive. Confirm that the health endpoint reports that exact revision.

## Troubleshooting

### The process stops but will not start again

The process manager must check whether a child is actually running, not only whether its exit code is `null`. On Windows, a child can be marked `killed` before its exit event supplies an exit code. Use this guard in `start()`:

```js
if (this.isRunning()) throw new Error('Application is already running.');
```

Do not use only `child.exitCode === null`; it can prevent rollback and future deployments after a stop.

### The supervisor cannot deploy its own restart fix

An already-running supervisor keeps its old code in memory. Stop it, update the deployment clone manually, reinstall production dependencies, then start it again:

```cmd
cd /d C:\Deploy\<PROJECT_NAME>
git fetch origin main
git reset --hard origin/main
npm ci --omit=dev
run-deployment-supervisor.cmd
```

Use this only for the dedicated clean deployment clone. Do not run `git reset --hard` in a development folder with uncommitted work.

### A dependency is missing after an update

Install the current production dependency set, then restart the supervisor:

```cmd
npm ci --omit=dev
run-deployment-supervisor.cmd
```

Ensure the dependency is declared in `dependencies`, not only `devDependencies`.

### The agent refuses to update because of local changes

Stop the agent and inspect the deployment clone. Remove unintended generated files from the clone or move legitimate local configuration into `.env`. The clone should contain only tracked application files, `node_modules`, and its local `.env`.

### Health check fails after an update

Read the application logs first. Common causes are a missing environment variable, unavailable database authentication, a port conflict, or a health endpoint that does not report the new `DEPLOY_REVISION`. The agent should roll back automatically; fix the cause, test it, and push a new commit.

## Security checklist

- Keep secrets and credential caches off Git.
- Use a dedicated Windows account with only the access the application needs.
- Restrict write access to the deployment directory.
- Configure Git credentials only for the deployment account and repository.
- Expose the health endpoint only where appropriate for the network.
- Review the deployment clone before using a hard reset.
