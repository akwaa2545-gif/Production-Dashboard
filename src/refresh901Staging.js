import 'dotenv/config';
import sql from 'mssql';
import { read901StagingConfig, readDatasetConfig } from './config.js';
import { SqlRepository } from './sqlRepository.js';
import { Staging901Repository } from './staging901Repository.js';

const q = (name) => name.split('.').map((part) => `[${part}]`).join('.');
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).reduce((out, part) => ({ ...out, [part.type]: part.value }), {});
const startDate = process.env.STAGING_901_START_DATE || `${today.year}-${today.month}-01`;
const endDate = process.env.STAGING_901_END_DATE || `${today.year}-${today.month}-${today.day}`;

async function main() {
  const targetConfig = read901StagingConfig(process.env); const sourceConfig = readDatasetConfig(process.env, 'closed');
  if (!targetConfig.ready || !sourceConfig.ready) throw new Error('Staging or MES configuration is incomplete.');
  const target = new Staging901Repository(targetConfig); const source = new SqlRepository(sourceConfig); const sourcePool = await source.getPool();
  const request = sourcePool.request(); request.input('startDate', sql.Date, startDate); request.input('endDate', sql.Date, endDate);
  const rows = (await request.query(`
    SELECT CAST([source].[CloseDate] AS date) AS reportingDate, CAST([source].[ProdType] AS nvarchar(30)) AS product,
      CAST(CASE WHEN [source].[ProdType] = N'SC' AND NULLIF(LTRIM(RTRIM(CAST([source].[Series] AS nvarchar(4000)))), N'') IS NULL THEN N'Element' ELSE NULLIF(LTRIM(RTRIM(CAST([source].[Series] AS nvarchar(4000)))), N'') END AS nvarchar(4000)) AS serie,
      CAST([source].[PartNumber] AS nvarchar(4000)) AS partNumber, SUM(TRY_CONVERT(decimal(18,4), [source].[CompleteQty])) AS quantityMoved
    FROM ${q(sourceConfig.view)} AS [source]
    WHERE [source].[CloseDate] >= @startDate AND [source].[CloseDate] < DATEADD(day, 1, @endDate)
      AND (NULLIF(LTRIM(RTRIM(CAST([source].[ProdLine] AS nvarchar(4000)))), N'') IS NULL OR CAST([source].[ProdLine] AS nvarchar(4000)) NOT LIKE N'Semi-Finished Good apply in Racking%')
    GROUP BY CAST([source].[CloseDate] AS date), CAST([source].[ProdType] AS nvarchar(30)), CAST(CASE WHEN [source].[ProdType] = N'SC' AND NULLIF(LTRIM(RTRIM(CAST([source].[Series] AS nvarchar(4000)))), N'') IS NULL THEN N'Element' ELSE NULLIF(LTRIM(RTRIM(CAST([source].[Series] AS nvarchar(4000)))), N'') END AS nvarchar(4000)), CAST([source].[PartNumber] AS nvarchar(4000))`)).recordset;
  const pool = await target.getPool(); await pool.request().query(`IF OBJECT_ID(N'${targetConfig.table}', N'U') IS NULL CREATE TABLE ${q(targetConfig.table)} (ReportingDate date NOT NULL, Product nvarchar(30) NOT NULL, Serie nvarchar(4000) NOT NULL, PartNumber nvarchar(4000) NULL, QuantityMoved decimal(18,4) NOT NULL, RefreshedAt datetime2 NOT NULL CONSTRAINT DF_Dashboard901Daily_RefreshedAt DEFAULT SYSUTCDATETIME()); IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Dashboard901Daily_Filter') CREATE INDEX IX_Dashboard901Daily_Filter ON ${q(targetConfig.table)} (ReportingDate, Product, Serie) INCLUDE (PartNumber, QuantityMoved);`);
  const transaction = new sql.Transaction(pool); await transaction.begin(); try { const del = new sql.Request(transaction); del.input('startDate', sql.Date, startDate); del.input('endDate', sql.Date, endDate); await del.query(`DELETE FROM ${q(targetConfig.table)} WHERE ReportingDate >= @startDate AND ReportingDate < DATEADD(day, 1, @endDate)`); const table = new sql.Table(targetConfig.table); table.create = false; ['ReportingDate','Product','Serie','PartNumber','QuantityMoved'].forEach((name, index) => table.columns.add(name, [sql.Date, sql.NVarChar(30), sql.NVarChar(4000), sql.NVarChar(4000), sql.Decimal(18,4)][index], { nullable: name === 'PartNumber' })); rows.forEach((row) => table.rows.add(row.reportingDate, row.product, row.serie || 'Unspecified', row.partNumber, row.quantityMoved)); if (rows.length) await new sql.Request(transaction).bulk(table); await transaction.commit(); } catch (error) { await transaction.rollback(); throw error; }
  console.log(`901 staging refreshed: ${rows.length} rows for ${startDate} to ${endDate}.`);
}
main().catch((error) => { console.error(`901 staging refresh failed: ${error.message}`); process.exitCode = 1; });
