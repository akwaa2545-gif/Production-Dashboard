export function taYieldRefreshPlan(filters, snapshot) {
  if (snapshot?.scopeStart !== filters.startDate) return { mode: 'FULL' };
  if (snapshot.scopeEnd >= filters.endDate) return { mode: 'REFRESH_CURRENT' };
  return { mode: 'RESUME' };
}

export function thailandTapingDate(value) {
  const raw = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const timestamp = value instanceof Date ? value : new Date(raw);
  return Number.isNaN(timestamp.getTime()) ? raw.slice(0, 10) : new Date(timestamp.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function taWorkbookBusinessKey(lot) {
  return `${lot.line}|${lot.lotNo}|${thailandTapingDate(lot.tapingDate)}`;
}

export function mergeTaWorkbookLots(snapshotRows, freshRows, { replaceDate, dateForLot, keyForLot }) {
  const retainedRows = replaceDate ? snapshotRows.filter((lot) => dateForLot(lot) !== replaceDate) : snapshotRows;
  return [...new Map([...retainedRows, ...freshRows].map((lot) => [keyForLot(lot), lot])).values()];
}
