# Report DB CPU review — 2026-09-18

## Incident and limits of the evidence

The supplied “Top SQL - By User” report identifies Watcharaphong Punupa's account as the largest CPU consumer shown for 2026-09-17, 20:23:08–21:53:08 (report timezone and CPU units are not specified). It does not identify the SQL statements or prove that this dashboard caused all activity under the account.

The administrator requested index review for these Report DB tables:

- `ETL.WIP_Create`
- `ETL.WIP_Close`
- `ETL.WIP_MoveToNextOperation`
- `Kmesv3.ReleaseBatchTemplate`

The dashboard uses views including `PowerBIThailand.ClosedBatch_v`, `PowerBIThailand.LotCompleteLog`, and `PowerBIThailand.CompleteAction_v`. The follow-up metadata inspection below establishes the visible indexes on two of the four tables. View definitions, dependencies, and execution plans remain unavailable to this account. The DBA must confirm how those views access the four tables before choosing index columns. Do not infer base-table column names from view aliases.

## Live read-only metadata inspection — 2026-09-18

Connected to the configured Report DB using Microsoft Entra sign-in and queried only SQL Server catalog metadata. No business rows were selected, reports rerun, indexes created, or database settings changed.

| DBA table | Observed metadata | Relevance to the index request |
|---|---|---|
| `ETL.WIP_Create` | `OBJECT_ID` returned NULL; `VIEW DEFINITION` permission returned 0. No columns or indexes were visible. | Cannot assess. NULL metadata does not establish that the table is absent; DBA must confirm its location and provide metadata. |
| `ETL.WIP_Close` | `OBJECT_ID` returned NULL; `VIEW DEFINITION` permission returned 0. No columns or indexes were visible. | Cannot assess for the same reason. |
| `ETL.WIP_MoveToNextOperation` | Visible user table. Heap (`index_id=0`), with only `PK_WIP_MoveToNextOperation`: unique nonclustered primary key on `LogID DESC`. | No reported index on `OccuredOn` or `JobName`. Date-range and job lookups cannot seek those columns using the `LogID` key alone. |
| `KMESV3.ReleaseBatchTemplate` | Visible user table. Only `PK_KMESV3.ReleaseBatchTemplate`: unique clustered primary key on `ReleaseBatchTemplateId ASC`. | No reported index on `LotID` or other product/date columns. A lot join cannot seek by `LotID` using the ID key alone. |

Confirmed relevant columns in `WIP_MoveToNextOperation`: `JobName nvarchar(50)`, `OccuredOn datetime`, `QuantityMoved float`, `DispositionCode varchar(80)`, `From_OperationName varchar(80)`, `To_OperationName varchar(80)`, and `organizationbyplantid int`.

Confirmed relevant columns in `ReleaseBatchTemplate`: `LotID nvarchar(50)`, `SFGLotID nvarchar(50)`, `ProductType nvarchar(50)`, `ProductCase nvarchar(50)`, `FGPartNum nvarchar(50)`, `OrganizationByPlantId int`, `EntryDate datetime`, and `DeletedOn datetime`. SQL Server reports `nvarchar` maximum lengths in bytes; the lengths here are characters.

The four dashboard views (`ClosedBatch_v`, `LotCompleteLog`, `CompleteAction_v`, and `LotStartLog`) were confirmed as views. `KMESV3.ReleasedJob` was confirmed as a separate user table; it must not be confused with `ReleaseBatchTemplate`. All queried objects returned 0 for `VIEW DEFINITION`, and all view definitions returned NULL. Reading `sys.sql_expression_dependencies` failed with a SELECT permission denial. The exact view-to-base-table chains therefore remain unverified.

**Interpretation:** The two visible tables have primary-key indexes but no visible indexes for the date/job/lot access patterns used at the dashboard-view level. This supports the DBA's concern about missing supporting indexes. If those predicates and joins reach these base columns, SQL Server may need scans and additional join work. This is a plausible explanation, not proof of the incident's execution plan or measured CPU attribution. Appropriate key order and included columns still require the DBA's plans and view definitions.

The dashboard's local usage is confirmed: 901 reads `ClosedBatch_v`; WIP reads `LotCompleteLog` and joins `ClosedBatch_v` on `JobName`; SC Yield combines `ClosedBatch_v` and `CompleteAction_v` on `JobName`; TA Yield combines those views and joins `ReleasedJob.LotID` to `JobName`. Shared underlying tables can therefore be accessed by several features if the DBA confirms those dependencies.

## Confirmed application findings

