import { mapTaWorkbookReconciliationRows } from './taYieldMapping.js';
import { mapTaYieldCompare, reportingFamily, seriesKey } from './taYieldCompare.js';
import { thailandTapingDate } from './taYieldRefreshPlan.js';

const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const rate = (quantity, input) => input > 0 ? quantity / input * 100 : null;

export function createTaCompareDetailsLimiter({ now = () => Date.now(), limit = 60, windowMs = 60000,
  code = 'COMPARE_DETAILS_RATE_LIMIT', errorMessage = 'Too many Compare LOOKUP requests. Wait a minute and try again.' } = {}) {
  const clients = new Map();
  return (request, response, next) => {
    const time = now();
    for (const [key, entry] of clients) if (entry.expiresAt <= time) clients.delete(key);
    const key = request.ip || request.socket?.remoteAddress || 'unknown';
    const entry = clients.get(key) || { count: 0, expiresAt: time + windowMs };
    if (entry.count >= limit || (!clients.has(key) && clients.size >= 1000)) {
      response.set('Retry-After', String(Math.max(1, Math.ceil((entry.expiresAt - time) / 1000))));
      return response.status(429).json({ success: false, code, error: errorMessage });
    }
    clients.set(key, { ...entry, count: entry.count + 1 });
    return next();
  };
}

export function validateTaYieldCompareSelection(query) {
  const { kind, key } = query;
  if (!['total', 'group', 'series'].includes(kind) || typeof key !== 'string' || !key.trim() || key.length > 500
    || (kind === 'total' && key !== 'Total') || (kind === 'group' && !['STD', 'FPS', 'GPS'].includes(key))) return { error: 'Provide a valid Compare row kind and key.' };
  const offsetText = query.offset === undefined ? '0' : query.offset;
  const limitText = query.limit === undefined ? '50' : query.limit;
  if (typeof offsetText !== 'string' || typeof limitText !== 'string' || !/^\d+$/.test(offsetText) || !/^\d+$/.test(limitText)) return { error: 'offset and limit must be nonnegative integers.' };
  const offset = Number(offsetText); const limit = Number(limitText);
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) return { error: 'offset must be a safe integer and limit must be from 1 to 100.' };
  return { selection: { kind, key }, pagination: { offset, limit } };
}

function evidence(lot) {
  const grouped = Object.entries(lot.categories || {}).filter(([group]) => !['Input', 'Input-', 'Good'].includes(group))
    .map(([group, quantity]) => ({ group, quantity: number(quantity) }));
  const other2 = number(lot.calculation.other2);
  const groups = [...grouped, ...(other2 ? [{ group: 'Other2', quantity: other2 }] : [])].filter((group) => group.quantity !== 0);
  const input = number(lot.calculation.inputF); const good = number(lot.categories.Good);
  return { lotNo: String(lot.lotNo || '').trim(), line: String(lot.line || '').trim(), itemName: String(lot.itemName || ''), tapingDate: thailandTapingDate(lot.tapingDate),
    input, good, yield: rate(good, input), defectQty: groups.reduce((sum, group) => sum + group.quantity, 0), groups };
}

function summarize(lots, pagination) {
  const rows = lots.map(evidence);
  const input = rows.reduce((sum, row) => sum + row.input, 0); const good = rows.reduce((sum, row) => sum + row.good, 0);
  const groups = rows.flatMap((row) => row.groups).reduce((values, row) => ({ ...values, [row.group]: number(values[row.group]) + row.quantity }), Object.create(null));
  const affected = rows.filter((row) => row.groups.length).sort((left, right) => right.defectQty - left.defectQty || `${left.lotNo}|${left.itemName}|${left.tapingDate}`.localeCompare(`${right.lotNo}|${right.itemName}|${right.tapingDate}`));
  const { offset, limit } = pagination;
  return { summary: { input, good, yield: rate(good, input), lotCount: new Set(rows.map((row) => row.lotNo).filter(Boolean)).size, defectQty: rows.reduce((sum, row) => sum + row.defectQty, 0) }, groups,
    lots: { total: affected.length, offset, limit, rows: affected.slice(offset, offset + limit) } };
}

export function mapTaYieldCompareDetails(currentRows, compareRows, mapping, selection, pagination = { offset: 0, limit: 50 }) {
  const currentLots = mapTaWorkbookReconciliationRows(currentRows, mapping);
  const compareLots = mapTaWorkbookReconciliationRows(compareRows, mapping);
  const category = mapTaYieldCompare(currentLots, compareLots).find((row) => row.kind === selection.kind && row.key === selection.key);
  if (!category) throw Object.assign(new Error('Compare selection is not available in these staged periods.'), { code: 'TA_COMPARE_SELECTION_INVALID' });
  const matches = (row) => selection.kind === 'total' || (selection.kind === 'group' ? reportingFamily(row.line) === selection.key : seriesKey(row.line) === selection.key);
  const current = summarize(currentLots.filter(matches), pagination); const compare = summarize(compareLots.filter(matches), pagination);
  const groups = [...new Set([...Object.keys(current.groups), ...Object.keys(compare.groups)])].sort().map((group) => {
    const currentQty = number(current.groups[group]); const compareQty = number(compare.groups[group]);
    const currentRate = rate(currentQty, current.summary.input); const compareRate = rate(compareQty, compare.summary.input);
    return { group, currentQty, compareQty, currentRate, compareRate, deltaRate: currentRate === null || compareRate === null ? null : currentRate - compareRate };
  });
  return { selection: { ...selection, label: category.label }, dataSource: 'staging', current: current.summary, compare: compare.summary, groups, lots: { current: current.lots, compare: compare.lots } };
}
