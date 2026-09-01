import sql from 'mssql';

const quote = (identifier) => identifier.split('.').map((part) => `[${part}]`).join('.');
const monthStarts = (filters) => {
  const months = [];
  for (let cursor = new Date(`${filters.startDate.slice(0, 7)}-01T00:00:00Z`); cursor <= new Date(`${filters.endDate.slice(0, 7)}-01T00:00:00Z`); cursor.setUTCMonth(cursor.getUTCMonth() + 1)) months.push(cursor.toISOString().slice(0, 10));
  return months;
};

export class ScYieldStagingRepository {
  constructor(config) { this.config = config; this.pool = undefined; this.tableReady = undefined; }
  async getPool() {
    if (!this.pool) this.pool = await new sql.ConnectionPool({ server: this.config.server, database: this.config.database, user: this.config.user, password: this.config.password, requestTimeout: this.config.requestTimeout, options: { encrypt: true, trustServerCertificate: this.config.trustServerCertificate } }).connect();
    return this.pool;
  }
  ensureTable() {
    this.tableReady ||= (async () => {
      await (await this.getPool()).request().query(`IF OBJECT_ID(N'${this.config.table}',N'U') IS NULL CREATE TABLE ${quote(this.config.table)} (ScopeStart date NOT NULL, ScopeEnd date NOT NULL, Bucket nvarchar(10) NOT NULL, Payload nvarchar(max) NOT NULL, RefreshedAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME(), PRIMARY KEY(ScopeStart, Bucket));`);
    })();
    return this.tableReady;
  }
  async replaceYieldRows(rows, filters, bucket) {
    await this.ensureTable();
    const request = (await this.getPool()).request();
    request.input('start', sql.Date, filters.startDate); request.input('end', sql.Date, filters.endDate); request.input('bucket', sql.NVarChar(10), bucket); request.input('payload', sql.NVarChar(sql.MAX), JSON.stringify(rows));
    await request.query(`MERGE ${quote(this.config.table)} WITH(HOLDLOCK) AS target USING(SELECT @start ScopeStart,@bucket Bucket) AS source ON target.ScopeStart=source.ScopeStart AND target.Bucket=source.Bucket WHEN MATCHED THEN UPDATE SET ScopeEnd=@end,Payload=@payload,RefreshedAt=SYSUTCDATETIME() WHEN NOT MATCHED THEN INSERT(ScopeStart,ScopeEnd,Bucket,Payload) VALUES(@start,@end,@bucket,@payload);`);
  }
  async getYieldRows(filters, bucket = 'month') {
    if (filters.startDate !== `${filters.startDate.slice(0, 7)}-01`) throw new Error('SC Yield staging supports complete monthly snapshots only.');
    const starts = monthStarts(filters); const request = (await this.getPool()).request(); request.input('bucket', sql.NVarChar(10), bucket); request.input('first', sql.Date, starts[0]); request.input('last', sql.Date, starts.at(-1));
    const result = await request.query(`SELECT ScopeStart, ScopeEnd, Payload FROM ${quote(this.config.table)} WHERE Bucket=@bucket AND ScopeStart>=@first AND ScopeStart<=@last ORDER BY ScopeStart`);
    const available = new Set(result.recordset.map((row) => new Date(row.ScopeStart).toISOString().slice(0, 10)));
    if (starts.some((start) => !available.has(start))) throw new Error('SC Yield staging data is not ready for this date range.');
    const finalScopeEnd = new Date(result.recordset.at(-1).ScopeEnd).toISOString().slice(0, 10);
    if (finalScopeEnd !== filters.endDate) throw new Error('SC Yield staging snapshot does not exactly match the requested end date.');
    return result.recordset.reduce((all, row) => { const value = JSON.parse(row.Payload); return { inputs: [...all.inputs, ...(value.inputs || [])], defects: [...all.defects, ...(value.defects || [])] }; }, { inputs: [], defects: [] });
  }
  async getActivity() { const result = await (await this.getPool()).request().query(`SELECT COUNT(*) AS [rowCount], MIN(ScopeStart) AS [firstDataDate], MAX(ScopeEnd) AS [lastDataDate], MAX(RefreshedAt) AS [lastRefreshedAt] FROM ${quote(this.config.table)}`); return result.recordset[0]; }
}
