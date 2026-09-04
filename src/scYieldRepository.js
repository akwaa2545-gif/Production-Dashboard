import sql from 'mssql';
import { SqlRepository } from './sqlRepository.js';

const quoted = (identifier) => identifier.split('.').map((part) => `[${part}]`).join('.');
const sourceColumn = (column) => quoted(`source.${column}`);
const closedColumn = (column) => quoted(`closed.${column}`);
const yieldBucketExpression = (dateExpression, bucket) => bucket === 'day'
  ? `CONVERT(char(10), CAST(${dateExpression} AS date), 23)`
  : bucket === 'week'
    ? `CONCAT(DATEPART(year, DATEADD(day, 26 - DATEPART(ISO_WEEK, CAST(${dateExpression} AS date)), CAST(${dateExpression} AS date))), N'-W', RIGHT(CONCAT(N'0', DATEPART(ISO_WEEK, CAST(${dateExpression} AS date))), 2))`
    : `CONVERT(char(7), CAST(${dateExpression} AS date), 23)`;

export class ScYieldRepository extends SqlRepository {
  constructor(config) { super(config); }

  async getDefectModes(filters) {
    if (filters?.startDate && filters?.endDate) {
      const { defects } = await this.getYieldRows(filters);
      return [...new Set(defects.map((row) => String(row.dispositionCode || '').trim()).filter(Boolean))].sort().map((mode) => ({ mode }));
    }
    const pool = await this.getPool();
    const request = pool.request();
    request.timeout = 15000;
    request.input('scYieldProduct', sql.NVarChar(100), this.config.productValue);
    request.input('scrapDisposition', sql.NVarChar(100), 'SCRAP');
    const result = await request.query(`
      SELECT TOP (50000) LTRIM(RTRIM(CAST(${sourceColumn(this.config.dispositionCodeColumn)} AS nvarchar(4000)))) AS [mode]
      FROM ${quoted(this.config.view)} AS [source]
      WHERE ${sourceColumn(this.config.productColumn)} = @scYieldProduct
        AND ${sourceColumn(this.config.dispositionTypeColumn)} = @scrapDisposition
        AND ${sourceColumn(this.config.dateColumn)} >= DATEFROMPARTS(2025, 1, 1)
        AND NULLIF(LTRIM(RTRIM(CAST(${sourceColumn(this.config.dispositionCodeColumn)} AS nvarchar(4000)))), N'') IS NOT NULL
    `);
    return [...new Set(result.recordset.map((row) => row.mode).filter(Boolean))].sort().map((mode) => ({ mode }));
  }

  completionJoin(request) {
    const config = this.config;
    request.input('scYieldProduct', sql.NVarChar(100), config.productValue);
    request.input('completionCategory', sql.NVarChar(100), config.closedCategoryValue);
    const closedProduct = closedColumn(config.closedProductColumn);
    const conditions = [`CAST(${closedProduct} AS nvarchar(4000)) = @scYieldProduct`, `CAST(${closedColumn(config.closedCategoryColumn)} AS nvarchar(4000)) = @completionCategory`];
    if (config.closedEndOperationColumn && config.closedEndOperationValue && config.closedProdLineColumn && config.closedProdLineValue) {
      request.input('completionNeoProduct', sql.NVarChar(100), 'NEO');
      request.input('completionEndOperation', sql.NVarChar(4000), config.closedEndOperationValue);
      request.input('completionExcludedProdLine', sql.NVarChar(4000), config.closedProdLineValue);
      conditions.push(`(CAST(${closedProduct} AS nvarchar(4000)) <> @completionNeoProduct OR (CAST(${closedColumn(config.closedEndOperationColumn)} AS nvarchar(4000)) = @completionEndOperation AND COALESCE(CAST(${closedColumn(config.closedProdLineColumn)} AS nvarchar(4000)), N'') <> @completionExcludedProdLine))`);
    }
    const job = closedColumn(config.closedJobColumn);
    const serie = `COALESCE(NULLIF(LTRIM(RTRIM(CAST(${closedColumn(config.closedSerieColumn)} AS nvarchar(4000)))), N''), N'Element')`;
    return `INNER JOIN (SELECT ${job} AS [jobName], MIN(${serie}) AS [serieName] FROM ${quoted(config.closedView)} AS [closed] WHERE ${conditions.join(' AND ')} GROUP BY ${job}) AS [closed] ON ${sourceColumn(config.jobColumn)} = [closed].[jobName]`;
  }

