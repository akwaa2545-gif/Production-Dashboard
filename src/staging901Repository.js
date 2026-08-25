import sql from 'mssql';

const quoted = (identifier) => identifier.split('.').map((part) => `[${part}]`).join('.');
const filtersWhere = (request, filters) => {
  const clauses = ['ReportingDate >= @startDate', 'ReportingDate < DATEADD(day, 1, @endDate)'];
  request.input('startDate', sql.Date, filters.startDate); request.input('endDate', sql.Date, filters.endDate);
  if (filters.product) { request.input('product', sql.NVarChar(30), filters.product); clauses.push('Product = @product'); }
  for (const [key, column] of [['serie', 'Serie'], ['pn', 'PartNumber']]) {
    const values = Array.isArray(filters[key]) ? filters[key] : filters[key] ? [filters[key]] : [];
    if (values.length) {
      const parameters = values.map((value, index) => {
        const parameter = `${key}${index}`;
        request.input(parameter, sql.NVarChar(4000), value);
        return `@${parameter}`;
      });
      clauses.push(`${column} IN (${parameters.join(', ')})`);
    }
  }
  return clauses.join(' AND ');
};

export class Staging901Repository {
  constructor(config) { this.config = config; this.pool = undefined; this.connecting = undefined; }
  async getPool() { if (this.pool) return this.pool; if (!this.connecting) this.connecting = new sql.ConnectionPool({ server: this.config.server, database: this.config.database, user: this.config.user, password: this.config.password, options: { encrypt: true, trustServerCertificate: this.config.trustServerCertificate } }).connect().then((pool) => (this.pool = pool)).finally(() => { this.connecting = undefined; }); return this.connecting; }
  async getQuantity(filters) { const request = (await this.getPool()).request(); const where = filtersWhere(request, filters); const result = await request.query(`SELECT CONVERT(varchar(10), ReportingDate, 23) AS bucketDate, Serie AS itemName, SUM(QuantityMoved) AS quantityMoved FROM ${quoted(this.config.table)} WHERE ${where} GROUP BY ReportingDate, Serie ORDER BY bucketDate, itemName`); return result.recordset.map((row) => ({ ...row, quantityMoved: Number(row.quantityMoved || 0) })); }
  async getOptions(filters = {}) { const request = (await this.getPool()).request(); const where = filtersWhere(request, { ...filters, startDate: filters.startDate || '2000-01-01', endDate: filters.endDate || '2100-01-01' }); const result = await request.query(`SELECT DISTINCT Product AS process, Serie AS serie FROM ${quoted(this.config.table)} WHERE ${where} ORDER BY process, serie`); return { process: [...new Set(result.recordset.map((row) => row.process).filter(Boolean))].sort(), serie: [...new Set(result.recordset.map((row) => row.serie).filter(Boolean))].sort(), case: [], pn: [] }; }
  async getPartNumbers(filters = {}, search = '', offset = 0, limit = 100) { const request = (await this.getPool()).request(); const where = filtersWhere(request, { ...filters, startDate: filters.startDate || '2000-01-01', endDate: filters.endDate || '2100-01-01' }); request.input('search', sql.NVarChar(100), `%${search}%`); request.input('offset', sql.Int, offset); const result = await request.query(`SELECT DISTINCT PartNumber AS value FROM ${quoted(this.config.table)} WHERE ${where} AND PartNumber LIKE @search ORDER BY value OFFSET @offset ROWS FETCH NEXT ${limit + 1} ROWS ONLY`); const values = result.recordset.map((row) => row.value); return { items: values.slice(0, limit), hasMore: values.length > limit }; }
  async getActivity() { const result = await (await this.getPool()).request().query(`SELECT COUNT_BIG(*) AS [rowCount], MIN(ReportingDate) AS [firstDataDate], MAX(ReportingDate) AS [lastDataDate], MAX(RefreshedAt) AS [lastRefreshedAt] FROM ${quoted(this.config.table)}`); return result.recordset[0] || {}; }
}
