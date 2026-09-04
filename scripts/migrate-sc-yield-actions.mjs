import 'dotenv/config';
import sql from 'mssql';
import { readScYieldActionConfig } from '../src/config.js';

const config = readScYieldActionConfig(process.env);
if (!config.ready) throw new Error('ProductionMES SC Yield action storage configuration is incomplete.');
const pool = await new sql.ConnectionPool({ server: config.server, database: config.database, user: config.user, password: config.password, options: { encrypt: true, trustServerCertificate: config.trustServerCertificate } }).connect();
try {
  await pool.request().query(`IF OBJECT_ID(N'${config.table}', N'U') IS NULL BEGIN CREATE TABLE ${config.table} (id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_DashboardScYieldActions PRIMARY KEY, actionDate DATE NOT NULL, serie NVARCHAR(100) NOT NULL, problem NVARCHAR(2000) NOT NULL, analysisAction NVARCHAR(MAX) NULL, pic NVARCHAR(255) NULL, progress NVARCHAR(MAX) NULL, dueDate DATE NULL, status NVARCHAR(20) NOT NULL CONSTRAINT DF_DashboardScYieldActions_Status DEFAULT N'OPEN', createdBy NVARCHAR(255) NOT NULL, createdAt DATETIME2 NOT NULL CONSTRAINT DF_DashboardScYieldActions_CreatedAt DEFAULT SYSUTCDATETIME(), updatedAt DATETIME2 NULL, deletedAt DATETIME2 NULL, CONSTRAINT CK_DashboardScYieldActions_Status CHECK (status IN (N'OPEN', N'IN_PROGRESS', N'CLOSED'))); END; IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'${config.table}') AND name = N'IX_DashboardScYieldActions_Active') CREATE INDEX IX_DashboardScYieldActions_Active ON ${config.table} (status, dueDate, actionDate DESC) WHERE deletedAt IS NULL;`);
  console.log('SC Yield action storage is ready.');
} finally { await pool.close(); }