  defectSeriesJoin(request, filters, bucket = 'month') {
    const config = this.config;
    request.input('scYieldProduct', sql.NVarChar(100), config.productValue);
    request.input('completionCategory', sql.NVarChar(100), config.closedCategoryValue);
    const closedProduct = closedColumn(config.closedProductColumn);
    const conditions = [`CAST(${closedProduct} AS nvarchar(4000)) = @scYieldProduct`, `CAST(${closedColumn(config.closedCategoryColumn)} AS nvarchar(4000)) = @completionCategory`];
    if (filters) {
      request.input('closedStartDate', sql.Date, filters.startDate);
      request.input('closedEndDate', sql.Date, filters.endDate);
      const closedDate = closedColumn(config.closedDateColumn);
      conditions.push(`${closedDate} >= @closedStartDate`, `${closedDate} < DATEADD(day, 1, @closedEndDate)`);
    }
    if (config.closedEndOperationColumn && config.closedEndOperationValue && config.closedProdLineColumn && config.closedProdLineValue) {
      request.input('completionNeoProduct', sql.NVarChar(100), 'NEO');
      request.input('completionEndOperation', sql.NVarChar(4000), config.closedEndOperationValue);
      request.input('completionExcludedProdLine', sql.NVarChar(4000), config.closedProdLineValue);
      conditions.push(`(CAST(${closedProduct} AS nvarchar(4000)) <> @completionNeoProduct OR (CAST(${closedColumn(config.closedEndOperationColumn)} AS nvarchar(4000)) = @completionEndOperation AND COALESCE(CAST(${closedColumn(config.closedProdLineColumn)} AS nvarchar(4000)), N'') <> @completionExcludedProdLine))`);
    }
    const serie = `COALESCE(NULLIF(LTRIM(RTRIM(CAST(${closedColumn(config.closedSerieColumn)} AS nvarchar(4000)))), N''), N'Element')`;
    const job = closedColumn(config.closedJobColumn);
    const closedSource = quoted(config.closedView);
    const where = conditions.join(' AND ');
    const bucketExpression = yieldBucketExpression(closedColumn(config.closedDateColumn), bucket);
    const join = `INNER JOIN (SELECT ${job} AS [jobName], ${bucketExpression} AS [bucketMonth], MIN(${serie}) AS [serieName] FROM ${closedSource} AS [closed] WHERE ${where} GROUP BY ${job}, ${bucketExpression}) AS [closed] ON ${sourceColumn(config.jobColumn)} = [closed].[jobName]`;
    return { join, serie: '[closed].[serieName]', bucket: '[closed].[bucketMonth]' };
  }

  addEligibleJobScope(request, filters, clauses, serie, includeSourceDate = true) {
    const config = this.config;
    const date = sourceColumn(config.dateColumn);
    const sourceProduct = sourceColumn(config.productColumn);
    if (includeSourceDate) {
      request.input('startDate', sql.Date, filters.startDate);
      request.input('endDate', sql.Date, filters.endDate);
      clauses.push(`${date} >= @startDate`, `${date} < DATEADD(day, 1, @endDate)`);
    }
    clauses.push(`CAST(${sourceProduct} AS nvarchar(4000)) = @scYieldProduct`);
    if (filters.serie) {
      const values = Array.isArray(filters.serie) ? filters.serie : [filters.serie];
      const parameters = values.map((value, index) => { const name = `serie${index}`; request.input(name, sql.NVarChar(4000), value); return `@${name}`; });
      clauses.push(`${serie} IN (${parameters.join(', ')})`);
    }
  }

