import sql from 'mssql';

const batchLimit = 128;
const quoted = (name) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(name)) throw new Error('Invalid WIP classification identifier.');
  return name.split('.').map(part => `[${part}]`).join('.');
};
const requestFor = (pool, config) => {
  const request = pool.request();
  request.timeout = Math.min(Number(config.requestTimeout) > 0 ? config.requestTimeout : 60000, 60000);
  return request;
};
const sourceIdentity = row => JSON.stringify([row.plantId, row.eventId]);
const validIdentity = row => Number.isInteger(row.plantId) && Number.isInteger(row.eventId);
const addQuantity = (left, right) => {
  const units = Math.round(Number(left || 0) * 10000) + Math.round(Number(right || 0) * 10000);
  if (!Number.isSafeInteger(units)) throw Object.assign(new Error('WIP movement quantity exceeds exact aggregation precision.'), { code: 'WIP_MOVEMENT_QUANTITY_PRECISION' });
  return units / 10000;
};

// Classification enriches each source row; candidate rows never contribute quantities.
export async function classifyWipMovements(pool, config, sourceRows, filters, { closedSerieSql, prepareClosedRequest }) {
  const closed = new Map();
  const jobs = [...new Set(sourceRows.map(row => row.jobName).filter(Boolean))];
  const selectedSeries = Array.isArray(filters.serie) ? filters.serie : filters.serie ? [filters.serie] : [];
  for (let offset = 0; offset < jobs.length; offset += batchLimit) {
    const request = requestFor(pool, config); prepareClosedRequest(request);
    const batch = jobs.slice(offset, offset + batchLimit);
    const parameters = batch.map((job, i) => { request.input(`job${i}`, sql.NVarChar(4000), job); return `@job${i}`; });
    const seriesParameters = selectedSeries.map((series, i) => { request.input(`series${i}`, sql.NVarChar(4000), series); return `@series${i}`; });
    const selectedMatch = seriesParameters.length ? `MAX(CASE WHEN ${closedSerieSql} IN (${seriesParameters.join(',')}) THEN 1 ELSE 0 END)` : '1';
    const result = await request.query(`/* wip:closed-metadata */
      SELECT [requested].[jobName] AS jobName,
        MIN(CASE WHEN [seriesLookup].${quoted(config.productLookupColumn)} = N'NEO' THEN ${closedSerieSql} END) AS neoSeries,
        MIN(CASE WHEN [seriesLookup].${quoted(config.productLookupColumn)} = N'SC' THEN ${closedSerieSql} END) AS scSeries,
        MAX(CASE WHEN [seriesLookup].${quoted(config.productLookupColumn)} = N'NEO' THEN 1 ELSE 0 END) AS neoMatched,
        MAX(CASE WHEN [seriesLookup].${quoted(config.productLookupColumn)} = N'SC' THEN 1 ELSE 0 END) AS scMatched,
        MIN(${closedSerieSql}) AS allSeries, COUNT_BIG(*) AS closedMatches,
        ${selectedMatch} AS selectedSeriesMatched
      FROM ${quoted(config.serieLookupView)} AS [seriesLookup]
      INNER JOIN (VALUES ${parameters.map((parameter, i) => `(${parameter},${i})`).join(',')}) AS [requested]([jobName],[ordinal])
        ON [seriesLookup].${quoted(config.serieLookupJoinColumn)} = [requested].[jobName]
      WHERE [seriesLookup].${quoted(config.serieLookupJoinColumn)} IN (${parameters.join(',')})
      GROUP BY [requested].[jobName],[requested].[ordinal]`);
    for (const row of result.recordset) closed.set(String(row.jobName), row);
  }

  const identityCounts = new Map();
  for (const row of sourceRows) identityCounts.set(sourceIdentity(row), (identityCounts.get(sourceIdentity(row)) || 0) + 1);
  const missing = sourceRows.map((row, eventIndex) => ({ ...row, eventIndex })).filter(row => !closed.has(String(row.jobName))
    && validIdentity(row) && identityCounts.get(sourceIdentity(row)) === 1);
  const candidates = new Map();
  for (let offset = 0; offset < missing.length; offset += batchLimit) {
    const request = requestFor(pool, config);
    const batch = missing.slice(offset, offset + batchLimit);
    const values = batch.map((row, i) => {
      const inputs = [
        ['plant', sql.Int, row.plantId], ['job', sql.NVarChar(50), row.jobName],
        ['time', sql.DateTime, row.occurredOn], ['part', sql.VarChar(80), row.sourcePartNumber ?? row.partNumber],
        ['fromOp', sql.VarChar(80), row.chartName], ['toOp', sql.VarChar(80), row.processName],
        ['code', sql.VarChar(80), row.dispositionCode], ['type', sql.VarChar(80), row.dispositionType],
        ['qty', sql.Decimal(18, 4), row.quantityMoved]
      ];
      for (const [name, type, value] of inputs) request.input(`${name}${i}`, type, value);
      return `(${row.eventIndex},${inputs.map(([name]) => `@${name}${i}`).join(',')})`;
    });
    request.input('minimumTime', sql.DateTime, new Date(Math.min(...batch.map(row => new Date(row.occurredOn).getTime()))));
    request.input('maximumTime', sql.DateTime, new Date(Math.max(...batch.map(row => new Date(row.occurredOn).getTime()))));
    const result = await request.query(`/* wip:action-metadata */
      SELECT DISTINCT [events].[eventIndex], UPPER(RTRIM([action].[ProdType])) AS product, [action].[ProdLine] AS prodLine,
        REPLACE(REPLACE(REPLACE([action].[ProdLine],N'Ta NEO Capacitor ',N''),N' series ',N' '),N' case',N'') AS seriesName,
        CASE WHEN [action].[ProdLine] LIKE N'Ta NEO Capacitor % series % case' THEN 1 ELSE 0 END AS supportedNeoLine,
        [releaseIdentity].[releaseIdentityCount]
      FROM (VALUES ${values.join(',')}) AS [events]([eventIndex],[plantId],[jobName],[occurredOn],[partNumber],[fromOperation],[toOperation],[dispositionCode],[dispositionType],[quantityMoved])
      INNER JOIN ${quoted(config.wipActionView)} AS [action]
        ON [action].[JobName] = [events].[jobName] AND [action].[OccuredOn] = [events].[occurredOn]
        AND [action].[From_ItemName] = [events].[partNumber]
        AND [action].[From_OperationName] = [events].[fromOperation] AND [action].[To_OperationName] = [events].[toOperation]
        AND [action].[DispositionCode] = [events].[dispositionCode] AND [action].[DispositionType] = [events].[dispositionType]
        AND TRY_CONVERT(decimal(18,4),[action].[QuantityMoved]) = [events].[quantityMoved]
      INNER JOIN ${quoted(config.wipReleasedView)} AS [released]
        ON [released].[OrganizationByPlantID] = [events].[plantId] AND [released].[LotID] = [events].[jobName]
        AND [released].[PartNumber] = [events].[partNumber] AND [released].[ProdLine] = [action].[ProdLine]
      CROSS APPLY (
        SELECT COUNT_BIG(*) AS releaseIdentityCount
        FROM ${quoted(config.wipReleasedView)} AS [identity]
        WHERE [identity].[OrganizationByPlantID] = [events].[plantId] AND [identity].[LotID] = [events].[jobName]
      ) AS [releaseIdentity]
      WHERE [action].[JobName] IN (${batch.map((_, i) => `@job${i}`).join(',')})
        AND [action].[OccuredOn] >= @minimumTime AND [action].[OccuredOn] <= @maximumTime`);
    for (const candidate of result.recordset) {
      const eventCandidates = candidates.get(Number(candidate.eventIndex)) || new Map();
      eventCandidates.set(JSON.stringify([candidate.product, candidate.prodLine, candidate.seriesName, candidate.supportedNeoLine, candidate.releaseIdentityCount]), candidate);
      candidates.set(Number(candidate.eventIndex), eventCandidates);
    }
  }

  const diagnostics = { sourceMovements: sourceRows.length, closedClassified: 0, fallbackResolved: 0, unresolved: 0, reasons: {}, unresolvedByOperation: {} };
  const unresolved = (row, reason) => {
    diagnostics.unresolved++; diagnostics.reasons[reason] = (diagnostics.reasons[reason] || 0) + 1;
    const operation = row.chartName || 'Unspecified';
    const count = diagnostics.unresolvedByOperation[operation] ||= { movements: 0, quantityMoved: 0 };
    count.movements++; count.quantityMoved = addQuantity(count.quantityMoved, row.quantityMoved);
  };
  const rows = sourceRows.map((row, eventIndex) => {
    const metadata = closed.get(String(row.jobName));
    if (metadata) {
      diagnostics.closedClassified++;
      return { ...row, classification: 'closed', neoSeries: metadata.neoSeries == null ? Number(metadata.neoMatched) === 1 ? 'Unspecified' : undefined : String(metadata.neoSeries).trim() || 'Unspecified',
        scSeries: metadata.scSeries == null ? Number(metadata.scMatched) === 1 ? 'Unspecified' : undefined : String(metadata.scSeries).trim() || 'Unspecified',
        chartSeries: String(metadata.allSeries || '').trim() || 'Unspecified',
        chartSeriesSelected: !selectedSeries.length || Number(metadata.selectedSeriesMatched) === 1 };
    }
    if (!validIdentity(row)) { unresolved(row, 'missingSourceIdentity'); return undefined; }
    if (identityCounts.get(sourceIdentity(row)) !== 1) { unresolved(row, 'ambiguousSourceIdentity'); return undefined; }
    const matches = [...(candidates.get(eventIndex)?.values() || [])];
    if (matches.length !== 1) { unresolved(row, matches.length ? 'ambiguous' : 'missingVerifiedAction'); return undefined; }
    const match = matches[0];
    if (Number(match.releaseIdentityCount) !== 1) { unresolved(row, 'ambiguousReleaseIdentity'); return undefined; }
    if (match.product === 'SC') { unresolved(row, 'unsupportedScSeries'); return undefined; }
    if (match.product !== 'NEO') { unresolved(row, 'unsupportedProduct'); return undefined; }
    const series = String(match.seriesName || '').trim();
    if (Number(match.supportedNeoLine) !== 1 || !series) { unresolved(row, 'unsupportedNeoSeries'); return undefined; }
    diagnostics.fallbackResolved++;
    return { ...row, classification: 'action', neoSeries: series, chartSeries: series, chartSeriesSelected: !selectedSeries.length || selectedSeries.includes(series) };
  }).filter(Boolean);
  return { rows, diagnostics };
}

