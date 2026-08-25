import 'dotenv/config';
import ExcelJS from 'exceljs';
import sql from 'mssql';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTaYieldActionConfig } from '../src/config.js';

export const TA_YIELD_ACTION_WORKBOOK = 'TA/TA yiled comment.xlsx';
const TA_YIELD_ACTION_SHEET = 'Daily_Yield_Ta';
const FIRST_ACTION_ROW = 35;

function cellText(cell) {
  const value = (cell.master || cell).value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (value?.richText) return value.richText.map((part) => part.text || '').join('').trim();
  if (typeof value?.text === 'string') return value.text.trim();
  if (value?.result !== undefined) return cellText({ value: value.result });
  return String(value || '').trim();
}

const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

export function readTaYieldActionsFromSheet(sheet) {
  const rows = [];
  let actionDate;
  for (let row = FIRST_ACTION_ROW; row <= sheet.rowCount; row += 1) {
    const candidateDate = cellText(sheet.getCell(row, 1));
    if (validDate(candidateDate)) actionDate = candidateDate;
    const serie = cellText(sheet.getCell(row, 2));
    const problem = cellText(sheet.getCell(row, 3));
    const analysisAction = cellText(sheet.getCell(row, 4));
    const pic = cellText(sheet.getCell(row, 7));
    const progress = cellText(sheet.getCell(row, 9));
    const dueCandidate = cellText(sheet.getCell(row, 16));
    if (!actionDate || !serie || !(problem || analysisAction || progress)) continue;
    rows.push({
      actionDate,
      serie: serie.slice(0, 100),
      problem: (problem || `Legacy follow-up: ${(analysisAction || progress).split('\n')[0]}`).slice(0, 2000),
      analysisAction: analysisAction.slice(0, 8000),
      pic: pic.slice(0, 255),
      progress: progress.slice(0, 8000),
      dueDate: validDate(dueCandidate) ? dueCandidate : null,
      status: /finished|complete|closed/i.test(progress) ? 'CLOSED' : 'IN_PROGRESS',
    });
  }
  return [...new Map(rows.map((row) => [[row.actionDate, row.serie, row.problem, row.analysisAction, row.progress].join('|'), row])).values()];
}

export async function readTaYieldActions(workbookFile = TA_YIELD_ACTION_WORKBOOK) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(workbookFile);
  const sheet = workbook.getWorksheet(TA_YIELD_ACTION_SHEET);
  if (!sheet) throw new Error(`${TA_YIELD_ACTION_SHEET} worksheet is missing.`);
  return readTaYieldActionsFromSheet(sheet);
}

export async function importTaYieldActions(environment = process.env) {
  const config = readTaYieldActionConfig(environment);
  if (!config.ready) throw new Error('ProductionMES TA Yield action storage configuration is incomplete.');
  const actions = await readTaYieldActions();
  const pool = await new sql.ConnectionPool({ server: config.server, database: config.database, user: config.user, password: config.password, options: { encrypt: true, trustServerCertificate: config.trustServerCertificate } }).connect();
  let imported = 0;
  let skipped = 0;
  try {
    for (const action of actions) {
      const request = pool.request();
      Object.entries(action).forEach(([key, value]) => request.input(key, key === 'actionDate' || key === 'dueDate' ? sql.Date : sql.NVarChar, value));
      request.input('createdBy', sql.NVarChar(255), 'TA yiled comment.xlsx import');
      const existing = await request.query(`SELECT TOP (1) id FROM ${config.table} WHERE deletedAt IS NULL AND actionDate = @actionDate AND serie = @serie AND problem = @problem AND ISNULL(progress, N'') = ISNULL(@progress, N'');`);
      if (existing.recordset.length) { skipped += 1; continue; }
      await request.query(`INSERT INTO ${config.table} (actionDate, serie, problem, analysisAction, pic, progress, dueDate, status, createdBy) VALUES (@actionDate, @serie, @problem, @analysisAction, @pic, @progress, @dueDate, @status, @createdBy);`);
      imported += 1;
    }
    console.log(`TA Yield comment import complete: ${imported} imported, ${skipped} already present, ${actions.length} unique records.`);
  } finally {
    await pool.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await importTaYieldActions();
}
