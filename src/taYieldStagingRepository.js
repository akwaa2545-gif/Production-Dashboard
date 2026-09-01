import sql from 'mssql';
const q = (name) => name.split('.').map((part) => `[${part}]`).join('.');
const thailandDate = (value) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const utcDate = (value) => new Date(value).toISOString().slice(0, 10);
const latestSnapshotsByMonth = (records) => [...records.reduce((snapshots, record) => {
  const month = utcDate(record.ScopeStart).slice(0, 7);
  const current = snapshots.get(month);
  if (!current || utcDate(record.ScopeEnd) > utcDate(current.ScopeEnd) || (utcDate(record.ScopeEnd) === utcDate(current.ScopeEnd) && new Date(record.RefreshedAt || 0) > new Date(current.RefreshedAt || 0))) snapshots.set(month, record);
  return snapshots;
}, new Map()).values()];
export async function deleteMachineLotsForScope(transaction, scopeMonth, lotNumbers, { machineRowTable, machineLotTable }, Request = sql.Request) {
  for (let offset = 0; offset < lotNumbers.length; offset += 500) {
    const remove = new Request(transaction); remove.input('scopeMonth', sql.Date, scopeMonth);
    const parameters = lotNumbers.slice(offset, offset + 500).map((lotNo, index) => { const name = `lot${index}`; remove.input(name, sql.NVarChar(4000), lotNo); return `@${name}`; });
    await remove.query(`DELETE FROM ${q(machineRowTable)} WHERE ScopeMonth=@scopeMonth AND LotNo IN (${parameters.join(', ')}); DELETE FROM ${q(machineLotTable)} WHERE ScopeMonth=@scopeMonth AND LotNo IN (${parameters.join(', ')});`);
  }
}
export class TaYieldStagingRepository {
  constructor(config) { this.config = config; this.pool = undefined; }
  async getPool() {
    if (!this.pool) this.pool = await new sql.ConnectionPool({ server: this.config.server, database: this.config.database, user: this.config.user, password: this.config.password, requestTimeout: this.config.requestTimeout || undefined, options: { encrypt: true, trustServerCertificate: this.config.trustServerCertificate } }).connect();
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
  async getLatestWorkbookSnapshotForMonth(filters) {
    const request = (await this.getPool()).request();
    request.input('monthStart', sql.Date, `${filters.startDate.slice(0, 7)}-01`);
    const result = await request.query(`SELECT TOP (1) ScopeStart, ScopeEnd, RefreshedAt, Payload FROM ${q(this.config.workbookTable)} WHERE ScopeStart=@monthStart ORDER BY ScopeEnd DESC, RefreshedAt DESC`);
    if (!result.recordset[0]) return undefined;
    const row = result.recordset[0];
    return { scopeStart: utcDate(row.ScopeStart), scopeEnd: utcDate(row.ScopeEnd), refreshedAt: row.RefreshedAt, rows: JSON.parse(row.Payload) };
  }
  replaceMachineEvents(rows, filters) { return this.replaceSnapshot(this.config.machineTable, rows, filters); }
  async replaceMachineRowsForLots(events, lots, filters, { lotNumbersToRemove = [] } = {}) {
    const lotNumbers = [...new Set(lots.map((lot) => lot.lotNo).filter(Boolean))];
    const removedLotNumbers = [...new Set([...lotNumbersToRemove, ...lotNumbers].filter(Boolean))];
    if (!removedLotNumbers.length) return;
    const pool = await this.getPool(); const transaction = new sql.Transaction(pool); const scopeMonth = `${filters.startDate.slice(0, 7)}-01`;
    await transaction.begin();
    try {
      await deleteMachineLotsForScope(transaction, scopeMonth, removedLotNumbers, this.config);
      const distinctEvents = new Map(events.map((event) => { const eventDate = thailandDate(event.occuredOn); const machineName = String(event.machineName || '').trim(); return [`${eventDate}|${event.lotNo}|${event.operationName || ''}|${machineName}`, { ...event, eventDate, machineName }]; }));
      for (const event of distinctEvents.values()) { const request = new sql.Request(transaction); request.input('scopeMonth', sql.Date, scopeMonth); request.input('eventDate', sql.Date, event.eventDate); request.input('lotNo', sql.NVarChar(4000), event.lotNo); request.input('operationName', sql.NVarChar(4000), event.operationName || ''); request.input('machineName', sql.NVarChar(4000), event.machineName); await request.query(`INSERT INTO ${q(this.config.machineRowTable)} (ScopeMonth,EventDate,LotNo,OperationName,MachineName) VALUES (@scopeMonth,@eventDate,@lotNo,@operationName,@machineName)`); }
      for (const lot of lots) for (const [category, quantity] of Object.entries(lot.categories || {})) { if (!['Input', 'Input-', 'Good'].includes(category) && Number(quantity)) { const request = new sql.Request(transaction); request.input('scopeMonth', sql.Date, scopeMonth); request.input('lotNo', sql.NVarChar(4000), lot.lotNo); request.input('serie', sql.NVarChar(4000), lot.line || ''); request.input('partNumber', sql.NVarChar(4000), lot.itemName || ''); request.input('tapingDate', sql.Date, thailandDate(lot.tapingDate)); request.input('yieldCategory', sql.NVarChar(200), category); request.input('defectMode', sql.NVarChar(4000), category); request.input('quantity', sql.Decimal(18, 4), Number(quantity)); await request.query(`INSERT INTO ${q(this.config.machineLotTable)} (ScopeMonth,LotNo,Serie,PartNumber,TapingDate,YieldCategory,DefectMode,Quantity) VALUES (@scopeMonth,@lotNo,@serie,@partNumber,@tapingDate,@yieldCategory,@defectMode,@quantity)`); } }
      await transaction.commit();
    } catch (error) { await transaction.rollback(); throw error; }
  }
  async replaceMachineRows(events, lots, filters) {
    const pool = await this.getPool(); const transaction = new sql.Transaction(pool); const scopeMonth = `${filters.startDate.slice(0, 7)}-01`;
    await transaction.begin();
    try {
      const remove = new sql.Request(transaction); remove.input('scopeMonth', sql.Date, scopeMonth);
      await remove.query(`DELETE FROM ${q(this.config.machineRowTable)} WHERE ScopeMonth=@scopeMonth; DELETE FROM ${q(this.config.machineLotTable)} WHERE ScopeMonth=@scopeMonth;`);
      const distinctEvents = new Map(events.map((event) => { const eventDate = thailandDate(event.occuredOn); const machineName = String(event.machineName || '').trim(); return [`${eventDate}|${event.lotNo}|${event.operationName || ''}|${machineName}`, { ...event, eventDate, machineName }]; }));
      for (const event of distinctEvents.values()) {
        const request = new sql.Request(transaction); request.input('scopeMonth', sql.Date, scopeMonth); request.input('eventDate', sql.Date, event.eventDate); request.input('lotNo', sql.NVarChar(4000), event.lotNo); request.input('operationName', sql.NVarChar(4000), event.operationName || ''); request.input('machineName', sql.NVarChar(4000), event.machineName);
        await request.query(`INSERT INTO ${q(this.config.machineRowTable)} (ScopeMonth,EventDate,LotNo,OperationName,MachineName) VALUES (@scopeMonth,@eventDate,@lotNo,@operationName,@machineName)`);
      }
      for (const lot of lots) for (const [category, quantity] of Object.entries(lot.categories || {})) {
        if (['Input', 'Input-', 'Good'].includes(category) || !Number(quantity)) continue;
        const request = new sql.Request(transaction); request.input('scopeMonth', sql.Date, scopeMonth); request.input('lotNo', sql.NVarChar(4000), lot.lotNo); request.input('serie', sql.NVarChar(4000), lot.line || ''); request.input('partNumber', sql.NVarChar(4000), lot.itemName || ''); request.input('tapingDate', sql.Date, thailandDate(lot.tapingDate)); request.input('yieldCategory', sql.NVarChar(200), category); request.input('defectMode', sql.NVarChar(4000), category); request.input('quantity', sql.Decimal(18, 4), Number(quantity));
        await request.query(`INSERT INTO ${q(this.config.machineLotTable)} (ScopeMonth,LotNo,Serie,PartNumber,TapingDate,YieldCategory,DefectMode,Quantity) VALUES (@scopeMonth,@lotNo,@serie,@partNumber,@tapingDate,@yieldCategory,@defectMode,@quantity)`);
      }
      await transaction.commit();
    } catch (error) { await transaction.rollback(); throw error; }
  }
  machineFilter(request, filters, column) {
    const values = (value) => Array.isArray(value) ? value : value ? [value] : [];
    const conditions = [];
    [['serie', 'Serie'], ['pn', 'PartNumber']].forEach(([filter, name]) => {
      const matches = values(filters[filter]).map((value, index) => { const parameter = `${filter}${index}`; request.input(parameter, sql.NVarChar(4000), value); return `${column}.${name}=@${parameter}`; });
      if (matches.length) conditions.push(`(${matches.join(' OR ')})`);
    });
    return conditions.length ? ` AND ${conditions.join(' AND ')}` : '';
  }
  async getMachineLots(filters) {
    const request = (await this.getPool()).request(); request.input('start', sql.Date, filters.startDate); request.input('end', sql.Date, filters.endDate);
    const result = await request.query(`SELECT LotNo, YieldCategory, DefectMode, Quantity FROM ${q(this.config.machineLotTable)} AS lot WHERE lot.TapingDate>=@start AND lot.TapingDate<=@end${this.machineFilter(request, filters, 'lot')} ORDER BY LotNo, DefectMode`);
    if (!result.recordset.length) throw new Error('TA Yield Machine staging data is not ready for this date range.');
    const lots = new Map(); result.recordset.forEach((row) => { const current = lots.get(row.LotNo) || { lotNo: row.LotNo, modes: [] }; current.modes.push({ mode: row.DefectMode, category: row.YieldCategory, quantity: Number(row.Quantity) }); lots.set(row.LotNo, current); });
    return [...lots.values()];
  }
  async getMachineEvents(filters, { processPattern, machine } = {}) {
    const request = (await this.getPool()).request(); request.input('start', sql.Date, filters.startDate); request.input('end', sql.Date, filters.endDate); request.input('processPattern', sql.NVarChar(4000), processPattern || '%'); if (machine) request.input('machine', sql.NVarChar(4000), machine);
    const lotFilter = this.machineFilter(request, filters, 'lot');
    const result = await request.query(`SELECT DISTINCT event.EventDate AS occuredOn, event.LotNo AS lotNo, event.MachineName AS machineName, event.OperationName AS operationName FROM ${q(this.config.machineRowTable)} AS event WHERE event.EventDate>=@start AND event.EventDate<=@end AND event.OperationName LIKE @processPattern${machine ? ' AND event.MachineName=@machine' : ''} AND EXISTS (SELECT 1 FROM ${q(this.config.machineLotTable)} AS lot WHERE lot.LotNo=event.LotNo AND lot.TapingDate>=@start AND lot.TapingDate<=@end${lotFilter}) ORDER BY occuredOn, machineName, lotNo`);
    if (!result.recordset.length) return [];
    return result.recordset.map((row) => ({ occuredOn: row.occuredOn, lotNo: row.lotNo, machineName: row.machineName, operationName: row.operationName }));
  }
  async getMachineEventsSnapshot(filters, { lotNumbers, processPattern, machine } = {}) {
    const req = (await this.getPool()).request(); req.input('start', sql.Date, filters.startDate); req.input('end', sql.Date, filters.endDate);
    const result = await req.query(`SELECT Payload FROM ${q(this.config.machineTable)} WHERE ScopeStart >= DATEFROMPARTS(YEAR(@start), MONTH(@start), 1) AND ScopeStart <= DATEFROMPARTS(YEAR(@end), MONTH(@end), 1) ORDER BY ScopeStart`);
    if (!result.recordset.length) throw new Error('TA Yield Machine staging data is not ready for this date range.');
    const rows = result.recordset.flatMap((row) => JSON.parse(row.Payload)).filter((row) => { const date = thailandDate(row.occuredOn); return date >= filters.startDate && date <= filters.endDate; });
    const lots = new Set(lotNumbers || []); const pattern = String(processPattern || '').replaceAll('%', '').toLowerCase();
    return rows.filter((row) => lots.has(row.lotNo) && String(row.operationName || '').toLowerCase().includes(pattern) && (!machine || String(row.machineName || '').trim() === machine));
  }
  async replaceMonthlySummary(rows, filters) {
    const pool = await this.getPool(); const transaction = new sql.Transaction(pool); await transaction.begin();
    try { const remove = new sql.Request(transaction); remove.input('month', sql.Date, `${filters.startDate.slice(0, 7)}-01`); await remove.query(`DELETE FROM ${q(this.config.monthlySummaryTable)} WHERE MonthStart=@month`); for (const row of rows) { const request = new sql.Request(transaction); request.input('month', sql.Date, `${row.month}-01`); request.input('serie', sql.NVarChar(4000), row.line); request.input('partNumber', sql.NVarChar(4000), row.partNumber || 'All'); request.input('group', sql.NVarChar(200), row.group); request.input('input', sql.Decimal(18, 4), row.input); request.input('finalGood', sql.Decimal(18, 4), row.finalGood); request.input('defect', sql.Decimal(18, 4), row.defect); await request.query(`INSERT INTO ${q(this.config.monthlySummaryTable)} (MonthStart,Serie,PartNumber,DefectGroup,InputQty,FinalGoodQty,DefectQty) VALUES (@month,@serie,@partNumber,@group,@input,@finalGood,@defect)`); } await transaction.commit(); } catch (error) { await transaction.rollback(); throw error; }
  }
  async getMonthlySummary(filters) {
    const request = (await this.getPool()).request(); request.input('start', sql.Date, `${filters.startDate.slice(0, 7)}-01`); request.input('end', sql.Date, `${filters.endDate.slice(0, 7)}-01`); if (filters.pn) request.input('pn', sql.NVarChar(4000), filters.pn);
    const result = await request.query(`SELECT MonthStart, Serie, PartNumber, DefectGroup, InputQty, FinalGoodQty, DefectQty FROM ${q(this.config.monthlySummaryTable)} WHERE MonthStart>=@start AND MonthStart<=@end${filters.pn ? ' AND PartNumber=@pn' : " AND PartNumber='All'"} ORDER BY MonthStart, Serie, PartNumber, DefectGroup`);
    return result.recordset.map((row) => ({ month: new Date(row.MonthStart).toISOString().slice(0, 7), line: row.Serie, partNumber: row.PartNumber, group: row.DefectGroup, input: Number(row.InputQty), finalGood: Number(row.FinalGoodQty), defect: Number(row.DefectQty) }));
  }
  async getMonthlyPartNumbers(filters) {
    const request = (await this.getPool()).request(); request.input('start', sql.Date, `${filters.startDate.slice(0, 7)}-01`); request.input('end', sql.Date, `${filters.endDate.slice(0, 7)}-01`);
    const result = await request.query(`SELECT DISTINCT PartNumber FROM ${q(this.config.monthlySummaryTable)} WHERE MonthStart>=@start AND MonthStart<=@end AND PartNumber<>'All' ORDER BY PartNumber`);
    return result.recordset.map((row) => row.PartNumber);
  }
  async getWorkbookRows(filters) {
    const req = (await this.getPool()).request(); req.input('start', sql.Date, filters.startDate); req.input('end', sql.Date, filters.endDate);
    const result = await req.query(`SELECT ScopeStart, ScopeEnd, RefreshedAt, Payload FROM ${q(this.config.workbookTable)} WHERE ScopeStart >= DATEFROMPARTS(YEAR(@start), MONTH(@start), 1) AND ScopeStart <= DATEFROMPARTS(YEAR(@end), MONTH(@end), 1) ORDER BY ScopeStart, ScopeEnd DESC, RefreshedAt DESC`);
    if (!result.recordset.length) throw new Error('TA Yield DataTable staging data is not ready for this date range.');
    return latestSnapshotsByMonth(result.recordset).flatMap((row) => JSON.parse(row.Payload)).filter((row) => { const date = thailandDate(row.tapingDate); return date >= filters.startDate && date <= filters.endDate; });
  }
  async getWorkbookOptions() {
    const result = await (await this.getPool()).request().query(`SELECT TOP (1) Payload FROM ${q(this.config.workbookTable)} ORDER BY ScopeEnd DESC, RefreshedAt DESC`);
    const rows = result.recordset[0] ? JSON.parse(result.recordset[0].Payload) : [];
    return { process: [], serie: [...new Set(rows.map((row) => row.line).filter(Boolean))].sort(), case: [], pn: [...new Set(rows.map((row) => row.itemName).filter(Boolean))].sort() };
  }
  async hasWorkbookCoverage(filters) {
    const req = (await this.getPool()).request(); req.input('start', sql.Date, filters.startDate); req.input('end', sql.Date, filters.endDate);
    const result = await req.query(`SELECT ScopeStart, ScopeEnd FROM ${q(this.config.workbookTable)} WHERE ScopeStart >= DATEFROMPARTS(YEAR(@start), MONTH(@start), 1) AND ScopeStart <= DATEFROMPARTS(YEAR(@end), MONTH(@end), 1)`);
    const available = new Map(latestSnapshotsByMonth(result.recordset).map((row) => [utcDate(row.ScopeStart).slice(0, 7), utcDate(row.ScopeEnd)]));
    for (let date = new Date(`${filters.startDate.slice(0, 7)}-01T00:00:00Z`); date <= new Date(`${filters.endDate.slice(0, 7)}-01T00:00:00Z`); date.setUTCMonth(date.getUTCMonth() + 1)) {
      const month = date.toISOString().slice(0, 7);
      const expectedEnd = month === filters.endDate.slice(0, 7) ? filters.endDate : new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
      if (!available.get(month) || available.get(month) < expectedEnd) return false;
    }
    return true;
  }
  async getActivity(table = this.config.workbookTable) {
    const result = await (await this.getPool()).request().query(`SELECT COUNT(*) AS [rowCount], MIN(ScopeStart) AS [firstDataDate], MAX(ScopeEnd) AS [lastDataDate], MAX(RefreshedAt) AS [lastRefreshedAt] FROM ${q(table)}`);
    return result.recordset[0];
  }
  async getMonthlySummaryActivity() {
    const result = await (await this.getPool()).request().query(`SELECT COUNT(*) AS [rowCount], MIN(MonthStart) AS [firstDataDate], MAX(MonthStart) AS [lastDataDate], MAX(RefreshedAt) AS [lastRefreshedAt] FROM ${q(this.config.monthlySummaryTable)}`);
    return result.recordset[0];
  }
  async getMachineActivity() {
    const result = await (await this.getPool()).request().query(`SELECT COUNT(*) AS [rowCount], MIN(EventDate) AS [firstDataDate], MAX(EventDate) AS [lastDataDate], MAX(RefreshedAt) AS [lastRefreshedAt] FROM ${q(this.config.machineRowTable)} WITH (NOLOCK)`);
    return result.recordset[0];
  }
}
