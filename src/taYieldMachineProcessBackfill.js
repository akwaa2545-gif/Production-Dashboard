import { mapTaWorkbookReconciliationRows } from './taYieldMapping.js';

const monthPattern = /^(?:[1-9]\d{3})-(?:0[1-9]|1[0-2])$/;
const thailandDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' });
const monthIndex = (month) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5)) - 1;
const monthName = (index) => `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`;
const monthEnd = (month) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).toISOString().slice(0, 10);

function validateRange({ start, end }) {
  if (!monthPattern.test(start || '') || !monthPattern.test(end || '')) throw new Error('Explicit --start=YYYY-MM and --end=YYYY-MM are required.');
  const count = monthIndex(end) - monthIndex(start) + 1;
  if (count < 1 || count > 12) throw new Error('Month range must be ordered and contain at most 12 months.');
  return Array.from({ length: count }, (_, index) => monthName(monthIndex(start) + index));
}

export function parseTaYieldMachineBackfillArguments(args) {
  const parsed = { apply: false };
  const seen = new Set();
  for (const argument of args) {
    const match = /^--(start|end)=(.+)$/.exec(argument);
    const key = match?.[1] || (argument === '--apply' ? 'apply' : undefined);
    if (!key || seen.has(key)) throw new Error(`Unknown or duplicate argument: ${argument}`);
    seen.add(key);
    parsed[key] = match ? match[2] : true;
  }
  validateRange(parsed);
  return { start: parsed.start, end: parsed.end, apply: parsed.apply };
}

function validateSnapshot(snapshot, scope, today) {
  const lastAllowed = scope.startDate.slice(0, 7) === today.slice(0, 7) ? today : scope.endDate;
  const end = snapshot?.scopeEnd;
  const validEnd = typeof end === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(end)
    && !Number.isNaN(Date.parse(`${end}T00:00:00Z`)) && new Date(`${end}T00:00:00Z`).toISOString().slice(0, 10) === end;
  if (!snapshot || snapshot.scopeStart !== scope.startDate || !validEnd || end < scope.startDate || end > lastAllowed
    || (scope.endDate < today && end !== scope.endDate) || !Array.isArray(snapshot.rows)) {
    throw new Error(`Complete workbook staging scope is required for ${scope.startDate.slice(0, 7)}; no machine rows were replaced for this month.`);
  }
}

/** Rebuild only normalized Machine rows from the existing calculated workbook population. */
export async function backfillTaYieldMachineProcesses({ start, end, apply = false }, { staging, source, loadMapping, now = () => new Date() }) {
  const months = validateRange({ start, end });
  const today = thailandDate.format(now());
  if (end > today.slice(0, 7)) throw new Error('Future months cannot be backfilled.');
  const plans = [];
  let mapping;
  // Preflight every staged scope before any MES retrieval or machine-table replacement.
  for (const month of months) {
    const fullScope = { startDate: `${month}-01`, endDate: monthEnd(month) };
    const snapshot = await staging.getLatestWorkbookSnapshotForMonth(fullScope);
    validateSnapshot(snapshot, fullScope, today);
    if (snapshot.rows.some((row) => !row?.categories || typeof row.categories !== 'object')) mapping ||= await loadMapping();
    const lots = mapTaWorkbookReconciliationRows(snapshot.rows, mapping || new Map()).filter((row) => typeof row.lotNo === 'string' && row.lotNo.trim());
    plans.push({ month, scope: { startDate: snapshot.scopeStart, endDate: snapshot.scopeEnd }, lots, lotNumbers: [...new Set(lots.map((row) => row.lotNo))] });
  }
  const results = [];
  for (const plan of plans) {
    const { month, scope, lots, lotNumbers } = plan;
    const inventory = { month, ...scope, lotRows: lots.length, lotCount: lotNumbers.length };
    if (!apply) {
      results.push({ ...inventory, status: 'DRY_RUN' });
      continue;
    }
    const eligible = new Set(lotNumbers);
    const events = lotNumbers.length ? (await source.getMachineEvents(scope, { lotNumbers })).filter((event) => eligible.has(event.lotNo)) : [];
    await staging.replaceMachineRows(events, lots, scope);
    results.push({ ...inventory, status: 'REPLACED', eventRows: events.length });
  }
  return { apply, months: results };
}
