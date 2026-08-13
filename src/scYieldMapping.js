import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function resolveWorkbookPath(filename) {
  return path.isAbsolute(filename) ? filename : path.resolve(projectRoot, filename);
}

function text(value) {
  if (value?.richText) return value.richText.map((part) => part.text).join('').trim();
  return String(value ?? '').trim();
}

function keysForMode(value) {
  const normalized = text(value).toUpperCase();
  const numericPrefix = normalized.match(/^\s*([A-Z0-9-]+)/)?.[1];
  return [...new Set([normalized, numericPrefix].filter(Boolean))];
}

export async function loadScYieldMapping(filename) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(resolveWorkbookPath(filename));
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('SC Yield mapping workbook has no worksheets.');
  const mapping = new Map();
  sheet.eachRow((row, index) => {
    if (index === 1) return;
    const mode = text(row.getCell(2).value);
    const included = text(row.getCell(3).value).toUpperCase() === 'Y';
    const group = text(row.getCell(4).value) || 'Other';
    if (!mode) return;
    keysForMode(mode).forEach((key) => mapping.set(key, { mode, included, group }));
  });
  if (!mapping.size) throw new Error('SC Yield mapping workbook contains no Mode mappings.');
  return mapping;
}

export async function loadScYieldSourceModes(filename) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(resolveWorkbookPath(filename));
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('SC Yield mapping workbook has no worksheets.');
  const modes = new Map();
  sheet.eachRow((row, index) => {
    if (index === 1) return;
    const mode = text(row.getCell(2).value);
    if (mode) modes.set(mode.toUpperCase(), mode);
  });
  if (!modes.size) throw new Error('SC Yield mapping workbook contains no source modes.');
  return [...modes.values()].sort((left, right) => left.localeCompare(right));
}

export function mapScYieldRows(rows, mapping) {
  const includedModes = [...new Map([...mapping.values()].filter((entry) => entry.included).map((entry) => [entry.mode, entry])).values()].sort((left, right) => left.mode.localeCompare(right.mode));
  const inputByKey = new Map();
  rows.inputs.forEach((row) => {
    const key = `${row.bucketMonth}|${row.line || 'Unspecified'}`;
    inputByKey.set(key, (inputByKey.get(key) || 0) + Number(row.quantity || 0));
  });
  const defectByKey = new Map();
  const modeByKey = new Map();
  const excludedByKey = new Map();
  const unmappedByKey = new Map();
  rows.defects.forEach((row) => {
    const key = `${row.bucketMonth}|${row.line || 'Unspecified'}`;
    const entry = keysForMode(row.dispositionCode).map((code) => mapping.get(code)).find(Boolean);
    const quantity = Number(row.quantity || 0);
    if (!entry) { unmappedByKey.set(key, (unmappedByKey.get(key) || 0) + quantity); return; }
    if (!entry.included) { excludedByKey.set(key, (excludedByKey.get(key) || 0) + quantity); return; }
    const groups = defectByKey.get(key) || new Map();
    groups.set(entry.group, (groups.get(entry.group) || 0) + quantity);
    defectByKey.set(key, groups);
    const modes = modeByKey.get(key) || new Map();
    modes.set(entry.mode, (modes.get(entry.mode) || 0) + quantity);
    modeByKey.set(key, modes);
  });
  const keys = new Set([...inputByKey.keys(), ...defectByKey.keys(), ...excludedByKey.keys(), ...unmappedByKey.keys()]);
  return [...keys].sort().map((key) => {
    const [month, line] = key.split('|');
    const input = inputByKey.get(key) || 0;
    const groups = [...(defectByKey.get(key) || new Map()).entries()].map(([group, quantity]) => ({ group, quantity, rate: input ? quantity / input * 100 : undefined })).sort((left, right) => left.group.localeCompare(right.group));
    const modeQuantities = modeByKey.get(key) || new Map();
    const modes = includedModes.map((entry) => { const quantity = modeQuantities.get(entry.mode) || 0; return { mode: entry.mode, group: entry.group, quantity, rate: input ? quantity / input * 100 : undefined }; });
    const defect = groups.reduce((sum, group) => sum + group.quantity, 0);
    return { month, line, input, defect, yield: input ? (input - defect) / input * 100 : undefined, defectRate: input ? defect / input * 100 : undefined, groups, modes, excluded: excludedByKey.get(key) || 0, unmapped: unmappedByKey.get(key) || 0 };
  });
}
