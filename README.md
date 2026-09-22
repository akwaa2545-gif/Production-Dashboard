# OneMES Quantity Dashboard

Read-only dashboard for daily `quantityMoved` totals from Azure SQL `dbo.LotCompleteLog`. The browser only calls this application's API; Microsoft Entra authentication and Azure SQL access remain on the server.

## Setup

1. Install Node.js 20 or later, then run `npm install`.
2. Copy `.env.example` to `.env` and set `DATE_COLUMN` plus any available filter columns. Do not add credentials to frontend files.
3. Run `npm run dev`, then open `http://localhost:3000`.

The supplied server and database values are included in `.env.example`. Local development uses `DB_AUTH=ActiveDirectoryInteractive`; selecting data may open a Microsoft Entra sign-in flow. The signed-in account needs read-only access to both configured views. The server shares one Entra credential and one Azure SQL connection pool between Closed Batch and Lot Complete Log, then attempts silent token renewal before requesting a new interactive login. A browser login can still be required after a server restart, Entra logout, MFA, or Conditional Access challenge.

Report queries and scheduled jobs renew credentials silently; they cannot open sign-in windows themselves. When interaction is required, concurrent report requests share one sign-in attempt. Complete sign-in in the server computer's browser, close its confirmation tab, and return to the original dashboard. If sign-in fails or MES still rejects access, automatic prompts stop and a **Sign in to MES** button allows an explicit retry. Failed server sign-in attempts have a 30-second cooldown. SQL query timeouts, missing views/columns, and database permission errors are reported separately; repeating sign-in does not resolve those errors.

Set `AZURE_TOKEN_CACHE_PERSISTENCE=true` on a single-user dashboard host to store the Entra token cache in that Windows account's Credential Manager and retain the session across restarts. Keep it `false` on shared hosts, restrict dashboard network access, and use a least-privileged Windows account; anyone using the dashboard server's Windows identity can access its configured SQL views.

If the persistent cache reports `CrossPlatformLockError`, the server logs a warning and uses an in-memory credential for the rest of that server process. Credential operations are serialized, and recovery retries only once without the disk cache. No cache or lock files are deleted. Report queries remain silent; the shared sign-in flow can complete using the in-memory session. A server restart may require signing in again. Do not delete a lock file while another process might be using it.

`SQL_TRUST_SERVER_CERTIFICATE` defaults to `false`. Set it to `true` only when required by your organization's certificate configuration.

## Portable Windows deployment

Copy the project folder without `.env` or `node_modules` to the target Windows server. Install Node.js 20 or later, create the target server's `.env` from `.env.example`, then run either:

```cmd
deploy-portable.cmd
```

or:

```cmd
npm run deploy:portable
```

The command installs production dependencies on first run and starts the dashboard on `0.0.0.0:5000`. Allow TCP port `5000` through the Windows Firewall if LAN users cannot connect. The server host must complete Microsoft Entra sign-in when prompted; do not copy a personal `.env` or Entra token to another machine.

## Automatic Windows deployment

For the current interactive Entra authentication, use the included Windows deployment supervisor instead of Docker. It runs the dashboard and polls the configured Git remote for new commits on `main`. When it finds one, it stops the dashboard, updates the clean deployment clone, installs production dependencies, restarts it, and checks `GET /api/health`. If the new revision is unhealthy, it restores and restarts the previous Git revision automatically.

On the dedicated dashboard computer, make a separate clean clone for deployment, then create its `.env` from `.env.example`. Do not use a working folder that contains local edits or Excel files.

```cmd
git clone https://github.com/akwaa2545-gif/Production-Dashboard.git C:\OneMES\dashboard
cd /d C:\OneMES\dashboard
npm ci --omit=dev
run-deployment-supervisor.cmd
```

Before the first run, set `AZURE_TOKEN_CACHE_PERSISTENCE=true` in that deployment clone's `.env`. The first run may open the existing Microsoft Entra sign-in flow. Sign in using the dedicated Windows account. Later restarts normally reuse that account's persisted token cache, although Microsoft can still require a new sign-in after MFA, policy, password, or token changes.

To make it automatic, create a Windows Scheduled Task that starts `C:\OneMES\dashboard\run-deployment-supervisor.cmd` **at log on**, runs only when that dedicated user is logged on, and uses `C:\OneMES\dashboard` as its working directory. Keep the task running; it checks GitHub every five minutes by default. Change the interval with `DEPLOY_INTERVAL_MS` (minimum 60000). Git credentials, if the repository is private, must be configured once for that Windows account.

Push a tested commit to `main` to deploy it. The supervisor will never overwrite a deployment clone with local changes, and it rolls back automatically if the replacement fails the revision-specific health check. Stop any old `deploy-portable.cmd` dashboard process before starting the supervisor, then use `Ctrl+C` before doing planned maintenance in that deployment clone.

## Finding column names

After setting `DATE_COLUMN` to a known safe temporary candidate and starting the server, call `GET /api/columns` to inspect columns from the configured view. Update the `.env` values with the exact timestamp, process, serie, and case column names. The endpoint does not return data rows.

## API

- `GET /api/health` verifies the server is running.
- `GET /api/config` returns safe metadata only, never credentials or tokens.
- `GET /api/columns` returns available columns.
- `GET /api/options` returns bounded filter option lists.
- `GET /api/quantity?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD` returns daily, item-grouped totals. Optional filters are `process`, `serie`, `case`, and `pn`.