- `src/server.js` schedules 901, WIP, SC Yield, and TA Yield staging refreshes on five-minute default intervals. Each job prevents overlapping instances of itself, but different jobs can overlap. These schedules apply while the server runs, including when no dashboard page is open.
- The general cache warmer runs every 270 seconds by default. At investigation time, it read source repositories even with staging enabled. The accompanying application fix selects staging for those warmed datasets when available, preserving direct reads when staging is absent. Staging read errors are propagated rather than triggering another live query.
- `app.refreshScYieldStaging` reads current-month SC Yield twice, concurrently, for monthly and weekly results. Both schedules and duplicate source reads remain potential optimization targets.
- 901 and WIP staging already use incremental date scopes through `stagingIncrementalRefreshFilters`; do not assume they always reload a full month. Initialization or missing coverage can still require a larger scope.
- Some WIP filters and other endpoints still use live repositories. Staging does not eliminate all Report DB activity.
- `src/scYieldRepository.js` builds series options from historical action/closed-job data; `src/sqlRepository.js` also runs multiple option queries without a date scope. Execution plans are needed to establish their contribution to CPU.
- TA eligibility currently depends on action dates, and SC defect calculations intentionally include historical actions for selected closed lots. Adding date restrictions merely to reduce scans could change results. `FeatureMD/TA_YIELD_PERFORMANCE_PLAN.md` describes an older closed-first TA query shape and must not be treated as the current implementation.

This local fix removes avoidable source calls from cache warming; it does not establish the incident's root cause or a measured CPU reduction. The follow-up database access was restricted to catalog metadata; no production data queries, index changes, refreshes, or deployment were performed for this review.

## Local validation

- Before the fix, the focused tests produced five expected failures and one passing direct-source compatibility case. After the fix, all six passed with `npm test -- test/cacheWarmer.test.js --maxWorkers=1 --no-file-parallelism`.
- JavaScript syntax checks and `git diff --check` passed. Independent code and test/document reviews found no material issues.
- The full coverage command, `npm run test:coverage -- --maxWorkers=1 --no-file-parallelism`, stalled while executing the existing API tests, including on a retry outside the sandbox. Both attempts were interrupted. Full-suite results and coverage thresholds remain unverified; this review does not claim they passed.

## DBA request — draft to send

Subject: Report DB CPU investigation and index review — Watcharaphong Punupa

Hello DBA team,

Following the high-CPU alert for my account on 17 September 2026, please review the top CPU-consuming statements during 20:23–21:53 in the report's timezone and the supporting indexes on `ETL.WIP_Create`, `ETL.WIP_Close`, `ETL.WIP_MoveToNextOperation`, and `Kmesv3.ReleaseBatchTemplate`.

Please share the statement text or query IDs, parameter values/types where available, execution counts, CPU time, logical reads, and execution plans. Please confirm the dependencies from the dashboard's `PowerBIThailand.ClosedBatch_v`, `PowerBIThailand.LotCompleteLog`, and `PowerBIThailand.CompleteAction_v` views to these tables, and review existing indexes and statistics before proposing additions.

Our read-only metadata check found only the nonclustered `LogID` primary key on `ETL.WIP_MoveToNextOperation` and the clustered `ReleaseBatchTemplateId` primary key on `KMESV3.ReleaseBatchTemplate`. We could not inspect `WIP_Create` or `WIP_Close` metadata. The account lacks view-definition access and SELECT on `sys.sql_expression_dependencies`. Please provide the definitions/dependency output and index metadata for the remaining two tables; no permission expansion is necessary if you can supply those results.

We found unnecessary direct source reads in the dashboard cache warmer when staging is enabled and have prepared a local fix. Staging refreshes and some filtered requests still read Report DB. Please advise a temporary refresh cadence suitable for the server while the top statements are investigated.

Please validate proposed indexes against the actual predicates and joins, check for overlap with existing indexes, and compare CPU and logical reads before and after using representative parameters. Coordinate production index creation through your normal change process.

Thank you,
Watcharaphong Punupa

## Operational follow-up

1. Obtain “View Top Statements” details or retained Query Store evidence for the incident window; do not rerun expensive reports just to reproduce the alert.
2. Deploy the cache-warmer change using the normal deployment process, then compare source-query execution counts and CPU at comparable traffic and parameter values.
3. If immediate load reduction is needed before deployment, `DASHBOARD_CACHE_WARMER_ENABLED=false` stops only the general warmer after server restart. It does not stop staging refreshes, the separate TA dashboard warmer, or user-triggered queries.
4. Review the existing `DASHBOARD_901_STAGING_INTERVAL_MS`, `DASHBOARD_WIP_STAGING_INTERVAL_MS`, and `DASHBOARD_SC_YIELD_STAGING_INTERVAL_MS` settings with the DBA and dashboard owner. TA currently shares the WIP interval. Increasing them trades freshness for fewer scheduled reads; startup refreshes still run.
5. Do not disable staging as a substitute for disabling refresh work: that can send dashboard requests back to Report DB.

Microsoft references: [Troubleshoot high CPU usage](https://learn.microsoft.com/en-us/troubleshoot/sql/database-engine/performance/troubleshoot-high-cpu-usage-issues) and [Monitor performance using Query Store](https://learn.microsoft.com/en-us/sql/relational-databases/performance/monitoring-performance-by-using-the-query-store).
