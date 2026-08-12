# MTD Target Feature Agent Instructions

## 1. MTD Target Feature Overview

Add a new feature to the OneMES Azure SQL dashboard: an MTD Target table with a Parameter Setting page.

The feature lets users enter:

- Product
- Serie
- Target
- Working Day

These values must be saved and reused by the dashboard. Do not hardcode them.

Targets must be assignable to a specific product, such as `NEO` or `SC`, and to a specific serie under that product.

Formula:

```text

  MTD Target = Monthly Plan / Working Days × Current Day

  Ex:

  - Monthly plan: 2,000
  - Working days: 31
  Daily target = 2,000 / 31 = 64.52
  MTD target on July 18 = 64.52 × 18 = 1,161.29

```

Existing production data comes from Azure SQL Database:

- Database: `OneMES_Report_THR`
- View/table: `dbo.LotCompleteLog`
- Series/item column: `from_itemName`
- Quantity column: `quantityMoved`

The dashboard already filters by:

- Product
- Process
- Date/time range
- Serie
- Case
- PN

Product examples:

- `NEO`
- `SC`

Series must be grouped under their product. For example, if the user selects product `NEO`, the serie selector should show only series that belong to `NEO`. If the user selects product `SC`, the serie selector should show only series that belong to `SC`.

## 2. Parameter Setting Page Requirements

Create a clear Parameter Setting page or tab where the user can input:

- `Product`
- `Serie`
- `Target`
- `Working Day`

Requirements:

- Save the values so the dashboard can reuse them by product and serie.
- Product is required.
- Serie is required.
- Product options should include at least `NEO` and `SC`, and should be configurable.
- Serie options must be filtered by selected product.
- Support one target setting per product + serie combination.
- If the app is local-only, `localStorage` is acceptable.
- If the app is multi-user or production, use backend storage or a database table.
- Show current saved values after reload.
- Provide a Save button.
- Show validation errors clearly.
- Do not save invalid values.

## 3. MTD Table Calculation Rules

The MTD table should show:

| Metric | Formula |
|---|---|
| Product | Selected product |
| Serie | Selected serie |
| Target | User input |
| Working Day | User input |
| Daily Target / MTD Target | `Target / Working Day` |
| Actual MTD | `SUM(quantityMoved)` for selected filters/date range |
| Gap | `Actual MTD - Target` |
| Achievement % | `Actual MTD / Target * 100` |

Calculation rules:

- Look up Target and Working Day from the selected product + serie.
- `Target` must be numeric.
- `Working Day` must be numeric.
- Prevent divide-by-zero.
- Format large numbers with commas.
- Show percentage with 1-2 decimal places.
- If Target or Working Day is missing, show a setup message instead of wrong calculations.

## 4. Backend/API Requirements

Do not connect to SQL Server directly from frontend code.

Use the backend API for SQL queries.

The API should provide or reuse an endpoint that returns Actual MTD:

```text
Actual MTD = SUM(quantityMoved)
```

Actual MTD must respect selected filters:

- Product
- Date/time range
- Process
- Serie
- Case
- PN

Product/serie target settings must be stored separately from production SQL data unless the user explicitly asks to create a database table for settings.

Suggested local settings shape:

```json
{
  "NEO": {
    "FPS A08": {
      "target": 1000000,
      "workingDay": 20
    }
  },
  "SC": {
    "SC SERIES 1": {
      "target": 500000,
      "workingDay": 22
    }
  }
}
```

SQL requirements:

- Use parameterized SQL queries.
- Validate date inputs.
- Validate configured table/view/column names.
- Keep database access read-only unless explicitly asked.
- Do not expose database credentials or raw SQL errors to the frontend.

## 5. Frontend/UI Requirements

Add:

- A Parameter Setting page or tab.
- An MTD Target table on the dashboard.
- Product selector, such as `NEO` and `SC`.
- Serie selector filtered by selected product.

The MTD table should be easy to read and suitable for production reporting.

Recommended table:

| Metric | Value |
|---|---:|
| Product | selected product |
| Serie | selected serie |
| Target | saved target |
| Working Day | saved working day |
| Daily Target / MTD Target | target / working day |
| Actual MTD | sum(quantityMoved) |
| Gap | actual MTD - target |
| Achievement % | actual MTD / target * 100 |

UI behavior:

- When the user selects Product, update the Serie list to show only series under that product.
- When the user selects Product + Serie, load the saved Target and Working Day for that pair.
- When the user changes filters, Actual MTD and Gap should update.
- Saved Target and Working Day should remain until changed in Parameter Setting.
- If settings are missing, show a clear message asking user to enter parameters.

## 6. Validation Rules

Validate before saving:

- Product is required.
- Product must be one of the allowed configured products.
- Serie is required.
- Serie must belong to the selected product.
- Target is required.
- Target must be greater than `0`.
- Working Day is required.
- Working Day must be greater than `0`.
- Working Day should allow decimal only if the business wants partial working days.
- Prevent divide-by-zero.
- Do not allow text, negative numbers, or empty values.

## 7. Security Rules

- Never hardcode passwords, tokens, or database secrets.
- Never expose database credentials in frontend code.
- Never connect browser JavaScript directly to SQL Server.
- Use environment variables for connection settings.
- Use backend API for all database access.
- Use parameterized queries for user values.
- Do not allow raw SQL from the browser.
- Keep database access read-only unless explicitly requested.
- Protect organization data.

## 8. Testing Checklist

Verify:

- Parameter Setting page opens correctly.
- User can save Target and Working Day.
- Saved values remain after page reload.
- Invalid Target is rejected.
- Invalid Working Day is rejected.
- Working Day `0` is rejected.
- MTD Target equals `Target / Working Day`.
- Target settings are saved separately for each product + serie.
- Selecting `NEO` shows only `NEO` series.
- Selecting `SC` shows only `SC` series.
- Changing product clears or updates the selected serie safely.
- Actual MTD equals `SUM(quantityMoved)` for selected filters/date range.
- Gap equals `Actual MTD - Target`.
- Achievement % equals `Actual MTD / Target * 100`.
- Changing filters updates Actual MTD.
- Frontend build passes.
- Backend starts successfully.
- API does not expose secrets.
- SQL queries use parameters.

## 9. Things The Agent Must Not Do

The agent must not:

- Modify production data.
- Mix targets between different products.
- Allow a serie that does not belong to the selected product.
- Hardcode Target or Working Day.
- Hardcode database credentials.
- Put SQL credentials in frontend code.
- Connect directly from the browser to Azure SQL.
- Accept raw SQL from users.
- Use string concatenation for user filter values in SQL.
- Ignore divide-by-zero.
- Show incorrect MTD calculations when parameters are missing.
- Replace existing dashboard behavior unrelated to this feature.
