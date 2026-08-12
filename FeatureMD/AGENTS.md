# AGENTS.md - OneMES Azure SQL Dashboard

## 1. Project Overview

This project is a web dashboard for viewing production/MES data from Azure SQL Database.

Database context:

- SQL platform: Azure SQL Database
- Server: `apaz-sqlinstprod3.d9dee625aa38.database.windows.net`
- Database: `OneMES_Report_THR`
- Main view/table: `dbo.LotCompleteLog`
- Known important columns:
  - `from_itemName`
  - `quantityMoved`

The dashboard must let users filter by:

- Process
- Date/time range
- Serie
- Case
- PN

The main visualization should graph `quantityMoved` across the selected date range, grouped by day and item/PN.

## 2. Agent Responsibilities

The coding agent should:

- Build and maintain a simple, readable web dashboard.
- Keep frontend, backend API, and database access clearly separated.
- Use a backend API for all SQL Server access.
- Keep database operations read-only unless the user explicitly requests otherwise.
- Add useful setup and run instructions to `README.md`.
- Prefer small, focused files over large mixed-purpose files.
- Preserve existing user changes and avoid unrelated refactors.
- When database column names are uncertain, add a safe column-inspection endpoint or script.

## 3. Database And Security Rules

Never hardcode passwords, tokens, connection strings with secrets, API keys, or personal credentials.

Database connection settings must come from environment variables, such as:

- `SQL_SERVER`
- `SQL_DATABASE`
- `DB_AUTH`
- `SQL_USER`
- `SQL_PASSWORD`
- `AZURE_TENANT_ID`
- `DB_VIEW`
- `DATE_COLUMN`
- `PROCESS_COLUMN`
- `SERIE_COLUMN`
- `CASE_COLUMN`
- `PN_COLUMN`

Rules:

- Do not connect directly from the browser to SQL Server.
- Do not expose database credentials to frontend code.
- Use parameterized queries for all user-provided values.
- Validate date inputs before querying.
- Validate any configured table/view/column names before using them in SQL.
- Do not allow raw SQL from the browser or query string.
- Do not return full internal SQL errors to normal dashboard users.
- Prefer read-only database permissions.
- Use Microsoft Entra authentication, managed identity, service principal, or a read-only SQL login as appropriate.
- For local development with a personal organization account, interactive Microsoft Entra login is acceptable.
- For production, prefer managed identity or service principal with least-privilege read access.

## 4. Coding Standards

Use a simple, maintainable architecture:

- Frontend: dashboard UI, filters, charts, loading/error states.
- Backend: API routes, validation, SQL access, response shaping.
- Configuration: environment variables and `.env.example`.
- Documentation: setup, authentication mode, and troubleshooting in `README.md`.

Code quality expectations:

- Keep functions small and named clearly.
- Avoid unnecessary abstractions.
- Handle errors deliberately.
- Use consistent response shapes from the API.
- Keep user-facing error messages helpful but not sensitive.
- Do not mutate unrelated files.
- Avoid committing generated build output unless the project convention requires it.

## 5. Frontend Dashboard Requirements

The dashboard should include:

- Date range controls.
- Select controls for process, serie, case, and PN.
- A clear graph of `quantityMoved` grouped by selected day range and item/PN.
- Summary metrics such as total quantity and returned row count.
- Loading state while data is being fetched.
- Helpful error state when configuration or database access is missing.

Frontend rules:

- Fetch data only from the backend API.
- Do not include SQL credentials or SQL queries in frontend code.
- Keep the UI usable on desktop and smaller screens.
- Use clear labels that match manufacturing/reporting language.
- Avoid decorative UI that makes operational data harder to scan.

## 6. Backend API Requirements

The backend API should provide endpoints similar to:

- `GET /api/health` - basic server health.
- `GET /api/config` - safe public configuration, excluding secrets.
- `GET /api/columns` - inspect available columns in `dbo.LotCompleteLog`.
- `GET /api/options` - return filter options for process, serie, case, and PN.
- `GET /api/quantity` - return graph-ready quantity data.

Query behavior:

- Filter by selected date range.
- Filter by process, serie, case, and PN when configured.
- Group results by date bucket and `from_itemName` or configured PN/item column.
- Aggregate with `SUM(quantityMoved)`.
- Limit option lists to a reasonable size.
- Use SQL parameters for dates and filter values.

Example aggregation shape:

```sql
SELECT
  CONVERT(varchar(10), CAST([date_column] AS date), 23) AS bucketDate,
  CAST([from_itemName] AS nvarchar(4000)) AS itemName,
  SUM(TRY_CONVERT(decimal(18, 4), [quantityMoved])) AS quantityMoved
FROM [dbo].[LotCompleteLog]
WHERE [date_column] >= @startDate
  AND [date_column] < DATEADD(day, 1, @endDate)
GROUP BY
  CAST([date_column] AS date),
  CAST([from_itemName] AS nvarchar(4000))
ORDER BY bucketDate ASC, itemName ASC;
```

Do not paste this query directly without replacing `[date_column]` with the real configured date/time column.

## 7. Testing And Verification Checklist

Before saying the work is done, verify:

- Dependencies install successfully.
- The backend starts without syntax/runtime errors.
- The frontend builds successfully.
- `GET /api/health` returns success.
- `GET /api/config` returns expected server/database/view metadata without secrets.
- Missing required config, especially `DATE_COLUMN`, returns a clear error.
- SQL queries use parameters for user values.
- Browser frontend can load without exposing database credentials.
- The chart renders with real or representative API data.
- README setup instructions are current.

If database access is unavailable in the current environment, state that clearly and verify all non-database behavior locally.

## 8. Things The Agent Must Not Do

The agent must not:

- Hardcode passwords, tokens, or private connection secrets.
- Put organization credentials in frontend code.
- Connect from browser JavaScript directly to SQL Server.
- Accept raw SQL from users.
- Use string concatenation for user filter values in SQL.
- Write, update, or delete production database records unless explicitly requested.
- Broaden database permissions without approval.
- Log secrets or access tokens.
- Expose raw database stack traces to dashboard users.
- Replace user changes without checking them first.
- Add unnecessary frameworks or complex infrastructure for a small dashboard.
