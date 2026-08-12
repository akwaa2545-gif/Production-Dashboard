import sql from 'mssql';

const quoted = (identifier) => identifier.split('.').map((part) => `[${part}]`).join('.');

export class ScYieldTargetRepository {
  constructor(config) { this.config = config; this.pool = undefined; this.connecting = undefined; }

  async getPool() {
    if (this.pool) return this.pool;
    if (!this.connecting) this.connecting = (async () => {
      const pool = new sql.ConnectionPool({ server: this.config.server, database: this.config.database, user: this.config.user, password: this.config.password, options: { encrypt: true, trustServerCertificate: this.config.trustServerCertificate } });
      await pool.connect(); this.pool = pool; return pool;
    })().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  async list() {
    const result = await (await this.getPool()).request().query(`SELECT Serie AS serie, ReportingPeriod AS period, TargetPercent AS target FROM ${quoted(this.config.table)} ORDER BY Serie, ReportingPeriod`);
    return result.recordset.map((row) => ({ ...row, target: Number(row.target) }));
  }

  async upsert(target) {
    const request = (await this.getPool()).request(); request.input('serie', sql.NVarChar(200), target.serie); request.input('period', sql.Char(7), target.period); request.input('target', sql.Decimal(5, 2), target.target);
    await request.query(`SET XACT_ABORT ON; BEGIN TRANSACTION; UPDATE ${quoted(this.config.table)} WITH (UPDLOCK, SERIALIZABLE) SET TargetPercent = @target, UpdatedAt = SYSUTCDATETIME() WHERE Serie = @serie AND ReportingPeriod = @period; IF @@ROWCOUNT = 0 INSERT INTO ${quoted(this.config.table)} (Serie, ReportingPeriod, TargetPercent) VALUES (@serie, @period, @target); COMMIT TRANSACTION;`);
  }

  async remove(target) { const request = (await this.getPool()).request(); request.input('serie', sql.NVarChar(200), target.serie); request.input('period', sql.Char(7), target.period); await request.query(`DELETE FROM ${quoted(this.config.table)} WHERE Serie = @serie AND ReportingPeriod = @period;`); }
}
