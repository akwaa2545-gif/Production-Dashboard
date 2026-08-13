import sql from 'mssql';
const q = (name) => name.split('.').map((part) => `[${part}]`).join('.');
export class TaYieldStagingRepository {
  constructor(config) { this.config = config; this.pool = undefined; }
  async getPool() {
    if (!this.pool) this.pool = await new sql.ConnectionPool({ server: this.config.server, database: this.config.database, user: this.config.user, password: this.config.password, options: { encrypt: true, trustServerCertificate: this.config.trustServerCertificate } }).connect();
    return this.pool;
  }
  async ensureTable(table) {
    await (await this.getPool()).request().query(`IF OBJECT_ID(N'${table}',N'U') IS NULL CREATE TABLE ${q(table)} (ScopeStart date NOT NULL, ScopeEnd date NOT NULL, Payload nvarchar(max) NOT NULL, RefreshedAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME(), PRIMARY KEY(ScopeStart,ScopeEnd));`);
  }
  async replaceSnapshot(table, rows, filters) {
    await this.ensureTable(table);
    const req = (await this.getPool()).request();
    req.input('start', sql.Date, filters.startDate); req.input('end', sql.Date, filters.endDate); req.input('payload', sql.NVarChar(sql.MAX), JSON.stringify(rows));
    await req.query(`MERGE ${q(table)} WITH(HOLDLOCK) AS target USING(SELECT @start ScopeStart,@end ScopeEnd) AS source ON target.ScopeStart=source.ScopeStart AND target.ScopeEnd=source.ScopeEnd WHEN MATCHED THEN UPDATE SET Payload=@payload,RefreshedAt=SYSUTCDATETIME() WHEN NOT MATCHED THEN INSERT(ScopeStart,ScopeEnd,Payload) VALUES(@start,@end,@payload);`);
  }
  async getSnapshot(table, filters, label) {
    const req = (await this.getPool()).request(); req.input('start', sql.Date, filters.startDate); req.input('end', sql.Date, filters.endDate);
    const result = await req.query(`SELECT Payload FROM ${q(table)} WHERE ScopeStart=@start AND ScopeEnd=@end`);
    if (!result.recordset[0]) throw new Error(`${label} staging data is not ready for this date range.`);
    return JSON.parse(result.recordset[0].Payload);
  }
  replace(rows, filters) { return this.replaceSnapshot(this.config.table, rows, filters); }
  getYieldRows(filters) { return this.getSnapshot(this.config.table, filters, 'TA Yield'); }
  replaceWorkbookRows(rows, filters) { return this.replaceSnapshot(this.config.workbookTable, rows, filters); }
  async getWorkbookRows(filters) {
    const req = (await this.getPool()).request(); req.input('start', sql.Date, filters.startDate); req.input('end', sql.Date, filters.endDate);
    const result = await req.query(`SELECT Payload FROM ${q(this.config.workbookTable)} WHERE ScopeStart >= DATEFROMPARTS(YEAR(@start), MONTH(@start), 1) AND ScopeStart <= DATEFROMPARTS(YEAR(@end), MONTH(@end), 1) ORDER BY ScopeStart`);
    if (!result.recordset.length) throw new Error('TA Yield DataTable staging data is not ready for this date range.');
    return result.recordset.flatMap((row) => JSON.parse(row.Payload)).filter((row) => { const date = new Date(row.tapingDate).toISOString().slice(0, 10); return date >= filters.startDate && date <= filters.endDate; });
  }
  async getWorkbookOptions() {
    const result = await (await this.getPool()).request().query(`SELECT TOP (1) Payload FROM ${q(this.config.workbookTable)} ORDER BY ScopeEnd DESC, RefreshedAt DESC`);
    const rows = result.recordset[0] ? JSON.parse(result.recordset[0].Payload) : [];
    return { process: [], serie: [...new Set(rows.map((row) => row.line).filter(Boolean))].sort(), case: [], pn: [] };
  }
  async hasWorkbookCoverage(filters) {
    const req = (await this.getPool()).request(); req.input('start', sql.Date, filters.startDate); req.input('end', sql.Date, filters.endDate);
    const result = await req.query(`SELECT ScopeStart, ScopeEnd FROM ${q(this.config.workbookTable)} WHERE ScopeStart >= DATEFROMPARTS(YEAR(@start), MONTH(@start), 1) AND ScopeStart <= DATEFROMPARTS(YEAR(@end), MONTH(@end), 1)`);
    const available = new Set(result.recordset.map((row) => new Date(row.ScopeStart).toISOString().slice(0, 7)));
    for (let date = new Date(`${filters.startDate.slice(0, 7)}-01T00:00:00Z`); date <= new Date(`${filters.endDate.slice(0, 7)}-01T00:00:00Z`); date.setUTCMonth(date.getUTCMonth() + 1)) if (!available.has(date.toISOString().slice(0, 7))) return false;
    return true;
  }
  async getActivity(table = this.config.workbookTable) {
    const result = await (await this.getPool()).request().query(`SELECT COUNT(*) AS [rowCount], MIN(ScopeStart) AS [firstDataDate], MAX(ScopeEnd) AS [lastDataDate], MAX(RefreshedAt) AS [lastRefreshedAt] FROM ${q(table)}`);
    return result.recordset[0];
  }
}
