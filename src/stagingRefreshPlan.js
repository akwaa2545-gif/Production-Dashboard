function asDateString(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);
  return undefined;
}

export function stagingIncrementalRefreshPlan(monthFilters, lastDataDate, lateArrivalDays = 1) {
  const lastDate = asDateString(lastDataDate);
  if (!lastDate) return { ...monthFilters };
  const days = Math.min(Math.max(Math.trunc(Number(lateArrivalDays)) || 1, 1), 7);
  const lookback = new Date(`${monthFilters.endDate}T00:00:00.000Z`);
  lookback.setUTCDate(lookback.getUTCDate() - days + 1);
  const lookbackStart = lookback.toISOString().slice(0, 10);
  if (lastDate < monthFilters.startDate && lastDate < lookbackStart) return { ...monthFilters };
  const nextDate = new Date(`${lastDate}T00:00:00.000Z`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  const missingStart = nextDate.toISOString().slice(0, 10) > monthFilters.endDate ? monthFilters.endDate : nextDate.toISOString().slice(0, 10);
  return { startDate: missingStart < lookbackStart ? missingStart : lookbackStart, endDate: monthFilters.endDate };
}

export async function stagingIncrementalRefreshFilters(target, monthFilters, lateArrivalDays = 1) {
  try {
    return stagingIncrementalRefreshPlan(monthFilters, (await target.getActivity()).lastDataDate, lateArrivalDays);
  } catch (error) {
    if (error?.number === 208 || /invalid object name/i.test(String(error?.message || ''))) return { ...monthFilters };
    throw error;
  }
}