All filter values use SQL parameters. Configured view and column identifiers are allowlisted before query construction. Database errors are not returned to dashboard users.

## Performance cache

The server caches option lists and part-number searches for 10 minutes, and quantity/chart results for 2 minutes. Cache keys include the selected data source, so `901 (Closed Batch)` and `WIP (Lot Complete Log)` never share results. The browser also retains successful source-specific GET responses for the server-provided cache duration, so switching back to a recently used source avoids another HTTP request and SQL query. Identical requests in progress are combined into one SQL query. Set `DASHBOARD_CACHE_MAX_ENTRIES` in `.env` to change the in-memory cache size (default: `500`). Restarting the server or completing Microsoft Entra re-authentication clears the server cache; re-authentication also clears the browser cache.

## Dashboard data mode

Open **Staging status** and use **Change data mode** in the Dashboard data mode panel to select **Staging** or **Live MES** for everyone connected to this server. Live MES reads production data directly from MES on each Apply, bypasses dashboard result caches, and pauses this server's staging refreshes, repairs, QA, and cache warmers. Queries can take longer because they run against MES. Switching back resumes the configured staging jobs and uses existing staged data; switching does not rebuild or delete it.

Set `DASHBOARD_DATA_MODE_TOKEN` to a separate random secret of at least 32 characters before allowing data-mode changes. The form does not persist this token. For a controlled server computer, setting `DASHBOARD_DATA_MODE_LOCAL_AUTOFILL=true` enables **Change data mode → Auto fill**, which creates a one-use temporary token that expires after two minutes. Autofill is disabled by default and should only be enabled where every local process is trusted.

An operator gets the secret from the person managing the server; it does not come from MES. Configure exact `DASHBOARD_DATA_MODE_ALLOWED_IPS` and `DASHBOARD_DATA_MODE_ALLOWED_ORIGINS`, including the deployed port. Autofill requires a direct loopback connection and matching browser origin; it is unavailable through remote addresses or forwarding proxies, and never returns the permanent server secret.

`DASHBOARD_DATA_MODE=staging` is the startup default; set it to `live` to start directly against MES. Dashboard selections last until the server restarts.

Active work finishes before a switch completes. New data requests briefly receive `503` while switching; new background jobs are skipped. The dashboard clears cached results on a mode change and checks for changes made by other operators. Shared targets, comments, and other editable settings continue using their configured settings storage. This control applies to this server process; independently launched staging scripts, other server instances, and external scheduled tasks must be managed separately.

`GET /api/data-mode` returns the current and requested modes, transition status, revision, active work count, startup mode, and whether operator authorization is configured. `PUT /api/data-mode` accepts `{ "mode": "staging" }` or `{ "mode": "live" }`, requires a Bearer token and an allowed Origin, and returns `200` when applied or `202` while current work drains.

## WIP historical repair

The Staging monitor's **WIP restore / repair** control reloads a selected date range from MES into both WIP daily quantities and WIP process charts for NEO and SC. The range can span up to seven calendar days, including month boundaries, and cannot include future Bangkok dates. Both tables are replaced together in a transaction; a failed source read leaves staging unchanged. Repair and scheduled WIP refresh cannot run at the same time.

Set `DASHBOARD_WIP_REPAIR_TOKEN` to a random operator secret of at least 32 bytes in the server environment, then restart the server. The form requires that token for each submission and does not persist it. Access defaults to loopback addresses; remote operators require exact `DASHBOARD_WIP_REPAIR_ALLOWED_IPS` and `DASHBOARD_WIP_REPAIR_ALLOWED_ORIGINS` entries. See `.env.example`. `POST /api/staging/wip-repair` accepts `{ "startDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD" }`, requires a Bearer token and an allowed Origin, and returns `202`; completion or failure is reported in `GET /api/staging-status` under `pipelines.wip`.

Scheduled WIP refresh behavior is unchanged: once caught up, it rereads the current day only. Use historical repair to capture late MES arrivals for earlier dates. Successful repair invalidates the WIP server cache; the monitor clears cached WIP browser responses when it observes completion.

## Cell comments

Completion-by-day cells support shared comments stored separately from MES data in `dbo.DashboardCellComments` on the configured settings database. Run [DashboardCellComments.sql](FeatureMD/DashboardCellComments.sql) once, then set `COMMENTS_SQL_TABLE` and `COMMENT_DISPLAY_NAME` in `.env`. The dashboard uses the configured display name as the audit identity; no database credential or comment is stored in browser local storage. Comments are scoped to Product, Serie, PN, Process, and reporting date. Deleting a comment is a soft delete.

## Verification

Run `npm test` for API contracts. Live database verification requires a configured `DATE_COLUMN` and a Microsoft Entra account with Azure SQL read access.

Run `node test/e2e-wip-repair.mjs` with an installed `playwright-core` and matching Chromium to verify the WIP repair form and automatic status polling against simulated repositories. If Playwright is installed outside this project, set `PLAYWRIGHT_MODULE_PATH` to that installation. The test does not access MES or staging databases.

Run `node test/e2e-data-mode.mjs` with the same browser setup to verify mode switching across two browser sessions, fresh live reads, rejected operator credentials, and paused staging jobs and repairs. It uses simulated repositories and does not access production databases.
