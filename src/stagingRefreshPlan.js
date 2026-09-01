function asDateString(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);
  return undefined;
}

export function stagingIncrementalRefreshPlan(monthFilters, lastDataDate) {
  const lastDate = asDateString(lastDataDate);
  if (!lastDate || lastDate < monthFilters.startDate) return { ...monthFilters };
  if (lastDate >= monthFilters.endDate) return { startDate: monthFilters.endDate, endDate: monthFilters.endDate };
  const nextDate = new Date(`${lastDate}T00:00:00.000Z`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  return { startDate: nextDate.toISOString().slice(0, 10), endDate: monthFilters.endDate };
}

export async function stagingIncrementalRefreshFilters(target, monthFilters) {
  try {
    return stagingIncrementalRefreshPlan(monthFilters, (await target.getActivity()).lastDataDate);
  } catch (error) {
    if (error?.number === 208 || /invalid object name/i.test(String(error?.message || ''))) return { ...monthFilters };
    throw error;
  }
}
