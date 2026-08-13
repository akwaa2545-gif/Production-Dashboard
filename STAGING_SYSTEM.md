# Dashboard staging system

## Purpose

The dashboard normally reads MES views directly. Those views are accurate but can be slow, especially for Completion 901 and WIP because they resolve production series from related MES records.

The staging system copies calculated dashboard data into SQL Server database `ProductionMES`. The dashboard reads these local staging tables for fast display while MES remains the source of truth.

```
MES Azure SQL views
        |
        | Microsoft Entra token from the running dashboard
        v
Dashboard refresh worker (every 5 minutes)
        |
        v
ProductionMES staging tables
        |
        v
Dashboard quantity table / export / chart
```

## What is staged

| Dashboard area | Staging table | Status |
|---|---|---|
| Completion 901 daily quantity by series | `dbo.Dashboard901Daily` | Active |
| WIP daily quantity by series | `dbo.DashboardWipDaily` | Active |
| WIP daily quantity by operation and series | `dbo.DashboardWipProcessDaily` | Being completed; SC data is present, NEO product mapping still needs correction |

TA Yield and SC Yield are not staged. They still read MES live.

## Refresh behavior

When the dashboard server is running:

1. The user signs in to MES from the dashboard.
2. The server holds the Microsoft Entra access token in memory.
3. Completion 901 refresh starts about 15 seconds after server startup.
4. WIP refresh starts about 45 seconds after server startup.
5. Each refresh runs every 5 minutes.
6. A refresh reads MES for the entire current Thailand month, deletes that same month from staging, and inserts the latest calculated totals.
7. Dashboard cache is cleared after a successful refresh.

This is near-real-time, not instant. MES changes normally appear within about five minutes.

The refresh intentionally replaces the current month rather than appending only new records. This catches MES corrections to earlier days in the month.

If the dashboard is stopped, no refresh runs. On the next startup, it reloads the full current month and catches up the missing days after sign-in.

## History

History from 2026-01-01 through 2026-08-12 was loaded for both main tables:

- Completion 901: 14,361 corrected rows after NEO series resolution.
- WIP daily series: 3,719 rows.

History before the current month is retained. The automatic refresh modifies only the current month.

## Data rules

### Completion 901

Source: `PowerBIThailand.ClosedBatch_v`

- Date: `CloseDate`
- Quantity: `CompleteQty`
- Product: `ProdType`
- Series: `Series`
- Part number: `PartNumber`
- Excludes `ProdLine` beginning with `Semi-Finished Good apply in Racking`.
- SC rows with blank series become `Element`.
- NEO blank or `Unspecified` series are resolved by joining the job to `PowerBIThailand.CompleteAction_v` and converting its `ProdLine` to the standard FPS series label.

This NEO fallback is essential. The initial staging version omitted it and created too many `Unspecified` rows; the current 901 staging refresh includes the same rule used by direct MES dashboard data.

### WIP daily series

Source: `PowerBIThailand.LotCompleteLog`

- Date: `OccuredOn`
- Quantity: `QuantityMoved`
- WIP series are resolved by `JobName` lookup to Closed Batch data.
- The staging worker calls the existing WIP repository logic so the series-link calculation matches the direct dashboard calculation.

Operation, part number, and case-filtered WIP quantity requests currently continue to use MES directly because the daily series staging table does not contain enough detail for those filters.

## Validation

Run an exact MES-to-staging comparison with:

```powershell
npm run validate:staging
```

Optional environment settings:

```powershell
$env:STAGING_VALIDATION_DATASET = '901' # 901, wip, or all
$env:STAGING_VALIDATION_START_DATE = '2026-08-12'
$env:STAGING_VALIDATION_END_DATE = '2026-08-12'
npm run validate:staging
```

The comparison checks every `date + series` quantity for NEO and SC. It reports mismatches and exits with failure if values differ.

Verified result for 2026-08-12:

| Dataset | Product | MES rows | Staging rows | Mismatches |
|---|---:|---:|---:|---:|
| 901 | NEO | 10 | 10 | 0 |
| 901 | SC | 3 | 3 | 0 |
| WIP | NEO | 11 | 11 | 0 |
| WIP | SC | 3 | 3 | 0 |

Full-history direct validation is slow because the MES views themselves can take several minutes. Use smaller date windows for audit validation.

## Manual commands

```powershell
# Refresh current Thailand month (or use STAGING_901_START_DATE / END_DATE)
npm run refresh:901-staging

# Refresh WIP current Thailand month
npm run refresh:wip-staging

# Validate direct MES against staging
npm run validate:staging
```

For one-time history loads, set a date range before the command:

```powershell
$env:STAGING_901_START_DATE = '2026-01-01'
$env:STAGING_901_END_DATE = '2026-08-13'
npm run refresh:901-staging
```

## Required local configuration

The following settings belong in local `.env` only. Do not commit passwords.

```env
DASHBOARD_901_STAGING_ENABLED=true
DASHBOARD_WIP_STAGING_ENABLED=true
STAGING_SQL_SERVER=svr120a
STAGING_SQL_DATABASE=ProductionMES
STAGING_SQL_USER=ProdMESIT
STAGING_SQL_PASSWORD=<private password>
STAGING_SQL_TRUST_SERVER_CERTIFICATE=true

STAGING_901_SQL_TABLE=dbo.Dashboard901Daily
STAGING_WIP_SQL_TABLE=dbo.DashboardWipDaily
STAGING_WIP_PROCESS_SQL_TABLE=dbo.DashboardWipProcessDaily

DASHBOARD_901_STAGING_INTERVAL_MS=300000
DASHBOARD_WIP_STAGING_INTERVAL_MS=300000
```

## Security and operations

- `.env` is ignored by Git; credentials must never be stored in source code or documentation.
- The SQL login needs read/write access to the `ProductionMES` staging database.
- The MES connection remains Microsoft Entra interactive authentication.
- Automatic refresh shares the dashboard server's in-memory MES token.
- Manual `npm run refresh:*` commands are separate Node processes and may require a separate MES sign-in.
- If the MES token expires, use the dashboard sign-in endpoint again; the running server then resumes its scheduled refresh.

## Current limitation: WIP process chart

The WIP process chart originally read MES live, causing a slow graph and misleading temporary “No data” messages. A process-level staging table was added to make it fast.

The current SC process data is present in `dbo.DashboardWipProcessDaily`. The NEO process-data product assignment is not yet correct and must be fixed and validated before the WIP process chart can be relied on for NEO. The WIP daily quantity staging table remains valid and independently validated for both NEO and SC.

