# SC Yield Discovery

## Status

Initial implementation is in progress. This document remains the business-rule record for SC Yield.

## Proposed Source

- View: `PowerBIThailand.CompleteAction_v` (verified database object name)
- Scope: Super Capacitor (SC) yield reporting.
- Eligibility: include only records whose `JobName` exists in the Closed Batch source after the Completion 901 SQL eligibility condition has been applied.

### Completion 901 Job Eligibility

`Complete_actionV` is not used as an unrestricted source. It must be limited to the job population that is valid for Completion 901:

```text
Complete_actionV.JobName
    must exist in
Closed Batch JobName
    after applying the same SQL condition used by the Completion 901 report.
```

This relationship prevents SC Yield from including WIP, unqualified, or unrelated jobs that are not part of the 901 completion population. The final query should use a parameterized `EXISTS` or inner join on `JobName` and must reuse the established 901 condition rather than duplicate a different interpretation.

The linked Closed Batch `Series` is also the reporting group for both input and scrap. `CompleteAction_v.ProdLine` must not be used as the yield series because SFG input actions and scrap actions use different product-line values.

### Observed Source Behaviour

For the first live July 2026 check, the Completion 901 eligible input linked to `Element`, while included scrap linked to other series such as `CAN`, `FC`, and `FM`. Product-total yield is therefore calculated by month across the complete qualified SC scope. A per-series yield is available only when that series has linked input; a zero-input row is shown as unavailable rather than divided by zero.

## Source Measures

### Input quantity

Input is the sum of Closed Batch `GrossQty` where:

- `Category = 'FG'`
- the Closed Batch series is the reporting series.

This replaces the prior Complete Action `SFG_input` measure so that each series uses its own finished-good input quantity.

### Defect quantity

Defect is the sum of `Qty_moved` where:

- `DispositionType = 'SCRAP'`
- `Qty_moved >= 1`

The defect code comes from `DispositionCode`.

## Defect Code Mapping

Reference workbook: `SC/Yield Calculation SC.xlsx`, Sheet 1.

The inspected sheet contains 198 rows and these relevant columns:

| Workbook column | Meaning |
| --- | --- |
| `Line` | SC product line / series grouping used by the reference calculation. |
| `Mode` | Defect-mode value to match against source `DispositionCode`. |
| `Calculate Yield (Y/N)` | Include the mapped defect in yield only when the value is `Y`. |
| `Mode Grouping (Refer Column G)` | Reporting group for the included defect code. |

The workbook currently contains 121 `Y` codes and 71 `N` codes. A source `DispositionCode` that is unmapped or marked `N` must not contribute to the SC Yield defect total.

Example mapping values observed in the workbook include `1212_Element Expose` and group `Assembly`.

## Calculations

For each reporting scope (for example a month, line, series, or defect group):

```text
Defect rate (%) = Defect quantity / Input quantity * 100
Yield (%)       = (Input quantity - Defect quantity) / Input quantity * 100
                = Good quantity / Input quantity * 100
```

If input quantity is zero, Yield and Defect rate must be shown as unavailable rather than divided by zero.

### Total Yield

The handwritten example requires a weighted total, not an average of individual series yields:

```text
Total input  = sum of all included series inputs
Total defect = sum of all included series defects
Total yield  = (Total input - Total defect) / Total input * 100
```

Example from the note: inputs `10 + 20 + 30 = 60`, defects `2 + 2 + 2 = 6`, therefore total yield is `(60 - 6) / 60 * 100 = 90%`.

## Intended Reporting Visuals

### Monthly total yield

The reference chart shows:

- Month on the X axis.
- Stacked defect-rate bars by defect group.
- Yield percentage as a line on a secondary Y axis.
- A target-yield line for comparison.

The bar stack represents defect-rate contributions. The total defect rate plus yield should equal 100% when both are calculated from the same included input and defect scope.

### Detail reporting

The expected drill-down dimensions are still to be confirmed, but may include:

- Line / series.
- Month and date range.
- Defect group from the workbook.
- Individual `DispositionCode`.

## Items To Confirm Before Design Or Implementation

1. Exact date column in `Complete_actionV` for daily and monthly grouping.
2. Exact spelling and data types of `OperationName`, `DispositionType`, `DispositionCode`, and `Qty_moved`.
3. Which source column maps to workbook `Line` / dashboard series.
4. Whether all SC series use the same `SFG_input` input operation.
5. Whether the yield target is one value for all SC, or varies by line, series, month, or defect group.
6. Whether unmatched `DispositionCode` values should be reported separately as `Unmapped`, while excluded `N` codes remain excluded.
7. Required default reporting period and whether partial current-month data should be marked live.
