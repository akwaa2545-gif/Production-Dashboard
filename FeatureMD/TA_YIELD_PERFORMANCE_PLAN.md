# TA Yield SQL Performance Plan

## Purpose

Reduce TA Yield load time without changing the current MES calculation rules or the resulting Input Q, Final Good Q, disposition quantities, eligibility, and yield values.

This document is a required baseline for any TA SQL performance change. No query rewrite may be released until it reconciles to the baseline described below.

## Locked calculation baseline

The dashboard uses MES data only:

| Result | MES source | Locked condition |
| --- | --- | --- |
| Input Q | `PowerBIThailand.ClosedBatch_v.GrossQty` | `ProdType = 'NEO'`, TA `ProdLine`, optional selected `Series`, and selected `CloseDate` range. One maximum `GrossQty` per `JobName`. |
| Final Good Q | `PowerBIThailand.CompleteAction_v.QuantityMoved` | Same selected MES lots; selected `OccuredOn` range; `DispositionType = 'GOOD'`; `DispositionCode = TA_YIELD_FINAL_GOOD_DISPOSITION_CODE`. |
| Defect quantity | `PowerBIThailand.CompleteAction_v.QuantityMoved` | Same selected MES lots; selected `OccuredOn` range; `DispositionType = 'SCRAP'`. |
| Input deductions | `CompleteAction_v.QuantityMoved` | Exact codes `0201_Inp_Pellet_Assy` and `X01_Machine_Sample`, regardless of disposition type. |
| Lot exclusion | Closed Batch `JobType` and lot number | Exclude `NON-STANDARD`/`E`, invalid day segment before `N`, and yield at or below 30%. |
| Final-operation eligibility | `CompleteAction_v` | A lot is eligible only when its `DispositionCode` exactly equals `To rteTaping_ALL` (the configured final-good disposition) and that record's `OccuredOn` is within the selected reporting date range. |

The existing mapping layer remains authoritative for workbook-reference groupings, Other balancing, and display categories. The Excel files are reference material only; they are not data sources.

## TA mode and category reference mapping

MES provides the raw `DispositionCode` and quantity. The TA mapping workbook provides the reference labels only:

| Display field | Reference mapping |
| --- | --- |
| Mode | Exact MES-system / `DispositionCode` value, such as `0301_Sample_CV`. |
| Defect Yield Category | TA workbook `Deft Yield Category`, such as `Inproc Up`, `Inproc Dw`, or `Input-`. |
| Main graph category | TA workbook main graph category. |

The dashboard must keep the MES mode value visible for reconciliation. A missing mapping is reported as `Unmapped`; it must not be silently assigned to a category.

The TA chart and summary table display every configured Main graph category for each TA series. Categories with no quantity in the selected period are shown as zero; this is a presentation-only completion of the mapping and does not change defect totals or yield.

## TA weekly yield tendency

The TA Weekly Yield Tendency chart uses the exact same eligible lots, input deductions, final-good records, defect groups, ACC/SH rules, and yield formula as the TA summary. It groups each eligible lot by the ISO week-year label (`YYYY-Wnn`) of its MES `ClosedBatch_v.CloseDate`; this keeps input, final-good, and defects in the same TA lot reporting week. The weekly endpoint reuses the existing shared TA raw-row cache and does not issue an additional MES query.

The TA weekly area provides a From week / To week display range, a weekly series chart, and an accumulated series chart. Weekly yield is `Final Good / Adjusted Input × 100`; accumulated yield applies that same formula to the selected weeks from the range start through each displayed week. The range changes presentation only and does not change MES eligibility, TA conditions, or cache duration.

For `1812_SH_PLS`, a normal ACC classification is also included as the **ACC** defect group in the TA chart and summary table. It therefore contributes to defect quantity, defect rate, and yield. The `acc_volt = 0` and missing-PartType SH classifications remain in the **SH** group instead.

## Current safe query shape

1. Query Closed Batch first, filtered by product, TA line, optional series, and CloseDate.
2. Aggregate one input row per `JobName`.
3. Serialize the selected Closed Batch `JobName` values once as a parameterized JSON lot set.
4. Query Complete Action once, inner-joined to that selected-lot set and filtered by product, selected OccuredOn range, and the locked final-good/SCRAP/input-disposition conditions. This avoids both a broad action scan and SQL Server's 2,100 scalar-parameter limit.
5. Combine the two result sets in application memory, then apply the existing TA calculation and mapping.

This avoids an unrestricted one-to-many join between the two live MES history views.

## Complete Action lot-set filter

The TA report retains every locked condition above. The selected Closed Batch `JobName` values are serialized once as a parameterized JSON lot set and consumed by `OPENJSON` in the single Complete Action query. The action query reads only rows whose `JobName` is in the already-qualified TA lot set, while retaining the same selected `OccuredOn` range, final-good condition, scrap condition, input-deduction codes, and `ParametersECP_v` ACC/SH checks.

This replaces the former broad Complete Action date scan followed by in-application lot rejection. It does not introduce a repeated per-lot/per-batch MES query, does not require a new MES database object, and avoids SQL Server's 2,100 scalar-parameter limit. `OPENJSON` requires SQL Server 2016+/Azure SQL with database compatibility level 130 or later.

## Measured action-query shape

Complete Action is queried once for the selected product, selected lot set, OccuredOn range, and locked disposition conditions. A July 2026 cold-request measurement showed that sequential lot batches timed out after 180 seconds because the MES view was repeatedly scanned; this batch shape was removed.

