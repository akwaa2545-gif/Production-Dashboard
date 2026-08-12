import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { publicConfig, publicDataModel, publicScYieldConfig, publicTaYieldConfig, read901StagingConfig, readCellCommentConfig, readDatasetConfig, readMtdTargetConfig, readScYieldConfig, readScYieldTargetConfig, readTaYieldConfig, readTaYieldTargetConfig } from './config.js';
import { MtdTargetRepository } from './mtdTargetRepository.js';
import { CellCommentRepository } from './cellCommentRepository.js';
import { SqlRepository } from './sqlRepository.js';
import { Staging901Repository } from './staging901Repository.js';
import { ScYieldRepository } from './scYieldRepository.js';
import { TaYieldRepository } from './taYieldRepository.js';
import { ScYieldTargetRepository } from './scYieldTargetRepository.js';
import { TaYieldTargetRepository } from './taYieldTargetRepository.js';
import { loadScYieldMapping, mapScYieldRows } from './scYieldMapping.js';
import { loadTaWorkbookReconciliationMapping, loadTaYieldMapping, mapTaWorkbookReconciliationRows, mapTaWorkbookYieldRows, mapTaYieldLotDetails, mapTaYieldRows } from './taYieldMapping.js';
import { TtlCache } from './ttlCache.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const filterNames = ['product', 'process', 'serie', 'case', 'pn'];

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

