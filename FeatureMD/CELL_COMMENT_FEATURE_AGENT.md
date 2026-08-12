# Cell Comment Feature Agent Instructions

## 1. Feature Overview

Add an Excel-like comment feature to the `Series completion by day` table.

Users should be able to click a day cell, add a comment, and later see that comment from the same cell. Cells with comments should show a small corner marker similar to Excel.

This feature must not modify production MES data.

Production data source:

- Database: `OneMES_Report_THR`
- Production view/table: `dbo.LotCompleteLog`
- Existing table view: `Series completion by day`

## 2. Cell Comment Scope

A comment belongs to one specific table cell.

Build a stable cell key from:

- Product
- Serie
- PN, if available
- Process/filter context, if needed
- Reporting date/day column

Recommended key shape:

```text
product|serie|pn|process|reportingDate
```

Rules:

- The same cell must always load the same comment.
- A comment for one reporting date must not appear on another reporting date.
- A comment for one serie must not appear on another serie.
- A comment for one product must not appear on another product.
- If PN or process is not used in the current table context, store it as blank or `null` consistently.

## 3. User Experience Requirements

The user should be able to:

- Click a day cell in the `Series completion by day` table.
- Add a comment to that specific cell.
- See a small corner marker when the cell has a comment.
- Hover or click the marked cell to show the comment popup.
- Edit their comment if allowed.
- Delete their comment if allowed.
- Optionally reply to comments if threaded comments are implemented.

The comment popup should show:

- User name
- Comment text
- Created date/time
- Edited date/time if edited
- Reply input if replies are supported

UI behavior:

- Popup should appear near the selected cell.
- Popup should not hide important table content when possible.
- Pressing `Escape` should close the popup.
- Clicking outside should close the popup.
- Save, edit, delete, and loading states should be visible.
- Errors should be clear and user-friendly.
- The table layout must remain stable.

## 4. SQL Server Storage Rules

Comments must be saved in SQL Server through the backend API.

Do not use `localStorage` for saved comments. `localStorage` is allowed only for temporary unsaved draft text.

Comments must be stored separately from production SQL data. Do not write comments into:

```text
dbo.LotCompleteLog
```

Required comment table:

```text
dbo.DashboardCellComments
```

Recommended schema:

```sql
CREATE TABLE dbo.DashboardCellComments (
    id INT IDENTITY(1,1) PRIMARY KEY,
    product NVARCHAR(100) NOT NULL,
    serie NVARCHAR(100) NOT NULL,
    pn NVARCHAR(100) NULL,
    process NVARCHAR(100) NULL,
    reportingDate DATE NOT NULL,
    commentText NVARCHAR(1000) NOT NULL,
    createdBy NVARCHAR(255) NOT NULL,
    createdAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    updatedAt DATETIME2 NULL,
    deletedAt DATETIME2 NULL
);
```

Recommended lookup index:

```sql
CREATE INDEX IX_DashboardCellComments_Lookup
ON dbo.DashboardCellComments (
    product,
    serie,
    reportingDate,
    pn,
    process
)
WHERE deletedAt IS NULL;
```

If the business wants only one active comment per cell, use a unique index. Because `pn` and `process` can be `NULL`, normalize them with computed columns:

```sql
ALTER TABLE dbo.DashboardCellComments
ADD pnKey AS ISNULL(pn, N'') PERSISTED,
    processKey AS ISNULL(process, N'') PERSISTED;

CREATE UNIQUE INDEX UX_DashboardCellComments_Cell
ON dbo.DashboardCellComments (
    product,
    serie,
    reportingDate,
    pnKey,
    processKey
)
WHERE deletedAt IS NULL;
```

Recommended permissions for the web app database user:

```sql
GRANT SELECT, INSERT, UPDATE ON dbo.DashboardCellComments TO [your-web-app-user];
```

Do not grant write permission on `dbo.LotCompleteLog`.

Recommended behavior:

- Use soft delete with `deletedAt`.
- Use UTC timestamps for storage.
- Display timestamps in the user's local timezone.
- Keep comment history only if explicitly required.
- Keep comment writes separate from MES production records.

## 5. Backend/API Requirements

Use backend API for comment storage in SQL Server.

