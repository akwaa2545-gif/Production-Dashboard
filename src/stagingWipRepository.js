import sql from 'mssql';

const q = (name) => name.split('.').map((part) => `[${part}]`).join('.');

export class StagingWipRepository {
  constructor(config) { this.config = config; this.pool = undefined; this.connecting = undefined; }
  async getPool() { if (this.pool) return this.pool; if (!this.connecting) this.connecting = new sql.ConnectionPool({ server: this.config.server, database: this.config.database, user: this.config.user, password: this.config.password, requestTimeout: this.config.requestTimeout, options: { encrypt: true, trustServerCertificate: this.config.trustServerCertificate } }).connect().then((pool) => (this.pool = pool)).finally(() => { this.connecting = undefined; }); return this.connecting; }
  async getOptions(filters = {}) {
    const pool = await this.getPool();
    const request = pool.request();
    const clauses = ['Serie IS NOT NULL', "LTRIM(RTRIM(Serie)) <> ''"];
    const products = Array.isArray(filters.product) ? filters.product : filters.product ? [filters.product] : [];
    if (products.length) {
      request.input('product', sql.NVarChar(sql.MAX), JSON.stringify(products));
      clauses.push('Product IN (SELECT [value] FROM OPENJSON(@product))');
    }
    const result = await request.query(`SELECT DISTINCT Serie AS value FROM ${q(this.config.table)} WHERE ${clauses.join(' AND ')} ORDER BY value`);
    return { process: [], serie: result.recordset.map((row) => row.value), case: [], pn: [] };
  }
  async getQuantity(filters) {
    const request = (await this.getPool()).request(); request.input('startDate', sql.Date, filters.startDate); request.input('endDate', sql.Date, filters.endDate);
    const clauses = ['ReportingDate >= @startDate', 'ReportingDate < DATEADD(day, 1, @endDate)'];
    if (filters.product) { request.input('product', sql.NVarChar(30), filters.product); clauses.push('Product = @product'); }
    const series = Array.isArray(filters.serie) ? filters.serie : filters.serie ? [filters.serie] : [];
    if (series.length) { request.input('serie', sql.NVarChar(sql.MAX), JSON.stringify(series)); clauses.push('Serie IN (SELECT [value] FROM OPENJSON(@serie))'); }
    const result = await request.query(`SELECT CONVERT(varchar(10), ReportingDate, 23) AS bucketDate, Serie AS itemName, SUM(QuantityMoved) AS quantityMoved FROM ${q(this.config.table)} WHERE ${clauses.join(' AND ')} GROUP BY ReportingDate, Serie ORDER BY bucketDate, itemName`);
    return result.recordset.map((row) => ({ ...row, quantityMoved: Number(row.quantityMoved || 0) }));
  }
  async getChartData(filters) {
    const request = (await this.getPool()).request(); request.input('startDate', sql.Date, filters.startDate); request.input('endDate', sql.Date, filters.endDate);
    const clauses = ['ReportingDate >= @startDate', 'ReportingDate < DATEADD(day, 1, @endDate)'];
    if (filters.product) { request.input('product', sql.NVarChar(30), filters.product); clauses.push('Product = @product'); }
    const series = Array.isArray(filters.serie) ? filters.serie : filters.serie ? [filters.serie] : [];
    if (series.length) { request.input('serie', sql.NVarChar(sql.MAX), JSON.stringify(series)); clauses.push('Serie IN (SELECT [value] FROM OPENJSON(@serie))'); }
    const result = await request.query(`SELECT OperationName AS chartName, Serie AS seriesName, SUM(QuantityMoved) AS quantityMoved FROM ${q(this.config.processTable)} WHERE ${clauses.join(' AND ')} GROUP BY OperationName, Serie ORDER BY chartName, seriesName`);
    return result.recordset.map((row) => ({ ...row, quantityMoved: Number(row.quantityMoved || 0) }));
  }
  async getActivity() { const pool = await this.getPool(); const [daily, process] = await Promise.all([pool.request().query(`SELECT COUNT_BIG(*) AS [rowCount], MIN(ReportingDate) AS [firstDataDate], MAX(ReportingDate) AS [lastDataDate], MAX(RefreshedAt) AS [lastRefreshedAt] FROM ${q(this.config.table)}`), pool.request().query(`SELECT COUNT_BIG(*) AS [rowCount], MAX(RefreshedAt) AS [lastRefreshedAt] FROM ${q(this.config.processTable)}`)]); return { ...(daily.recordset[0] || {}), processRowCount: process.recordset[0]?.rowCount || 0, processLastRefreshedAt: process.recordset[0]?.lastRefreshedAt }; }
}
