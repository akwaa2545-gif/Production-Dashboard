const seriesName = (value) => String(value || '').trim() || 'Unspecified';

export function mapTaDailyOutput(summary, lots) {
  const quantities = summary.reduce((totals, row) => {
    const name = seriesName(row.line);
    return new Map([...totals, [name, (totals.get(name) || 0) + (Number(row.finalGood) || 0)]]);
  }, new Map());
  return [...quantities].map(([itemName, quantityMoved]) => {
    const jobNames = [...new Set(lots.filter((row) => seriesName(row.line) === itemName)
      .map((row) => String(row.lotNo || '').trim()).filter(Boolean))].sort();
    return { itemName, quantityMoved, lotCount: jobNames.length, jobNames };
  }).sort((left, right) => left.itemName.localeCompare(right.itemName, undefined, { numeric: true, sensitivity: 'base' }));
}