Suggested endpoints:

```text
GET /api/comments?product=&serie=&pn=&process=&startDate=&endDate=
POST /api/comments
PATCH /api/comments/:id
DELETE /api/comments/:id
```

Endpoint behavior:

- `GET /api/comments` should return comments for the selected dashboard filter context and date range.
- `POST /api/comments` should create a comment for one cell in `dbo.DashboardCellComments`.
- `PATCH /api/comments/:id` should update an existing comment in `dbo.DashboardCellComments`.
- `DELETE /api/comments/:id` should soft-delete an existing comment.

Soft delete SQL:

```sql
UPDATE dbo.DashboardCellComments
SET deletedAt = SYSUTCDATETIME()
WHERE id = @id;
```

Backend rules:

- Validate all inputs.
- Use parameterized SQL queries.
- Do not allow raw SQL from frontend.
- Do not expose raw SQL/database errors to users.
- Return consistent API response shapes.
- Write only to `dbo.DashboardCellComments`.
- Never write comment data to `dbo.LotCompleteLog`.
- If authentication exists, derive `createdBy` from the authenticated user.
- If no authentication exists, allow a configured display name for local demo only.

## 6. Frontend Requirements

Add comment behavior to day cells in the `Series completion by day` table.

Frontend must include:

- Comment marker in cells that have comments.
- Comment popup near the selected cell.
- Add comment form.
- Edit comment action.
- Delete comment action.
- Optional reply input for threaded comments.
- Loading state while saving.
- Error state if save/delete fails.

Display rules:

- Render comment text as text, not raw HTML.
- Do not allow HTML/script injection.
- Keep day cell numeric content readable.
- Keep marker small and visually similar to Excel corner markers.
- Avoid shifting row height or column width when marker appears.

## 7. Validation Rules

Validate:

- Product is required.
- Serie is required.
- Reporting date is required.
- Reporting date must be a valid date.
- Comment text is required when creating a comment.
- Comment text must not exceed the configured max length.
- PN and process should be normalized consistently when blank.
- User/display name must not contain unsafe markup.

Recommended comment length:

```text
1 to 1000 characters
```

## 8. Security Requirements

- Do not store database credentials in frontend code.
- Do not connect browser JavaScript directly to Azure SQL.
- Do not mix comments with production `LotCompleteLog` data.
- Do not modify production quantity values.
- Validate comment length.
- Sanitize display text to prevent XSS.
- Use parameterized SQL queries.
- Do not allow raw SQL from the browser.
- Do not expose raw SQL errors.
- Store `createdBy` from authenticated user if login exists.
- If no login exists, allow a configured display name for local demo only.

## 9. Testing Checklist

Verify:

- User can add a comment to a day cell.
- Cell shows a comment marker after saving.
- Clicking or hovering the marker shows the comment popup.
- Comment persists after page reload from SQL Server.
- User can edit a comment.
- User can delete a comment with soft delete.
- Comments are scoped to the correct product/serie/PN/date cell.
- Comment on one date does not appear on another date.
- Comment on one serie does not appear on another serie.
- Comment on one product does not appear on another product.
- Popup closes on `Escape`.
- Popup closes on click outside.
- Empty comments are rejected.
- Overlong comments are rejected.
- Table remains readable on desktop.
- Frontend build passes.
- Backend API validates inputs.
- SQL queries are parameterized.
- API does not expose secrets or raw SQL errors.
- Comments are saved in `dbo.DashboardCellComments`.
- Comment create/edit/delete does not write to `dbo.LotCompleteLog`.
- The database user has write permission only for the comments table, not production MES data.

## 10. Things The Agent Must Not Do

The agent must not:

- Write comments into `dbo.LotCompleteLog`.
- Change production quantity values.
- Modify production MES data unless explicitly requested.
- Hardcode user names unless local demo mode.
- Hardcode database credentials.
- Put SQL credentials in frontend code.
- Connect directly from the browser to Azure SQL.
- Accept raw SQL from users.
- Use string concatenation for user values in SQL.
- Expose raw SQL errors.
- Allow HTML/script injection in comments.
- Break the existing `Series completion by day` table.
- Make comment markers resize table cells.
