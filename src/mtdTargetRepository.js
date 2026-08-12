import sql from 'mssql';

function quoted(identifier) {
  return identifier.split('.').map((part) => `[${part}]`).join('.');
}

export class MtdTargetRepository {
  constructor(config) {
    this.config = config;
    this.pool = undefined;
    this.connecting = undefined;
  }

  async getPool() {
    if (this.pool) return this.pool;
    if (!this.connecting) {
      this.connecting = (async () => {
        const pool = new sql.ConnectionPool({
          server: this.config.server,
          database: this.config.database,
          user: this.config.user,
          password: this.config.password,
          options: { encrypt: true, trustServerCertificate: this.config.trustServerCertificate }
        });
        await pool.connect();
        this.pool = pool;
        return pool;
      })().finally(() => { this.connecting = undefined; });
    }
    return this.connecting;
  }

  async list() {
    const result = await (await this.getPool()).request().query(`
      SELECT Product AS product, Serie AS serie, ReportingPeriod AS period,
        MonthlyPlan AS monthlyPlan, WorkingDays AS workingDay
      FROM ${quoted(this.config.table)}
      ORDER BY Product, Serie, ReportingPeriod`);
    return result.recordset.map((row) => ({ ...row, monthlyPlan: Number(row.monthlyPlan), workingDay: Number(row.workingDay) }));
  }

  async upsert(target) {
    const request = (await this.getPool()).request();
    request.input('product', sql.NVarChar(20), target.product);
    request.input('serie', sql.NVarChar(200), target.serie);
    request.input('period', sql.Char(7), target.period);
    request.input('monthlyPlan', sql.Decimal(18, 2), target.monthlyPlan);
    request.input('workingDay', sql.Decimal(8, 2), target.workingDay);
    await request.query(`
      SET XACT_ABORT ON;
      BEGIN TRANSACTION;
      UPDATE ${quoted(this.config.table)} WITH (UPDLOCK, SERIALIZABLE)
      SET MonthlyPlan = @monthlyPlan, WorkingDays = @workingDay, UpdatedAt = SYSUTCDATETIME()
      WHERE Product = @product AND Serie = @serie AND ReportingPeriod = @period;
      IF @@ROWCOUNT = 0
        INSERT INTO ${quoted(this.config.table)} (Product, Serie, ReportingPeriod, MonthlyPlan, WorkingDays)
        VALUES (@product, @serie, @period, @monthlyPlan, @workingDay);
      COMMIT TRANSACTION;`);
  }

  async remove(target) {
    const request = (await this.getPool()).request();
    request.input('product', sql.NVarChar(20), target.product);
    request.input('serie', sql.NVarChar(200), target.serie);
    request.input('period', sql.Char(7), target.period);
    await request.query(`DELETE FROM ${quoted(this.config.table)} WHERE Product = @product AND Serie = @serie AND ReportingPeriod = @period;`);
  }
}