export function createApp({ environment = process.env, repository, scYieldRepository, taYieldRepository, mtdTargetRepository, scYieldTargetRepository, taYieldTargetRepository, cellCommentRepository, staging901Repository, cache } = {}) {
  const configs = { closed: readDatasetConfig(environment, 'closed'), lot: readDatasetConfig(environment, 'lot') };
  const scYieldConfig = readScYieldConfig(environment);
  const taYieldConfig = readTaYieldConfig(environment);
  const mtdTargetConfig = readMtdTargetConfig(environment);
  const scYieldTargetConfig = readScYieldTargetConfig(environment);
  const taYieldTargetConfig = readTaYieldTargetConfig(environment);
  const commentConfig = readCellCommentConfig(environment);
  const staging901Config = read901StagingConfig(environment);
  const repositories = new Map();
  let scYieldMapping;
  let taYieldMapping;
  let taWorkbookReconciliationMapping;
  const targets = mtdTargetRepository || (mtdTargetConfig.ready ? new MtdTargetRepository(mtdTargetConfig) : undefined);
  const scYieldTargets = scYieldTargetRepository || (scYieldTargetConfig.ready ? new ScYieldTargetRepository(scYieldTargetConfig) : undefined);
  const taYieldTargets = taYieldTargetRepository || (taYieldTargetConfig.ready ? new TaYieldTargetRepository(taYieldTargetConfig) : undefined);
  const comments = cellCommentRepository || (commentConfig.ready ? new CellCommentRepository(commentConfig) : undefined);
  const staging901 = staging901Repository || (staging901Config.enabled && staging901Config.ready ? new Staging901Repository(staging901Config) : undefined);
  const responseCache = cache || new TtlCache({ maxEntries: Math.min(Math.max(Number(environment.DASHBOARD_CACHE_MAX_ENTRIES) || 500, 10), 2000) });
  const app = express();
  app.use(express.json({ limit: '8kb' }));
  app.use(express.static(path.join(here, '../public')));
  app.get('/api/health', (_request, response) => response.json({ success: true, data: { status: 'ok' } }));

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
        await responseCache.getOrSet(`yield:summary:${JSON.stringify(filters)}`, 300000, async () => mapScYieldRows(await repositories.get('yield').getYieldRows(filters), await scYieldMapping), 30000);
        await responseCache.getOrSet(`yield:weekly:${JSON.stringify(filters)}`, 300000, async () => mapScYieldRows(await repositories.get('yield').getYieldRows(filters, 'week'), await scYieldMapping), 30000);
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

  function dashboardDatabase(context) {
    return context.dataset === 'closed' && staging901 ? staging901 : context.database;
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
    const cached = await responseCache.getOrSet(`ta-yield:rows:${JSON.stringify(filters)}`, 300000, () => context.database.getYieldRows(filters));
    return cached.value;
  }

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
    return useDatabase(() => dashboardDatabase(context).getQuantity(validation.filters), response, context.config, false, { key: `${context.dataset}:quantity:${JSON.stringify(validation.filters)}`, ttlMs: 120000 });
  });
  app.get('/api/sc-yield', (request, response) => {
    const validation = validatedFilters(request.query);
    if (validation.error) return response.status(400).json({ success: false, error: validation.error });
    const context = contextFor(request, response); if (!context) return undefined;
    if (context.dataset !== 'yield') return response.status(400).json({ success: false, error: 'SC Yield is available for the SC Yield data source only.' });
    return useDatabase(async () => {
      scYieldMapping ||= loadScYieldMapping(context.config.mappingFile);
      const [mapping, rows] = await Promise.all([scYieldMapping, context.database.getYieldRows(validation.filters)]);
      return mapScYieldRows(rows, mapping);
    }, response, context.config, false, { key: `${context.dataset}:summary:${JSON.stringify(validation.filters)}`, ttlMs: 120000 });
  });
  app.get('/api/sc-yield-weekly', (request, response) => {
    const validation = validatedFilters(request.query);
    if (validation.error) return response.status(400).json({ success: false, error: validation.error });
    const context = contextFor(request, response); if (!context) return undefined;
    if (context.dataset !== 'yield') return response.status(400).json({ success: false, error: 'SC Yield is available for the SC Yield data source only.' });
    return useDatabase(async () => { scYieldMapping ||= loadScYieldMapping(context.config.mappingFile); const [mapping, rows] = await Promise.all([scYieldMapping, context.database.getYieldRows(validation.filters, 'week')]); return mapScYieldRows(rows, mapping); }, response, context.config, false, { key: `${context.dataset}:weekly:${JSON.stringify(validation.filters)}`, ttlMs: 120000 });
  });
  app.get('/api/ta-yield', (request, response) => {
    const validation = validatedFilters(request.query); if (validation.error) return response.status(400).json({ success: false, error: validation.error }); const context = contextFor(request, response); if (!context) return undefined;
    if (context.dataset !== 'ta-yield') return response.status(400).json({ success: false, error: 'TA Yield is available for the TA Yield data source only.' });
    return useDatabase(async () => { taYieldMapping ||= loadTaYieldMapping(context.config.mappingFile); const [maps, rows] = await Promise.all([taYieldMapping, sharedTaYieldRows(context, validation.filters)]); return mapTaYieldRows(rows, maps); }, response, context.config, false, undefined, context.dataset);
  });
  app.get('/api/ta-yield-weekly', (request, response) => {
    const validation = validatedFilters(request.query); if (validation.error) return response.status(400).json({ success: false, error: validation.error }); const context = contextFor(request, response); if (!context) return undefined;
    if (context.dataset !== 'ta-yield') return response.status(400).json({ success: false, error: 'TA weekly yield is available for the TA Yield data source only.' });
    return useDatabase(async () => { taYieldMapping ||= loadTaYieldMapping(context.config.mappingFile); const [maps, rows] = await Promise.all([taYieldMapping, sharedTaYieldRows(context, validation.filters)]); return mapTaYieldRows(rows, maps, 'week'); }, response, context.config, false, undefined, context.dataset);
  });
  app.get('/api/ta-yield-tendency', (request, response) => {
    const validation = validatedFilters(request.query); if (validation.error) return response.status(400).json({ success: false, error: validation.error });
    const interval = request.query.interval || 'month';
    if (!['day', 'week', 'month'].includes(interval)) return response.status(400).json({ success: false, error: 'Interval must be day, week, or month.' });
    const context = contextFor(request, response); if (!context) return undefined;
    if (context.dataset !== 'ta-yield') return response.status(400).json({ success: false, error: 'TA Yield is available for the TA Yield data source only.' });
    return useDatabase(async () => { taYieldMapping ||= loadTaYieldMapping(context.config.mappingFile); const [maps, rows] = await Promise.all([taYieldMapping, sharedTaYieldRows(context, validation.filters)]); return mapTaYieldRows(rows, maps, interval); }, response, context.config, false, undefined, context.dataset);
  });
  app.get('/api/ta-yield-lots', (request, response) => {
    const validation = validatedFilters(request.query); if (validation.error) return response.status(400).json({ success: false, error: validation.error }); const context = contextFor(request, response); if (!context) return undefined;
    if (context.dataset !== 'ta-yield') return response.status(400).json({ success: false, error: 'TA Yield lot detail is available for the TA Yield data source only.' });
    return useDatabase(async () => { taYieldMapping ||= loadTaYieldMapping(context.config.mappingFile); const [maps, rows] = await Promise.all([taYieldMapping, sharedTaYieldRows(context, validation.filters)]); return mapTaYieldLotDetails(rows, maps); }, response, context.config, false, undefined, context.dataset);
  });
  app.get('/api/ta-yield-workbook-reconciliation', (request, response) => {
    const validation = validatedFilters(request.query); if (validation.error) return response.status(400).json({ success: false, error: validation.error }); const context = contextFor(request, response); if (!context) return undefined;
    if (context.dataset !== 'ta-yield') return response.status(400).json({ success: false, error: 'TA workbook reconciliation is available for the TA Yield data source only.' });
    return useDatabase(async () => { taWorkbookReconciliationMapping ||= loadTaWorkbookReconciliationMapping('TA/Yield_Data_Aug2026.xlsx'); const [mapping, rows] = await Promise.all([taWorkbookReconciliationMapping, context.database.getWorkbookReconciliationRows(validation.filters)]); return mapTaWorkbookReconciliationRows(rows, mapping); }, response, context.config, false, { key: `ta-yield:workbook-reconciliation:v2:${JSON.stringify(validation.filters)}`, ttlMs: 300000 }, context.dataset);
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
      const cached = await responseCache.getOrSet(`${context.dataset}:quantity:${JSON.stringify(validation.filters)}`, 120000, () => dashboardDatabase(context).getQuantity(validation.filters));
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
    return useDatabase(() => context.database.getChartData(validation.filters), response, context.config, false, { key: `${context.dataset}:chart:${JSON.stringify(validation.filters)}`, ttlMs: 120000 });
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
