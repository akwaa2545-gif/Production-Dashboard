import 'dotenv/config';
import ExcelJS from 'exceljs';
import sql from 'mssql';
import { readTaYieldTargetConfig } from '../src/config.js';

const config = readTaYieldTargetConfig(process.env);
if (!config.ready) throw new Error('ProductionMES TA Yield target storage configuration is incomplete.');
const workbook = new ExcelJS.Workbook();
await workbook.xlsx.readFile('TA/1. Target yield CY26 Standard ,facedown.xlsx');
const sheet = workbook.getWorksheet('Target CY26');
if (!sheet) throw new Error('Target CY26 worksheet is missing.');
const cellNumber = (cell) => Number(cell.value?.result ?? cell.value);
const targets = [];
for (let row = 1; row <= sheet.rowCount; row += 1) {
  const serie = String(sheet.getCell(row, 10).value || '').trim();
  const targetSerie = /^standard$/i.test(serie) ? 'Standard Production' : /^facedown$/i.test(serie) ? 'Facedown' : '';
  if (!targetSerie) continue;
  for (let month = 1; month <= 12; month += 1) {
    const target = cellNumber(sheet.getCell(row, 10 + month));
    if (!Number.isFinite(target) || target < 0 || target > 100) throw new Error(`Invalid ${targetSerie} target for month ${month}.`);
    targets.push({ serie: targetSerie, period: `2026-${String(month).padStart(2, '0')}`, target });
  }
}
if (targets.length !== 24) throw new Error(`Expected 24 group targets, found ${targets.length}.`);
const legacySeries = ['FPS A08', 'FPS A2', 'FPS A3', 'FPS B10', 'FPS B3', 'PSG B2', 'PSL A', 'PSL B15', 'PSL B2', 'PSL B3'];
const pool = await new sql.ConnectionPool({ server: config.server, database: config.database, user: config.user, password: config.password, options: { encrypt: true, trustServerCertificate: config.trustServerCertificate } }).connect();
const transaction = new sql.Transaction(pool);
try {
  await transaction.begin();
  const remove = new sql.Request(transaction); remove.input('period', sql.VarChar(7), '2026-%'); legacySeries.forEach((serie, index) => remove.input(`serie${index}`, sql.NVarChar(200), serie));
  await remove.query(`DELETE FROM ${config.table} WHERE ReportingPeriod LIKE @period AND Serie IN (${legacySeries.map((_, index) => `@serie${index}`).join(', ')});`);
  for (const target of targets) {
    const request = new sql.Request(transaction); request.input('serie', sql.NVarChar(200), target.serie); request.input('period', sql.Char(7), target.period); request.input('target', sql.Decimal(5, 2), target.target);
    await request.query(`UPDATE ${config.table} WITH (UPDLOCK, SERIALIZABLE) SET TargetPercent = @target, UpdatedAt = SYSUTCDATETIME() WHERE Serie = @serie AND ReportingPeriod = @period; IF @@ROWCOUNT = 0 INSERT INTO ${config.table} (Serie, ReportingPeriod, TargetPercent) VALUES (@serie, @period, @target);`);
  }
  await transaction.commit();
  console.log(`CY26 TA Yield group targets imported: ${targets.length} targets; retained GPS targets.`);
} catch (error) {
  await transaction.rollback().catch(() => undefined);
  throw error;
} finally { await pool.close(); }
