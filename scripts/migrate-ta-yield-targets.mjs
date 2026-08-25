import 'dotenv/config';
import sql from 'mssql';
import { readTaYieldTargetConfig } from '../src/config.js';

const config = readTaYieldTargetConfig(process.env);
if (!config.ready) throw new Error('ProductionMES TA Yield target storage configuration is incomplete.');
const pool = await new sql.ConnectionPool({ server: config.server, database: config.database, user: config.user, password: config.password, options: { encrypt: true, trustServerCertificate: config.trustServerCertificate } }).connect();
try {
  await pool.request().query(`IF OBJECT_ID(N'${config.table}', N'U') IS NULL BEGIN CREATE TABLE ${config.table} (Serie NVARCHAR(200) NOT NULL, ReportingPeriod CHAR(7) NOT NULL, TargetPercent DECIMAL(5,2) NOT NULL, UpdatedAt DATETIME2 NOT NULL CONSTRAINT DF_DashboardTaYieldTarget_UpdatedAt DEFAULT SYSUTCDATETIME(), CONSTRAINT PK_DashboardTaYieldTarget PRIMARY KEY (Serie, ReportingPeriod), CONSTRAINT CK_DashboardTaYieldTarget_Period CHECK (ReportingPeriod LIKE '[0-9][0-9][0-9][0-9]-[0-1][0-9]'), CONSTRAINT CK_DashboardTaYieldTarget_Percent CHECK (TargetPercent >= 0 AND TargetPercent <= 100)); END;`);
  console.log('TA Yield target storage is ready.');
} finally { await pool.close(); }