  async getOptions(filters = {}) {
    const pool = await this.getPool();
    const request = pool.request();
    const completionJoin = this.completionJoin(request);
    const result = await request.query(`
      SELECT DISTINCT TOP (1000) [closed].[serieName] AS value
      FROM ${quoted(this.config.view)} AS [source]
      ${completionJoin}
      WHERE [closed].[serieName] IS NOT NULL
      ORDER BY value ASC`);
    return { process: [], serie: result.recordset.map((row) => row.value), case: [], pn: [] };
  }

  async getYieldRows(filters, bucket = 'month') {
    const pool = await this.getPool();
    const inputRequest = pool.request();
    const inputDate = closedColumn(this.config.closedDateColumn);
    const inputProduct = closedColumn(this.config.closedProductColumn);
    const inputSerie = `COALESCE(NULLIF(LTRIM(RTRIM(CAST(${closedColumn(this.config.closedSerieColumn)} AS nvarchar(4000)))), N''), N'Element')`;
    const inputBucket = yieldBucketExpression(inputDate, bucket);
    inputRequest.input('startDate', sql.Date, filters.startDate);
    inputRequest.input('endDate', sql.Date, filters.endDate);
    inputRequest.input('scYieldProduct', sql.NVarChar(100), this.config.productValue);
    inputRequest.input('inputCategory', sql.NVarChar(100), this.config.closedCategoryValue);
    const inputClauses = [`${inputDate} >= @startDate`, `${inputDate} < DATEADD(day, 1, @endDate)`, `CAST(${inputProduct} AS nvarchar(4000)) = @scYieldProduct`, `CAST(${closedColumn(this.config.closedCategoryColumn)} AS nvarchar(4000)) = @inputCategory`];
    if (filters.serie) {
      const values = Array.isArray(filters.serie) ? filters.serie : [filters.serie];
      const parameters = values.map((value, index) => { const name = `inputSerie${index}`; inputRequest.input(name, sql.NVarChar(4000), value); return `@${name}`; });
      inputClauses.push(`${inputSerie} IN (${parameters.join(', ')})`);
    }
    const inputResult = await inputRequest.query(`
      SELECT ${inputBucket} AS bucketMonth,
        ${inputSerie} AS line,
        SUM(TRY_CONVERT(decimal(19, 4), ${closedColumn(this.config.closedGrossQuantityColumn)})) AS quantity
      FROM ${quoted(this.config.closedView)} AS [closed]
      WHERE ${inputClauses.join(' AND ')}
      GROUP BY ${inputBucket}, ${inputSerie}
      ORDER BY bucketMonth, line`);
    const defectRequest = pool.request();
    const defectClauses = [];
    const defectSeries = this.defectSeriesJoin(defectRequest, filters, bucket);
    this.addEligibleJobScope(defectRequest, filters, defectClauses, defectSeries.serie, false);
    defectRequest.input('scrapDisposition', sql.NVarChar(100), 'SCRAP');
    const defectResult = await defectRequest.query(`
      SELECT ${defectSeries.bucket} AS bucketMonth,
        ${defectSeries.serie} AS line,
        CAST(${sourceColumn(this.config.dispositionCodeColumn)} AS nvarchar(4000)) AS dispositionCode,
        COALESCE(SUM(TRY_CONVERT(decimal(19, 4), ${sourceColumn(this.config.quantityColumn)})), 0) AS quantity
      FROM ${quoted(this.config.view)} AS [source]
      ${defectSeries.join}
      WHERE ${defectClauses.join(' AND ')}
        AND ${defectSeries.serie} IS NOT NULL
        AND UPPER(CAST(${sourceColumn(this.config.dispositionTypeColumn)} AS nvarchar(4000))) = @scrapDisposition
      GROUP BY ${defectSeries.bucket}, ${defectSeries.serie}, CAST(${sourceColumn(this.config.dispositionCodeColumn)} AS nvarchar(4000))
      ORDER BY bucketMonth, line, dispositionCode`);
    return { inputs: inputResult.recordset.map((row) => ({ ...row, quantity: Number(row.quantity || 0) })), defects: defectResult.recordset.map((row) => ({ ...row, quantity: Number(row.quantity || 0) })) };
  }

}
