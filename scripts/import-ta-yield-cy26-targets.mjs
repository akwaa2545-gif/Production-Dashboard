import 'dotenv/config';
import ExcelJS from 'exceljs';
import sql from 'mssql';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTaYieldTargetConfig } from '../src/config.js';

export const CY26_TA_YIELD_TARGET_WORKBOOK = 'TA/1. Target yield CY26.xlsx';
const CY26_TARGET_SHEET = 'Target CY26';
const SERIES_TARGET_FIRST_ROW = 35;
const SERIES_TARGET_LAST_ROW = 45;
const SERIES_COLUMN = 10;
const FIRST_MONTH_COLUMN = 11;
const TOTAL_TARGET_ROW = 53;

const normalizeSerie = (value) => String(value || '').trim().replace(/-/g, ' ').replace(/\s+/g, ' ');
const cellText = (cell) => {
  const value = cell.value;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (value && typeof value === 'object' && typeof value.text === 'string') return value.text;
  return '';
};
const cellNumber = (cell) => Number(cell.value?.result ?? cell.value);

function readTargetRow(sheet, row, serie = normalizeSerie(cellText(sheet.getCell(row, SERIES_COLUMN)))) {
  if (!serie) throw new Error(`CY26 TA Yield target row ${row} does not contain a series name.`);
  const targets = [];
  for (let month = 1; month <= 12; month += 1) {
    const target = cellNumber(sheet.getCell(row, FIRST_MONTH_COLUMN + month - 1));
    if (!Number.isFinite(target) || target < 0 || target > 100) throw new Error(`Invalid ${serie} target for month ${month}.`);
    targets.push({ serie, period: `2026-${String(month).padStart(2, '0')}`, target });
  }
  return targets;
}

export function readTaYieldCy26TargetsFromSheet(sheet) {
  const seriesTargets = Array.from({ length: SERIES_TARGET_LAST_ROW - SERIES_TARGET_FIRST_ROW + 1 }, (_, index) => readTargetRow(sheet, SERIES_TARGET_FIRST_ROW + index)).flat();
  const totalLabel = normalizeSerie(cellText(sheet.getCell(TOTAL_TARGET_ROW, SERIES_COLUMN)));
  if (!/^total$/i.test(totalLabel)) throw new Error(`CY26 TA Yield total target must be on row ${TOTAL_TARGET_ROW}.`);
  return [...seriesTargets, ...readTargetRow(sheet, TOTAL_TARGET_ROW, 'Total')];
}

export async function readTaYieldCy26Targets(workbookFile = CY26_TA_YIELD_TARGET_WORKBOOK) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(workbookFile);
  const sheet = workbook.getWorksheet(CY26_TARGET_SHEET);
  if (!sheet) throw new Error(`${CY26_TARGET_SHEET} worksheet is missing.`);
  return readTaYieldCy26TargetsFromSheet(sheet);
}

export async function importTaYieldCy26Targets(environment = process.env) {
  const config = readTaYieldTargetConfig(environment);
  if (!config.ready) throw new Error('ProductionMES TA Yield target storage configuration is incomplete.');
  const targets = await readTaYieldCy26Targets();
  const pool = await new sql.ConnectionPool({ server: config.server, database: config.database, user: config.user, password: config.password, options: { encrypt: true, trustServerCertificate: config.trustServerCertificate } }).connect();
  try {
    for (const target of targets) {
      const request = pool.request();
      request.input('serie', sql.NVarChar(200), target.serie);
      request.input('period', sql.Char(7), target.period);
      request.input('target', sql.Decimal(5, 2), target.target);
      await request.query(`SET XACT_ABORT ON; BEGIN TRANSACTION; UPDATE ${config.table} WITH (UPDLOCK, SERIALIZABLE) SET TargetPercent = @target, UpdatedAt = SYSUTCDATETIME() WHERE Serie = @serie AND ReportingPeriod = @period; IF @@ROWCOUNT = 0 INSERT INTO ${config.table} (Serie, ReportingPeriod, TargetPercent) VALUES (@serie, @period, @target); COMMIT TRANSACTION;`);
    }
    console.log(`CY26 TA Yield targets imported: ${targets.length} targets across ${new Set(targets.map((target) => target.serie)).size} series, including Total.`);
  } finally {
    await pool.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await importTaYieldCy26Targets();
}
