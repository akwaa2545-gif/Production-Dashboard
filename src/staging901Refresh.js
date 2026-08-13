import sql from 'mssql';

const q = (name) => name.split('.').map((part) => `[${part}]`).join('.');

export async function refresh901Staging({ source, sourceConfig, target, targetConfig, startDate, endDate }) {
  const sourcePool = await source.getPool();
  const request = sourcePool.request(); request.input('startDate', sql.Date, startDate); request.input('endDate', sql.Date, endDate);
  const sourceProduct = q(`source.${sourceConfig.processColumn}`); const sourceSerie = `CAST(${q(`source.${sourceConfig.serieColumn}`)} AS nvarchar(4000))`;
  const sourceJob = q(`source.${sourceConfig.serieActionFallbackSourceJobColumn}`); const sourceProdLine = q(`source.${sourceConfig.excludedProdLineColumn}`);
  const actionJob = q(`action.${sourceConfig.serieActionFallbackJobColumn}`); const actionLine = `CAST(${q(`action.${sourceConfig.serieActionFallbackLineColumn}`)} AS nvarchar(4000))`;
  const missingNeoSerie = `${sourceProduct} = N'NEO' AND (NULLIF(LTRIM(RTRIM(${sourceSerie})), N'') IS NULL OR UPPER(LTRIM(RTRIM(${sourceSerie}))) = N'UNSPECIFIED')`;
  const resolvedSerie = `CASE WHEN ${sourceProduct} = N'SC' AND NULLIF(LTRIM(RTRIM(${sourceSerie})), N'') IS NULL THEN N'Element' WHEN ${missingNeoSerie} THEN COALESCE(NULLIF(LTRIM(RTRIM(REPLACE(REPLACE(REPLACE(CAST([actionSerie].[prodLine] AS nvarchar(4000)), N'Ta NEO Capacitor ', N''), N' series ', N' '), N' case', N''))), N''), N'Unspecified') ELSE COALESCE(NULLIF(LTRIM(RTRIM(${sourceSerie})), N''), N'Unspecified') END`;
  const rows = (await request.query(`
    WITH [filtered] AS (
      SELECT [source].* FROM ${q(sourceConfig.view)} AS [source]
      WHERE ${q(`source.${sourceConfig.dateColumn}`)} >= @startDate AND ${q(`source.${sourceConfig.dateColumn}`)} < DATEADD(day, 1, @endDate)
        AND (NULLIF(LTRIM(RTRIM(CAST(${sourceProdLine} AS nvarchar(4000)))), N'') IS NULL OR CAST(${sourceProdLine} AS nvarchar(4000)) NOT LIKE N'Semi-Finished Good apply in Racking%')
    ), [fallbackJobs] AS (
      SELECT DISTINCT ${sourceJob} AS jobName FROM [filtered] AS [source] WHERE ${missingNeoSerie}
    ), [actionSeries] AS (
      SELECT ${actionJob} AS jobName, MIN(${actionLine}) AS prodLine FROM ${q(sourceConfig.serieActionFallbackView)} AS [action]
      INNER JOIN [fallbackJobs] AS [jobs] ON ${actionJob} = [jobs].jobName
      WHERE NULLIF(LTRIM(RTRIM(${actionLine})), N'') IS NOT NULL GROUP BY ${actionJob}
    )
    SELECT CAST(${q(`source.${sourceConfig.dateColumn}`)} AS date) AS reportingDate, CAST(${sourceProduct} AS nvarchar(30)) AS product,
      CAST(${resolvedSerie} AS nvarchar(4000)) AS serie, CAST(${q(`source.${sourceConfig.pnColumn}`)} AS nvarchar(4000)) AS partNumber,
      SUM(TRY_CONVERT(decimal(18,4), ${q(`source.${sourceConfig.quantityColumn}`)})) AS quantityMoved
    FROM [filtered] AS [source] LEFT JOIN [actionSeries] AS [actionSerie] ON ${sourceJob} = [actionSerie].jobName
    GROUP BY CAST(${q(`source.${sourceConfig.dateColumn}`)} AS date), CAST(${sourceProduct} AS nvarchar(30)), CAST(${resolvedSerie} AS nvarchar(4000)), CAST(${q(`source.${sourceConfig.pnColumn}`)} AS nvarchar(4000))`)).recordset;
  const pool = await target.getPool();
  await pool.request().query(`IF OBJECT_ID(N'${targetConfig.table}', N'U') IS NULL CREATE TABLE ${q(targetConfig.table)} (ReportingDate date NOT NULL, Product nvarchar(30) NOT NULL, Serie nvarchar(4000) NOT NULL, PartNumber nvarchar(4000) NULL, QuantityMoved decimal(18,4) NOT NULL, RefreshedAt datetime2 NOT NULL CONSTRAINT DF_Dashboard901Daily_RefreshedAt DEFAULT SYSUTCDATETIME()); IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Dashboard901Daily_Filter') CREATE INDEX IX_Dashboard901Daily_Filter ON ${q(targetConfig.table)} (ReportingDate, Product, Serie) INCLUDE (PartNumber, QuantityMoved);`);
  const transaction = new sql.Transaction(pool); await transaction.begin();
  try {
    const del = new sql.Request(transaction); del.input('startDate', sql.Date, startDate); del.input('endDate', sql.Date, endDate);
    await del.query(`DELETE FROM ${q(targetConfig.table)} WHERE ReportingDate >= @startDate AND ReportingDate < DATEADD(day, 1, @endDate)`);
    const table = new sql.Table(targetConfig.table); table.create = false;
    ['ReportingDate', 'Product', 'Serie', 'PartNumber', 'QuantityMoved'].forEach((name, index) => table.columns.add(name, [sql.Date, sql.NVarChar(30), sql.NVarChar(4000), sql.NVarChar(4000), sql.Decimal(18, 4)][index], { nullable: name === 'PartNumber' }));
    rows.forEach((row) => table.rows.add(row.reportingDate, row.product, row.serie || 'Unspecified', row.partNumber, row.quantityMoved));
    if (rows.length) await new sql.Request(transaction).bulk(table);
    await transaction.commit();
  } catch (error) { await transaction.rollback(); throw error; }
  return { rows: rows.length, startDate, endDate };
}
