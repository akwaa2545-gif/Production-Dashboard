import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { publicConfig, publicDataModel, publicScYieldConfig, publicTaYieldConfig, read901StagingConfig, readCellCommentConfig, readDatasetConfig, readMtdTargetConfig, readScYieldConfig, readScYieldStagingConfig, readScYieldTargetConfig, readTaYieldActionConfig, readTaYieldConfig, readTaYieldTargetConfig, readWipStagingConfig, readYieldDefectSettingConfig, readTaYieldStagingConfig } from './config.js';
import { MtdTargetRepository } from './mtdTargetRepository.js';
import { CellCommentRepository } from './cellCommentRepository.js';
import { SqlRepository } from './sqlRepository.js';
import { Staging901Repository } from './staging901Repository.js';
import { refresh901Staging } from './staging901Refresh.js';
import { StagingWipRepository } from './stagingWipRepository.js';
import { refreshWipStaging } from './stagingWipRefresh.js';
import { ScYieldRepository } from './scYieldRepository.js';
import { ScYieldStagingRepository } from './scYieldStagingRepository.js';
import { TaYieldRepository } from './taYieldRepository.js';
import { ScYieldTargetRepository } from './scYieldTargetRepository.js';
import { TaYieldTargetRepository } from './taYieldTargetRepository.js';
import { TaYieldActionRepository } from './taYieldActionRepository.js';
import { YieldDefectSettingRepository } from './yieldDefectSettingRepository.js';
import { TaYieldStagingRepository } from './taYieldStagingRepository.js';
import { mergeTaWorkbookLots, taYieldRefreshPlan } from './taYieldRefreshPlan.js';
import { stagingIncrementalRefreshFilters } from './stagingRefreshPlan.js';
import { loadScYieldMapping, loadScYieldSourceModes, mapScYieldRows } from './scYieldMapping.js';
import { loadTaWorkbookReconciliationMapping, loadTaYieldMapping, mapTaWorkbookReconciliationRows, mapTaWorkbookYieldRows, mapTaYieldLotDetails, mapTaYieldMachineEvents, mapTaYieldRows } from './taYieldMapping.js';
import { TtlCache } from './ttlCache.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const filterNames = ['product', 'process', 'serie', 'case', 'pn'];
const taMachineProcesses = new Map([['1.1stAnodization', 'Anodization'], ['2.Welding', 'Welding'], ['3.Ei', 'EI']]);

function isCompleteCalendarMonthRange({ startDate, endDate }) {
  if (!startDate.endsWith('-01')) return false;
  const monthEnd = new Date(`${endDate.slice(0, 7)}-01T00:00:00Z`);
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1, 0);
  return endDate === monthEnd.toISOString().slice(0, 10);
}

function isAuthenticationError(error) {
  return error?.code === 'ELOGIN' || /token\s+(?:is\s+)?expired|authentication|login failed|aadsts|credential/i.test(error?.message || '');
}

function isConnectionError(error) {
  const connectionCodes = new Set(['ESOCKET', 'ETIMEOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND']);
  return connectionCodes.has(error?.code) || /failed to connect|connection.*timed out|etimedout|econnrefused|enotfound|socket.*closed/i.test(error?.message || '');
}

