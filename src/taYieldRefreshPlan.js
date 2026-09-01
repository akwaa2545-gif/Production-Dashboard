export function taYieldRefreshPlan(filters, snapshot) {
  if (snapshot?.scopeStart !== filters.startDate) return { mode: 'FULL' };
  if (snapshot.scopeEnd >= filters.endDate) return { mode: 'REFRESH_CURRENT' };
  return { mode: 'RESUME' };
}

export function mergeTaWorkbookLots(snapshotRows, freshRows, { replaceDate, dateForLot, keyForLot }) {
  const retainedRows = replaceDate ? snapshotRows.filter((lot) => dateForLot(lot) !== replaceDate) : snapshotRows;
  return [...new Map([...retainedRows, ...freshRows].map((lot) => [keyForLot(lot), lot])).values()];
}
