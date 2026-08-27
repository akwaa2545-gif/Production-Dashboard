# TA Yield Data Structure and Calculation Guide

## Purpose

This document explains the TA Yield data used by the dashboard and the **TA Yield DataTable** Excel export. It is based on the current implementation in `src/taYieldRepository.js`, `src/taYieldMapping.js`, and `src/app.js`.

There are two related data paths:

1. **TA Yield dashboard summary** - calculated from MES Closed Batch and Complete Action records.
2. **TA Yield DataTable / tendency** - calculated from the staged workbook-reconciliation structure. This is the source for the Excel-style DataTable export and the TA yield tendency charts.

Do not add quantities from the two paths together; they are alternative presentations of the same manufacturing context with different reconciliation rules.

## 1. MES input structure for the TA Yield dashboard

The dashboard first builds one logical record per lot, keyed by:

```text
line + lotNo
```

### Raw fields

| Field | MES source | Meaning | How it is used |
| --- | --- | --- | --- |
| `lotNo` | `ClosedBatch_v.JobName` / `CompleteAction_v.JobName` | TA production lot identifier | Join key and lot-level grouping key. |
| `line` | `ClosedBatch_v.Series` | TA series/line displayed in the report | Reporting series and mapping selection. GPS lines use the GPS defect map; other TA lines use the NEO/STD-FPS map. |
| `closeDate` | `ClosedBatch_v.CloseDate` | Lot close date | Determines the reporting day, ISO week, or month. Thailand calendar time is used for bucketing. |
| `jobType` | `ReleasedJob.JobClass` when available; otherwise `ClosedBatch_v.JobType` | Production classification | `E` and `NON-STANDARD` lots are excluded. |
| `inputQ` | `ClosedBatch_v.GrossQty` | Gross input quantity | The maximum value is retained once per lot; it is not summed once per action row. |
| `occuredOn` | `CompleteAction_v.OccuredOn` | Date/time of final-good, scrap, or input-deduction action | Used to select action records inside the requested reporting range. |
| `finalGoodQ` | `CompleteAction_v.QuantityMoved` | Quantity at the configured final-good disposition | The maximum positive final-good quantity is retained once per lot. |
| `dispositionCode` | `CompleteAction_v.DispositionCode` | MES action/mode code | Used for input deductions, defect mapping, and diagnostic evidence. |
| `quantity` | `CompleteAction_v.QuantityMoved` | Quantity moved for the disposition code | Summed by lot and mode after code normalization. |

### Lot eligibility

A lot is excluded when any of the following is true:

- `jobType` is `E` or `NON-STANDARD`.
- The two digits immediately before `N` in `lotNo` are not in `01` through `31`.
- Final good / adjusted input is less than or equal to 30%.
- Input is zero or negative and the lot has no recorded modes.

Only lots with the configured final-good disposition in the requested action-date range are loaded into the dashboard calculation.

## 2. MES dashboard calculations

All formulas below are performed at **lot level first**. The dashboard then sums eligible lot results into the selected day, week, or month and series. This prevents repeated MES input and final-good values from being multiplied by the number of disposition rows.

| Result | Formula | Notes |
| --- | --- | --- |
| Pellet assembly deduction | Sum of `quantity` where `dispositionCode = 0201_Inp_Pellet_Assy` | Removed from gross input. |
| Machine-sample deduction | Sum of `quantity` where `dispositionCode = X01_Machine_Sample` | Removed from gross input. |
| Usable input | `inputQ - pellet assembly deduction - machine-sample deduction` | Starting denominator before the Other balancing rule. |
| Defect sum used for Other | Sum of mapped quantities whose base code is in the configured `0301_Sample_CV` through `2021_CAM6` Other-code list | Codes generated after EI are not part of this subtraction. |
| Raw Other | `usable input - finalGoodQ - defect sum used for Other` | Reconciliation difference for the lot. |
| Adjusted input | If `ABS(raw Other) > 500`, `usable input - raw Other`; otherwise `usable input` | This is the denominator shown as `input` in summary and lot-detail responses. |
| Yield (%) | `finalGoodQ / adjusted input × 100` | Unavailable when adjusted input is zero. |
| Defect group quantity | Sum of eligible mode quantities mapped to that group | The two input-deduction modes are never defect groups. |
| Defect-group rate (%) | `defect group quantity / adjusted input × 100` | Calculated after lot quantities are rolled up to the reporting bucket. |
| Total defect quantity | Sum of all displayed defect-group quantities | Includes configured zero-quantity groups as zero. |
| Total defect rate (%) | `total defect quantity / adjusted input × 100` | Calculated after rollup. |

`1812_SH_PLS` is mapped to **ACC** by default when its part type is found and `acc_volt` is not zero. It is classified as **SH** when `acc_volt = 0` or when no matching part type exists. The underlying mode remains visible in the calculation log.

## 3. TA Yield DataTable structure

The exported **TA Yield DataTable** has one row per normalized lot. Its business key is:

```text
ProdLine + JobName + Taping Date
```

The row contains raw workbook-style category quantities in `categories`, plus the calculated values in `calculation`.

### Identity columns

