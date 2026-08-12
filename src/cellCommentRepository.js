import sql from 'mssql';

function quoted(identifier) { return identifier.split('.').map((part) => `[${part}]`).join('.'); }

export class CellCommentRepository {
  constructor(config) { this.config = config; this.pool = undefined; this.connecting = undefined; }

  async getPool() {
    if (this.pool) return this.pool;
    if (!this.connecting) this.connecting = (async () => {
      const pool = new sql.ConnectionPool({ server: this.config.server, database: this.config.database, user: this.config.user, password: this.config.password, options: { encrypt: true, trustServerCertificate: this.config.trustServerCertificate } });
      await pool.connect(); this.pool = pool; return pool;
    })().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  async list(scope) {
    const request = (await this.getPool()).request();
    request.input('product', sql.NVarChar(100), scope.product); request.input('pn', sql.NVarChar(100), scope.pn || ''); request.input('process', sql.NVarChar(100), scope.process || ''); request.input('startDate', sql.Date, scope.startDate); request.input('endDate', sql.Date, scope.endDate);
    const result = await request.query(`SELECT id, product, serie, pn, process, reportingDate, commentText, createdBy, createdAt, updatedAt FROM ${quoted(this.config.table)} WHERE deletedAt IS NULL AND product = @product AND ISNULL(pn, N'') = @pn AND ISNULL(process, N'') = @process AND reportingDate >= @startDate AND reportingDate <= @endDate ORDER BY reportingDate, serie;`);
    return result.recordset;
  }

  async listAll(limit = 500) {
    const request = (await this.getPool()).request();
    request.input('limit', sql.Int, limit);
    const result = await request.query(`SELECT TOP (@limit) id, product, serie, pn, process, reportingDate, commentText, createdBy, createdAt, updatedAt FROM ${quoted(this.config.table)} WHERE deletedAt IS NULL ORDER BY COALESCE(updatedAt, createdAt) DESC, id DESC;`);
    return result.recordset;
  }

  async create(comment) {
    const request = (await this.getPool()).request();
    request.input('product', sql.NVarChar(100), comment.product); request.input('serie', sql.NVarChar(100), comment.serie); request.input('pn', sql.NVarChar(100), comment.pn || null); request.input('process', sql.NVarChar(100), comment.process || null); request.input('reportingDate', sql.Date, comment.reportingDate); request.input('commentText', sql.NVarChar(1000), comment.commentText); request.input('createdBy', sql.NVarChar(255), comment.createdBy);
    const result = await request.query(`INSERT INTO ${quoted(this.config.table)} (product, serie, pn, process, reportingDate, commentText, createdBy) OUTPUT INSERTED.id, INSERTED.createdAt VALUES (@product, @serie, @pn, @process, @reportingDate, @commentText, @createdBy);`);
    return result.recordset[0];
  }

  async update(id, commentText) {
    const request = (await this.getPool()).request(); request.input('id', sql.Int, id); request.input('commentText', sql.NVarChar(1000), commentText);
    const result = await request.query(`UPDATE ${quoted(this.config.table)} SET commentText = @commentText, updatedAt = SYSUTCDATETIME() OUTPUT INSERTED.id, INSERTED.updatedAt WHERE id = @id AND deletedAt IS NULL;`);
    return result.recordset[0];
  }

  async remove(id) { const request = (await this.getPool()).request(); request.input('id', sql.Int, id); await request.query(`UPDATE ${quoted(this.config.table)} SET deletedAt = SYSUTCDATETIME() WHERE id = @id AND deletedAt IS NULL;`); }
}