export function wipQuantityRows(rows, filters, { keepJobs = false } = {}) {
  if (filters.product && !['NEO', 'SC'].includes(filters.product)) return [];
  const selected = Array.isArray(filters.serie) ? filters.serie : filters.serie ? [filters.serie] : [];
  const groups = new Map();
  for (const row of rows) {
    const series = filters.product === 'SC' ? row.scSeries : filters.product === 'NEO' ? row.neoSeries : row.chartSeries;
    if (!series || (selected.length && !selected.includes(series))) continue;
    const key = JSON.stringify([row.bucketDate, series, keepJobs ? row.jobName : null]);
    const existing = groups.get(key);
    if (existing) existing.quantityMoved = addQuantity(existing.quantityMoved, row.quantityMoved);
    else groups.set(key, { bucketDate: row.bucketDate, itemName: series, ...(keepJobs ? { jobName: String(row.jobName) } : {}), quantityMoved: addQuantity(0, row.quantityMoved) });
  }
  return [...groups.values()].sort((a, b) => `${a.bucketDate}|${a.itemName}|${a.jobName || ''}`.localeCompare(`${b.bucketDate}|${b.itemName}|${b.jobName || ''}`));
}

export function wipChartRows(rows, filters, config, daily, includePartNumber) {
  if (filters.product && !['NEO', 'SC'].includes(filters.product)) return [];
  const groups = new Map();
  for (const row of rows) {
    if (filters.product === 'NEO' && !row.neoSeries || filters.product === 'SC' && !row.scSeries) continue;
    const excludedValues = config.chartExcludedValues || [];
    const excluded = row.chartEligible == null
      ? excludedValues.includes(row.chartName) || (excludedValues.length > 0 && row.chartName == null)
      : Number(row.chartEligible) !== 1;
    if (!row.chartSeriesSelected || excluded) continue;
    const key = JSON.stringify([daily ? row.bucketDate : null, row.chartName, row.chartSeries, includePartNumber ? row.partNumber : null]);
    const existing = groups.get(key);
    if (existing) {
      existing.quantityMoved = addQuantity(existing.quantityMoved, row.quantityMoved);
      for (const name of ['fromRouteStepName', 'toRouteStepName']) if (row[name] != null && (existing[name] == null || String(row[name]) < existing[name])) existing[name] = String(row[name]);
      for (const name of ['fromRouteStepOrder', 'toRouteStepOrder', 'fromRouteSequence', 'toRouteSequence']) if (row[name] != null && (existing[name] == null || Number(row[name]) < existing[name])) existing[name] = Number(row[name]);
    } else groups.set(key, { ...(daily ? { bucketDate: row.bucketDate } : {}), chartName: String(row.chartName || '').trim() || 'Unspecified', seriesName: row.chartSeries,
      ...(includePartNumber ? { partNumber: row.partNumber || null } : {}),
      fromRouteStepName: row.fromRouteStepName == null ? undefined : String(row.fromRouteStepName), toRouteStepName: row.toRouteStepName == null ? undefined : String(row.toRouteStepName),
      fromRouteStepOrder: row.fromRouteStepOrder == null ? undefined : Number(row.fromRouteStepOrder), toRouteStepOrder: row.toRouteStepOrder == null ? undefined : Number(row.toRouteStepOrder),
      fromRouteSequence: row.fromRouteSequence == null ? undefined : Number(row.fromRouteSequence), toRouteSequence: row.toRouteSequence == null ? undefined : Number(row.toRouteSequence),
      quantityMoved: addQuantity(0, row.quantityMoved) });
  }
  return [...groups.values()].map(row => ({ ...row, fromRouteStepName: row.fromRouteStepName || '', toRouteStepName: row.toRouteStepName || '' }))
    .sort((a,b) => a.chartName.localeCompare(b.chartName) || a.seriesName.localeCompare(b.seriesName));
}
