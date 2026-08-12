CREATE TABLE dbo.DashboardCellComments (
  id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_DashboardCellComments PRIMARY KEY,
  product NVARCHAR(100) NOT NULL,
  serie NVARCHAR(100) NOT NULL,
  pn NVARCHAR(100) NULL,
  process NVARCHAR(100) NULL,
  reportingDate DATE NOT NULL,
  commentText NVARCHAR(1000) NOT NULL,
  createdBy NVARCHAR(255) NOT NULL,
  createdAt DATETIME2 NOT NULL CONSTRAINT DF_DashboardCellComments_CreatedAt DEFAULT SYSUTCDATETIME(),
  updatedAt DATETIME2 NULL,
  deletedAt DATETIME2 NULL,
  pnKey AS ISNULL(pn, N'') PERSISTED,
  processKey AS ISNULL(process, N'') PERSISTED
);
CREATE UNIQUE INDEX UX_DashboardCellComments_Cell ON dbo.DashboardCellComments (product, serie, reportingDate, pnKey, processKey) WHERE deletedAt IS NULL;
