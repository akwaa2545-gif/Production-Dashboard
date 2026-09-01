export function taYieldRefreshPlan(filters, snapshot) {
  if (snapshot?.scopeStart !== filters.startDate) return { mode: 'FULL' };
  if (snapshot.scopeEnd >= filters.endDate) return { mode: 'CURRENT', result: { status: 'ALREADY_CURRENT', ...filters } };
  return { mode: 'RESUME' };
}
