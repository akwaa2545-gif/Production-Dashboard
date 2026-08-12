CREATE TABLE dbo.DashboardTaYieldTarget (
  Serie NVARCHAR(200) NOT NULL,
  ReportingPeriod CHAR(7) NOT NULL,
  TargetPercent DECIMAL(5,2) NOT NULL,
  UpdatedAt DATETIME2 NOT NULL CONSTRAINT DF_DashboardTaYieldTarget_UpdatedAt DEFAULT SYSUTCDATETIME(),
  CONSTRAINT PK_DashboardTaYieldTarget PRIMARY KEY (Serie, ReportingPeriod),
  CONSTRAINT CK_DashboardTaYieldTarget_Period CHECK (ReportingPeriod LIKE '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  CONSTRAINT CK_DashboardTaYieldTarget_Percent CHECK (TargetPercent >= 0 AND TargetPercent <= 100)
);
