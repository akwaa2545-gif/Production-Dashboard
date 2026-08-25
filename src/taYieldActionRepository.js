import sql from 'mssql';

const quoted = (identifier) => identifier.split('.').map((part) => `[${part}]`).join('.');

export class TaYieldActionRepository {
  constructor(config) { this.config = config; this.pool = undefined; this.connecting = undefined; }

  async getPool() {
    if (this.pool) return this.pool;
    if (!this.connecting) this.connecting = (async () => {
      const pool = new sql.ConnectionPool({ server: this.config.server, database: this.config.database, user: this.config.user, password: this.config.password, options: { encrypt: true, trustServerCertificate: this.config.trustServerCertificate } });
      await pool.connect(); this.pool = pool; return pool;
    })().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  async list(limit = 200) {
    const request = (await this.getPool()).request(); request.input('limit', sql.Int, limit);
    const result = await request.query(`SELECT TOP (@limit) id, actionDate, serie, problem, analysisAction, pic, progress, dueDate, status, createdBy, createdAt, updatedAt FROM ${quoted(this.config.table)} WHERE deletedAt IS NULL ORDER BY actionDate DESC, id DESC;`);
    return result.recordset;
  }

  async create(action) {
    const request = (await this.getPool()).request();
    request.input('actionDate', sql.Date, action.actionDate); request.input('serie', sql.NVarChar(100), action.serie); request.input('problem', sql.NVarChar(2000), action.problem); request.input('analysisAction', sql.NVarChar(sql.MAX), action.analysisAction || null); request.input('pic', sql.NVarChar(255), action.pic || null); request.input('progress', sql.NVarChar(sql.MAX), action.progress || null); request.input('dueDate', sql.Date, action.dueDate || null); request.input('status', sql.NVarChar(20), action.status); request.input('createdBy', sql.NVarChar(255), action.createdBy);
    const result = await request.query(`INSERT INTO ${quoted(this.config.table)} (actionDate, serie, problem, analysisAction, pic, progress, dueDate, status, createdBy) OUTPUT INSERTED.id, INSERTED.actionDate, INSERTED.serie, INSERTED.problem, INSERTED.analysisAction, INSERTED.pic, INSERTED.progress, INSERTED.dueDate, INSERTED.status, INSERTED.createdBy, INSERTED.createdAt, INSERTED.updatedAt VALUES (@actionDate, @serie, @problem, @analysisAction, @pic, @progress, @dueDate, @status, @createdBy);`);
    return result.recordset[0];
  }

  async update(id, action) {
    const request = (await this.getPool()).request();
    request.input('id', sql.Int, id); request.input('actionDate', sql.Date, action.actionDate); request.input('serie', sql.NVarChar(100), action.serie); request.input('problem', sql.NVarChar(2000), action.problem); request.input('analysisAction', sql.NVarChar(sql.MAX), action.analysisAction || null); request.input('pic', sql.NVarChar(255), action.pic || null); request.input('progress', sql.NVarChar(sql.MAX), action.progress || null); request.input('dueDate', sql.Date, action.dueDate || null); request.input('status', sql.NVarChar(20), action.status);
    const result = await request.query(`UPDATE ${quoted(this.config.table)} SET actionDate = @actionDate, serie = @serie, problem = @problem, analysisAction = @analysisAction, pic = @pic, progress = @progress, dueDate = @dueDate, status = @status, updatedAt = SYSUTCDATETIME() OUTPUT INSERTED.id, INSERTED.actionDate, INSERTED.serie, INSERTED.problem, INSERTED.analysisAction, INSERTED.pic, INSERTED.progress, INSERTED.dueDate, INSERTED.status, INSERTED.createdBy, INSERTED.createdAt, INSERTED.updatedAt WHERE id = @id AND deletedAt IS NULL;`);
    return result.recordset[0];
  }

  async remove(id) { const request = (await this.getPool()).request(); request.input('id', sql.Int, id); const result = await request.query(`UPDATE ${quoted(this.config.table)} SET deletedAt = SYSUTCDATETIME() WHERE id = @id AND deletedAt IS NULL;`); return result.rowsAffected[0] > 0; }
}