| Excel column | Internal field | Meaning |
| --- | --- | --- |
| `ProdLine` | `line` | TA production line / series. |
| `JobName` | `lotNo` | Lot number. |
| `From ItemName` | `itemName` | Source part number/item name. |
| `Taping Date` | `tapingDate` | Date of the final/taping event used to place the lot in the DataTable period. |

### Raw category columns

The export includes the following category columns when present in the staged data. `ACC` is always included so its absence is visible as zero.

| Column | Meaning | Included in `Defect`? |
| --- | --- | --- |
| `Input` | Gross workbook-reconciliation input quantity | No |
| `Input-` | Input quantity removed from the denominator | No |
| `Good` | Final good quantity | No |
| `ACC` | Electrical ACC defect quantity | Yes |
| `App` | Appearance defect quantity | Yes |
| `CO` | CO defect quantity | Yes |
| `Cap` | Capacitance defect quantity | Yes |
| `DF` | Dissipation-factor defect quantity | Yes |
| `ESR` | ESR defect quantity | Yes |
| `Inproc Dw` | Downstream in-process defect quantity | Yes |
| `Inproc Up` | Upstream in-process defect quantity | Yes |
| `LC` | Leakage-current defect quantity | Yes |
| `La/Ex1` | La/Ex1 defect quantity | Yes |
| `La/Ex2-6` | La/Ex2 through La/Ex6 defect quantity | Yes |
| `PULSE` | Pulse defect quantity | Yes |
| `SH` | Short-related defect quantity | Yes |

Category columns not listed above can exist in the staged data, but only the configured defect categories contribute to the DataTable `Defect` calculation.

### Calculated columns

| Excel column | Internal field | Formula | Meaning |
| --- | --- | --- | --- |
| `Defect` | `calculation.defect` | `ACC + App + CO + Cap + DF + ESR + Inproc Dw + Inproc Up + LC + La/Ex1 + La/Ex2-6 + PULSE + SH` | Total configured defect quantity before Other is considered. |
| `Other1` | `calculation.other1` | `Input - Input- - Defect - Good` | Unexplained balance quantity before the threshold adjustment. |
| `InputF` | `calculation.inputF` | If `ABS(Other1) > 500`: `Input - Input- - Other1`; otherwise `Input - Input-` | Final input denominator for rates. |
| `Other2` | `calculation.other2` | If `ABS(Other1) > 500`: `0`; otherwise `Other1` | Residual reconciliation difference included in the displayed defect total/rate. |
| `%Good` | `calculation.goodRate` | `Good / InputF × 100` | Good yield percentage. Excel stores the value as a fraction and formats it as a percentage. |
| `%Defect` | `calculation.defectRate` | `(Defect + Other2) / InputF × 100` | Defect percentage including the residual Other2 amount. |
| `TTL` | `calculation.ttl` | `%Good + %Defect`, rounded to two decimals | Reconciliation total; normally 100.00%. |
| `Check` | `calculation.check` | `ABS(TTL - 100)` | Difference from a perfect 100% reconciliation. `0` means the row reconciles. |

If `InputF` is zero, `%Good`, `%Defect`, `TTL`, and `Check` are unavailable rather than divided by zero.

## 4. Rollup data structure

The DataTable tendency and summary roll up normalized lot rows by reporting period and `ProdLine`.

```json
{
  "month": "2026-08",
  "line": "FPS",
  "input": 900,
  "finalGood": 800,
  "groups": [
    { "group": "CO", "quantity": 50, "rate": 5.5556 },
    { "group": "Other2", "quantity": 50, "rate": 5.5556 }
  ],
  "defect": 100,
  "defectRate": 11.1111,
  "yield": 88.8889,
  "partNumbers": ["example part number"]
}
```

| Rollup field | Calculation |
| --- | --- |
| `month` | Taping-date bucket for DataTable/tendency data: day (`YYYY-MM-DD`), ISO week (`YYYY-Wnn`), or month (`YYYY-MM`). |
| `line` | `ProdLine` / TA series. |
| `input` | Sum of each normalized lot's `InputF`. |
| `finalGood` | Sum of each normalized lot's `Good`. |
| `groups` | Sum by defect category; `Other2` is included when non-zero. |
| `groups[].rate` | `group quantity / input × 100`. |
| `defect` | Sum of all group quantities, including `Other2` when present. |
| `defectRate` | `defect / input × 100`. |
| `yield` | `finalGood / input × 100`. |
| `partNumbers` | Distinct sorted `From ItemName` values included in the bucket. |

## 5. Important handling rules

- Numeric values are treated as numbers; missing quantities become zero.
- Repeated source rows for the same normalized DataTable lot are collapsed, not added repeatedly.
- In MES dashboard data, input and final good use the maximum per lot, while disposition quantities are summed per mode.
- Raw MES disposition codes are normalized before mapping (for example, surrounding spaces are removed).
- Unmapped MES modes are recorded as `Unmapped` for diagnostic review; they are not silently assigned to a defect group.
- Date buckets use Thailand calendar time. Weekly values use ISO week-year, so dates at a year boundary can belong to the previous ISO week-year.
