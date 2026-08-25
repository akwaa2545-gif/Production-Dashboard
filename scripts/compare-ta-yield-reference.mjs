import 'dotenv/config';
import ExcelJS from 'exceljs';
import sql from 'mssql';
import { readTaYieldStagingConfig } from '../src/config.js';

const date = process.argv[2] || '2026-08-17';
const workbookPath = process.argv[3] || 'TA/Yield_Data_Aug_17_2026.xlsx';
const fields = ['ACC', 'App', 'CO', 'Cap', 'DF', 'ESR', 'Good', 'Inproc Dw', 'Inproc Up', 'Input', 'Input-', 'LC', 'La/Ex1', 'La/Ex2-6', 'PULSE', 'SH'];
const number = (value) => Number(value?.result ?? value ?? 0) || 0;
const thailandDate = (value) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const referenceDate = (value) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);
const sum = (rows, field) => rows.reduce((total, row) => total + number(row[field]), 0);

const workbook = new ExcelJS.Workbook();
await workbook.xlsx.readFile(workbookPath);
const sheet = workbook.getWorksheet('PowerBIThailand CompleteAction_');
if (!sheet) throw new Error('Reference worksheet PowerBIThailand CompleteAction_ is missing.');
const headers = new Map();
sheet.getRow(1).eachCell((cell, column) => headers.set(String(cell.value).trim(), column));
const reference = [];
sheet.eachRow((row, index) => {
  if (index === 1 || referenceDate(row.getCell(headers.get('Taping Date')).value) !== date) return;
  reference.push({
    line: String(row.getCell(headers.get('ProdLine')).value || '').trim(),
    lotNo: String(row.getCell(headers.get('JobName')).value || '').trim(),
    itemName: String(row.getCell(headers.get('From_ItemName')).value || '').trim(),
    ...Object.fromEntries(fields.map((field) => [field, number(row.getCell(headers.get(field)).value)]))
  });
});

const config = readTaYieldStagingConfig(process.env);
if (!config.ready) throw new Error('TA Yield staging configuration is incomplete.');
const pool = await new sql.ConnectionPool({ server: config.server, database: config.database, user: config.user, password: config.password, options: { encrypt: true, trustServerCertificate: config.trustServerCertificate } }).connect();
let staged;
try {
  const result = await pool.request().query(`SELECT TOP (1) Payload FROM ${config.workbookTable} ORDER BY ScopeEnd DESC, RefreshedAt DESC`);
  staged = JSON.parse(result.recordset[0]?.Payload || '[]').filter((row) => thailandDate(row.tapingDate) === date);
} finally {
  await pool.close();
}

const stagedValues = staged.map((row) => row.categories || {});
const differences = fields.map((field) => ({ field, reference: sum(reference, field), staged: sum(stagedValues, field) })).map((row) => ({ ...row, difference: row.staged - row.reference })).filter((row) => row.difference);
console.table(differences.length ? differences : fields.map((field) => ({ field, reference: sum(reference, field), staged: sum(stagedValues, field), difference: 0 })));
const key = (row) => [row.line, row.lotNo, row.itemName].join('|');
const referenceByLot = new Map(reference.map((row) => [key(row), row]));
const stagedByLot = new Map(staged.map((row) => [key(row), { ...row, ...(row.categories || {}) }]));
const lotDifferences = [...new Set([...referenceByLot.keys(), ...stagedByLot.keys()])].map((lotKey) => {
  const referenceRow = referenceByLot.get(lotKey) || {};
  const stagedRow = stagedByLot.get(lotKey) || {};
  const difference = Object.fromEntries(fields.map((field) => [field, number(stagedRow[field]) - number(referenceRow[field])]).filter(([, value]) => value));
  return Object.keys(difference).length ? { lotNo: stagedRow.lotNo || referenceRow.lotNo, itemName: stagedRow.itemName || referenceRow.itemName, difference: JSON.stringify(difference) } : null;
}).filter(Boolean);
console.table(lotDifferences);
console.log(JSON.stringify({ date, referenceLots: reference.length, stagedLots: staged.length, mismatchedColumns: differences.length }));