function validDate(value) {
  return typeof value === 'string' && datePattern.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function thailandCalendarDate(value) {
  const raw = String(value || '').trim();
  if (datePattern.test(raw)) return raw;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw.slice(0, 10);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).reduce((values, part) => ({ ...values, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function validFilterValue(name, value) {
  if (['serie', 'pn'].includes(name) && Array.isArray(value)) return value.length <= 12 && value.every((item) => typeof item === 'string' && item.length <= 200);
  return typeof value === 'string' && value.length <= 200;
}

function validTarget(target) {
  if (!target || !['NEO', 'SC'].includes(target.product) || typeof target.serie !== 'string' || !target.serie.trim() || target.serie.length > 200) return undefined;
  if (typeof target.period !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(target.period)) return undefined;
  if (!Number.isFinite(target.monthlyPlan) || target.monthlyPlan < 0 || !Number.isFinite(target.workingDay) || target.workingDay <= 0) return undefined;
  return { product: target.product, serie: target.serie.trim(), period: target.period, monthlyPlan: target.monthlyPlan, workingDay: target.workingDay };
}

function validScYieldTarget(target) {
  if (!target || typeof target.serie !== 'string' || !target.serie.trim() || target.serie.length > 200 || typeof target.period !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(target.period) || !Number.isFinite(target.target) || target.target < 0 || target.target > 100) return undefined;
  return { serie: target.serie.trim(), period: target.period, target: target.target };
}

function validCommentScope(value, requireText = false) {
  if (!value || !['NEO', 'SC'].includes(value.product) || typeof value.serie !== 'string' || !value.serie.trim() || value.serie.length > 100 || !validDate(value.reportingDate)) return undefined;
  const pn = typeof value.pn === 'string' ? value.pn.trim() : ''; const process = typeof value.process === 'string' ? value.process.trim() : ''; const commentText = typeof value.commentText === 'string' ? value.commentText.trim() : '';
  if (pn.length > 100 || process.length > 100 || (requireText && (!commentText || commentText.length > 1000))) return undefined;
  const createdBy = value.dataset === 'closed' ? '901' : value.dataset === 'lot' ? 'WIP' : undefined;
  if (requireText && !createdBy) return undefined;
  return { product: value.product, serie: value.serie.trim(), pn, process, reportingDate: value.reportingDate, ...(requireText ? { commentText, createdBy } : {}) };
}

function validTaYieldAction(value) {
  const text = (name, maximum) => typeof value?.[name] === 'string' && value[name].trim().length <= maximum ? value[name].trim() : undefined;
  const actionDate = value?.actionDate; const dueDate = value?.dueDate || undefined; const serie = text('serie', 100); const problem = text('problem', 2000); const analysisAction = text('analysisAction', 8000); const pic = text('pic', 255); const progress = text('progress', 8000); const status = value?.status;
  if (!validDate(actionDate) || (dueDate && !validDate(dueDate)) || !serie || !problem || !['OPEN', 'IN_PROGRESS', 'CLOSED'].includes(status)) return undefined;
  return { actionDate, serie, problem, analysisAction: analysisAction || '', pic: pic || '', progress: progress || '', dueDate: dueDate || null, status };
}

function validatedFilters(query) {
  const startDate = query.startDate;
  const endDate = query.endDate;
  if (!validDate(startDate) || !validDate(endDate)) return { error: 'Provide valid startDate and endDate values in YYYY-MM-DD format.' };
  if (startDate > endDate) return { error: 'startDate must be on or before endDate.' };
  if ((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000 > 366) return { error: 'Date range cannot exceed 366 days.' };
  const filters = { startDate, endDate };
  for (const name of filterNames) {
    const value = query[name];
    if (value !== undefined && !validFilterValue(name, value)) return { error: `Invalid ${name} filter.` };
    if (value) filters[name] = value;
  }
  return { filters };
}

function validatedOptionFilters(query) {
  const filters = {};
  for (const name of filterNames) {
    const value = query[name];
    if (value !== undefined && !validFilterValue(name, value)) return { error: `Invalid ${name} filter.` };
    if (value) filters[name] = value;
  }
  return { filters };
}

function validatedPartNumberQuery(query) {
  const optionFilters = validatedOptionFilters(query);
  if (optionFilters.error) return optionFilters;
  const search = query.search || '';
  const offset = Number(query.offset || 0);
  if (typeof search !== 'string' || search.length > 100) return { error: 'Invalid part number search.' };
  if (!Number.isInteger(offset) || offset < 0 || offset > 100000) return { error: 'Invalid part number offset.' };
  return { filters: optionFilters.filters, search, offset };
}

function validatedTaMachineQuery(query, { requireMachine = false, requireDefect = false } = {}) {
  const validation = validatedFilters(query);
  if (validation.error) return validation;
  const process = typeof query.process === 'string' ? query.process.trim() : '';
  const requestedMachine = typeof query.machine === 'string' ? query.machine.trim() : '';
  const machine = requestedMachine === '__ALL__' ? '' : requestedMachine;
  const defectType = typeof query.defectType === 'string' ? query.defectType.trim() : '';
  const defect = typeof query.defect === 'string' ? query.defect.trim() : '';
  const groupBy = typeof query.groupBy === 'string' ? query.groupBy.trim() : 'day';
  if (!taMachineProcesses.has(process)) return { error: 'Select a valid TA Machine process.' };
  if ((requireMachine && !requestedMachine) || machine.length > 200) return { error: 'Select a valid machine.' };
  if (requireDefect && (!['code', 'category'].includes(defectType) || !defect || defect.length > 200)) return { error: 'Select a valid disposition code or Yield Category.' };
  if (!['day', 'week', 'month'].includes(groupBy)) return { error: 'Select Week or Month for the Machine grouping.' };
  return { filters: validation.filters, process, processPattern: `%${taMachineProcesses.get(process)}%`, machine, defectType, defect, groupBy };
}

async function completionWorkbook(rows) {
  const dates = [...new Set(rows.map((row) => String(row.bucketDate).slice(0, 10)))].sort();
  const series = [...new Set(rows.map((row) => String(row.itemName || 'Unspecified')))].sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }));
  const quantities = rows.reduce((values, row) => ({ ...values, [`${row.itemName}|${String(row.bucketDate).slice(0, 10)}`]: (values[`${row.itemName}|${String(row.bucketDate).slice(0, 10)}`] || 0) + Number(row.quantityMoved || 0) }), {});
  const records = [['Series', 'Qty', ...dates], ...series.map((serie) => {
    const daily = dates.map((date) => quantities[`${serie}|${date}`] || 0);
    return [serie, daily.reduce((sum, value) => sum + value, 0), ...daily];
  })];
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Series completion');
  worksheet.addRows(records);
  worksheet.columns = [{ width: 22 }, { width: 16 }, ...dates.map(() => ({ width: 14 }))];
  worksheet.views = [{ state: 'frozen', xSplit: 2, ySplit: 1 }];
  worksheet.autoFilter = { from: 'A1', to: { row: 1, column: records[0].length } };
  worksheet.getRow(1).height = 24;
  worksheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF28358C' } };
    cell.alignment = { vertical: 'middle', horizontal: cell.col === 1 ? 'left' : 'center' };
    cell.border = { bottom: { style: 'medium', color: { argb: 'FF17256B' } } };
  });
  worksheet.eachRow((row, index) => {
    if (index < 2) return;
    const stripe = index % 2 === 0 ? 'FFF6F8FC' : 'FFFFFFFF';
    row.eachCell((cell, column) => {
      const quantityCell = column > 1;
      const quantity = Number(cell.value || 0);
      cell.numFmt = quantityCell ? '#,##0.####' : '@';
      cell.alignment = { vertical: 'middle', horizontal: quantityCell ? 'right' : 'left' };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFDDE2EE' } } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: quantityCell && quantity === 0 ? 'FFF1F3F7' : stripe } };
      if (column === 1) cell.font = { bold: true, color: { argb: 'FF25304B' } };
      if (column === 2) { cell.font = { bold: true, color: { argb: 'FF28358C' } }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: quantity === 0 ? 'FFF1F3F7' : 'FFE6EDFF' } }; }
      if (column > 2 && quantity > 0) cell.font = { color: { argb: 'FF126545' } };
    });
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function taYieldDataTableWorkbook(rows, filters) {
  const categoryOrder = ['ACC', 'App', 'CO', 'Cap', 'DF', 'ESR', 'Good', 'Inproc Dw', 'Inproc Up', 'Input', 'Input-', 'LC', 'La/Ex1', 'La/Ex2-6', 'PULSE', 'SH'];
  const categories = categoryOrder.filter((category) => category === 'ACC' || rows.some((row) => Object.hasOwn(row.categories || {}, category)));
  const calculated = ['Defect', 'Other1', 'InputF', 'Other2', '%Good', '%Defect', 'TTL', 'Check'];
  const headers = ['ProdLine', 'JobName', 'From ItemName', 'Taping Date', ...categories, ...calculated];
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'OneMES Quantity Dashboard';
  workbook.created = new Date();
  const worksheet = workbook.addWorksheet('TA Yield DataTable', { views: [{ state: 'frozen', xSplit: 4, ySplit: 4 }] });
  worksheet.mergeCells(1, 1, 1, headers.length);
  const title = worksheet.getCell('A1');
  title.value = 'TA Yield DataTable';
  title.font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
  title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF28358C' } };
  title.alignment = { vertical: 'middle', horizontal: 'left' };
  worksheet.getRow(1).height = 28;
  worksheet.mergeCells(2, 1, 2, headers.length);
  const subtitle = worksheet.getCell('A2');
  subtitle.value = `Reporting period: ${filters.startDate} to ${filters.endDate}`;
  subtitle.font = { italic: true, color: { argb: 'FF465473' } };
  subtitle.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F5FB' } };
  subtitle.alignment = { vertical: 'middle', horizontal: 'left' };
  worksheet.getRow(2).height = 20;
  worksheet.getRow(3).height = 8;
  worksheet.getRow(4).values = headers;
  worksheet.getRow(4).height = 24;
  worksheet.getRow(4).eachCell((cell, column) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF28358C' } };
    cell.alignment = { vertical: 'middle', horizontal: column <= 4 ? 'left' : 'center' };
    cell.border = { bottom: { style: 'medium', color: { argb: 'FF17256B' } } };
  });
  rows.forEach((row, index) => {
    const calculation = row.calculation || {};
    const tapingDate = thailandCalendarDate(row.tapingDate);
    const values = [row.line || '', row.lotNo || '', row.itemName || '', validDate(tapingDate) ? new Date(`${tapingDate}T00:00:00Z`) : tapingDate, ...categories.map((category) => Number(row.categories?.[category] || 0)), calculation.defect, calculation.other1, calculation.inputF, calculation.other2, Number.isFinite(calculation.goodRate) ? calculation.goodRate / 100 : undefined, Number.isFinite(calculation.defectRate) ? calculation.defectRate / 100 : undefined, calculation.ttl, calculation.check];
    const worksheetRow = worksheet.addRow(values);
    const stripe = index % 2 === 0 ? 'FFFFFFFF' : 'FFF6F8FC';
    worksheetRow.eachCell((cell, column) => {
      const numeric = column > 4;
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: stripe } };
      cell.alignment = { vertical: 'middle', horizontal: numeric ? 'right' : 'left' };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFDDE2EE' } } };
      cell.numFmt = column === 4 ? 'yyyy-mm-dd' : numeric ? (headers[column - 1].startsWith('%') ? '0.000000%' : '#,##0.####') : '@';
      if (column <= 3) cell.font = { bold: column === 1, color: { argb: 'FF25304B' } };
      if (headers[column - 1] === 'Good') cell.font = { color: { argb: 'FF126545' }, bold: true };
    });
  });
  worksheet.columns = [{ width: 38 }, { width: 16 }, { width: 28 }, { width: 14 }, ...headers.slice(4).map(() => ({ width: 14 }))];
  worksheet.autoFilter = { from: 'A4', to: { row: Math.max(5, rows.length + 4), column: headers.length } };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export function createApp({ environment = process.env, repository, scYieldRepository, taYieldRepository, mtdTargetRepository, scYieldTargetRepository, taYieldTargetRepository, taYieldActionRepository, cellCommentRepository, staging901Repository, stagingWipRepository, scYieldStagingRepository, taYieldStagingRepository, yieldDefectSettingRepository, cache } = {}) {
  const configs = { closed: readDatasetConfig(environment, 'closed'), lot: readDatasetConfig(environment, 'lot') };
  const scYieldConfig = readScYieldConfig(environment);
  const taYieldConfig = readTaYieldConfig(environment);
  const taYieldActionConfig = readTaYieldActionConfig(environment);
  const mtdTargetConfig = readMtdTargetConfig(environment);
  const scYieldTargetConfig = readScYieldTargetConfig(environment);
  const taYieldTargetConfig = readTaYieldTargetConfig(environment);
  const commentConfig = readCellCommentConfig(environment);
  const staging901Config = read901StagingConfig(environment);
  const stagingWipConfig = readWipStagingConfig(environment);
  const scYieldStagingConfig = readScYieldStagingConfig(environment);
  const yieldDefectSettingConfig = readYieldDefectSettingConfig(environment);
  const taYieldStagingConfig = readTaYieldStagingConfig(environment);
  const repositories = new Map();
  let scYieldMapping;
  let scYieldSourceModes;
  let taYieldMapping;
  let taWorkbookReconciliationMapping;
  let taYieldMachineDefectViews;
  const workbookDescriptions = (mapping) => [...mapping.entries()].filter(([, category]) => category && category !== 'X').map(([description]) => description);
  const targets = mtdTargetRepository || (mtdTargetConfig.ready ? new MtdTargetRepository(mtdTargetConfig) : undefined);
  const scYieldTargets = scYieldTargetRepository || (scYieldTargetConfig.ready ? new ScYieldTargetRepository(scYieldTargetConfig) : undefined);
  const taYieldTargets = taYieldTargetRepository || (taYieldTargetConfig.ready ? new TaYieldTargetRepository(taYieldTargetConfig) : undefined);
  const comments = cellCommentRepository || (commentConfig.ready ? new CellCommentRepository(commentConfig) : undefined);
  const staging901 = staging901Repository || (staging901Config.enabled && staging901Config.ready ? new Staging901Repository(staging901Config) : undefined);
  const stagingWip = stagingWipRepository || (stagingWipConfig.enabled && stagingWipConfig.ready ? new StagingWipRepository(stagingWipConfig) : undefined);
  const scYieldStaging = scYieldStagingRepository || (scYieldStagingConfig.enabled && scYieldStagingConfig.ready ? new ScYieldStagingRepository(scYieldStagingConfig) : undefined);
  const yieldDefectSettings = yieldDefectSettingRepository || (yieldDefectSettingConfig.ready ? new YieldDefectSettingRepository(yieldDefectSettingConfig) : undefined);
  const taYieldStaging = taYieldStagingRepository || (taYieldStagingConfig.enabled && taYieldStagingConfig.ready ? new TaYieldStagingRepository(taYieldStagingConfig) : undefined);
  const taYieldActions = taYieldActionRepository || (taYieldActionConfig.ready ? new TaYieldActionRepository(taYieldActionConfig) : undefined);
  let taYieldQa = { status: 'NOT_RUN' };
  let taYieldPipeline = { status: 'IDLE', stage: 'Waiting for the next scheduled refresh.', updatedAt: new Date().toISOString(), startedAt: undefined, completedAt: undefined, logs: [] };
  const updateTaYieldPipeline = (status, stage, extra = {}) => {
    const entry = { at: new Date().toISOString(), status, stage };
    taYieldPipeline = { ...taYieldPipeline, ...extra, status, stage, updatedAt: entry.at, logs: [entry, ...taYieldPipeline.logs].slice(0, 20) };
    console.log(`TA Yield staging: ${stage}`);
  };
  const responseCache = cache || new TtlCache({ maxEntries: Math.min(Math.max(Number(environment.DASHBOARD_CACHE_MAX_ENTRIES) || 500, 10), 2000) });
  async function configuredScYieldMapping() { scYieldMapping ||= loadScYieldMapping(scYieldConfig.mappingFile); const [base, overrides] = await Promise.all([scYieldMapping, yieldDefectSettings ? yieldDefectSettings.list() : []]); const byMode = new Map(overrides.filter((item) => item.dataset === 'SC').map((item) => [item.mode.toUpperCase(), item])); return new Map([...base.entries()].map(([key, value]) => { const override = byMode.get(value.mode.toUpperCase()); return [key, override ? { ...value, group: override.group, included: override.included } : value]; })); }
  async function configuredTaYieldMapping() { taYieldMapping ||= loadTaYieldMapping(taYieldConfig.mappingFile); const [base, overrides] = await Promise.all([taYieldMapping, yieldDefectSettings ? yieldDefectSettings.list() : []]); const byMode = new Map(overrides.filter((item) => item.dataset === 'TA').map((item) => [item.mode.toUpperCase(), item])); const configure = (entries) => new Map([...entries].map(([code, value]) => { const override = byMode.get(code.toUpperCase()); return [code, override ? { ...value, main: override.group, included: override.included } : value]; })); return { neo: configure(base.neo), gps: configure(base.gps) }; }
  async function taMachineDefectViews() { taYieldMachineDefectViews ||= loadTaYieldMapping(taYieldConfig.mappingFile).then((mapping) => { const entries = [...mapping.neo.entries(), ...mapping.gps.entries()]; return { codes: [...new Set(entries.map(([code]) => code))].sort(), categories: [...new Set(entries.map(([, entry]) => entry.category).filter(Boolean))].sort() }; }); return taYieldMachineDefectViews; }
  const app = express();
  app.use(express.json({ limit: '8kb' }));
  app.use(express.static(path.join(here, '../public'), { setHeaders: (response) => response.set('Cache-Control', 'no-store') }));
  app.get('/api/health', (_request, response) => response.json({ success: true, data: { status: 'ok', ...(environment.DEPLOY_REVISION ? { revision: environment.DEPLOY_REVISION } : {}) } }));
  app.get('/api/defect-settings', async (_request, response) => {
    try {
      if (!repositories.has('ta-yield')) repositories.set('ta-yield', taYieldRepository || new TaYieldRepository(taYieldConfig));
      if (!repositories.has('yield') && scYieldConfig.ready) repositories.set('yield', scYieldRepository || new ScYieldRepository(scYieldConfig));
      const mesTaModesRequest = responseCache.getOrSet('ta-yield:defect-modes', 3600000, () => repositories.get('ta-yield').getDefectModes()).catch(() => ({ value: [] }));
      const scModeToday = currentThailandMonthFilters(); const scModeFilters = { startDate: `${scModeToday.startDate.slice(0, 4)}-01-01`, endDate: scModeToday.endDate };
      const mesScModesRequest = scYieldConfig.ready ? responseCache.getOrSet('sc-yield:defect-modes', 3600000, () => repositories.get('yield').getDefectModes(scModeFilters)).catch(() => ({ value: [] })) : Promise.resolve({ value: [] });
      const mesTaModesFallback = new Promise((resolve) => { const timer = setTimeout(() => resolve({ value: [] }), 3000); timer.unref?.(); });
      scYieldSourceModes ||= loadScYieldSourceModes(scYieldConfig.mappingFile);
      const [scMappings, workbookScModes, taMappings, overrides, mesTaModes, mesScModes] = await Promise.all([configuredScYieldMapping(), scYieldSourceModes, configuredTaYieldMapping(), yieldDefectSettings ? yieldDefectSettings.list() : [], Promise.race([mesTaModesRequest, mesTaModesFallback]), Promise.race([mesScModesRequest, mesTaModesFallback])]);
      const override = new Map(overrides.map((item) => [`${item.dataset}|${item.mode.toUpperCase()}`, item]));
      const mappedScModes = new Map();
      scMappings.forEach((value, key) => { mappedScModes.set(key.toUpperCase(), value); mappedScModes.set(value.mode.toUpperCase(), value); });
      const allScModes = new Map([...workbookScModes, ...mesScModes.value.map((item) => item.mode)].map((mode) => { const canonical = mappedScModes.get(mode.toUpperCase())?.mode || mode; return [canonical.toUpperCase(), canonical]; }));
      [...new Set(mappedScModes.values())].forEach((value) => { if (!allScModes.has(value.mode.toUpperCase())) allScModes.set(value.mode.toUpperCase(), value.mode); });
      overrides.filter((item) => item.dataset === 'SC').forEach((item) => { if (!allScModes.has(item.mode.toUpperCase())) allScModes.set(item.mode.toUpperCase(), item.mode); });
      const sc = [...allScModes.values()].map((mode) => { const mapped = mappedScModes.get(mode.toUpperCase()); const saved = override.get(`SC|${mode.toUpperCase()}`); return { mode, group: saved?.group || (mapped?.included ? mapped.group : 'Unmapped'), included: saved?.included ?? Boolean(mapped?.included) }; }).sort((a, b) => a.group.localeCompare(b.group) || a.mode.localeCompare(b.mode));
      const mappedTaModes = new Map([...new Map([...taMappings.neo, ...taMappings.gps]).entries()].map(([source, target]) => [source.toUpperCase(), { source, target }]));
      const allTaModes = new Map(mesTaModes.value.map((item) => [item.mode.toUpperCase(), { source: item.mode, description: item.description } ]));
      mappedTaModes.forEach(({ source }, key) => { if (!allTaModes.has(key)) allTaModes.set(key, { source, description: '' }); });
      overrides.filter((item) => item.dataset === 'TA').forEach((item) => { const key = item.mode.toUpperCase(); if (!allTaModes.has(key)) allTaModes.set(key, { source: item.mode, description: '' }); });
      const ta = [...allTaModes.values()]
        .map(({ source, description }) => { const target = mappedTaModes.get(source.toUpperCase())?.target; const saved = override.get(`TA|${source.toUpperCase()}`); return { source, description, target: saved?.group || target?.main || target?.category || 'Unmapped', included: saved?.included ?? Boolean(target?.main || target?.category) }; })
        .sort((a, b) => a.target.localeCompare(b.target) || a.source.localeCompare(b.source));
      response.json({ success: true, data: { sc, ta } });
    } catch (error) { response.status(503).json({ success: false, error: 'Defect mapping settings are unavailable.' }); }
  });
  app.put('/api/defect-settings', async (request, response) => {
    const dataset = request.body?.dataset; const mode = typeof request.body?.mode === 'string' ? request.body.mode.trim() : ''; const group = typeof request.body?.group === 'string' ? request.body.group.trim() : ''; const included = request.body?.included;
    if (!['SC', 'TA'].includes(dataset) || !mode || mode.length > 300 || !group || group.length > 100 || typeof included !== 'boolean') return response.status(400).json({ success: false, error: 'Provide a valid SC or TA mode, group, and included setting.' });
    if (!yieldDefectSettings) return response.status(503).json({ success: false, error: 'ProductionMES defect-settings storage is not configured.' });
    try { await yieldDefectSettings.upsert({ dataset, mode, group, included, updatedBy: environment.COMMENT_DISPLAY_NAME || 'Production Dashboard' }); responseCache.clear(); response.json({ success: true, data: { dataset, mode, group, included } }); } catch { response.status(503).json({ success: false, error: 'Defect setting could not be saved to ProductionMES.' }); }
  });
  app.get('/api/staging-status', async (_request, response) => {
    const intervalMs = Math.max(Number(environment.DASHBOARD_901_STAGING_INTERVAL_MS) || 300000, 60000);
    const wipIntervalMs = Math.max(Number(environment.DASHBOARD_WIP_STAGING_INTERVAL_MS) || 300000, 60000);
    const loadActivity = async (repository, method = 'getActivity', table, missingTableError = 'Staging table is not installed.', timeoutError = 'Staging database is unreachable.') => { try { return await repository[method](table); } catch (error) { const missingTable = error?.number === 208 || /invalid object name/i.test(String(error?.message || '')); const timedOut = error?.code === 'ETIMEOUT' || error?.number === 'ETIMEOUT'; return { unavailable: true, error: missingTable ? missingTableError : timedOut ? timeoutError : 'Staging database is unreachable.' }; } };
    const [completion, wip, scYield, taWorkbook, taMachine, taMonthlySummary] = await Promise.all([staging901 ? loadActivity(staging901) : undefined, stagingWip ? loadActivity(stagingWip) : undefined, scYieldStaging ? loadActivity(scYieldStaging) : undefined, taYieldStaging ? loadActivity(taYieldStaging) : undefined, taYieldStaging ? loadActivity(taYieldStaging, 'getMachineActivity', undefined, 'Normalized Machine staging tables are not installed. Run npm run migrate:ta-yield-machine-rows.', 'Machine staging refresh is still in progress. Check again shortly.') : undefined, taYieldStaging ? loadActivity(taYieldStaging, 'getMonthlySummaryActivity') : undefined]);
    const row = (name, table, source, activity, enabled, interval, extra = {}) => ({ name, table, source, enabled, intervalMs: interval, activityAvailable: Boolean(activity && !activity.unavailable), activityError: activity?.error, rowCount: Number(activity?.rowCount || 0), firstDataDate: activity?.firstDataDate, lastDataDate: activity?.lastDataDate, lastRefreshedAt: activity?.lastRefreshedAt, ...extra });
    const wipProcessActivity = wip?.unavailable ? wip : wip ? { rowCount: wip.processRowCount, lastRefreshedAt: wip.processLastRefreshedAt, firstDataDate: wip.firstDataDate, lastDataDate: wip.lastDataDate } : undefined;
    const status = [row('Completion 901', staging901Config.table, 'MES Closed Batch → staging', completion, Boolean(staging901), intervalMs), row('WIP daily quantity', stagingWipConfig.table, 'MES Lot Complete Log → staging', wip, Boolean(stagingWip), wipIntervalMs), row('WIP process chart', stagingWipConfig.processTable, 'MES Lot Complete Log → staging', wipProcessActivity, Boolean(stagingWip), wipIntervalMs), row('SC Yield', scYieldStagingConfig.table, 'MES normalized SC Yield input/defect rows → staging', scYield, Boolean(scYieldStaging), Math.max(Number(environment.DASHBOARD_SC_YIELD_STAGING_INTERVAL_MS) || 300000, 60000), { plan: 'Monthly input and defect snapshots preserve the direct MES row shape before mapping.' }), row('TA Yield DataTable', taYieldStagingConfig.workbookTable, 'MES workbook reconciliation → staging', taWorkbook, Boolean(taYieldStaging), wipIntervalMs, { plan: 'Workbook rows retain the Excel reference conditions before mapping.' }), row('TA Yield Machine events', taYieldStagingConfig.machineRowTable, 'MES normalized machine events → staging', taMachine, Boolean(taYieldStaging), wipIntervalMs, { plan: 'Anodization, Welding, and EI events joined to normalized TA lot defects.' }), row('TA Yield Monthly summary', taYieldStagingConfig.monthlySummaryTable, 'TA workbook yield aggregates → staging', taMonthlySummary, Boolean(taYieldStaging), wipIntervalMs, { plan: 'Monthly yield and defect aggregates for all parts and individual part numbers.' })];
    response.json({ success: true, data: status, checkedAt: new Date().toISOString(), pipelines: { taYield: taYieldPipeline } });
  });

  function contextFor(request, response) {
    const dataset = request.query.dataset || 'closed';
    if (!Object.hasOwn(configs, dataset) && !['yield', 'ta-yield'].includes(dataset)) {
      response.status(400).json({ success: false, error: 'Unknown data source.' });
      return undefined;
    }
    const config = dataset === 'yield' ? scYieldConfig : dataset === 'ta-yield' ? taYieldConfig : configs[dataset];
    if (!repositories.has(dataset)) repositories.set(dataset, dataset === 'yield' ? (scYieldRepository || new ScYieldRepository(config)) : dataset === 'ta-yield' ? (taYieldRepository || new TaYieldRepository(config)) : (repository || new SqlRepository(config)));
    return { config, database: repositories.get(dataset), dataset };
  }

  function currentThailandMonthFilters() {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).reduce((values, part) => ({ ...values, [part.type]: part.value }), {});
    return { startDate: `${parts.year}-${parts.month}-01`, endDate: `${parts.year}-${parts.month}-${parts.day}` };
  }

  let stagingRefreshInProgress = false;
  app.refresh901Staging = async () => {
    if (!staging901) return { status: 'SKIPPED' };
    if (stagingRefreshInProgress) return { status: 'SKIPPED' };
    stagingRefreshInProgress = true;
    try {
      if (!repositories.has('closed')) repositories.set('closed', repository || new SqlRepository(configs.closed));
      const filters = await stagingIncrementalRefreshFilters(staging901, currentThailandMonthFilters());
      const result = await refresh901Staging({ source: repositories.get('closed'), sourceConfig: configs.closed, target: staging901, targetConfig: staging901Config, ...filters });
      responseCache.invalidate('closed:');
      return { status: 'REFRESHED', ...result };
    } finally { stagingRefreshInProgress = false; }
  };

  let wipStagingRefreshInProgress = false;
  app.refreshWipStaging = async () => {
    if (!stagingWip || wipStagingRefreshInProgress) return { status: 'SKIPPED' };
    wipStagingRefreshInProgress = true;
    try {
      if (!repositories.has('lot')) repositories.set('lot', repository || new SqlRepository(configs.lot));
      const filters = await stagingIncrementalRefreshFilters(stagingWip, currentThailandMonthFilters());
      const result = await refreshWipStaging({ source: repositories.get('lot'), target: stagingWip, targetConfig: stagingWipConfig, ...filters });
      responseCache.invalidate('lot:');
      return { status: 'REFRESHED', ...result };
    } finally { wipStagingRefreshInProgress = false; }
  };
  let scYieldStagingRefreshInProgress = false;
  app.refreshScYieldStaging = async (requestedFilters = currentThailandMonthFilters()) => {
    if (!scYieldStaging || scYieldStagingRefreshInProgress) return { status: 'SKIPPED' };
    scYieldStagingRefreshInProgress = true;
    try {
      if (!repositories.has('yield')) repositories.set('yield', scYieldRepository || new ScYieldRepository(scYieldConfig));
      const source = repositories.get('yield');
      const [monthly, weekly] = await Promise.all([source.getYieldRows(requestedFilters), source.getYieldRows(requestedFilters, 'week')]);
      await Promise.all([scYieldStaging.replaceYieldRows(monthly, requestedFilters, 'month'), scYieldStaging.replaceYieldRows(weekly, requestedFilters, 'week')]);
      responseCache.clear();
      return { status: 'REFRESHED', inputRows: monthly.inputs.length, defectRows: monthly.defects.length, ...requestedFilters };
    } finally { scYieldStagingRefreshInProgress = false; }
  };
  app.refreshScYieldStagingHistory = async () => {
    const today = currentThailandMonthFilters(); const historyStart = environment.DASHBOARD_SC_YIELD_STAGING_HISTORY_START || `${today.startDate.slice(0, 4)}-01-01`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(historyStart) || historyStart > today.endDate) throw new Error('SC Yield staging history start date is invalid.');
    const results = [];
    for (let cursor = new Date(`${historyStart.slice(0, 7)}-01T00:00:00Z`); cursor <= new Date(`${today.startDate}T00:00:00Z`); cursor.setUTCMonth(cursor.getUTCMonth() + 1)) { const startDate = cursor.toISOString().slice(0, 10); const next = new Date(cursor); next.setUTCMonth(next.getUTCMonth() + 1); next.setUTCDate(0); const endDate = startDate.slice(0, 7) === today.startDate.slice(0, 7) ? today.endDate : next.toISOString().slice(0, 10); results.push(await app.refreshScYieldStaging({ startDate, endDate })); }
    return { status: 'REFRESHED', months: results.length, inputRows: results.reduce((sum, result) => sum + Number(result.inputRows || 0), 0), defectRows: results.reduce((sum, result) => sum + Number(result.defectRows || 0), 0), startDate: historyStart, endDate: today.endDate };
  };
  let taYieldStagingRefreshInProgress = false;
  app.refreshTaYieldStaging = async (requestedFilters) => {
    if (!taYieldStaging) { updateTaYieldPipeline('DISABLED', 'TA Yield staging is not configured.'); return { status: 'SKIPPED' }; }
    if (taYieldStagingRefreshInProgress) return { status: 'SKIPPED' };
    const fullFilters = currentThailandMonthFilters();
    if (!requestedFilters) {
      let snapshot;
      try {
        snapshot = await taYieldStaging.getLatestWorkbookSnapshotForMonth(fullFilters);
      } catch (error) {
        const missingTable = error?.number === 208 || /invalid object name/i.test(String(error?.message || ''));
        if (!missingTable) throw error;
      }
      const plan = taYieldRefreshPlan(fullFilters, snapshot);
      if (plan.mode === 'REFRESH_CURRENT') return app.refreshTaYieldStagingResume({ refreshCurrent: true });
      if (plan.mode === 'RESUME') return app.refreshTaYieldStagingResume();
    }
    taYieldStagingRefreshInProgress = true;
    try {
    if (!repositories.has('ta-yield')) repositories.set('ta-yield', taYieldRepository || new TaYieldRepository(taYieldConfig));
    const filters = requestedFilters || fullFilters;
    const scope = `${filters.startDate} to ${filters.endDate}`;
    updateTaYieldPipeline('RUNNING', `Loading workbook rows for ${scope}.`, { startedAt: new Date().toISOString(), completedAt: undefined });
    taWorkbookReconciliationMapping ||= loadTaWorkbookReconciliationMapping('TA/Yield_Data_Aug2026.xlsx');
    const source = repositories.get('ta-yield');
    const mapping = await taWorkbookReconciliationMapping;
    const workbookRows = await source.getWorkbookReconciliationRows(filters, { descriptions: workbookDescriptions(mapping) });
    const workbookLots = mapTaWorkbookReconciliationRows(workbookRows, mapping);
    const partNumbers = [...new Set(workbookLots.map((row) => row.itemName).filter(Boolean))]; const monthlySummary = [{ partNumber: 'All', rows: workbookLots }, ...partNumbers.map((partNumber) => ({ partNumber, rows: workbookLots.filter((row) => row.itemName === partNumber) }))].flatMap((scope) => mapTaWorkbookYieldRows(scope.rows, mapping).flatMap((row) => row.groups.map((group) => ({ month: row.month, line: row.line, partNumber: scope.partNumber, group: group.group, input: row.input, finalGood: row.finalGood, defect: group.quantity }))));
    updateTaYieldPipeline('RUNNING', `Writing ${monthlySummary.length} monthly summary rows for ${scope}.`);
    await taYieldStaging.replaceMonthlySummary(monthlySummary, filters);
    updateTaYieldPipeline('RUNNING', `Loading machine events for ${scope}.`);
    const machineEvents = (await Promise.all(['%Anodization%', '%Welding%', '%EI%'].map((processPattern) => source.getMachineEvents(filters, { lotNumbers: workbookLots.map((lot) => lot.lotNo), processPattern })))).flat();
    updateTaYieldPipeline('RUNNING', `Writing ${machineEvents.length} machine events for ${scope}.`);
    await taYieldStaging.replaceMachineRows(machineEvents, workbookLots, filters);
    updateTaYieldPipeline('RUNNING', `Publishing ${workbookLots.length} workbook rows for ${scope}.`);
    await taYieldStaging.replaceWorkbookRows(workbookLots, filters);
    responseCache.clear();
    updateTaYieldPipeline('SUCCEEDED', `Refresh completed for ${scope}.`, { completedAt: new Date().toISOString() });
    return { status: 'REFRESHED', workbookRows: workbookRows.length, workbookLots: workbookLots.length, ...filters };
    } catch (error) { console.error('TA Yield staging refresh failed:', error.message); updateTaYieldPipeline('FAILED', 'Refresh failed. Check the server log for details.', { completedAt: new Date().toISOString() }); throw error; } finally { taYieldStagingRefreshInProgress = false; }
  };
  app.refreshTaYieldStagingResume = async ({ timeoutMs, refreshCurrent = false } = {}) => {
    if (!taYieldStaging) return { status: 'SKIPPED' };
    if (taYieldStagingRefreshInProgress) return { status: 'SKIPPED' };
    taYieldStagingRefreshInProgress = true;
    try {
      const fullFilters = currentThailandMonthFilters();
      const snapshot = await taYieldStaging.getLatestWorkbookSnapshotForMonth(fullFilters);
      if (!snapshot || snapshot.scopeStart !== fullFilters.startDate) throw new Error('TA Yield resume requires a current-month workbook snapshot that starts on the first day of the month.');
      if (snapshot.scopeEnd >= fullFilters.endDate && !refreshCurrent) return { status: 'ALREADY_CURRENT', ...fullFilters };
      const cursor = new Date(`${snapshot.scopeEnd}T00:00:00Z`); cursor.setUTCDate(cursor.getUTCDate() + 1);
      const resumeFilters = refreshCurrent ? { ...fullFilters, startDate: fullFilters.endDate } : { ...fullFilters, startDate: cursor.toISOString().slice(0, 10) };
      if (resumeFilters.startDate > fullFilters.endDate) return { status: 'ALREADY_CURRENT', ...fullFilters };
      const requestTimeout = Math.min(Math.max(Number(timeoutMs) || 600000, 120000), 900000);
      const scope = `${resumeFilters.startDate} to ${resumeFilters.endDate}`;
      updateTaYieldPipeline('RUNNING', `Resume range resolved: ${scope}.`, { startedAt: new Date().toISOString(), completedAt: undefined });
      taWorkbookReconciliationMapping ||= loadTaWorkbookReconciliationMapping('TA/Yield_Data_Aug2026.xlsx');
      const mapping = await taWorkbookReconciliationMapping;
      const source = taYieldRepository instanceof TaYieldRepository
        ? new TaYieldRepository({ ...taYieldRepository.config, requestTimeout })
        : taYieldRepository || new TaYieldRepository({ ...taYieldConfig, requestTimeout });
      updateTaYieldPipeline('RUNNING', `Loading workbook rows for ${scope}.`);
      const freshRows = await source.getWorkbookReconciliationRows(resumeFilters, { descriptions: workbookDescriptions(mapping), timeoutMs: requestTimeout, actionLookbackMonths: 0 });
      const freshLots = mapTaWorkbookReconciliationRows(freshRows, mapping);
      const lotDate = (lot) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(lot.tapingDate));
      const resumeLotKey = (lot) => `${lot.line}|${lot.lotNo}|${lot.itemName}|${lotDate(lot)}`;
      const previousCurrentLots = refreshCurrent ? snapshot.rows.filter((lot) => lotDate(lot) === fullFilters.endDate) : [];
      const mergedLots = mergeTaWorkbookLots(snapshot.rows, freshLots, { replaceDate: refreshCurrent ? fullFilters.endDate : undefined, dateForLot: lotDate, keyForLot: resumeLotKey });
      const partNumbers = [...new Set(mergedLots.map((row) => row.itemName).filter(Boolean))]; const monthlySummary = [{ partNumber: 'All', rows: mergedLots }, ...partNumbers.map((partNumber) => ({ partNumber, rows: mergedLots.filter((row) => row.itemName === partNumber) }))].flatMap((scope) => mapTaWorkbookYieldRows(scope.rows, mapping).flatMap((row) => row.groups.map((group) => ({ month: row.month, line: row.line, partNumber: scope.partNumber, group: group.group, input: row.input, finalGood: row.finalGood, defect: group.quantity }))));
      updateTaYieldPipeline('RUNNING', `Writing ${monthlySummary.length} merged monthly summary rows.`);
      await taYieldStaging.replaceMonthlySummary(monthlySummary, fullFilters);
      updateTaYieldPipeline('RUNNING', `Loading machine events for ${freshLots.length} resumed lots.`);
      const machineEvents = (await Promise.all(['%Anodization%', '%Welding%', '%EI%'].map((processPattern) => source.getMachineEvents(fullFilters, { lotNumbers: freshLots.map((lot) => lot.lotNo), processPattern, timeoutMs: requestTimeout })))).flat();
      await taYieldStaging.replaceMachineRowsForLots(machineEvents, freshLots, fullFilters, { lotNumbersToRemove: previousCurrentLots.map((lot) => lot.lotNo) });
      updateTaYieldPipeline('RUNNING', `Publishing ${mergedLots.length} merged workbook rows for ${fullFilters.startDate} to ${fullFilters.endDate}.`);
      await taYieldStaging.replaceWorkbookRows(mergedLots, fullFilters);
      responseCache.clear(); updateTaYieldPipeline('SUCCEEDED', `Resume completed for ${scope}.`, { completedAt: new Date().toISOString() });
      return { status: 'RESUMED', workbookRows: freshRows.length, workbookLots: freshLots.length, ...resumeFilters };
    } catch (error) { console.error('TA Yield staging resume failed:', error.message); updateTaYieldPipeline('FAILED', 'Resume failed. Check the server log for details.', { completedAt: new Date().toISOString() }); throw error; } finally { taYieldStagingRefreshInProgress = false; }
  };
  app.refreshTaYieldStagingDay = async ({ date, timeoutMs } = {}) => {
    if (!taYieldStaging) return { status: 'SKIPPED' };
    if (!validDate(date)) throw new Error('TA Yield historical repair requires a valid date.');
    if (taYieldStagingRefreshInProgress) return { status: 'SKIPPED' };
    taYieldStagingRefreshInProgress = true;
    try {
      const monthStart = `${date.slice(0, 7)}-01`;
      const monthEnd = new Date(`${monthStart}T00:00:00Z`); monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1, 0);
      const monthFilters = { startDate: monthStart, endDate: monthEnd.toISOString().slice(0, 10) };
      const repairFilters = { startDate: date, endDate: date };
      const snapshot = await taYieldStaging.getLatestWorkbookSnapshotForMonth(monthFilters);
      const previousDate = new Date(`${repairFilters.startDate}T00:00:00Z`); previousDate.setUTCDate(previousDate.getUTCDate() - 1);
      if (!snapshot || snapshot.scopeStart !== monthFilters.startDate || snapshot.scopeEnd < previousDate.toISOString().slice(0, 10)) throw new Error('TA Yield historical repair requires staging coverage through the preceding day.');
      const publishFilters = { startDate: monthFilters.startDate, endDate: snapshot.scopeEnd > repairFilters.endDate ? snapshot.scopeEnd : repairFilters.endDate };
      const requestTimeout = Math.min(Math.max(Number(timeoutMs) || 600000, 120000), 900000);
      const scope = `${repairFilters.startDate} to ${repairFilters.endDate}`;
      updateTaYieldPipeline('RUNNING', `Repairing workbook rows for ${scope}.`, { startedAt: new Date().toISOString(), completedAt: undefined });
      taWorkbookReconciliationMapping ||= loadTaWorkbookReconciliationMapping('TA/Yield_Data_Aug2026.xlsx');
      const mapping = await taWorkbookReconciliationMapping;
      const source = taYieldRepository instanceof TaYieldRepository
        ? new TaYieldRepository({ ...taYieldRepository.config, requestTimeout })
        : taYieldRepository || new TaYieldRepository({ ...taYieldConfig, requestTimeout });
      const freshRows = await source.getWorkbookReconciliationRows(repairFilters, { descriptions: workbookDescriptions(mapping), timeoutMs: requestTimeout });
      const freshLots = mapTaWorkbookReconciliationRows(freshRows, mapping);
      const lotDate = (lot) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(lot.tapingDate));
      const repairLotKey = (lot) => `${lot.line}|${lot.lotNo}|${lot.itemName}|${lotDate(lot)}`;
      const previousDayLots = snapshot.rows.filter((lot) => lotDate(lot) === repairFilters.startDate);
      const mergedLots = mergeTaWorkbookLots(snapshot.rows, freshLots, { replaceDate: repairFilters.startDate, dateForLot: lotDate, keyForLot: repairLotKey });
      const partNumbers = [...new Set(mergedLots.map((row) => row.itemName).filter(Boolean))]; const monthlySummary = [{ partNumber: 'All', rows: mergedLots }, ...partNumbers.map((partNumber) => ({ partNumber, rows: mergedLots.filter((row) => row.itemName === partNumber) }))].flatMap((scope) => mapTaWorkbookYieldRows(scope.rows, mapping).flatMap((row) => row.groups.map((group) => ({ month: row.month, line: row.line, partNumber: scope.partNumber, group: group.group, input: row.input, finalGood: row.finalGood, defect: group.quantity }))));
      updateTaYieldPipeline('RUNNING', `Writing ${monthlySummary.length} merged monthly summary rows.`);
      await taYieldStaging.replaceMonthlySummary(monthlySummary, monthFilters);
      updateTaYieldPipeline('RUNNING', `Loading machine events for ${freshLots.length} repaired lots.`);
      const machineEvents = (await Promise.all(['%Anodization%', '%Welding%', '%EI%'].map((processPattern) => source.getMachineEvents(monthFilters, { lotNumbers: freshLots.map((lot) => lot.lotNo), processPattern, timeoutMs: requestTimeout })))).flat();
      await taYieldStaging.replaceMachineRowsForLots(machineEvents, freshLots, monthFilters, { lotNumbersToRemove: previousDayLots.map((lot) => lot.lotNo) });
      updateTaYieldPipeline('RUNNING', `Publishing ${mergedLots.length} merged workbook rows for ${publishFilters.startDate} to ${publishFilters.endDate}.`);
      await taYieldStaging.replaceWorkbookRows(mergedLots, publishFilters);
      responseCache.clear(); updateTaYieldPipeline('SUCCEEDED', `Historical repair completed for ${scope}.`, { completedAt: new Date().toISOString() });
      return { status: 'REPAIRED', workbookRows: freshRows.length, workbookLots: freshLots.length, ...repairFilters };
    } catch (error) { console.error('TA Yield staging historical repair failed:', error.message); updateTaYieldPipeline('FAILED', 'Historical repair failed. Check the server log for details.', { completedAt: new Date().toISOString() }); throw error; } finally { taYieldStagingRefreshInProgress = false; }
  };
  app.refreshTaYieldStagingHistory = async () => {
    const today = currentThailandMonthFilters(); const historyStart = environment.DASHBOARD_TA_YIELD_STAGING_HISTORY_START || `${today.startDate.slice(0, 4)}-01-01`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(historyStart) || historyStart > today.endDate) throw new Error('TA Yield staging history start date is invalid.');
    const results = [];
    for (let cursor = new Date(`${historyStart.slice(0, 7)}-01T00:00:00Z`); cursor <= new Date(`${today.startDate}T00:00:00Z`); cursor.setUTCMonth(cursor.getUTCMonth() + 1)) {
      const startDate = cursor.toISOString().slice(0, 10); const next = new Date(cursor); next.setUTCMonth(next.getUTCMonth() + 1); next.setUTCDate(0);
      const endDate = startDate.slice(0, 7) === today.startDate.slice(0, 7) ? today.endDate : next.toISOString().slice(0, 10);
      results.push(await app.refreshTaYieldStaging({ startDate, endDate }));
    }
    return { status: 'REFRESHED', months: results.length, workbookRows: results.reduce((sum, result) => sum + Number(result.workbookRows || 0), 0), startDate: historyStart, endDate: today.endDate };
  };
  app.runTaYieldStagingQa = async () => { if (!taYieldStaging) return { status: 'SKIPPED' }; if (taYieldQa.status === 'RUNNING') return taYieldQa; const filters = currentThailandMonthFilters(); taYieldQa = { status: 'RUNNING', filters, startedAt: new Date().toISOString() }; try { if (!repositories.has('ta-yield')) repositories.set('ta-yield', taYieldRepository || new TaYieldRepository(taYieldConfig)); const direct = await repositories.get('ta-yield').getYieldRows(filters); const staged = await taYieldStaging.getYieldRows(filters); const totals = (rows) => ['inputQ', 'finalGoodQ', 'quantity'].reduce((result, key) => ({ ...result, [key]: rows.reduce((sum, row) => sum + Number(row[key] || 0), 0) }), { rows: rows.length }); const directTotals = totals(direct); const stagedTotals = totals(staged); const passed = Object.keys(directTotals).every((key) => directTotals[key] === stagedTotals[key]); taYieldQa = { status: passed ? 'PASSED' : 'FAILED', filters, direct: directTotals, staged: stagedTotals, completedAt: new Date().toISOString() }; return taYieldQa; } catch (error) { taYieldQa = { status: 'FAILED', filters, error: 'TA staging QA could not complete.', completedAt: new Date().toISOString() }; return taYieldQa; } };
  app.get('/api/staging/ta-yield-qa', (_request, response) => response.json({ success: true, data: taYieldQa }));

  let cacheWarmInProgress = false;
  app.warmCurrentMonthCaches = async () => {
    if (cacheWarmInProgress) return { status: 'SKIPPED' };
    cacheWarmInProgress = true;
    try {
      const filters = currentThailandMonthFilters();
      const warmQuantity = async (dataset, product) => {
        const config = configs[dataset];
        if (!config?.ready) return;
        if (!repositories.has(dataset)) repositories.set(dataset, repository || new SqlRepository(config));
        const scopedFilters = { ...filters, ...(product ? { product } : {}) };
        await responseCache.getOrSet(`${dataset}:quantity:${JSON.stringify(scopedFilters)}`, 300000, () => repositories.get(dataset).getQuantity(scopedFilters), 30000);
      };
      await warmQuantity('closed', 'NEO');
      await warmQuantity('closed', 'SC');
      await warmQuantity('lot', 'NEO');
      await warmQuantity('lot', 'SC');
      if (scYieldConfig.ready) {
        if (!repositories.has('yield')) repositories.set('yield', scYieldRepository || new ScYieldRepository(scYieldConfig));
        scYieldMapping ||= loadScYieldMapping(scYieldConfig.mappingFile);
        await responseCache.getOrSet(`yield:summary:${JSON.stringify(filters)}`, 300000, async () => mapScYieldRows(await repositories.get('yield').getYieldRows(filters), await configuredScYieldMapping()), 30000);
        await responseCache.getOrSet(`yield:weekly:${JSON.stringify(filters)}`, 300000, async () => mapScYieldRows(await repositories.get('yield').getYieldRows(filters, 'week'), await configuredScYieldMapping()), 30000);
      }
      if (taYieldConfig.ready) {
        if (!repositories.has('ta-yield')) repositories.set('ta-yield', taYieldRepository || new TaYieldRepository(taYieldConfig));
        await responseCache.getOrSet(`ta-yield:rows:${JSON.stringify(filters)}`, 300000, () => repositories.get('ta-yield').getYieldRows(filters), 30000);
      }
      return { status: 'WARMED', filters };
    } finally {
      cacheWarmInProgress = false;
    }
  };

  function databaseFor(config) {
    return [...repositories.values()].find((database) => database.config === config || database === repository);
  }

  function dashboardDatabase(context, filters = {}) {
    if (context.dataset === 'closed' && staging901) return staging901;
    if (context.dataset === 'lot' && stagingWip && !filters.process && !filters.pn && !filters.case) return stagingWip;
    return context.database;
  }

  async function scYieldRows(context, filters, bucket = 'month') {
    if (!scYieldStaging) return context.database.getYieldRows(filters, bucket);
    try { return await scYieldStaging.getYieldRows(filters, bucket); } catch { return context.database.getYieldRows(filters, bucket); }
  }

  app.get('/api/config', (request, response) => {
    const context = contextFor(request, response);
    if (!context) return undefined;
    const config = context.dataset === 'yield' ? publicScYieldConfig(context.config) : context.dataset === 'ta-yield' ? publicTaYieldConfig(context.config) : publicConfig(context.config);
    return response.json({ success: true, data: { ...config, dataset: context.dataset, datasets: [{ id: 'closed', label: '901 (Closed Batch)' }, { id: 'lot', label: 'WIP (Lot Complete Log)' }, { id: 'yield', label: 'SC Yield (Complete Action)' }, { id: 'ta-yield', label: 'TA Yield' }], dataModels: { closed: publicDataModel(configs.closed), lot: publicDataModel(configs.lot) }, mtdTargetStorage: { enabled: Boolean(targets) }, scYieldTargetStorage: { enabled: Boolean(scYieldTargets) }, taYieldTargetStorage: { enabled: Boolean(taYieldTargets) }, commentStorage: { enabled: Boolean(comments) } } });
  });

  async function useTargetStorage(action, response) {
    if (!targets) return response.status(503).json({ success: false, error: 'Shared MTD target storage has not been configured.' });
    try {
      return response.json({ success: true, data: await action() });
    } catch (error) {
      console.error('MTD target storage request failed:', error.message);
      return response.status(503).json({ success: false, error: 'Shared MTD target storage is currently unavailable.' });
    }
  }

  app.get('/api/mtd-targets', (_request, response) => useTargetStorage(() => targets.list(), response));
  app.put('/api/mtd-targets', (request, response) => {
    const target = validTarget(request.body);
    if (!target) return response.status(400).json({ success: false, error: 'Provide a valid Product, Serie, period, monthly plan, and working day.' });
    return useTargetStorage(async () => { await targets.upsert(target); return target; }, response);
  });
  app.delete('/api/mtd-targets', (request, response) => {
    const target = validTarget({ ...request.query, monthlyPlan: 1, workingDay: 1 });
    if (!target) return response.status(400).json({ success: false, error: 'Provide a valid Product, Serie, and period.' });
    return useTargetStorage(async () => { await targets.remove(target); return { removed: true }; }, response);
  });
  async function useScYieldTargetStorage(action, response) { if (!scYieldTargets) return response.status(503).json({ success: false, error: 'Shared SC Yield target storage has not been configured.' }); try { return response.json({ success: true, data: await action() }); } catch (error) { console.error('SC Yield target storage request failed:', error.message); return response.status(503).json({ success: false, error: 'Shared SC Yield target storage is currently unavailable.' }); } }
  app.get('/api/sc-yield-targets', (_request, response) => useScYieldTargetStorage(() => scYieldTargets.list(), response));
  app.put('/api/sc-yield-targets', (request, response) => { const target = validScYieldTarget(request.body); if (!target) return response.status(400).json({ success: false, error: 'Provide a valid series, month, and target percentage from 0 to 100.' }); return useScYieldTargetStorage(async () => { await scYieldTargets.upsert(target); return target; }, response); });
  app.delete('/api/sc-yield-targets', (request, response) => { const target = validScYieldTarget({ ...request.query, target: 0 }); if (!target) return response.status(400).json({ success: false, error: 'Provide a valid series and month.' }); return useScYieldTargetStorage(async () => { await scYieldTargets.remove(target); return { removed: true }; }, response); });
  async function useTaYieldTargetStorage(action, response) { if (!taYieldTargets) return response.status(503).json({ success: false, error: 'TA Yield target storage has not been configured.' }); try { return response.json({ success: true, data: await action() }); } catch (error) { console.error('TA Yield target storage request failed:', error.message); return response.status(503).json({ success: false, error: 'TA Yield target storage is currently unavailable.' }); } }
  app.get('/api/ta-yield-targets', (_request, response) => useTaYieldTargetStorage(() => taYieldTargets.list(), response));
  app.put('/api/ta-yield-targets', (request, response) => { const target = validScYieldTarget(request.body); if (!target) return response.status(400).json({ success: false, error: 'Provide a valid series, month, and target percentage from 0 to 100.' }); return useTaYieldTargetStorage(async () => { await taYieldTargets.upsert(target); return target; }, response); });
  app.delete('/api/ta-yield-targets', (request, response) => { const target = validScYieldTarget({ ...request.query, target: 0 }); if (!target) return response.status(400).json({ success: false, error: 'Provide a valid series and month.' }); return useTaYieldTargetStorage(async () => { await taYieldTargets.remove(target); return { removed: true }; }, response); });

  async function useCommentStorage(action, response) { if (!comments) return response.status(503).json({ success: false, error: 'Cell comment storage has not been configured.' }); try { return response.json({ success: true, data: await action() }); } catch (error) { console.error('Cell comment storage request failed:', error.message); return response.status(503).json({ success: false, error: 'Cell comment storage is currently unavailable.' }); } }
  app.get('/api/comments', (request, response) => {
    const { product, startDate, endDate } = request.query; const pn = typeof request.query.pn === 'string' ? request.query.pn.trim() : ''; const process = typeof request.query.process === 'string' ? request.query.process.trim() : '';
    if (!['NEO', 'SC'].includes(product) || pn.length > 100 || process.length > 100 || !validDate(startDate) || !validDate(endDate) || startDate > endDate) return response.status(400).json({ success: false, error: 'Provide a valid comment filter scope and date range.' });
    return useCommentStorage(() => comments.list({ product, pn, process, startDate, endDate }), response);
  });
  app.get('/api/comments/all', (_request, response) => useCommentStorage(() => comments.listAll(500), response));
  app.post('/api/comments', (request, response) => { const comment = validCommentScope(request.body, true); if (!comment) return response.status(400).json({ success: false, error: 'Provide a valid cell comment.' }); return useCommentStorage(() => comments.create(comment), response); });
  app.patch('/api/comments/:id', (request, response) => { const id = Number(request.params.id); const commentText = typeof request.body?.commentText === 'string' ? request.body.commentText.trim() : ''; if (!Number.isInteger(id) || id < 1 || !commentText || commentText.length > 1000) return response.status(400).json({ success: false, error: 'Provide a valid comment update.' }); return useCommentStorage(() => comments.update(id, commentText), response); });
  app.delete('/api/comments/:id', (request, response) => { const id = Number(request.params.id); if (!Number.isInteger(id) || id < 1) return response.status(400).json({ success: false, error: 'Provide a valid comment id.' }); return useCommentStorage(async () => { await comments.remove(id); return { removed: true }; }, response); });

  async function useDatabase(action, response, config, allowMetadata = false, cacheEntry, source) {
    if (!config.ready && !allowMetadata) return response.status(503).json({ success: false, error: 'Database configuration is incomplete. Check the server environment.' });
    const load = async () => cacheEntry ? responseCache.getOrSet(cacheEntry.key, cacheEntry.ttlMs, action) : { value: await action(), status: 'BYPASS' };
    try {
      const result = await load();
      response.set('X-Dashboard-Cache', result.status);
      if (cacheEntry) response.set('Cache-Control', `private, max-age=${Math.floor(cacheEntry.ttlMs / 1000)}`);
      return response.json({ success: true, data: result.value });
    } catch (error) {
      console.error('Database request failed:', error.message);
      if (isConnectionError(error)) {
        const database = databaseFor(config);
        if (database?.resetConnection) {
          try {
            await database.resetConnection();
            const result = await load();
            response.set('X-Dashboard-Cache', result.status);
            if (cacheEntry) response.set('Cache-Control', `private, max-age=${Math.floor(cacheEntry.ttlMs / 1000)}`);
            return response.json({ success: true, data: result.value });
          } catch (retryError) {
            console.error('Database retry failed:', retryError.message);
            error = retryError;
          }
        }
      }
      if (isAuthenticationError(error)) {
        return response.status(401).json({ success: false, code: 'AUTH_REQUIRED', error: 'Microsoft Entra sign-in is required to refresh database access.' });
      }
      if (isConnectionError(error)) {
        return response.status(503).json({ success: false, code: 'DATABASE_UNREACHABLE', error: 'Azure SQL is temporarily unreachable. Check network or VPN access and try again.' });
      }
      if (source === 'ta-yield' && error?.code === 'EREQUEST') {
        return response.status(503).json({ success: false, code: 'TA_YIELD_DATA_UNAVAILABLE', error: 'TA Yield data is currently unavailable. Check TA Yield SQL object access and try again.' });
      }
      return response.status(503).json({ success: false, error: 'Database data is currently unavailable. Verify configuration and Microsoft Entra access.' });
    }
  }

  async function sharedTaYieldRows(context, filters) {
    const source = taYieldStaging && filters.startDate === currentThailandMonthFilters().startDate ? taYieldStaging : context.database; const cached = await responseCache.getOrSet(`ta-yield:rows:${JSON.stringify(filters)}`, 300000, () => source.getYieldRows(filters));
    return cached.value;
  }
  async function sharedTaWorkbookYieldRows(context, filters) {
    taWorkbookReconciliationMapping ||= loadTaWorkbookReconciliationMapping('TA/Yield_Data_Aug2026.xlsx');
    const loadRows = async () => {
      if (!taYieldStaging) return context.database.getWorkbookReconciliationRows(filters, { descriptions: workbookDescriptions(await taWorkbookReconciliationMapping) });
      try { return await taYieldStaging.getWorkbookRows(filters); } catch { /* Fall through to direct TA SQL only when no staged snapshot is available. */ }
      return context.database.getWorkbookReconciliationRows(filters, { descriptions: workbookDescriptions(await taWorkbookReconciliationMapping) });
    };
    const cached = await responseCache.getOrSet(`ta-yield:workbook-dashboard:${JSON.stringify(filters)}`, 300000, loadRows);
    const selectedSeries = filters.serie ? (Array.isArray(filters.serie) ? filters.serie : [filters.serie]) : [];
    const selectedPartNumbers = filters.pn ? (Array.isArray(filters.pn) ? filters.pn : [filters.pn]) : [];
    const rows = cached.value.filter((row) => (!selectedSeries.length || selectedSeries.includes(row.line)) && (!selectedPartNumbers.length || selectedPartNumbers.includes(row.itemName)));
    return { rows, mapping: await taWorkbookReconciliationMapping };
  }
  async function sharedTaMachineSnapshotLots(context, filters) {
    const cached = await responseCache.getOrSet(`ta-yield:machine-lots:${JSON.stringify(filters)}`, 300000, async () => {
      const { rows, mapping } = await sharedTaWorkbookYieldRows(context, filters);
      return mapTaWorkbookReconciliationRows(rows, mapping).map((lot) => ({ lotNo: lot.lotNo, modes: Object.entries(lot.categories || {}).filter(([category, quantity]) => !['Input', 'Input-', 'Good'].includes(category) && Number(quantity)).map(([category, quantity]) => ({ mode: category, category, quantity: Number(quantity) })) }));
    });
    return cached.value;
  }
  async function sharedTaMachineAnalysis(context, filters, options) {
    if (taYieldStaging && typeof taYieldStaging.getMachineLots === 'function') {
      try {
        const cached = await responseCache.getOrSet(`ta-yield:machine-lots:normalized:${JSON.stringify(filters)}`, 300000, () => taYieldStaging.getMachineLots(filters));
        return { lots: cached.value, events: await taYieldStaging.getMachineEvents(filters, options) };
      } catch (error) {
        if (typeof taYieldStaging.getMachineEventsSnapshot !== 'function') throw error;
      }
    }
    const lots = await sharedTaMachineSnapshotLots(context, filters);
    const source = taYieldStaging?.getMachineEventsSnapshot ? taYieldStaging : context.database;
    return { lots, events: await (source.getMachineEventsSnapshot || source.getMachineEvents).call(source, filters, { ...options, lotNumbers: lots.map((lot) => lot.lotNo) }) };
  }
  const taYieldDashboardCacheKey = (filters, period) => `ta-yield:dashboard:${period}:${JSON.stringify(filters)}`;
  async function sharedTaYieldDashboardResult(context, filters, period = 'month') {
    const cached = await responseCache.getOrSet(taYieldDashboardCacheKey(filters, period), 300000, async () => {
      const stagingReady = taYieldStaging && (typeof taYieldStaging.hasWorkbookCoverage !== 'function' || await taYieldStaging.hasWorkbookCoverage(filters).catch(() => false));
      if (stagingReady && period === 'month' && typeof taYieldStaging.getMonthlySummary === 'function' && isCompleteCalendarMonthRange(filters) && !filters.pn && !filters.serie) {
        const [summary, partNumbers] = await Promise.all([taYieldStaging.getMonthlySummary(filters).catch(() => []), taYieldStaging.getMonthlyPartNumbers(filters).catch(() => [])]);
        if (summary.length) { const grouped = new Map(); summary.forEach((row) => { const key = `${row.month}|${row.line}`; const current = grouped.get(key) || { month: row.month, line: row.line, input: row.input, finalGood: row.finalGood, groups: [], partNumbers }; current.groups.push({ group: row.group, quantity: row.defect }); grouped.set(key, current); }); return [...grouped.values()].map((row) => ({ ...row, defect: row.groups.reduce((sum, group) => sum + group.quantity, 0), yield: row.input ? row.finalGood / row.input * 100 : undefined })); }
      }
      const { rows, mapping } = await sharedTaWorkbookYieldRows(context, filters);
      return mapTaWorkbookYieldRows(rows, mapping, period);
    });
    return cached.value;
  }
  app.warmTaYieldDashboard = async () => {
    if (!taYieldStaging) return { status: 'SKIPPED' };
    const today = currentThailandMonthFilters();
    const cacheMonths = Math.max(1, Number(environment.DASHBOARD_TA_YIELD_CACHE_MONTHS) || 6); const cursor = new Date(`${today.startDate}T00:00:00Z`); cursor.setUTCMonth(cursor.getUTCMonth() - (cacheMonths - 1)); const historyStart = cursor.toISOString().slice(0, 10);
    const filters = { startDate: historyStart, endDate: today.endDate, product: 'NEO' };
    if (!await taYieldStaging.hasWorkbookCoverage(filters)) return { status: 'WAITING_FOR_STAGING', filters };
    const context = { database: repositories.get('ta-yield') || taYieldRepository || new TaYieldRepository(taYieldConfig) };
    await Promise.all(['month', 'week'].map((period) => sharedTaYieldDashboardResult(context, filters, period)));
    return { status: 'WARMED', filters };
  };

  app.get('/api/columns', (request, response) => {
    const context = contextFor(request, response); if (!context) return undefined;
    if (!context.config.metadataReady) return response.status(503).json({ success: false, error: 'Database connection configuration is incomplete. Check the server environment.' });
    return useDatabase(() => context.database.getColumns(), response, context.config, true, { key: `${context.dataset}:columns`, ttlMs: 600000 });
  });
  app.get('/api/objects', (request, response) => {
    const search = request.query.search;
    if (typeof search !== 'string' || !/^[A-Za-z0-9 _-]{2,80}$/.test(search)) {
      return response.status(400).json({ success: false, error: 'Provide a valid object name search.' });
    }
    const context = contextFor(request, response); if (!context) return undefined;
    if (!context.config.metadataReady) return response.status(503).json({ success: false, error: 'Database connection configuration is incomplete. Check the server environment.' });
    return useDatabase(() => context.database.findObjects(search), response, context.config, true, { key: `${context.dataset}:objects:${search}`, ttlMs: 600000 });
  });
  app.get('/api/column-search', (request, response) => {
    const search = request.query.search;
    if (typeof search !== 'string' || !/^[A-Za-z0-9 _-]{2,80}$/.test(search)) {
      return response.status(400).json({ success: false, error: 'Provide a valid column name search.' });
    }
    const context = contextFor(request, response); if (!context) return undefined;
    if (!context.config.metadataReady) return response.status(503).json({ success: false, error: 'Database connection configuration is incomplete. Check the server environment.' });
    return useDatabase(() => context.database.findColumns(search), response, context.config, true, { key: `${context.dataset}:column-search:${search}`, ttlMs: 600000 });
  });
  app.get('/api/object-columns', (request, response) => {
    const objectName = request.query.name;
    if (typeof objectName !== 'string' || !/^[A-Za-z0-9 _-]{2,128}$/.test(objectName)) {
      return response.status(400).json({ success: false, error: 'Provide a valid object name.' });
    }
    const context = contextFor(request, response); if (!context) return undefined;
    if (!context.config.metadataReady) return response.status(503).json({ success: false, error: 'Database connection configuration is incomplete. Check the server environment.' });
    return useDatabase(() => context.database.getObjectColumns(objectName), response, context.config, true, { key: `${context.dataset}:object-columns:${objectName}`, ttlMs: 600000 });
  });
  app.get('/api/options', (request, response) => {
    const validation = validatedOptionFilters(request.query);
    if (validation.error) return response.status(400).json({ success: false, error: validation.error });
    const context = contextFor(request, response); if (!context) return undefined;
    if (context.dataset === 'ta-yield' && taYieldStaging) return useDatabase(() => taYieldStaging.getWorkbookOptions(), response, context.config, false, { key: 'ta-yield:staging-options', ttlMs: 300000 });
    const cacheEntry = context.dataset === 'ta-yield' ? { key: 'ta-yield:options', ttlMs: 300000 } : undefined;
    if (!cacheEntry) response.set('Cache-Control', 'no-store');
    return useDatabase(() => dashboardDatabase(context).getOptions(validation.filters, false), response, context.config, false, cacheEntry);
  });
  app.get('/api/part-numbers', (request, response) => {
    const validation = validatedPartNumberQuery(request.query);
    if (validation.error) return response.status(400).json({ success: false, error: validation.error });
    const context = contextFor(request, response); if (!context) return undefined;
    return useDatabase(() => dashboardDatabase(context).getPartNumbers(validation.filters, validation.search, validation.offset), response, context.config, false, { key: `${context.dataset}:part-numbers:${JSON.stringify([validation.filters, validation.search, validation.offset])}`, ttlMs: 600000 });
  });
  app.get('/api/auth/login', async (_request, response) => {
    const context = contextFor(_request, response); if (!context) return undefined;
    if (!context.config.metadataReady) return response.status(503).json({ success: false, error: 'Database connection configuration is incomplete. Check the server environment.' });
    try {
      await context.database.authenticate();
      responseCache.clear();
      return response.json({ success: true, data: { authenticated: true } });
    } catch (error) {
      console.error('Interactive sign-in failed:', error.message);
      return response.status(401).json({ success: false, code: 'AUTH_REQUIRED', error: 'Microsoft Entra sign-in could not be completed.' });
    }
  });
  app.get('/api/quantity', (request, response) => {
    const validation = validatedFilters(request.query);
    if (validation.error) return response.status(400).json({ success: false, error: validation.error });
    const context = contextFor(request, response); if (!context) return undefined;
    return useDatabase(() => dashboardDatabase(context, validation.filters).getQuantity(validation.filters), response, context.config, false, { key: `${context.dataset}:quantity:${JSON.stringify(validation.filters)}`, ttlMs: 120000 });
  });
  app.get('/api/sc-yield', (request, response) => {
    const validation = validatedFilters(request.query);
    if (validation.error) return response.status(400).json({ success: false, error: validation.error });
    const context = contextFor(request, response); if (!context) return undefined;
    if (context.dataset !== 'yield') return response.status(400).json({ success: false, error: 'SC Yield is available for the SC Yield data source only.' });
    return useDatabase(async () => {
      const [mapping, rows] = await Promise.all([configuredScYieldMapping(), scYieldRows(context, validation.filters)]);
      return mapScYieldRows(rows, mapping);
    }, response, context.config, false, { key: `${context.dataset}:summary:${JSON.stringify(validation.filters)}`, ttlMs: 120000 });
  });
  app.get('/api/sc-yield-weekly', (request, response) => {
    const validation = validatedFilters(request.query);
    if (validation.error) return response.status(400).json({ success: false, error: validation.error });
    const context = contextFor(request, response); if (!context) return undefined;
    if (context.dataset !== 'yield') return response.status(400).json({ success: false, error: 'SC Yield is available for the SC Yield data source only.' });
    return useDatabase(async () => { const [mapping, rows] = await Promise.all([configuredScYieldMapping(), scYieldRows(context, validation.filters, 'week')]); return mapScYieldRows(rows, mapping); }, response, context.config, false, { key: `${context.dataset}:weekly:${JSON.stringify(validation.filters)}`, ttlMs: 120000 });
  });
  app.get('/api/ta-yield', (request, response) => {
    const validation = validatedFilters(request.query); if (validation.error) return response.status(400).json({ success: false, error: validation.error }); const context = contextFor(request, response); if (!context) return undefined;
    if (context.dataset !== 'ta-yield') return response.status(400).json({ success: false, error: 'TA Yield is available for the TA Yield data source only.' });
    return useDatabase(() => sharedTaYieldDashboardResult(context, validation.filters), response, context.config, false, undefined, context.dataset);
  });
  app.get('/api/ta-yield-weekly', (request, response) => {
    const validation = validatedFilters(request.query); if (validation.error) return response.status(400).json({ success: false, error: validation.error }); const context = contextFor(request, response); if (!context) return undefined;
    if (context.dataset !== 'ta-yield') return response.status(400).json({ success: false, error: 'TA weekly yield is available for the TA Yield data source only.' });
    return useDatabase(() => sharedTaYieldDashboardResult(context, validation.filters, 'week'), response, context.config, false, undefined, context.dataset);
  });
  app.get('/api/ta-yield-tendency', (request, response) => {
    const validation = validatedFilters(request.query); if (validation.error) return response.status(400).json({ success: false, error: validation.error });
    const interval = request.query.interval || 'month';
    if (!['day', 'week', 'month'].includes(interval)) return response.status(400).json({ success: false, error: 'Interval must be day, week, or month.' });
    const trendPn = typeof request.query.trendPn === 'string' ? request.query.trendPn.trim() : '';
    if (trendPn.length > 200) return response.status(400).json({ success: false, error: 'Part number is too long.' });
    const context = contextFor(request, response); if (!context) return undefined;
    if (context.dataset !== 'ta-yield') return response.status(400).json({ success: false, error: 'TA Yield is available for the TA Yield data source only.' });
    return useDatabase(() => sharedTaYieldDashboardResult(context, trendPn ? { ...validation.filters, pn: trendPn } : validation.filters, interval), response, context.config, false, undefined, context.dataset);
  });
  app.get('/api/ta-yield-lots', (request, response) => {
    const validation = validatedFilters(request.query); if (validation.error) return response.status(400).json({ success: false, error: validation.error }); const context = contextFor(request, response); if (!context) return undefined;
    if (context.dataset !== 'ta-yield') return response.status(400).json({ success: false, error: 'TA Yield lot detail is available for the TA Yield data source only.' });
    return useDatabase(async () => { const [maps, rows] = await Promise.all([configuredTaYieldMapping(), sharedTaYieldRows(context, validation.filters)]); return mapTaYieldLotDetails(rows, maps); }, response, context.config, false, undefined, context.dataset);
  });
  app.get('/api/ta-yield-machine-options', (request, response) => {
    const validation = validatedTaMachineQuery(request.query); if (validation.error) return response.status(400).json({ success: false, error: validation.error }); const context = contextFor(request, response); if (!context) return undefined;
    if (context.dataset !== 'ta-yield') return response.status(400).json({ success: false, error: 'TA Machine analysis is available for the TA Yield data source only.' });
    return useDatabase(async () => {
      return { machines: [], ...await taMachineDefectViews() };
    }, response, context.config, false, { key: `ta-yield:machine-options:${JSON.stringify(validation)}`, ttlMs: 300000 }, context.dataset);
  });
  app.get('/api/ta-yield-machine', (request, response) => {
    const validation = validatedTaMachineQuery(request.query, { requireMachine: true, requireDefect: true }); if (validation.error) return response.status(400).json({ success: false, error: validation.error }); const context = contextFor(request, response); if (!context) return undefined;
    if (context.dataset !== 'ta-yield') return response.status(400).json({ success: false, error: 'TA Machine analysis is available for the TA Yield data source only.' });
    return useDatabase(async () => {
      const [mapping, machineData] = await Promise.all([configuredTaYieldMapping(), sharedTaMachineAnalysis(context, validation.filters, { processPattern: validation.processPattern, machine: validation.machine })]);
      const { lots, events } = machineData;
      const eventCounts = events.reduce((counts, event) => ({ ...counts, [event.machineName]: Number(counts[event.machineName] || 0) + 1 }), {});
      if (validation.defectType === 'code') {
        const entry = mapping.neo.get(validation.defect) || mapping.gps.get(validation.defect);
        if (!entry?.category) return { linkedModes: [], rows: [] };
        const result = mapTaYieldMachineEvents(events, lots, { type: 'category', value: entry.category }, validation.groupBy);
        return { linkedModes: [validation.defect], totalMachines: Object.keys(eventCounts).length, rows: result.rows.map((row) => ({ ...row, mode: validation.defect })) };
      }
      return { ...mapTaYieldMachineEvents(events, lots, { type: validation.defectType, value: validation.defect }, validation.groupBy), totalMachines: Object.keys(eventCounts).length };
    }, response, context.config, false, { key: `ta-yield:machine:v2:${JSON.stringify(validation)}`, ttlMs: 300000 }, context.dataset);
  });
  app.get('/api/ta-yield-workbook-reconciliation', (request, response) => {
    const validation = validatedFilters(request.query); if (validation.error) return response.status(400).json({ success: false, error: validation.error }); const context = contextFor(request, response); if (!context) return undefined;
    if (context.dataset !== 'ta-yield') return response.status(400).json({ success: false, error: 'TA workbook reconciliation is available for the TA Yield data source only.' });
    return useDatabase(async () => { const { rows, mapping } = await sharedTaWorkbookYieldRows(context, validation.filters); return mapTaWorkbookReconciliationRows(rows, mapping); }, response, context.config, false, { key: `ta-yield:workbook-reconciliation:v3:${JSON.stringify(validation.filters)}`, ttlMs: 300000 }, context.dataset);
  });
  app.get('/api/ta-yield-actions', async (_request, response) => {
    if (!taYieldActions) return response.status(503).json({ success: false, error: 'TA Yield action storage is not configured.' });
    try { return response.json({ success: true, data: await taYieldActions.list() }); } catch { return response.status(503).json({ success: false, error: 'TA Yield actions are currently unavailable.' }); }
  });
  app.post('/api/ta-yield-actions', async (request, response) => {
    const action = validTaYieldAction(request.body);
    if (!action) return response.status(400).json({ success: false, error: 'Provide a valid date, series, problem, optional action details, and status.' });
    if (!taYieldActions) return response.status(503).json({ success: false, error: 'TA Yield action storage is not configured.' });
    try { return response.json({ success: true, data: await taYieldActions.create({ ...action, createdBy: taYieldActionConfig.displayName }) }); } catch { return response.status(503).json({ success: false, error: 'TA Yield action could not be saved.' }); }
  });
  app.patch('/api/ta-yield-actions/:id', async (request, response) => {
    const id = Number(request.params.id); const action = validTaYieldAction(request.body);
    if (!Number.isInteger(id) || id < 1 || !action) return response.status(400).json({ success: false, error: 'Provide a valid action record.' });
    if (!taYieldActions) return response.status(503).json({ success: false, error: 'TA Yield action storage is not configured.' });
    try { const updated = await taYieldActions.update(id, action); return updated ? response.json({ success: true, data: updated }) : response.status(404).json({ success: false, error: 'TA Yield action was not found.' }); } catch { return response.status(503).json({ success: false, error: 'TA Yield action could not be updated.' }); }
  });
  app.delete('/api/ta-yield-actions/:id', async (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id < 1) return response.status(400).json({ success: false, error: 'Provide a valid action id.' });
    if (!taYieldActions) return response.status(503).json({ success: false, error: 'TA Yield action storage is not configured.' });
    try { return await taYieldActions.remove(id) ? response.json({ success: true, data: { removed: true } }) : response.status(404).json({ success: false, error: 'TA Yield action was not found.' }); } catch { return response.status(503).json({ success: false, error: 'TA Yield action could not be removed.' }); }
  });
  app.get('/api/export/ta-yield-datatable', async (request, response) => {
    const validation = validatedFilters(request.query);
    if (validation.error) return response.status(400).json({ success: false, error: validation.error });
    const context = contextFor(request, response); if (!context) return undefined;
    if (context.dataset !== 'ta-yield') return response.status(400).json({ success: false, error: 'TA Yield DataTable export is available for the TA Yield data source only.' });
    try {
      const { rows, mapping } = await sharedTaWorkbookYieldRows(context, validation.filters);
      const filename = `ta-yield-datatable-${validation.filters.startDate}-to-${validation.filters.endDate}.xlsx`;
      response.attachment(filename);
      response.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      return response.send(await taYieldDataTableWorkbook(mapTaWorkbookReconciliationRows(rows, mapping), validation.filters));
    } catch (error) {
      console.error('TA Yield DataTable export failed:', error.message);
      if (isAuthenticationError(error)) return response.status(401).json({ success: false, code: 'AUTH_REQUIRED', error: 'Microsoft Entra sign-in is required to refresh database access.' });
      return response.status(503).json({ success: false, error: 'TA Yield DataTable export is currently unavailable. Try again after staging refresh completes.' });
    }
  });
  app.get('/api/mtd-quantity', (request, response) => {
    const validation = validatedFilters(request.query);
    if (validation.error) return response.status(400).json({ success: false, error: validation.error });
    const context = contextFor(request, response); if (!context) return undefined;
    if (context.dataset !== 'closed') return response.status(400).json({ success: false, error: 'MTD result quantity is available for Completion 901 only.' });
    return useDatabase(() => staging901 ? staging901.getQuantity(validation.filters) : context.database.getQuantity(validation.filters, { mtd: true }), response, context.config, false, { key: `${context.dataset}:mtd-quantity:${JSON.stringify(validation.filters)}`, ttlMs: 120000 });
  });
  app.get('/api/export/completion', async (request, response) => {
    const validation = validatedFilters(request.query);
    if (validation.error) return response.status(400).json({ success: false, error: validation.error });
    const context = contextFor(request, response); if (!context) return undefined;
    if (!context.config.ready) return response.status(503).json({ success: false, error: 'Database configuration is incomplete. Check the server environment.' });
    try {
      const cached = await responseCache.getOrSet(`${context.dataset}:quantity:${JSON.stringify(validation.filters)}`, 120000, () => dashboardDatabase(context, validation.filters).getQuantity(validation.filters));
      const filename = `${context.dataset === 'closed' ? '901' : 'wip'}-series-completion-${validation.filters.startDate}-to-${validation.filters.endDate}.xlsx`;
      response.set('X-Dashboard-Cache', cached.status);
      response.attachment(filename);
      response.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      return response.send(await completionWorkbook(cached.value));
    } catch (error) {
      console.error('Completion export failed:', error.message);
      if (isAuthenticationError(error)) return response.status(401).json({ success: false, code: 'AUTH_REQUIRED', error: 'Microsoft Entra sign-in is required to refresh database access.' });
      return response.status(503).json({ success: false, error: 'Database data is currently unavailable. Verify configuration and Microsoft Entra access.' });
    }
  });
  app.get('/api/chart', (request, response) => {
    const validation = validatedFilters(request.query);
    if (validation.error) return response.status(400).json({ success: false, error: validation.error });
    const context = contextFor(request, response); if (!context) return undefined;
    return useDatabase(() => dashboardDatabase(context, validation.filters).getChartData(validation.filters), response, context.config, false, { key: `${context.dataset}:chart:${JSON.stringify(validation.filters)}`, ttlMs: 120000 });
  });
  app.get('/api/operation-transitions', (request, response) => {
    const validation = validatedFilters(request.query);
    if (validation.error) return response.status(400).json({ success: false, error: validation.error });
    const context = contextFor(request, response); if (!context) return undefined;
    if (context.dataset !== 'lot') return response.status(400).json({ success: false, error: 'Operation transitions are available for WIP (Lot Complete Log) only.' });
    return useDatabase(() => context.database.getOperationTransitions(validation.filters), response, context.config, false, { key: `${context.dataset}:operation-transitions:${JSON.stringify(validation.filters)}`, ttlMs: 120000 });
  });
  app.get('/api/dispositions', (request, response) => {
    const validation = validatedFilters(request.query);
    if (validation.error) return response.status(400).json({ success: false, error: validation.error });
    const context = contextFor(request, response); if (!context) return undefined;
    if (context.dataset !== 'lot') return response.status(400).json({ success: false, error: 'Disposition diagnostics are available for WIP (Lot Complete Log) only.' });
    return useDatabase(() => context.database.getDispositionSummary(validation.filters), response, context.config, false, { key: `${context.dataset}:dispositions:${JSON.stringify(validation.filters)}`, ttlMs: 300000 });
  });
  app.get('/api/wip-flow', (request, response) => {
    const validation = validatedFilters(request.query);
    if (validation.error) return response.status(400).json({ success: false, error: validation.error });
    const context = contextFor(request, response); if (!context) return undefined;
    if (context.dataset !== 'lot') return response.status(400).json({ success: false, error: 'WIP flow analysis is available for WIP (Lot Complete Log) only.' });
    return useDatabase(() => context.database.getWipFlow(validation.filters), response, context.config, false, { key: `${context.dataset}:wip-flow:${JSON.stringify(validation.filters)}`, ttlMs: 120000 });
  });
  app.get('/api/yield', (request, response) => {
    const validation = validatedFilters(request.query);
    if (validation.error) return response.status(400).json({ success: false, error: validation.error });
    const context = contextFor(request, response); if (!context) return undefined;
    if (context.dataset !== 'lot') return response.status(400).json({ success: false, error: 'Yield analysis is available for WIP (Lot Complete Log) only.' });
    return useDatabase(async () => ({ goodDisposition: context.config.dispositionValue || 'good', rows: await context.database.getYieldSummary(validation.filters) }), response, context.config, false, { key: `${context.dataset}:yield:${JSON.stringify(validation.filters)}`, ttlMs: 300000 });
  });
  app.get('/api/series-diagnostics', (request, response) => {
    const context = contextFor(request, response); if (!context) return undefined;
    const action = context.dataset === 'lot' ? () => context.database.getSeriesLinkDiagnostics() : () => context.database.getBlankSeriesDiagnostics();
    return useDatabase(action, response, context.config, false, { key: `${context.dataset}:series-diagnostics`, ttlMs: 300000 });
  });
  return app;
}
