# TA Yield Discovery and Coding Specification

## Status

Prepared from `TA/Direction and guidance for TA Yield report.xlsx` and a read-only schema check of `PowerBIThailand.Yield_v` on 2026-07-24. This is the implementation baseline for TA Yield; resolve the marked confirmation items before production release.

## Source and scope

- Source view: `PowerBIThailand.Yield_v`.
- TA records currently appear under `ProdType = 'NEO'`.
- Reporting line: `ProdLine` (for example, the live source currently has `Ta NEO Capacitor FPS series B3 case`).
- Lot key: `LotNo`.
- Product/item context: `MaterialText`, `PelletPN`, and `PelletLotNo`.
- Use the same date rule as SC Yield: bucket/filter input with `CloseDate`, and bucket/filter defects plus final good with `OccuredOn`.

## Verified Yield_v fields

| Purpose | Column |
| --- | --- |
| Series/line | `ProdLine` |
| Product | `ProdType` |
| Lot | `LotNo` |
| Input base | `InputQ` |
| Defect mode | `DispositionCode` |
| Defect quantity | `Qty` (varchar; convert safely to decimal) |
| Final good for yield | `SpecifiedOperationCompletion FinalGoodQ` (varchar; convert safely to decimal) |
| Alternate final-good field | `FinalGoodQ` — do **not** use for the TA Yield formula |
| Date candidates | `OccuredOn`, `CloseDate` |

`Yield_v` is a long-form lot/mode view: `InputQ` and the specified-operation final-good value repeat across a lot's disposition rows. Aggregate at the lot level first, then aggregate the eligible lots into reporting buckets. Do not sum repeated values across every disposition row.

## Lot eligibility

Exclude a lot when either condition applies:

1. Its source `Job Type` is `E` (engineering/experiment); `N` is mass production.
2. The two digits immediately before `N` in `LotNo` are outside `01` through `31`, such as `6G98N...`, `6G32N...`, or `6G54N...`.
3. Its calculated yield is less than or equal to `30%`.

### Job Type database link

`Yield_v` does not contain Job Type. Join it to `KMESV3.ReleasedJob`:

```text
Yield_v.LotNo = ReleasedJob.LotID
```

Use `ReleasedJob.JobType` for the engineering-lot exclusion. Live TA values are `Standard`, `NON-STANDARD`, and null. Treating `NON-STANDARD` as the workbook's engineering/experiment (`E`) classification is a reasonable provisional mapping, but confirm it with the TA owner before release.

## Lot-level quantities

For each eligible lot, safely convert numeric varchar fields with `TRY_CONVERT(decimal(19,4), ...)` and treat null defect quantities as zero.

```text
Pellet assembly input = Qty where DispositionCode = '0201_Inp_Pellet_Assy'
Machine sample        = Qty where DispositionCode = 'X01_Machine_Sample'

Usable input = InputQ - Pellet assembly input - Machine sample
Final good   = SpecifiedOperationCompletion FinalGoodQ
```

The source currently contains `0201_Inp_Pellet_Assy`; the code must match the exact configured string, not a shortened display label.

## Defect mapping

The workbook contains mode-to-category maps for different TA variants:

- `NEO Def Mode` — NEO/FPS-oriented map with Yield Category, Main Graph Category, and Detail Graph Category.
- `GPS Def Mode` — GPS-oriented map with corresponding category fields.
- `STD-FPS` and `GPS` — source-code/category reference sheets.
- `GPS mode` — mapping between KMES main/GPS names and SAP names.

Use the selected `ProdLine`/TA variant to choose the applicable map. Store the mapping as configuration/data, not hard-coded chart logic. Include only disposition codes that exist in the supplied workbook mapping; report every database code not in that mapping as unmapped. Every mapped `DispositionCode` must provide at least:

| Field | Use |
| --- | --- |
| Mode/source code | Match to `Yield_v.DispositionCode` |
| Yield Category | Yield-table grouping |
| Main Graph Category | Stacked-bar group |
| Detail Graph Category | Drill-down group |

The stacked Yield/defect chart must show:

- Electrical characteristics: ACC, SH, ESR, CAP, LC, PULSE, and CO.
- Appearance separated into Crack and App.
- Inprocess Upstream.
- Inprocess Downstream.
- La/Ex1.
- La/Ex2.
- Other.

## Formulas

For each reporting bucket, sum the lot-level values only after all eligibility rules and the Other adjustment have been applied.

```text
Yield (%) = Final good / usable input × 100

Defect rate for a category (%) = category defect quantity / usable input × 100
```

### Other

The workbook defines Other as:

```text
Other = usable input - Final good - all defect items from 0301_Sample_CV through 2021_CAM6
```

Codes `2101_Keep_Sample` through `2201_Re_screen_defective` are generated after EI and are not part of that Other subtraction.

Confirmed balancing rule:

```text
If ABS(Other) > 500:
  adjusted input = usable input - Other
  adjusted Other = 0
Otherwise:
  adjusted input = usable input
  adjusted Other = Other
```

Use adjusted input as the denominator for Yield and defect rates.

## Visual requirements

1. Stacked defect-rate bars with a Yield line for the product total.
2. Yield-tendency line charts by series: PSL, PSG, FPS, and GPS.
3. Main/detail defect views driven by the selected workbook mode mapping.
4. If input is zero after adjustment, display Yield and rates as unavailable (`-`); never divide by zero.

## Implementation guardrails

- Use a single lot-level CTE/subquery before monthly/weekly rollups to prevent repeated `InputQ` and final-good values from being double counted.
- Parameterize dates, line/series selections, and product values.
- Keep unmatched disposition codes visible in diagnostics; do not silently count them in mapped categories.
- Report excluded lots and their exclusion reason for reconciliation.

## Remaining confirmation

Confirm that `ReleasedJob.JobType = 'NON-STANDARD'` is the intended equivalent of workbook Job Type `E` (engineering/experiment). `Standard` is expected to be mass production (`N`).
