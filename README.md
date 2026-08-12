# OneMES Quantity Dashboard

Read-only dashboard for daily `quantityMoved` totals from Azure SQL `dbo.LotCompleteLog`. The browser only calls this application's API; Microsoft Entra authentication and Azure SQL access remain on the server.

## Setup

1. Install Node.js 20 or later, then run `npm install`.
2. Copy `.env.example` to `.env` and set `DATE_COLUMN` plus any available filter columns. Do not add credentials to frontend files.
3. Run `npm run dev`, then open `http://localhost:3000`.

The supplied server and database values are included in `.env.example`. Local development uses `DB_AUTH=ActiveDirectoryInteractive`; selecting data may open a Microsoft Entra sign-in flow. The signed-in account needs read-only access to both configured views. The server shares one Entra credential and one Azure SQL connection pool between Closed Batch and Lot Complete Log, then attempts silent token renewal before requesting a new interactive login. A browser login can still be required after a server restart, Entra logout, MFA, or Conditional Access challenge.

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

## Cell comments

Completion-by-day cells support shared comments stored separately from MES data in `dbo.DashboardCellComments` on the configured settings database. Run [DashboardCellComments.sql](FeatureMD/DashboardCellComments.sql) once, then set `COMMENTS_SQL_TABLE` and `COMMENT_DISPLAY_NAME` in `.env`. The dashboard uses the configured display name as the audit identity; no database credential or comment is stored in browser local storage. Comments are scoped to Product, Serie, PN, Process, and reporting date. Deleting a comment is a soft delete.

## Verification

Run `npm test` for API contracts. Live database verification requires a configured `DATE_COLUMN` and a Microsoft Entra account with Azure SQL read access.
