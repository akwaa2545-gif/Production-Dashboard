import { settleAll } from './settleAll.js';
import { mapTaWorkbookReconciliationRows, mapTaWorkbookYieldRows } from './taYieldMapping.js';
import { mapTaYieldCompare } from './taYieldCompare.js';
import { createTaCompareDetailsLimiter, mapTaYieldCompareDetails, validateTaYieldCompareSelection } from './taYieldCompareDetails.js';

function failure(response, status, error, code) {
  if (!response.destroyed && !response.writableEnded) response.status(status).json({ success: false, error, ...(code ? { code } : {}) });
}

async function exportData(filters, periods, selection, loadStagedRows, maxJobRecords) {
  const [current, comparison] = await settleAll([
    loadStagedRows({ ...filters, ...periods.currentRange }),
    loadStagedRows({ ...filters, ...periods.compareRange })
  ]);
  const currentLots = mapTaWorkbookReconciliationRows(current.rows, current.mapping);
  const compareLots = mapTaWorkbookReconciliationRows(comparison.rows, comparison.mapping);
  const rows = mapTaYieldCompare(mapTaWorkbookYieldRows(currentLots, new Map()), mapTaWorkbookYieldRows(compareLots, new Map()));
  const compare = { ...periods, filters, rows, dataSource: 'staging' };
  if (!selection) return { compare };
  const details = { ...periods, ...mapTaYieldCompareDetails(currentLots, compareLots, new Map(), selection, { offset: 0, limit: maxJobRecords + 1 }) };
  if (details.lots.current.total + details.lots.compare.total > maxJobRecords) {
    throw Object.assign(new Error('This LOOKUP contains too many jobs to export. Narrow the Report dates or filters and try again.'), { code: 'COMPARE_EXPORT_TOO_LARGE' });
  }
  return { compare, details };
}

export function registerTaYieldCompareExportRoute(app, {
  validateFilters, getPeriods, contextFor, loadStagedRows, runTracked, buildWorkbook, maxJobRecords = 50000
}) {
  let activeExports = 0;
  const limiter = createTaCompareDetailsLimiter({ limit: 6, code: 'COMPARE_EXPORT_RATE_LIMIT', errorMessage: 'Too many Compare exports. Wait a minute and try again.' });
  app.get('/api/export/ta-yield-compare', limiter, async (request, response) => {
    const validation = validateFilters(request.query);
    if (validation.error) return failure(response, 400, validation.error);
    if (request.query.startDate === undefined || request.query.endDate === undefined) return failure(response, 400, 'Report dates are required for Compare export.');
    if (request.query.offset !== undefined || request.query.limit !== undefined) return failure(response, 400, 'Compare export includes all jobs; pagination is not supported.');
    const periods = getPeriods(request.query, validation.filters);
    if (periods.error) return failure(response, 400, periods.error);
    const selected = request.query.kind !== undefined || request.query.key !== undefined ? validateTaYieldCompareSelection(request.query) : {};
    if (selected.error) return failure(response, 400, selected.error);
    const context = contextFor(request, response);
    if (!context) return undefined;
    if (context.dataset !== 'ta-yield') return failure(response, 400, 'Compare export is available for TA Yield only.');
    if (activeExports >= 2) {
      response.set('Retry-After', '5');
      return failure(response, 503, 'Other Compare exports are being generated. Try again shortly.', 'COMPARE_EXPORT_BUSY');
    }
    activeExports += 1;
    try {
      await runTracked(async () => {
        const { compare, details } = await exportData(validation.filters, periods, selected.selection, loadStagedRows, maxJobRecords);
        const buffer = await buildWorkbook(compare, details);
        if (response.destroyed || response.writableEnded) return;
        const name = `ta-yield-compare-${periods.currentRange.startDate}-to-${periods.currentRange.endDate}-vs-${periods.compareRange.startDate}-to-${periods.compareRange.endDate}.xlsx`;
        response.attachment(name).type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buffer);
      });
    } catch (error) {
      if (error.code === 'TA_COMPARE_SELECTION_INVALID') failure(response, 400, 'The LOOKUP selection is not available in these staged periods.', error.code);
      else if (error.code === 'COMPARE_EXPORT_TOO_LARGE') failure(response, 413, error.message, error.code);
      else if (error.code === 'TA_COMPARE_STAGING_UNAVAILABLE') failure(response, 503, 'Compare export requires complete staged data for both periods. Check staging coverage and try again.', error.code);
      else {
        console.error('Compare Excel export failed:', error);
        failure(response, 503, 'Unable to generate the Compare Excel file. Please try again.', 'COMPARE_EXPORT_FAILED');
      }
    } finally {
      activeExports -= 1;
    }
    return undefined;
  });
}
