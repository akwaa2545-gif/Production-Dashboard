import sql from 'mssql';

const q = (name) => name.split('.').map((part) => `[${part}]`).join('.');

export async function loadWipStagingRows(source, { startDate, endDate }) {
  const rows = []; const processRows = [];
  for (const product of ['NEO', 'SC']) {
    rows.push(...(await source.getQuantity({ startDate, endDate, product })).map((row) => ({ ...row, product })));
    processRows.push(...(await source.getChartData({ startDate, endDate, product }, true)).map((row) => ({ ...row, product })));
  }
  return { rows, processRows };
}

export async function refreshWipStaging({ source, target, targetConfig, startDate, endDate }) {
  const { rows, processRows } = await loadWipStagingRows(source, { startDate, endDate }); const pool = await target.getPool();
  await pool.request().query(`IF OBJECT_ID(N'${targetConfig.table}', N'U') IS NULL CREATE TABLE ${q(targetConfig.table)} (ReportingDate date NOT NULL, Product nvarchar(30) NOT NULL, Serie nvarchar(4000) NOT NULL, QuantityMoved decimal(18,4) NOT NULL, RefreshedAt datetime2 NOT NULL CONSTRAINT DF_DashboardWipDaily_RefreshedAt DEFAULT SYSUTCDATETIME()); IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_DashboardWipDaily_Filter') CREATE INDEX IX_DashboardWipDaily_Filter ON ${q(targetConfig.table)} (ReportingDate, Product, Serie) INCLUDE (QuantityMoved); IF OBJECT_ID(N'${targetConfig.processTable}', N'U') IS NULL CREATE TABLE ${q(targetConfig.processTable)} (ReportingDate date NOT NULL, Product nvarchar(30) NOT NULL, OperationName nvarchar(4000) NOT NULL, Serie nvarchar(4000) NOT NULL, QuantityMoved decimal(18,4) NOT NULL, RefreshedAt datetime2 NOT NULL CONSTRAINT DF_DashboardWipProcessDaily_RefreshedAt DEFAULT SYSUTCDATETIME()); IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_DashboardWipProcessDaily_Filter') CREATE INDEX IX_DashboardWipProcessDaily_Filter ON ${q(targetConfig.processTable)} (ReportingDate, Product, Serie) INCLUDE (OperationName, QuantityMoved);`);
  const transaction = new sql.Transaction(pool); await transaction.begin();
  try {
    const del = new sql.Request(transaction); del.input('startDate', sql.Date, startDate); del.input('endDate', sql.Date, endDate); await del.query(`DELETE FROM ${q(targetConfig.table)} WHERE ReportingDate >= @startDate AND ReportingDate < DATEADD(day, 1, @endDate)`);
    const table = new sql.Table(targetConfig.table); table.create = false; table.columns.add('ReportingDate', sql.Date, { nullable: false }); table.columns.add('Product', sql.NVarChar(30), { nullable: false }); table.columns.add('Serie', sql.NVarChar(4000), { nullable: false }); table.columns.add('QuantityMoved', sql.Decimal(18, 4), { nullable: false });
    rows.forEach((row) => table.rows.add(row.bucketDate, row.product, String(row.itemName || '').trim() || 'Unspecified', row.quantityMoved)); if (rows.length) await new sql.Request(transaction).bulk(table);
    const processDelete = new sql.Request(transaction); processDelete.input('startDate', sql.Date, startDate); processDelete.input('endDate', sql.Date, endDate); await processDelete.query(`DELETE FROM ${q(targetConfig.processTable)} WHERE ReportingDate >= @startDate AND ReportingDate < DATEADD(day, 1, @endDate)`);
    const processTable = new sql.Table(targetConfig.processTable); processTable.create = false; ['ReportingDate', 'Product', 'OperationName', 'Serie', 'QuantityMoved'].forEach((name, index) => processTable.columns.add(name, [sql.Date, sql.NVarChar(30), sql.NVarChar(4000), sql.NVarChar(4000), sql.Decimal(18, 4)][index], { nullable: false })); processRows.forEach((row) => processTable.rows.add(row.bucketDate, row.product, row.chartName || 'Unspecified', row.seriesName || 'Unspecified', row.quantityMoved)); if (processRows.length) await new sql.Request(transaction).bulk(processTable); await transaction.commit();
  } catch (error) { await transaction.rollback(); throw error; }
  return { rows: rows.length, startDate, endDate };
}
