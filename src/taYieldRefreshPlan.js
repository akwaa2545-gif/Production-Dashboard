export function taYieldRefreshPlan(filters, snapshot) {
  if (snapshot?.scopeStart !== filters.startDate) return { mode: 'FULL' };
  if (snapshot.scopeEnd >= filters.endDate) return { mode: 'REFRESH_CURRENT' };
  return { mode: 'RESUME' };
}

export function taYieldLateArrivalDates(filters, configuredDays = 2) {
  const days = Math.min(Math.max(Number(configuredDays) || 2, 1), 7);
  const end = new Date(`${filters.endDate}T00:00:00Z`);
  const dates = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(end); date.setUTCDate(date.getUTCDate() - offset);
    dates.push(date.toISOString().slice(0, 10));
  }
  return dates;
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

export function mergeTaWorkbookLots(snapshotRows, freshRows, { replaceDate, replaceDates, dateForLot, keyForLot }) {
  const datesToReplace = replaceDates || (replaceDate ? new Set([replaceDate]) : undefined);
  const retainedRows = datesToReplace?.size ? snapshotRows.filter((lot) => !datesToReplace.has(dateForLot(lot))) : snapshotRows;
  return [...new Map([...retainedRows, ...freshRows].map((lot) => [keyForLot(lot), lot])).values()];
}
