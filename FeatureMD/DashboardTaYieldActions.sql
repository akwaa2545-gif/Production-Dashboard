CREATE TABLE dbo.DashboardTaYieldActions (
  id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_DashboardTaYieldActions PRIMARY KEY,
  actionDate DATE NOT NULL,
  serie NVARCHAR(100) NOT NULL,
  problem NVARCHAR(2000) NOT NULL,
  analysisAction NVARCHAR(MAX) NULL,
  pic NVARCHAR(255) NULL,
  progress NVARCHAR(MAX) NULL,
  dueDate DATE NULL,
  status NVARCHAR(20) NOT NULL CONSTRAINT DF_DashboardTaYieldActions_Status DEFAULT N'OPEN',
  createdBy NVARCHAR(255) NOT NULL,
  createdAt DATETIME2 NOT NULL CONSTRAINT DF_DashboardTaYieldActions_CreatedAt DEFAULT SYSUTCDATETIME(),
  updatedAt DATETIME2 NULL,
  deletedAt DATETIME2 NULL,
  CONSTRAINT CK_DashboardTaYieldActions_Status CHECK (status IN (N'OPEN', N'IN_PROGRESS', N'CLOSED'))
);
CREATE INDEX IX_DashboardTaYieldActions_Active ON dbo.DashboardTaYieldActions (status, dueDate, actionDate DESC) WHERE deletedAt IS NULL;
