# SC Yield Dashboard Calculations

This guide explains the calculations displayed by the **SC Yield Control** dashboard.

## Data scope

The selected start date, end date, and series filter apply to all SC Yield visuals. Input is filtered and bucketed using the Closed Batch date; scrap is filtered and bucketed using the Complete Action date. The scrap join resolves an eligible Closed Batch JobName and its series, but does not use the Closed Batch date or FG category as the scrap date bucket.

### Input quantity

Input comes from Closed Batch records:

```text
Product = SC
Category = FG
Input quantity = SUM(GrossQty)
```

The Closed Batch `Series` is the series used on the dashboard. A blank input series is displayed as `Element`.

### Scrap / defect quantity

Defects come from Complete Action records joined to the Completion 901 eligible Closed Batch job scope:

```text
DispositionType = SCRAP
Defect quantity = SUM(Qty_moved)
```

`DispositionCode` is matched to the workbook `Mode` value in `SC/Yield Calculation SC.xlsx`. The match accepts the normalized full Mode value or its leading alphanumeric/hyphen code prefix.

| Mapping result | Dashboard treatment |
| --- | --- |
| Matching Mode with `Calculate Yield = Y` | Included defect; assigned to its Mode Group |
| Matching Mode with `Calculate Yield = N` | Excluded scrap; not used in yield |
| No matching Mode | Unmapped scrap; not used in yield |

Missing mapped modes are retained as zero, so a zero defect quantity is a valid result.

## Core formulas

For any reporting bucket (month, week, or series):

```text
Included defect rate (%) = Included defect quantity / Input quantity × 100

Yield result (%) = (Input quantity − Included defect quantity) / Input quantity × 100
                 = 100 − Included defect rate
```

If input quantity is zero, defect rate and yield are unavailable (`-`); the dashboard never divides by zero.

## Summary cards

### Input qty

```text
SUM(Input quantity)
```

### Included defect qty

```text
SUM(defects mapped with Calculate Yield = Y)
```

### Defect rate and Total yield

These are weighted results for the full selected scope, not averages of series percentages:

```text
Total defect rate = Total included defect / Total input × 100
Total yield       = (Total input − Total included defect) / Total input × 100
```

## AR summary box

The AR box uses the latest month currently displayed in the selected date range.

### Yield Result

For Total and each eligible series (CAN, FC, FM, or any other series with input):

```text
Yield Result = (Input − Included defect) / Input × 100
```

### Achievement Rate (AR)

The Yield Target Setting page stores a target by **series and month**. AR measures how much of that target was achieved:

```text
AR (%) = Yield Result / Saved yield target × 100
```

Example: Yield Result `89.4%`, target `90.0%`:

```text
AR = 89.4 / 90.0 × 100 = 99.3%
```

AR may be greater than `100%` when yield is above target. If a target is blank or zero, AR is unavailable (`-`).

### Total AR

Only series that have a valid target greater than zero participate. Total AR is input-weighted so a high-volume series has a proportionally larger effect:

```text
Total AR = SUM(Series input × Series AR) / SUM(Series input)
```

Series without a target do not lower or raise Total AR.

## Monthly Total Yield chart

The main chart uses one bucket per calendar month.

| Visual element | Calculation |
| --- | --- |
| Stacked bars | Each Mode Group's included defect quantity / total monthly input × 100 |
| Green Yield line | `(monthly input − monthly included defect) / monthly input × 100` |
| Red Target line | Input-weighted saved target across series that have a target in that month |

The stacked bar height is the included defect rate. It excludes both `Calculate Yield = N` scrap and unmapped scrap.

## Input Ratio chart

This chart shows the composition of FG input for CAN, FC, and FM only. It does not measure yield or scrap.

For each month:

```text
Series input ratio (%) = Series FG input / (CAN input + FC input + FM input) × 100
```

The three stacked segments add to `100%` for a month with input.

## Yield by series charts

Each series card uses monthly data for that single Closed Batch series.

| Visual element | Calculation |
| --- | --- |
| Stacked bars | Each Mode Group's included defect / that series' monthly input × 100 |
| Green Yield line | `(series input − series included defect) / series input × 100` |
| Red Target line | Saved target for that series and month |

A series card is hidden when it has no eligible input in the selected period.

## Weekly yield tendency

The weekly charts use calendar-year / ISO-week-number buckets (`YYYY-Wnn`) and show CAN, FC, FM, and Total. At a new-year boundary, the displayed year is the calendar year from the source date while the week number is the ISO week number.

### Weekly yield tendency

For each selected week:

```text
Weekly yield = (Week input − Week included defect) / Week input × 100
```

### Accumulated weekly yield tendency

For each selected week, the calculation accumulates from the first selected week through that week:

```text
Accumulated yield at week N =
  (SUM(input through week N) − SUM(included defect through week N))
  / SUM(input through week N) × 100
```

Selecting a different From week / To week changes both charts to that displayed week range.

## Detail table

Each row is one month and series. The table shows the same measures used by the charts:

| Column | Calculation |
| --- | --- |
| Input qty | `SUM(FG GrossQty)` |
| Included defect qty | `SUM(Qty_moved)` for mapped `Calculate Yield = Y` codes |
| Defect rate | `Included defect qty / Input qty × 100` |
| Yield | `(Input qty − Included defect qty) / Input qty × 100` |
| Excluded scrap | Mapped codes with `Calculate Yield = N` |
| Unmapped scrap | Codes with no matching Mode in the mapping workbook |
