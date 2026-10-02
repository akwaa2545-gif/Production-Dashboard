import ExcelJS from 'exceljs';
import { addExcelCharts } from './excelCharts.js';

export const MAX_COMPARE_EXPORT_JOB_RECORDS = 50000;
const colors = { navy: 'FF28358C', teal: 'FF007C91', muted: 'FF526078', red: 'FFD32F2F', green: 'FF008A3E', border: 'FFE2E7F1' };
const finite = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const numeric = (value, divisor = 1) => finite(value) === null ? 'N/A' : finite(value) / divisor;
const isAdjustment = (group) => String(group.group || '').trim().toUpperCase() === 'OTHER2';
const dateFormatter = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

function rangeLabel(range) {
  if (!range?.startDate || !range?.endDate) return 'Date range unavailable';
  const start = new Date(`${range.startDate}T00:00:00Z`); const end = new Date(`${range.endDate}T00:00:00Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return 'Date range unavailable';
  const startDay = start.getUTCDate(); const endDay = end.getUTCDate();
  if (range.startDate === range.endDate) return `${startDay} ${dateFormatter.format(start)}`;
  if (range.startDate.slice(0, 7) === range.endDate.slice(0, 7)) return `${startDay}–${endDay} ${dateFormatter.format(end)}`;
  return `${startDay} ${dateFormatter.format(start)} – ${endDay} ${dateFormatter.format(end)}`;
}

function setupSheet(book, name, widths, frozenRow = 7) {
  const sheet = book.addWorksheet(name, { properties: { defaultRowHeight: 21, tabColor: { argb: colors.navy } }, views: [{ state: 'frozen', ySplit: frozenRow, showGridLines: false }] });
  sheet.columns = widths.map((width) => ({ width }));
  sheet.pageSetup = { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  return sheet;
}

function heading(sheet, text, row = 1) {
  sheet.mergeCells(row, 1, row, sheet.columns.length);
  const cell = sheet.getCell(row, 1);
  cell.value = String(text); cell.font = { name: 'Calibri', bold: true, size: row === 1 ? 18 : 11, color: { argb: 'FFFFFFFF' } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.navy } };
  sheet.getRow(row).height = row === 1 ? 34 : 25;
}

function note(sheet, row, text) {
  sheet.mergeCells(row, 1, row, sheet.columns.length);
  const cell = sheet.getCell(row, 1);
  cell.value = String(text); cell.font = { name: 'Calibri', size: 11, color: { argb: colors.muted } };
  cell.alignment = { wrapText: true, vertical: 'middle' };
  sheet.getRow(row).height = Math.max(24, 16 * Math.ceil(String(text).length / 130));
}

function headers(sheet, row, values) {
  const header = sheet.getRow(row);
  header.values = values;
  header.height = 42;
  header.eachCell((cell) => {
    cell.font = { name: 'Calibri', bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.navy } };
    cell.alignment = { wrapText: true, vertical: 'middle' };
  });
}

function dataRow(sheet, row, values, formats = {}) {
  const item = sheet.getRow(row); item.values = values;
  item.eachCell((cell, col) => {
    cell.font = { name: 'Calibri', size: 11, color: { argb: colors.muted } };
    cell.alignment = { vertical: 'middle', wrapText: col === 1 };
    cell.border = { bottom: { style: 'hair', color: { argb: colors.border } } };
    if (formats[col]) cell.numFmt = formats[col];
    if (row % 2 === 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F6FC' } };
  });
}

function changeColor(cell, value, yieldChange, adjustment = false) {
  const number = finite(value);
  const positiveGood = yieldChange;
  const color = adjustment || number === null || number === 0 ? colors.muted : (number > 0) === positiveGood ? colors.green : colors.red;
  cell.font = { name: 'Calibri', size: 11, bold: !adjustment, color: { argb: color } };
}

function summarySheet(book, compare, labels) {
  const sheet = setupSheet(book, 'Compare', [28, 24, 24, 20, 23, 23, 23, 23]);
  heading(sheet, 'TOKIN TA Yield Compare');
  note(sheet, 2, `${labels.current} versus ${labels.compare}`);
  note(sheet, 3, `Comparison mode: ${compare.comparisonMode === 'same-dates' ? 'Same dates' : 'Full month'}`);
  note(sheet, 4, 'Source: staging. Yield = good / adjusted input. Quantities are kpcs (pieces / 1,000). Changes are percentage points (pp).');
  note(sheet, 5, (compare.rangeNotes || []).join(' ') || 'Weighted accumulated yield by series and case size. Missing data is N/A, not zero.');
  headers(sheet, 7, ['Series / case size', `${labels.current}\nYield`, `${labels.compare}\nYield`, 'Yield change (pp)', `${labels.current}\nInput (kpcs)`, `${labels.current}\nGood (kpcs)`, `${labels.compare}\nInput (kpcs)`, `${labels.compare}\nGood (kpcs)`]);
  const rows = compare.rows || [];
  rows.forEach((row, index) => {
    dataRow(sheet, index + 8, [String(row.label ?? ''), numeric(row.currentYield, 100), numeric(row.compareYield, 100), numeric(row.delta), numeric(row.currentInput, 1000), numeric(row.currentGood, 1000), numeric(row.compareInput, 1000), numeric(row.compareGood, 1000)], { 2: '0.00%', 3: '0.00%', 4: '+0.00" pp";-0.00" pp";0.00" pp"', 5: '#,##0.00', 6: '#,##0.00', 7: '#,##0.00', 8: '#,##0.00' });
    changeColor(sheet.getCell(index + 8, 4), row.delta, true);
  });
  if (rows.length) sheet.autoFilter = { from: 'A7', to: `H${rows.length + 7}` };
  else note(sheet, 8, 'No Compare categories available.');
  return rows;
}

function lookupSheet(book, details, labels) {
  const sheet = setupSheet(book, 'LOOKUP', [30, 28, 28, 27, 27, 23], 9);
  const selection = String(details.selection?.label ?? 'Total');
  heading(sheet, `LOOKUP: ${selection}`);
  note(sheet, 2, `${labels.current} versus ${labels.compare}`);
  note(sheet, 3, 'Rates use full-period adjusted input, not only affected jobs. Other2 is a signed reconciliation adjustment, not a confirmed physical defect or root cause. It is excluded from physical-defect graphs.');
  headers(sheet, 5, ['Period', 'Input (kpcs)', 'Good (kpcs)', 'Weighted yield', 'Distinct JobName / lotNo', 'Defects incl. adjustments (kpcs)']);
  [details.current, details.compare].forEach((summary, index) => dataRow(sheet, index + 6, [index === 0 ? labels.current : labels.compare, numeric(summary?.input, 1000), numeric(summary?.good, 1000), numeric(summary?.yield, 100), numeric(summary?.lotCount), numeric(summary?.defectQty, 1000)], { 2: '#,##0.00', 3: '#,##0.00', 4: '0.00%', 5: '#,##0', 6: '#,##0.00' }));
  headers(sheet, 9, ['Defect group', `${labels.current}\nQuantity (kpcs)`, `${labels.compare}\nQuantity (kpcs)`, `${labels.current}\nRate`, `${labels.compare}\nRate`, 'Defect-rate change (pp)']);
  const groups = [...(details.groups || []).filter((group) => !isAdjustment(group)), ...(details.groups || []).filter(isAdjustment)];
  groups.forEach((group, index) => {
    dataRow(sheet, index + 10, [String(group.group ?? ''), numeric(group.currentQty, 1000), numeric(group.compareQty, 1000), numeric(group.currentRate, 100), numeric(group.compareRate, 100), numeric(group.deltaRate)], { 2: '#,##0.00', 3: '#,##0.00', 4: '0.00%', 5: '0.00%', 6: '+0.00" pp";-0.00" pp";0.00" pp"' });
    changeColor(sheet.getCell(index + 10, 6), group.deltaRate, false, isAdjustment(group));
  });
  if (groups.length) sheet.autoFilter = { from: 'A9', to: `F${groups.length + 9}` };
  else note(sheet, 10, 'No defect groups available.');
  return groups.filter((group) => !isAdjustment(group));
}

function jobsSheet(book, name, period, lots) {
  const rows = lots?.rows || [];
  if (!Number.isSafeInteger(lots?.total) || lots.total !== rows.length) throw new Error('Export requires all affected job records; an incomplete page cannot be exported.');
  const sheet = setupSheet(book, name, [23, 28, 34, 18, 21, 21, 18, 24, 55], 5);
  heading(sheet, `Affected jobs: ${period}`);
  note(sheet, 2, 'Source: staging. JobName is staged lotNo. A job can have multiple part/date records; these rows are affected records, not distinct-job totals.');
  note(sheet, 3, `All ${rows.length.toLocaleString('en-US')} affected records. Group quantities include signed Other2 reconciliation adjustments and are not confirmed root causes.`);
  headers(sheet, 5, ['JobName / lotNo', 'Series / line', 'Part number', 'Taping date', 'Input (kpcs)', 'Good (kpcs)', 'Yield', 'Defects incl. adjustments (kpcs)', 'Defect groups (kpcs)']);
  rows.forEach((row, index) => {
    const date = typeof row.tapingDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.tapingDate) ? new Date(`${row.tapingDate}T00:00:00Z`) : null;
    const groups = (row.groups || []).map((group) => `${String(group.group ?? '')}: ${numeric(group.quantity, 1000)}`).join('; ');
    dataRow(sheet, index + 6, [String(row.lotNo ?? ''), String(row.line ?? ''), String(row.itemName ?? ''), date && Number.isFinite(date.getTime()) ? date : 'N/A', numeric(row.input, 1000), numeric(row.good, 1000), numeric(row.yield, 100), numeric(row.defectQty, 1000), groups], { 4: 'd mmm yyyy', 5: '#,##0.00', 6: '#,##0.00', 7: '0.00%', 8: '#,##0.00' });
    sheet.getCell(index + 6, 9).alignment = { wrapText: true, vertical: 'middle' };
    sheet.getRow(index + 6).height = Math.min(126, 21 * Math.max(1, Math.ceil(groups.length / 50), Math.ceil(String(row.itemName ?? '').length / 30), Math.ceil(String(row.line ?? '').length / 26)));
  });
  if (rows.length) sheet.autoFilter = { from: 'A5', to: `I${rows.length + 5}` };
}

const reference = (sheet, col, start, length) => `'${sheet}'!$${col}$${start}:$${col}$${start + length - 1}`;

function exportCharts(rows, groups, labels, details) {
  const charts = [];
  if (rows.length) charts.push({ sheetId: 2, title: `Yield change: ${labels.current} minus ${labels.compare} (pp)`, type: 'column', categories: { formula: reference('Compare', 'A', 8, rows.length), values: rows.map((row) => row.label) }, series: [{ name: 'Yield change (pp)', formula: reference('Compare', 'D', 8, rows.length), values: rows.map((row) => finite(row.delta)), color: '28358C', positiveColor: '008A3E', negativeColor: 'D32F2F' }], anchor: { fromCol: 0, fromRow: 3, toCol: 16, toRow: 28 }, valueFormat: '0.00" pp"' });
  if (!groups.length) return charts;
  const categories = { formula: reference('LOOKUP', 'A', 10, groups.length), values: groups.map((group) => group.group) };
  const name = String(details.selection?.label ?? 'Total');
  const bottom = 32 + Math.max(22, Math.ceil(groups.length * 1.6));
  charts.push({ sheetId: 2, title: `Defect rates by group: ${name}`, type: 'bar', categories, series: [{ name: labels.current, formula: reference('LOOKUP', 'D', 10, groups.length), values: groups.map((group) => finite(group.currentRate) === null ? null : finite(group.currentRate) / 100), color: '28358C' }, { name: labels.compare, formula: reference('LOOKUP', 'E', 10, groups.length), values: groups.map((group) => finite(group.compareRate) === null ? null : finite(group.compareRate) / 100), color: '007C91' }], anchor: { fromCol: 0, fromRow: 32, toCol: 8, toRow: bottom }, valueFormat: '0.00%' });
  charts.push({ sheetId: 2, title: `Defect-rate change: ${name} (pp)`, type: 'bar', categories, series: [{ name: `${labels.current} minus ${labels.compare}`, formula: reference('LOOKUP', 'F', 10, groups.length), values: groups.map((group) => finite(group.deltaRate)), color: '526078', positiveColor: 'D32F2F', negativeColor: '008A3E' }], anchor: { fromCol: 8, fromRow: 32, toCol: 16, toRow: bottom }, valueFormat: '0.00" pp"' });
  return charts;
}

export async function buildTaYieldCompareWorkbook(compare, details) {
  const book = new ExcelJS.Workbook();
  book.creator = 'TOKIN Production Dashboard'; book.created = new Date();
  const labels = { current: rangeLabel(compare.currentRange), compare: rangeLabel(compare.compareRange) };
  const rows = summarySheet(book, compare, labels);
  const graphs = setupSheet(book, 'Graphs', Array(16).fill(12), 0);
  heading(graphs, 'Compare graphs');
  note(graphs, 2, `${labels.current} versus ${labels.compare}. Yield: green improvement, red decline. Defects: red increase, green decrease. Other2 excluded.`);
  const groups = details ? lookupSheet(book, details, labels) : [];
  if (details) {
    jobsSheet(book, 'Jobs Report', labels.current, details.lots?.current);
    jobsSheet(book, 'Jobs Compare', labels.compare, details.lots?.compare);
  }
  return addExcelCharts(await book.xlsx.writeBuffer(), exportCharts(rows, groups, labels, details));
}