The single lot-filtered action query preserves all locked conditions and avoids multiplying live-MES view scans. If `OPENJSON` is unavailable because of a database compatibility restriction, the database owner must enable a compatible set mechanism before this optimization can run; repeated `IN` batches must not be introduced.

The `ParametersECP_v` ACC/SH lookups run only for `1812_SH_PLS` actions. Other disposition codes do not use those values, so avoiding their per-row parameter lookup reduces the first-load cost without changing any TA selection, quantity, mapping, or yield rule.

## Shared Calculation Log source cache

The TA summary and TA Calculation Log share the same five-minute in-memory cache of raw MES rows for an identical filter set. Opening the Calculation Log after its summary therefore maps the already-loaded rows into evidence detail instead of issuing a second MES query. The mapped endpoints do not add another cache layer, so the five-minute freshness ceiling is preserved. The cache key includes the complete validated filter set.

## Measured baseline

- Before the single-scan Complete Action change, the June 2026 TA summary request exceeded a 120-second client timeout.
- After the change, the same live request returned HTTP 200 in approximately 50 seconds.
- The conditions in the Locked calculation baseline were not changed.

## Improvement order

### Phase 1 — Measure without changing results

- Record separately: Closed Batch query time, Complete Action query time, mapping time, total row counts, selected-lot count, and number of lot batches.
- Record only aggregate timings/counts; never log connection strings, tokens, or raw production quantities.
- Capture a fixed reconciliation sample covering one series and one full reporting month.

Success criterion: identify the slowest step with measurements, while every baseline reconciliation total remains identical.

### Phase 2 — Reduce database work safely

- Keep Closed Batch as the driving lot list.
- Keep the existing product, line, series, CloseDate, OccuredOn, disposition, and final-good conditions exactly unchanged.
- Keep one Complete Action query filtered by the selected Closed Batch lot set. Do not reintroduce sequential `JobName IN (...)` batches: the July measurement timed out after 180 seconds because the live view was repeatedly scanned.
- Use the existing parameterized JSON lot set; if compatibility does not support `OPENJSON`, use an approved reporting-table or table-valued-parameter equivalent in one database operation.
- Select only columns required for TA calculation; do not use `SELECT *`.
- Do not add Action-query concurrency against the live MES transaction view without measured database evidence and approval.

Success criterion: lower duration with identical lot count, Input Q, Final Good Q, deduction quantities, grouped defects, Other adjustment, and yield.

### Phase 3 — Cache completed historical results

- Cache only a completed response for the exact filter set: source, product, line prefix, selected series, start date, end date, final-good disposition, and calculation/mapping version.
- Use a short in-memory cache for repeated dashboard refreshes.
- For historical closed periods, add an optional durable reporting cache only after business approval for data freshness.
- Invalidate cached entries when the selected period includes today, configuration changes, or a manual refresh is requested.

Success criterion: repeated requests do not requery MES, while current/open periods continue to refresh correctly.

### Phase 4 — Reporting replica or precomputed fact table

- Do not move dashboard reporting to a replica until Phase 1 proves live MES is the bottleneck.
- Build a refreshable TA reporting fact table keyed by lot, close date, occurrence date, disposition code, series, and calculation version.
- Preserve the exact baseline conditions in the ETL/query definition.
- Reconcile the fact table with live MES before switching the dashboard source.

Success criterion: dashboard reporting reads a purpose-built reporting dataset with the same results as MES for agreed reconciliation periods.

## Required reconciliation gate

Before and after every performance change, compare the same filters and require equality for:

1. Eligible lot count and excluded-lot count by exclusion reason.
2. Input Q before and after deductions.
3. Final Good Q.
4. Each input deduction code.
5. Each mapped disposition group and unmapped quantity.
6. Other quantity and adjusted input.
7. Yield and defect rate.

Any difference is a correctness failure, not a performance improvement. Stop and investigate before proceeding.

## Not allowed

## TA mode and category evidence

The TA calculation log shows the exact MES DispositionCode (Mode), its Defect Yield Category, and quantity for reconciliation. This evidence belongs in the TA-specific Calculation Log, not as extra columns in the dashboard lot table.

The Excel-style TA lot-detail view displays rows only after the user selects a series; this is a presentation filter and does not change the MES query or TA calculation conditions.

## `1812_SH_PLS` ACC / SH classification

For TA mode `1812_SH_PLS`, match `CompleteAction_v.From_ItemName` directly to `ParametersECP_v.PartType`.

- When that PartType has `ParameterName = acc_volt` and `ParameterValue = 0`, classify the mode as **SH** and mark it as **SH — acc_volt is 0 in ParametersECP_v** in the TA Yield Calculation Log.
- A matching PartType without that zero `acc_volt` parameter keeps the workbook's **ACC** category and is highlighted as an ACC parameter match in the TA Yield Calculation Log.
- A non-matching PartType is classified as **SH** only in TA mode evidence and is visibly highlighted as an SH fallback in the TA Yield Calculation Log.
- Existing TA eligibility, input deduction, defect-group, Other adjustment, and yield conditions remain unchanged.

The TA Calculation Log supports local Series, Mode, and Defect Yield Category selection plus Lot No/Mode search over loaded evidence only; these presentation filters do not change the MES query or calculation conditions.

- Replacing the current date, product, line, series, disposition, or eligibility conditions only to make a query faster.
- Joining unfiltered Closed Batch and Complete Action histories together.
- Removing unmapped codes or excluded lots silently.
- Using the workbook as a live data source.
- Increasing cache lifetime for open/current production periods without an explicit freshness decision.
