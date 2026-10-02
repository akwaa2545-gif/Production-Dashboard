const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;

function validMonth(value, latestMonth) {
  return typeof value === 'string' && monthPattern.test(value) && value >= '1900-01' && value <= latestMonth;
}
function validCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function previousMonth(month) {
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() - 1);
  return date.toISOString().slice(0, 7);
}

function monthRange(month, today) {
  const last = new Date(`${month}-01T00:00:00Z`);
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  return { startDate: `${month}-01`, endDate: month === today.startDate.slice(0, 7) ? today.endDate : last.toISOString().slice(0, 10) };
}

export function taYieldComparePeriods(query, today, reportRange) {
  if (reportRange && (!validCalendarDate(reportRange.startDate) || !validCalendarDate(reportRange.endDate) || reportRange.startDate > reportRange.endDate)) return { error: 'Provide valid calendar Report dates in YYYY-MM-DD order.' };
  const comparisonMode = query.comparisonMode;
  if (comparisonMode !== undefined && !['same-dates', 'full-month'].includes(comparisonMode)) return { error: 'comparisonMode must be same-dates or full-month.' };
  const latestMonth = today.startDate.slice(0, 7);
  const currentMonth = reportRange ? reportRange.startDate.slice(0, 7) : query.currentMonth === undefined ? latestMonth : query.currentMonth;
  if (!reportRange && !validMonth(currentMonth, latestMonth)) return { error: 'Provide a valid currentMonth in YYYY-MM format, from 1900 through the current month.' };
  const compareMonth = query.compareMonth === undefined ? previousMonth(currentMonth) : query.compareMonth;
  if (!validMonth(compareMonth, latestMonth)) return { error: 'Provide a valid compareMonth in YYYY-MM format, from 1900 through the current month.' };
  const currentRange = reportRange ? { ...reportRange } : monthRange(currentMonth, today);
  const fullRange = monthRange(compareMonth, today);
  const rangeNotes = [];
  let compareRange = fullRange;
  if (comparisonMode === 'same-dates') {
    if (currentRange.startDate.slice(0, 7) !== currentRange.endDate.slice(0, 7)) return { error: 'Same dates requires Report dates within one month. Choose Full month for a multi-month report.' };
    const startDate = `${compareMonth}-${currentRange.startDate.slice(8)}`;
    const proposedEnd = `${compareMonth}-${currentRange.endDate.slice(8)}`;
    if (startDate > fullRange.endDate) return { error: 'The selected start day is not available in the comparison month. Choose Full month or an earlier Report start day.' };
    compareRange = { startDate, endDate: proposedEnd > fullRange.endDate ? fullRange.endDate : proposedEnd };
    if (proposedEnd > fullRange.endDate) rangeNotes.push(`Comparison end clamped to ${fullRange.endDate}, the last available day of the comparison month.`);
  }
  if (comparisonMode !== undefined && compareMonth === latestMonth) rangeNotes.push(`The current comparison month is available only through ${today.endDate}.`);
  return { currentMonth, compareMonth, currentRange, compareRange, ...(comparisonMode === undefined ? {} : { comparisonMode, rangeNotes }) };
}

function seriesLabel(line) {
  const value = String(line || '').trim();
  const match = value.match(/\b(FPS|GPS|PSG|PSH|PSL|PSU)\s+series\s+([A-Z]\d*)\b/i);
  return match ? `${match[1].toUpperCase()} ${match[2].toUpperCase()}` : value;
}

export function reportingFamily(line) {
  if (/\bGPS\b/i.test(line)) return 'GPS';
  if (/\bFPS\b/i.test(line)) return 'FPS';
  return 'STD';
}

function totals(rows) {
  const values = rows.reduce((total, row) => ({ input: total.input + Number(row.input || 0), good: total.good + Number(row.finalGood || 0) }), { input: 0, good: 0 });
  return { ...values, yield: values.input > 0 ? values.good / values.input * 100 : null };
}

export const seriesKey = (line) => String(line || '').trim().toUpperCase();

function seriesCategories(rows) {
  const lines = rows.map((row) => String(row.line || '').trim()).filter(Boolean);
  const series = [...new Set(lines.map(seriesKey))].map((key) => {
    const line = lines.find((value) => seriesKey(value) === key);
    return { key, line, label: seriesLabel(line) };
  });
  const distinctLabels = series.map((row) => {
    if (series.filter((other) => other.label.toUpperCase() === row.label.toUpperCase()).length === 1) return row;
    const suffix = row.line.match(/\b(?:FPS|GPS|PSG|PSH|PSL|PSU)\s+series\s+[A-Z]\d*\b\s*(.+)$/i)?.[1];
    return { ...row, label: suffix ? `${row.label} · ${suffix}` : row.line };
  });
  return distinctLabels.map((row) => ({ key: row.key, kind: 'series', label: distinctLabels.filter((other) => other.label.toUpperCase() === row.label.toUpperCase()).length > 1 ? row.line : row.label }))
    .sort((left, right) => left.label.localeCompare(right.label, undefined, { numeric: true }));
}

export function mapTaYieldCompare(currentRows, compareRows) {
  const categories = [{ label: 'Total', key: 'Total', kind: 'total' }, ...['STD', 'FPS', 'GPS'].map((label) => ({ label, key: label, kind: 'group' })), ...seriesCategories([...currentRows, ...compareRows])];
  return categories.map(({ label, kind, key }) => {
    const matches = (row) => kind === 'total' || (kind === 'group' ? reportingFamily(row.line) === label : seriesKey(row.line) === key);
    const current = totals(currentRows.filter(matches));
    const compare = totals(compareRows.filter(matches));
    return { label, kind, key, currentYield: current.yield, compareYield: compare.yield, delta: current.yield === null || compare.yield === null ? null : current.yield - compare.yield, currentInput: current.input, currentGood: current.good, compareInput: compare.input, compareGood: compare.good };
  });
}
