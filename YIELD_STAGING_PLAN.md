# SC Yield and TA Yield staging plan

## Goal

Extend the existing staging approach to SC Yield and TA Yield without changing their calculation results. MES remains the source of truth; staging is a fast copy of the already-defined input rows or calculated aggregates.

The primary requirement is correctness. A yield percentage can look valid while being wrong if any input, defect category, or exclusion rule is missing. Staging must not be enabled until MES-versus-staging validation passes.

## Scope

| Area | Current source | Planned staging result |
|---|---|---|
| SC Yield | Complete Action and Closed Batch MES views | Daily series/category inputs used by SC Yield mapping |
| TA Yield | TA yield MES source plus workbook mapping | Daily/lot-level inputs required by the TA Excel-compatible mapping |

## Design choice

Stage normalized inputs, not only final percentages.

Why:

- The dashboard can recalculate summaries, weekly charts, and future views from the same staged data.
- Individual input and defect quantities remain auditable.
- MES-versus-staging validation can compare raw business values before presentation formatting.
- Mapping changes can be applied without rereading all historical MES data.

Final calculated summary tables may be added later for faster large history views, but they must be derived from the normalized staging inputs.

## SC Yield plan

### Proposed tables

```text
dbo.DashboardScYieldInputDaily
  ReportingDate
  Serie
  Category / calculation group
  InputQty
  DefectQty
  SourceType
  RefreshedAt

dbo.DashboardScYieldLotDaily (only if required by existing detail views)
  ReportingDate
  JobName
  PartNumber
  Serie
  Category
  Quantity
  RefreshedAt
```

### Implementation steps

1. Document the current direct MES SQL conditions from `ScYieldRepository` and `scYieldMapping`.
2. Identify every source column and calculation group used by SC Yield:
   - adjusted input;
   - gross/input quantity;
   - defect quantity;
   - category mapping;
   - exclusions and special Excel rules.
3. Build a staging refresh worker that reads the same source rows for the current month.
4. Backfill history from January 1 onward in monthly windows.
5. Add a staging repository that returns the same row shape currently expected by `mapScYieldRows`.
6. Keep the mapping function unchanged; only replace its source repository after validation.
7. Add automatic five-minute refresh using the existing dashboard MES token.
8. Enable with `DASHBOARD_SC_YIELD_STAGING_ENABLED=true` only after validation passes.

### SC validation gate

For each selected period and series, compare direct MES and staging for:

- adjusted input quantity;
- included defect quantity;
- every mapped defect category;
- total yield;
- weekly yield rows;
- zero-defect and missing-disposition behavior.

Acceptance rule: exact quantity equality and yield percentage equality to the dashboard display precision for NEO/SC scope used by SC Yield.

## TA Yield plan

### Key business rules already identified

TA staging must preserve the Excel-compatible `TA/Yield_Data_Aug2026.xlsx` logic:

- Product type NEO and major category FG.
- Final disposition/route rule for Taping.
- Taping date is the final action date plus seven hours.
- Detail window covers selected month plus the prior three months.
- Exclude rows from the Taping operation where required.
- Map disposition descriptions through the workbook mapping sheet.
- Exclude blank and X categories.
- SH Pulse rows become ACC only when `ACC_Volt > 0` for the applicable part type.
- Preserve columns such as ACC, App, CO, Cap, DF, ESR, Good, Inproc Dw, Inproc Up, Input, Input-, LC, La/Ex1, La/Ex2-6, PULSE, and SH.

### Proposed tables

```text
dbo.DashboardTaYieldLotInput
  TapingDate
  JobName
  FromItemName
  ProductLine
  FromOperationName
  DispositionDescription
  DispositionCode
  Quantity
  AccVolt
  SourceActionDate
  RefreshedAt

dbo.DashboardTaYieldDailyCategory
  TapingDate
  JobName
  FromItemName
  ProductLine
  YieldCategory
  Quantity
  RefreshedAt
```

The lot-input table is the audit source. The daily-category table is an optional pre-aggregated projection for fast table/chart rendering.

### Implementation steps

1. Freeze the workbook mapping file version used by the dashboard.
2. Add a TA staging refresh query that includes the exact MES source fields needed for every workbook rule.
3. Load mapping data from the workbook at refresh time or record the mapping version used with each row.
4. Apply the SH Pulse / ACC voltage rule before daily category aggregation.
5. Backfill lot-level rows from January 1 onward in monthly windows.
6. Keep existing `mapTaYieldRows`, weekly, tendency, lot detail, and workbook reconciliation code unchanged at first.
7. Add a TA staging repository returning the same source shape as `TaYieldRepository.getYieldRows`.
8. Switch by feature flag only after detailed validation passes.
9. Add automatic refresh every five minutes for the current month, sharing the dashboard MES token.

### TA validation gate

Validate direct MES against staging at three levels:

1. Lot level: date, job, item, source operation, mapped category, and quantity.
2. Daily category level: every Excel output category per date/lot/item.
3. Presentation level: dashboard summary, weekly chart, tendency, Excel-style detail table, and workbook reconciliation output.

Acceptance rule: all numeric category values match the reference workbook and direct MES output. Any mismatch blocks enabling TA staging.

## Configuration to add later

```env
DASHBOARD_SC_YIELD_STAGING_ENABLED=false
DASHBOARD_TA_YIELD_STAGING_ENABLED=false

STAGING_SC_YIELD_SQL_TABLE=dbo.DashboardScYieldInputDaily
STAGING_TA_YIELD_LOT_SQL_TABLE=dbo.DashboardTaYieldLotInput
STAGING_TA_YIELD_DAILY_SQL_TABLE=dbo.DashboardTaYieldDailyCategory

DASHBOARD_SC_YIELD_STAGING_INTERVAL_MS=300000
DASHBOARD_TA_YIELD_STAGING_INTERVAL_MS=300000
```

These settings must remain disabled until validation is signed off.

## Rollout order

1. SC Yield staging prototype and one-day direct comparison.
2. SC current-month backfill and full dashboard validation.
3. Enable SC feature flag; monitor direct-versus-staging audit daily.
4. TA lot-input staging prototype against the Excel workbook.
5. TA category projection and workbook reconciliation validation.
6. Enable TA feature flag only after an approved comparison period.

## Operational safeguards

- Refresh uses the dashboard server's Microsoft Entra token and never stores that token in SQL.
- Current month is replaced on every refresh; historical months are preserved.
- Every refresh is transactional: a failure must leave existing staging rows intact.
- A refresh failure must not replace dashboard data with blank data.
- Feature flags allow immediate fallback to direct MES.
- Passwords stay only in local `.env`, never in Git or Markdown.
- Daily audit logs should record refresh time, source row count, staging row count, duration, and mismatch count.

