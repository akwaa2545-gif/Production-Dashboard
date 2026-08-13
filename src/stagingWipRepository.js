import sql from 'mssql';

const q = (name) => name.split('.').map((part) => `[${part}]`).join('.');

export class StagingWipRepository {
  constructor(config) { this.config = config; this.pool = undefined; this.connecting = undefined; }
  async getPool() { if (this.pool) return this.pool; if (!this.connecting) this.connecting = new sql.ConnectionPool({ server: this.config.server, database: this.config.database, user: this.config.user, password: this.config.password, options: { encrypt: true, trustServerCertificate: this.config.trustServerCertificate } }).connect().then((pool) => (this.pool = pool)).finally(() => { this.connecting = undefined; }); return this.connecting; }
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
}
