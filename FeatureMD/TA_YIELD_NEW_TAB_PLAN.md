# TA Yield Machine Tab - Requirements Intake

## Status

Captured from the initial business requirements. This is a requirements document only; the **Machine** tab has not been implemented.

## Purpose

Add a new TA Yield tab named **Machine**, placed next to **Production dashboard**. It analyses TA Yield eligible lots by the machine and process where they were handled, then shows their defect distribution over time.

The tab is available only when the selected data source is **TA Yield**.

## Scope and data sources

| Need | Source | Required fields |
| --- | --- | --- |
| Eligible TA Yield lots | Existing TA Yield calculation/result set | TA Yield lot identifier and current active filters |
| Machine/process history | MES `LotStartLog` table or view | `JobName`, `MachineName`, `From_OperationName`, `OccuredOn` |
| Defect mode | TA Yield MES data | `DispositionCode` |
| Yield category | Existing TA Yield mapping | Yield Category and its linked disposition codes |

`LotStartLog.JobName` must join to the TA Yield lot key. The verified MES source is `PowerBIThailand.LotStartLog`; the exact spelling/case of `MachineName` must still be confirmed before implementation.

## Shared TA Yield conditions

The Machine tab must use only lots that satisfy the existing TA Yield conditions. It must use the same filter values as the TA Yield Production dashboard:

- Start date
- End date
- Selected TA series, if a series is selected

The date source for Machine-tab events is `LotStartLog.OccuredOn`. The selected date range includes the full start and end dates in Thailand time:

```sql
LotStartLog.OccuredOn >= startDate 00:00:00 Thailand time
AND LotStartLog.OccuredOn < (endDate + 1 day) 00:00:00 Thailand time
```

This is separate from the existing Closed Batch `CloseDate` input-lot selection. Both conditions apply: the lot must be eligible for TA Yield, and its selected `LotStartLog` event must occur inside the selected event-date range.

## Required filters

### 1. Date range

Use the same Start date and End date controls already shown on the TA Yield Production dashboard. Do not create a second date selector in the Machine tab.

### 2. Process

Provide one Process selector with exactly these values:

1. `1.1stAnodization`
2. `2.Welding`
3. `3.Ei`

The selector filters `LotStartLog.From_OperationName`.

### 3. Machine

After the user selects a Process, populate the Machine selector with the distinct `LotStartLog.MachineName` values available for that process and the active TA Yield/date scope.

The Machine selector must be dependent on Process. Changing Process clears the previous machine selection and reloads the valid machines.

### 4. Defect view

Provide one dropdown that contains two visually separated sections:

- **Disposition code** - all TA Yield `DispositionCode` values
- **Yield category** - all TA Yield Yield Category values

If the user selects a Yield Category, the page must also show which disposition codes are linked to that category. If the user selects a Disposition Code, no linked-category explanation is required.

The UI must make the two option types clearly different, for example with optgroup labels, section headers, and different badges/colours in the selected-value summary.

## Graph requirements

Render a stacked graph after the user applies the filters.

| Chart element | Required behavior |
| --- | --- |
| Time | Group events by calendar date from `LotStartLog.OccuredOn` |
| Machine | Display the selected/returned machine name on the chart's vertical labels as rotated text when needed |
| Stack | Use the selected defect grouping: a disposition code or a Yield Category |
| Category selection | When a Yield Category is selected, display the linked disposition codes in the chart legend/detail area |
| Category selection | When a Disposition Code is selected, display only that code; no category linkage is required |

### Chart measurement to confirm

A stacked graph needs a numeric Y axis. The request says the Y axis should be a disposition code or Yield Category, but those are categorical labels. The likely intended design is:

```text
X axis:  LotStartLog.OccuredOn date, with machine names as vertical/rotated labels
Y axis:  numeric measure
Stack:   Disposition Code or Yield Category
```

The numeric measure must be confirmed before build:

- number of distinct lots (`COUNT(DISTINCT JobName)`), or
- defect quantity (`SUM(QuantityMoved)` from TA Yield defect records), or
- another business measure.

## Expected user flow

1. User selects TA Yield as the data source and opens **Machine**.
2. User sets the shared dashboard Start date and End date.
3. User selects one of the three processes.
4. The page loads machines for the chosen process; user selects a machine.
5. User selects either a Disposition Code or Yield Category.
6. The graph shows matching TA Yield eligible lots by `LotStartLog.OccuredOn` date and machine.
7. For a Yield Category selection, the page shows the linked Disposition Codes used in the result.

## Initial implementation outline

| Area | Expected work |
| --- | --- |
| Navigation | Add the TA-only **Machine** button beside Production dashboard in `public/index.html` |
| Client view | Add Machine-tab state, dependent process/machine selectors, grouped defect selector, and chart renderer in `public/app.js` |
| API | Add endpoints for available machines and chart data in `src/app.js` |
| Repository | Add parameterized `LotStartLog` queries and TA-eligible-lot join in a dedicated repository or `src/taYieldRepository.js` |
| Configuration | Add a safe `TA_YIELD_LOT_START_LOG_DB_VIEW` configuration value only after the MES object name is confirmed |
| Tests | Add UI, API, repository, date-boundary, and TA-eligibility reconciliation tests |

## Safeguards

- Join to the existing TA Yield eligible lot set first; do not report all `LotStartLog` records.
- Parameterize all date, process, machine, disposition-code, and Yield Category inputs.
- Preserve Thailand-time date boundaries.
- Keep the existing TA Yield eligibility, input, final-good, defect, and mapping rules unchanged.
- Do not multiply a lot's quantities when one lot has multiple `LotStartLog` rows; define aggregation explicitly.
- Provide clear empty and unavailable-data messages.

## Confirm before implementation

1. What is the exact MES object name/schema for `LotStartLog`?
2. Is the machine field exactly `MachineName`? The provided request included two spellings.
3. Do the process values exactly match `From_OperationName`, including spaces and punctuation?
4. What numeric measure should the graph use: distinct lot count, defect quantity, or another measure?
5. Should the chart show one selected machine only, or allow comparison of all machines in the selected process?
6. When a Yield Category is selected, should the chart stack each linked Disposition Code separately, or show one category total plus a linked-code list?
7. Should the Machine tab include a detail table/export below the graph?

## Reference

- Existing TA Yield baseline: `FeatureMD/TA_YIELD_PERFORMANCE_PLAN.md`
- Existing TA Yield discovery: `FeatureMD/TA_YIELD_DISCOVERY.md`
