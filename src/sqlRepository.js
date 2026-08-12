import sql from 'mssql';
import { InteractiveBrowserCredential } from '@azure/identity';

const OPTION_LIMIT = 1000;
const tokenCache = new Map();
const tokenRequests = new Map();
const credentialCache = new Map();
const connectionPools = new Map();
const connectionRequests = new Map();
const connectionGenerations = new Map();
const connectionExpiresAt = new Map();
const connectionRefreshBufferMs = 5 * 60 * 1000;
const serieFallbackRequests = new WeakSet();

function quoted(identifier) {
  return identifier.split('.').map((part) => `[${part}]`).join('.');
}

function sourceColumn(column) {
  return quoted(`source.${column}`);
}

function addSerieBlankFallbackParameters(request, config) {
  if (serieFallbackRequests.has(request)) return;
  if (config.serieBlankProduct && config.serieBlankValue) {
    request.input('serieBlankProduct', sql.NVarChar(4000), config.serieBlankProduct);
    request.input('serieBlankValue', sql.NVarChar(4000), config.serieBlankValue);
  }
  if (config.serieBlankSourceProduct && config.serieBlankSourceColumn) {
    request.input('serieBlankSourceProduct', sql.NVarChar(4000), config.serieBlankSourceProduct);
  }
  serieFallbackRequests.add(request);
}

function normalizedSerieExpression(config, alias, productColumn) {
  const serieColumn = quoted(`${alias}.${config.serieColumn}`);
  if (!productColumn) return serieColumn;
  const serie = `CAST(${serieColumn} AS nvarchar(4000))`;
  const product = quoted(`${alias}.${productColumn}`);
  const isBlank = `NULLIF(LTRIM(RTRIM(${serie})), N'') IS NULL`;
  const fallbacks = [];
  if (config.serieBlankProduct && config.serieBlankValue) {
    fallbacks.push(`WHEN ${product} = @serieBlankProduct AND ${isBlank} THEN @serieBlankValue`);
  }
  if (config.serieBlankSourceProduct && config.serieBlankSourceColumn) {
    const sourceColumn = `CAST(${quoted(`${alias}.${config.serieBlankSourceColumn}`)} AS nvarchar(4000))`;
    const sourceValue = config.serieBlankSourceFormat === 'neo-capacitor'
      ? `REPLACE(REPLACE(REPLACE(${sourceColumn}, N'Ta NEO Capacitor ', N''), N' series ', N' '), N' case', N'')`
      : sourceColumn;
    const source = `NULLIF(LTRIM(RTRIM(${sourceValue})), N'')`;
    fallbacks.push(`WHEN ${product} = @serieBlankSourceProduct AND ${isBlank} THEN COALESCE(${source}, N'Unspecified')`);
  }
  return fallbacks.length ? `CASE ${fallbacks.join(' ')} ELSE ${serie} END` : serieColumn;
}

function sourceSerieExpression(config) {
  return normalizedSerieExpression(config, 'source', config.processColumn);
}

function lookupSerieExpression(config) {
  return normalizedSerieExpression(config, 'seriesLookup', config.productLookupColumn);
}

function hasSeriesLookup(config) {
  return Boolean(config.serieLookupView && config.serieSourceJoinColumn && config.serieLookupJoinColumn && config.serieColumn);
}

function seriesLookupDefinition(config) {
  if (!hasSeriesLookup(config)) return undefined;
  const lookupSerie = lookupSerieExpression(config);
  const sourceJoin = sourceColumn(config.serieSourceJoinColumn);
  const lookupJoin = quoted(`seriesLookup.${config.serieLookupJoinColumn}`);
  return {
    column: `COALESCE([seriesLookup].[serieName], N'Unspecified')`,
    join: `INNER JOIN (SELECT ${lookupJoin} AS [joinValue], MIN(CAST(${lookupSerie} AS nvarchar(4000))) AS [serieName] FROM ${quoted(config.serieLookupView)} AS [seriesLookup] GROUP BY ${lookupJoin}) AS [seriesLookup] ON ${sourceJoin} = [seriesLookup].[joinValue]`
  };
}

function quantityGroupDefinition(config) {
  const configuredColumn = config.groupColumn || config.pnColumn;
  if (configuredColumn === config.serieColumn && config.serieActionFallbackView && config.serieActionFallbackJobColumn && config.serieActionFallbackLineColumn && config.serieActionFallbackSourceJobColumn) {
    const rawSerie = `CAST(${sourceColumn(config.serieColumn)} AS nvarchar(4000))`;
    const missing = `${sourceColumn(config.processColumn)} = @serieBlankSourceProduct AND (NULLIF(LTRIM(RTRIM(${rawSerie})), N'') IS NULL OR UPPER(LTRIM(RTRIM(${rawSerie}))) = N'UNSPECIFIED')`;
    const actionLine = `CAST([actionSerie].[prodLine] AS nvarchar(4000))`;
    const actionValue = config.serieBlankSourceFormat === 'neo-capacitor' ? `REPLACE(REPLACE(REPLACE(${actionLine}, N'Ta NEO Capacitor ', N''), N' series ', N' '), N' case', N'')` : actionLine;
    const actionSerie = `NULLIF(LTRIM(RTRIM(${actionValue})), N'')`;
    return {
      column: `CASE WHEN ${missing} THEN COALESCE(${actionSerie}, N'Unspecified') ELSE ${sourceSerieExpression(config)} END`,
      join: `OUTER APPLY (SELECT TOP (1) CAST(${quoted(`action.${config.serieActionFallbackLineColumn}`)} AS nvarchar(4000)) AS [prodLine] FROM ${quoted(config.serieActionFallbackView)} AS [action] WHERE ${quoted(`action.${config.serieActionFallbackJobColumn}`)} = ${sourceColumn(config.serieActionFallbackSourceJobColumn)} AND (NULLIF(LTRIM(RTRIM(${rawSerie})), N'') IS NULL OR UPPER(LTRIM(RTRIM(${rawSerie}))) = N'UNSPECIFIED') AND NULLIF(LTRIM(RTRIM(CAST(${quoted(`action.${config.serieActionFallbackLineColumn}`)} AS nvarchar(4000)))), N'') IS NOT NULL) AS [actionSerie]`
    };
  }
  if (!hasSeriesLookup(config) || configuredColumn !== config.serieColumn) {
    return { column: configuredColumn === config.serieColumn ? sourceSerieExpression(config) : sourceColumn(configuredColumn), join: '' };
  }
  return seriesLookupDefinition(config);
}

function addFilter(request, column, value, parameterName, clauses) {
  if (column && value) {
    request.input(parameterName, sql.NVarChar(4000), value);
    clauses.push(`${column} = @${parameterName}`);
  }
}

function addConfiguredFilters(request, config, clauses) {
  addFilter(request, config.dispositionColumn && `source.${config.dispositionColumn}`, config.dispositionValue, 'disposition', clauses);
}

function addCompletionProdLineExclusion(request, config, clauses) {
  if (!config.excludedProdLineColumn || !config.excludedProdLineValue) return;
  request.input('excludedProdLinePrefix', sql.NVarChar(4000), `${config.excludedProdLineValue.replace(/\s*\([^)]*\)\s*$/, '').trim()}%`);
  clauses.push(`LTRIM(RTRIM(COALESCE(CAST(${sourceColumn(config.excludedProdLineColumn)} AS nvarchar(4000)), N''))) NOT LIKE @excludedProdLinePrefix`);
}

function addSeriesFilter(request, config, value, clauses) {
  if (!value) return;
  const values = Array.isArray(value) ? value : [value];
  const parameters = values.map((serie, index) => {
    const parameterName = `serie${index}`;
    request.input(parameterName, sql.NVarChar(4000), serie);
    return `@${parameterName}`;
  });
  if (config.serieActionFallbackView && config.serieActionFallbackJobColumn && config.serieActionFallbackLineColumn && config.serieActionFallbackSourceJobColumn) {
    const rawSerie = `CAST(${sourceColumn(config.serieColumn)} AS nvarchar(4000))`;
    const missing = `${sourceColumn(config.processColumn)} = @serieBlankSourceProduct AND (NULLIF(LTRIM(RTRIM(${rawSerie})), N'') IS NULL OR UPPER(LTRIM(RTRIM(${rawSerie}))) = N'UNSPECIFIED')`;
    const actionLine = `CAST(${quoted(`action.${config.serieActionFallbackLineColumn}`)} AS nvarchar(4000))`;
    const actionValue = config.serieBlankSourceFormat === 'neo-capacitor' ? `REPLACE(REPLACE(REPLACE(${actionLine}, N'Ta NEO Capacitor ', N''), N' series ', N' '), N' case', N'')` : actionLine;
    clauses.push(`(${rawSerie} IN (${parameters.join(', ')}) OR (${missing} AND EXISTS (SELECT 1 FROM ${quoted(config.serieActionFallbackView)} AS [action] WHERE ${quoted(`action.${config.serieActionFallbackJobColumn}`)} = ${sourceColumn(config.serieActionFallbackSourceJobColumn)} AND NULLIF(LTRIM(RTRIM(${actionValue})), N'') IN (${parameters.join(', ')}))))`);
    return;
  }
  if (!hasSeriesLookup(config)) {
    addSerieBlankFallbackParameters(request, config);
    clauses.push(`${sourceSerieExpression(config)} IN (${parameters.join(', ')})`);
    return;
  }
  addSerieBlankFallbackParameters(request, config);
  clauses.push(`EXISTS (SELECT 1 FROM ${quoted(config.serieLookupView)} AS [seriesLookup] WHERE ${sourceColumn(config.serieSourceJoinColumn)} = ${quoted(`seriesLookup.${config.serieLookupJoinColumn}`)} AND ${lookupSerieExpression(config)} IN (${parameters.join(', ')}))`);
}

function addProductFilter(request, config, value, clauses) {
  if (!value) return;
  if (hasSeriesLookup(config) && config.productLookupColumn) {
    request.input('product', sql.NVarChar(4000), value);
    clauses.push(`EXISTS (SELECT 1 FROM ${quoted(config.serieLookupView)} AS [productLookup] WHERE ${sourceColumn(config.serieSourceJoinColumn)} = ${quoted(`productLookup.${config.serieLookupJoinColumn}`)} AND ${quoted(`productLookup.${config.productLookupColumn}`)} = @product)`);
    return;
  }
  addFilter(request, config.processColumn && sourceColumn(config.processColumn), value, 'product', clauses);
}

function addFilterForKey(request, config, key, value, clauses) {
  if (key === 'product') return addProductFilter(request, config, value, clauses);
  if (key === 'serie') return addSeriesFilter(request, config, value, clauses);
  const columns = { process: config.processColumn, case: config.caseColumn, pn: config.pnColumn };
  addFilter(request, columns[key] && `source.${columns[key]}`, value, key, clauses);
}

function authenticationSuccessPage(appUrl) {
  const redirectUrl = JSON.stringify(appUrl);
  return `<!doctype html><html><head><meta http-equiv="refresh" content="1;url=${appUrl}" /></head><body><p>Sign-in complete. Returning to the dashboard...</p><script>window.location.replace(${redirectUrl});</script></body></html>`;
}

async function getAccessToken(tenantId, appUrl, forceRefresh = false) {
  const key = tenantId || 'common';
  const cached = tokenCache.get(key);
  if (!forceRefresh && cached && cached.expiresOnTimestamp > Date.now() + 120000) return cached.token;
  // A sign-in is interactive, so all callers for one tenant must share the
  // same in-flight request. A forced refresh bypasses only the cached token.
  if (tokenRequests.has(key)) return tokenRequests.get(key);
  const request = (async () => {
    let credential = credentialCache.get(key);
    if (!credential) {
      credential = new InteractiveBrowserCredential({
        tenantId,
        browserCustomizationOptions: { successMessage: authenticationSuccessPage(appUrl) }
      });
      credentialCache.set(key, credential);
    }
    const token = await credential.getToken('https://database.windows.net//.default');
    if (!token) throw new Error('No Microsoft Entra access token was returned.');
    tokenCache.set(key, { token: token.token, expiresOnTimestamp: token.expiresOnTimestamp || Date.now() + 300000 });
    return token.token;
  })().finally(() => tokenRequests.delete(key));
  tokenRequests.set(key, request);
  return request;
}

function connectionKey(config) {
  return JSON.stringify([
    config.server,
    config.database,
    config.auth,
    config.tenantId || 'common',
    config.trustServerCertificate,
    config.requestTimeout
  ]);
}

function connectionGeneration(key) {
  return connectionGenerations.get(key) || 0;
}

async function closeSharedPool(key) {
  const pool = connectionPools.get(key);
  connectionPools.delete(key);
  connectionExpiresAt.delete(key);
  connectionGenerations.set(key, connectionGeneration(key) + 1);
  if (pool) await pool.close();
}

async function getSharedPool(config, forceRefresh = false) {
  if (config.auth !== 'ActiveDirectoryInteractive') {
    throw new Error('Unsupported database authentication mode.');
  }

  const key = connectionKey(config);
  if (forceRefresh) await closeSharedPool(key);
  const existing = connectionPools.get(key);
  const refreshNeeded = Boolean(existing && (connectionExpiresAt.get(key) || 0) <= Date.now() + connectionRefreshBufferMs);
  if (existing && !refreshNeeded) return { key, pool: existing, generation: connectionGeneration(key) };
  if (existing) await closeSharedPool(key);
  const requestGeneration = connectionGeneration(key);
  const pending = connectionRequests.get(key);
  if (pending?.generation === requestGeneration) return pending.promise;

  const request = (async () => {
    let pool;
    try {
      const token = await getAccessToken(config.tenantId, config.appUrl, forceRefresh || refreshNeeded);
      pool = new sql.ConnectionPool({
        server: config.server,
        database: config.database,
        requestTimeout: config.requestTimeout,
        options: { encrypt: true, trustServerCertificate: config.trustServerCertificate },
        authentication: { type: 'azure-active-directory-access-token', options: { token } }
      });
      pool.on('error', () => {
        if (connectionPools.get(key) === pool) connectionPools.delete(key);
      });
      await pool.connect();
      if (requestGeneration !== connectionGeneration(key)) {
        await pool.close();
        return getSharedPool(config);
      }
      connectionPools.set(key, pool);
      connectionExpiresAt.set(key, tokenCache.get(config.tenantId || 'common')?.expiresOnTimestamp || Date.now() + 300000);
      return { key, pool, generation: requestGeneration };
    } catch (error) {
      if (pool) await pool.close().catch(() => undefined);
      throw error;
    }
  })();
  connectionRequests.set(key, { generation: requestGeneration, promise: request });
  request.finally(() => {
    if (connectionRequests.get(key)?.promise === request) connectionRequests.delete(key);
  }).catch(() => undefined);
  return request;
}

export class SqlRepository {
  constructor(config) {
    this.config = config;
    this.pool = undefined;
    this.poolGeneration = undefined;
    this.linkedSeriesCache = new Map();
  }

  async getPool(forceRefresh = false) {
    const key = connectionKey(this.config);
    const generation = connectionGeneration(key);
    const isInjectedTestPool = this.pool && this.poolGeneration === undefined && !connectionPools.has(key);
    if (!forceRefresh && (isInjectedTestPool || (this.pool && this.poolGeneration === generation && connectionPools.get(key) === this.pool))) {
      return this.pool;
    }
    const connection = await getSharedPool(this.config, forceRefresh);
    this.pool = connection.pool;
    this.poolGeneration = connection.generation;
    return this.pool;
  }

  async authenticate() {
    await this.resetConnection();
    await this.getPool(true);
  }

  async resetConnection() {
    this.pool = undefined;
    this.poolGeneration = undefined;
    await closeSharedPool(connectionKey(this.config));
  }

  async getColumns() {
    const pool = await this.getPool();
    try {
      const result = await pool.request().query(`SELECT TOP (0) * FROM ${quoted(this.config.view)}`);
      return Object.values(result.recordset.columns || {}).map((column) => ({
        name: column.name,
        type: String(column.type?.name || 'unknown').toLowerCase()
      }));
    } catch (error) {
      if (!/Invalid object name/i.test(error.message)) throw error;
      const request = pool.request();
      request.input('objectName', sql.NVarChar(128), this.config.view.split('.').at(-1));
      const result = await request.query(`
        SELECT TABLE_SCHEMA AS schemaName, TABLE_NAME AS objectName, TABLE_TYPE AS objectType
        FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_NAME LIKE '%' + @objectName + '%'
        ORDER BY TABLE_SCHEMA, TABLE_NAME`);
      return { columns: [], matchingObjects: result.recordset };
    }
  }

  async findObjects(search) {
    const pool = await this.getPool();
    const request = pool.request();
    request.input('search', sql.NVarChar(128), search);
    const result = await request.query(`
      SELECT TABLE_SCHEMA AS schemaName, TABLE_NAME AS objectName, TABLE_TYPE AS objectType
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_NAME LIKE '%' + @search + '%'
      ORDER BY TABLE_SCHEMA, TABLE_NAME`);
    return result.recordset;
  }

  async findColumns(search) {
    const pool = await this.getPool();
    const request = pool.request();
    request.input('search', sql.NVarChar(128), search);
    const result = await request.query(`
      SELECT TABLE_SCHEMA AS schemaName, TABLE_NAME AS objectName, COLUMN_NAME AS columnName, DATA_TYPE AS dataType
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE COLUMN_NAME LIKE '%' + @search + '%'
      ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`);
    return result.recordset;
  }

  async getObjectColumns(objectName) {
    const pool = await this.getPool();
    const request = pool.request();
    request.input('objectName', sql.NVarChar(128), objectName);
    const result = await request.query(`
      SELECT TABLE_SCHEMA AS schemaName, TABLE_NAME AS objectName, COLUMN_NAME AS columnName, DATA_TYPE AS dataType
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = @objectName
      ORDER BY TABLE_SCHEMA, ORDINAL_POSITION`);
    return result.recordset;
  }

  async getPartNumbers(filters = {}, search = '', offset = 0, limit = 100) {
    const pool = await this.getPool();
    const request = pool.request();
    const pnColumn = sourceColumn(this.config.pnColumn);
    const clauses = [`${pnColumn} IS NOT NULL`, `CAST(${pnColumn} AS nvarchar(4000)) <> ''`];
    addConfiguredFilters(request, this.config, clauses);
    addFilterForKey(request, this.config, 'product', filters.product, clauses);
    addFilterForKey(request, this.config, 'process', filters.process, clauses);
    addFilterForKey(request, this.config, 'serie', filters.serie, clauses);
    addFilterForKey(request, this.config, 'case', filters.case, clauses);
    if (search) {
      request.input('pnSearch', sql.NVarChar(200), search);
      clauses.push(`CAST(${pnColumn} AS nvarchar(4000)) LIKE '%' + @pnSearch + '%'`);
    }
    request.input('offset', sql.Int, offset);
    const result = await request.query(`
      SELECT CAST(${pnColumn} AS nvarchar(4000)) AS value
      FROM ${quoted(this.config.view)} AS [source]
      WHERE ${clauses.join(' AND ')}
      GROUP BY CAST(${pnColumn} AS nvarchar(4000))
      ORDER BY value ASC
      OFFSET @offset ROWS FETCH NEXT ${limit + 1} ROWS ONLY`);
    const values = result.recordset.map((row) => row.value);
    return { items: values.slice(0, limit), hasMore: values.length > limit };
  }

  async getOptions(filters = {}, includePartNumbers = true) {
    const pool = await this.getPool();
    const columns = {
      process: this.config.processColumn && sourceColumn(this.config.processColumn),
      serie: this.config.serieColumn && sourceColumn(this.config.serieColumn),
      case: this.config.caseColumn && sourceColumn(this.config.caseColumn),
      pn: includePartNumbers && this.config.pnColumn ? sourceColumn(this.config.pnColumn) : undefined
    };
    const dependencies = {
      process: [],
      serie: ['process'],
      case: ['process', 'serie'],
      pn: ['process', 'serie', 'case']
    };
    const entries = await Promise.all(Object.entries(columns).map(async ([key, column]) => {
      if (key === 'serie' && hasSeriesLookup(this.config)) return [key, await this.getSeriesOptions(pool, filters.product)];
      if (!column) return [key, []];
      const request = pool.request();
      const optionColumn = key === 'serie' ? sourceSerieExpression(this.config) : column;
      if (key === 'serie') addSerieBlankFallbackParameters(request, this.config);
      const clauses = [`${optionColumn} IS NOT NULL`, `CAST(${optionColumn} AS nvarchar(4000)) <> ''`];
      addConfiguredFilters(request, this.config, clauses);
      addFilterForKey(request, this.config, 'product', filters.product, clauses);
      dependencies[key].forEach((filterName) => {
        const filterColumn = columns[filterName];
        const value = filters[filterName];
        if (filterColumn && value) addFilterForKey(request, this.config, filterName, value, clauses);
      });
      const result = await request.query(`
        SELECT TOP (${OPTION_LIMIT}) CAST(${optionColumn} AS nvarchar(4000)) AS value
        FROM ${quoted(this.config.view)} AS [source]
        WHERE ${clauses.join(' AND ')}
        GROUP BY CAST(${optionColumn} AS nvarchar(4000))
        ORDER BY value ASC`);
      return [key, result.recordset.map((row) => row.value)];
    }));
    return Object.fromEntries(entries);
  }

  async getSeriesOptions(pool, product) {
    const request = pool.request();
    addSerieBlankFallbackParameters(request, this.config);
    const lookupSeries = lookupSerieExpression(this.config);
    const productClause = product && this.config.productLookupColumn ? (() => { request.input('product', sql.NVarChar(4000), product); return ` AND ${quoted(`seriesLookup.${this.config.productLookupColumn}`)} = @product`; })() : '';
    const result = await request.query(`
      SELECT TOP (${OPTION_LIMIT}) CAST(${lookupSeries} AS nvarchar(4000)) AS value
      FROM ${quoted(this.config.serieLookupView)} AS [seriesLookup]
      WHERE ${lookupSeries} IS NOT NULL AND CAST(${lookupSeries} AS nvarchar(4000)) <> ''${productClause}
      GROUP BY CAST(${lookupSeries} AS nvarchar(4000))
      ORDER BY value ASC`);
    return result.recordset.map((row) => row.value);
  }

  async getQuantity(filters) {
    const pool = await this.getPool();
    const configuredGroupColumn = this.config.groupColumn || this.config.pnColumn;
    const usesLinkedSeries = hasSeriesLookup(this.config) && configuredGroupColumn === this.config.serieColumn && !this.config.serieActionFallbackView;
    if (usesLinkedSeries) return this.getLinkedSeriesQuantity(pool, filters);
    const request = pool.request();
    addSerieBlankFallbackParameters(request, this.config);
    request.input('startDate', sql.Date, filters.startDate);
    request.input('endDate', sql.Date, filters.endDate);
    const dateColumn = sourceColumn(this.config.dateColumn);
    const clauses = [`${dateColumn} >= @startDate`, `${dateColumn} < DATEADD(day, 1, @endDate)`];
    addConfiguredFilters(request, this.config, clauses);
    addCompletionProdLineExclusion(request, this.config, clauses);
    addFilterForKey(request, this.config, 'product', filters.product, clauses);
    addFilterForKey(request, this.config, 'process', filters.process, clauses);
    addFilterForKey(request, this.config, 'serie', filters.serie, clauses);
    addFilterForKey(request, this.config, 'case', filters.case, clauses);
    addFilterForKey(request, this.config, 'pn', filters.pn, clauses);
    const usesActionSerieFallback = Boolean(this.config.serieActionFallbackView && this.config.serieActionFallbackJobColumn && this.config.serieActionFallbackLineColumn && this.config.serieActionFallbackSourceJobColumn && configuredGroupColumn === this.config.serieColumn && filters.product === this.config.serieBlankSourceProduct);
    const group = quantityGroupDefinition(this.config);
    const groupColumn = group.column;
    const quantityColumn = sourceColumn(this.config.quantityColumn);
    const query = usesActionSerieFallback ? (() => {
      const rawSerie = `CAST(${sourceColumn(this.config.serieColumn)} AS nvarchar(4000))`;
      const missing = `${sourceColumn(this.config.processColumn)} = @serieBlankSourceProduct AND (NULLIF(LTRIM(RTRIM(${rawSerie})), N'') IS NULL OR UPPER(LTRIM(RTRIM(${rawSerie}))) = N'UNSPECIFIED')`;
      const actionLine = `CAST([actionSerie].[prodLine] AS nvarchar(4000))`;
      const actionValue = this.config.serieBlankSourceFormat === 'neo-capacitor' ? `REPLACE(REPLACE(REPLACE(${actionLine}, N'Ta NEO Capacitor ', N''), N' series ', N' '), N' case', N'')` : actionLine;
      const resolvedSerie = `CASE WHEN ${missing} THEN COALESCE(NULLIF(LTRIM(RTRIM(${actionValue})), N''), N'Unspecified') ELSE ${sourceSerieExpression(this.config)} END`;
      const actionJob = quoted(`action.${this.config.serieActionFallbackJobColumn}`);
      const actionLineColumn = quoted(`action.${this.config.serieActionFallbackLineColumn}`);
      const sourceJob = sourceColumn(this.config.serieActionFallbackSourceJobColumn);
      return `
        WITH [filtered] AS (
          SELECT [source].*
          FROM ${quoted(this.config.view)} AS [source]
          WHERE ${clauses.join(' AND ')}
        ), [fallbackJobs] AS (
          SELECT DISTINCT ${sourceJob} AS [jobName]
          FROM [filtered] AS [source]
          WHERE ${missing}
        ), [actionSeries] AS (
          SELECT ${actionJob} AS [jobName], MIN(CAST(${actionLineColumn} AS nvarchar(4000))) AS [prodLine]
          FROM ${quoted(this.config.serieActionFallbackView)} AS [action]
          INNER JOIN [fallbackJobs] AS [jobs] ON ${actionJob} = [jobs].[jobName]
          WHERE NULLIF(LTRIM(RTRIM(CAST(${actionLineColumn} AS nvarchar(4000)))), N'') IS NOT NULL
          GROUP BY ${actionJob}
        )
        SELECT
          CONVERT(varchar(10), CAST(${dateColumn} AS date), 23) AS bucketDate,
          CAST(${resolvedSerie} AS nvarchar(4000)) AS itemName,
          SUM(TRY_CONVERT(decimal(18, 4), ${quantityColumn})) AS quantityMoved
        FROM [filtered] AS [source]
        LEFT JOIN [actionSeries] AS [actionSerie] ON ${sourceJob} = [actionSerie].[jobName]
        GROUP BY CAST(${dateColumn} AS date), CAST(${resolvedSerie} AS nvarchar(4000))
        ORDER BY bucketDate ASC, itemName ASC`;
    })() : `
      SELECT
        CONVERT(varchar(10), CAST(${dateColumn} AS date), 23) AS bucketDate,
        CAST(${groupColumn} AS nvarchar(4000)) AS itemName,
        SUM(TRY_CONVERT(decimal(18, 4), ${quantityColumn})) AS quantityMoved
      FROM ${quoted(this.config.view)} AS [source]
      ${group.join}
      WHERE ${clauses.join(' AND ')} 
      GROUP BY CAST(${dateColumn} AS date), CAST(${groupColumn} AS nvarchar(4000))
      ORDER BY bucketDate ASC, itemName ASC`;
    const result = await request.query(query);
    return result.recordset.map((row) => ({
      ...row,
      itemName: String(row.itemName || '').trim() || 'Unspecified',
      quantityMoved: Number(row.quantityMoved || 0)
    }));
  }

  async getLinkedSeriesQuantity(pool, filters) {
    const sourceRequest = pool.request();
    sourceRequest.input('startDate', sql.Date, filters.startDate);
    sourceRequest.input('endDate', sql.Date, filters.endDate);
    const dateColumn = sourceColumn(this.config.dateColumn);
    const sourceJob = sourceColumn(this.config.serieSourceJoinColumn);
    const quantityColumn = sourceColumn(this.config.quantityColumn);
    const clauses = [`${dateColumn} >= @startDate`, `${dateColumn} < DATEADD(day, 1, @endDate)`, `${sourceJob} IS NOT NULL`];
    addConfiguredFilters(sourceRequest, this.config, clauses);
    addFilterForKey(sourceRequest, this.config, 'process', filters.process, clauses);
    addFilterForKey(sourceRequest, this.config, 'case', filters.case, clauses);
    addFilterForKey(sourceRequest, this.config, 'pn', filters.pn, clauses);
    const sourceRows = (await sourceRequest.query(`
      SELECT CONVERT(varchar(10), CAST(${dateColumn} AS date), 23) AS bucketDate,
        CAST(${sourceJob} AS nvarchar(4000)) AS jobName,
        SUM(TRY_CONVERT(decimal(18, 4), ${quantityColumn})) AS quantityMoved
      FROM ${quoted(this.config.view)} AS [source]
      WHERE ${clauses.join(' AND ')}
      GROUP BY CAST(${dateColumn} AS date), CAST(${sourceJob} AS nvarchar(4000))
    `)).recordset.map((row) => ({ ...row, quantityMoved: Number(row.quantityMoved || 0) }));
    const jobs = [...new Set(sourceRows.map((row) => row.jobName).filter(Boolean))];
    if (!jobs.length) return [];
    const cacheKey = (jobName) => `${filters.product || ''}|${jobName}`;
    const now = Date.now();
    const missingJobs = jobs.filter((jobName) => (this.linkedSeriesCache.get(cacheKey(jobName))?.expiresAt || 0) <= now);
    const cachedSeries = new Map(jobs.map((jobName) => [jobName, this.linkedSeriesCache.get(cacheKey(jobName))?.serieName]).filter(([, serieName]) => serieName));
    if (missingJobs.length) {
      const lookupRequest = pool.request();
      lookupRequest.input('lookupJobs', sql.NVarChar(sql.MAX), JSON.stringify(missingJobs));
      addSerieBlankFallbackParameters(lookupRequest, this.config);
      const lookupProduct = this.config.productLookupColumn && filters.product ? (() => { lookupRequest.input('product', sql.NVarChar(4000), filters.product); return `AND ${quoted(`seriesLookup.${this.config.productLookupColumn}`)} = @product`; })() : '';
      const lookupJob = quoted(`seriesLookup.${this.config.serieLookupJoinColumn}`);
      const lookupSerie = lookupSerieExpression(this.config);
      const linked = await lookupRequest.query(`
        WITH [selectedJobs] AS (SELECT CAST([json].[value] AS nvarchar(4000)) AS [jobName] FROM OPENJSON(@lookupJobs) AS [json] WHERE [json].[type] = 1)
        SELECT ${lookupJob} AS jobName, MIN(CAST(${lookupSerie} AS nvarchar(4000))) AS serieName
        FROM ${quoted(this.config.serieLookupView)} AS [seriesLookup]
        INNER JOIN [selectedJobs] AS [jobs] ON ${lookupJob} = [jobs].[jobName]
        WHERE 1 = 1 ${lookupProduct}
        GROUP BY ${lookupJob}
      `);
      const found = new Map(linked.recordset.map((row) => [String(row.jobName), String(row.serieName || '').trim() || 'Unspecified']));
      missingJobs.forEach((jobName) => {
        const serieName = found.get(String(jobName));
        this.linkedSeriesCache.set(cacheKey(jobName), { serieName, expiresAt: now + 15 * 60 * 1000 });
        if (serieName) cachedSeries.set(jobName, serieName);
      });
      if (this.linkedSeriesCache.size > 20000) {
        for (const [key, entry] of this.linkedSeriesCache) if (entry.expiresAt <= now) this.linkedSeriesCache.delete(key);
      }
    }
    const selectedSeries = Array.isArray(filters.serie) ? new Set(filters.serie) : filters.serie ? new Set([filters.serie]) : undefined;
    const totals = new Map();
    sourceRows.forEach((row) => { const itemName = cachedSeries.get(String(row.jobName)); if (!itemName || selectedSeries && !selectedSeries.has(itemName)) return; const key = `${row.bucketDate}|${itemName}`; totals.set(key, (totals.get(key) || 0) + row.quantityMoved); });
    return [...totals.entries()].map(([key, quantityMoved]) => { const [bucketDate, itemName] = key.split('|'); return { bucketDate, itemName, quantityMoved }; }).sort((left, right) => `${left.bucketDate}|${left.itemName}`.localeCompare(`${right.bucketDate}|${right.itemName}`));
  }

  async getChartData(filters) {
    if (!this.config.chartColumn) return [];
    const pool = await this.getPool();
    const request = pool.request();
    addSerieBlankFallbackParameters(request, this.config);
    request.input('startDate', sql.Date, filters.startDate);
    request.input('endDate', sql.Date, filters.endDate);
    const dateColumn = sourceColumn(this.config.dateColumn);
    const chartColumn = sourceColumn(this.config.chartColumn);
    const fromRouteStepColumn = this.config.fromRouteStepColumn ? sourceColumn(this.config.fromRouteStepColumn) : undefined;
    const toRouteStepColumn = this.config.toRouteStepColumn ? sourceColumn(this.config.toRouteStepColumn) : undefined;
    const fromRouteSequenceColumn = this.config.fromRouteSequenceColumn ? sourceColumn(this.config.fromRouteSequenceColumn) : undefined;
    const toRouteSequenceColumn = this.config.toRouteSequenceColumn ? sourceColumn(this.config.toRouteSequenceColumn) : undefined;
    const series = seriesLookupDefinition(this.config);
    const seriesColumn = series?.column || (this.config.serieColumn ? sourceSerieExpression(this.config) : sourceColumn(this.config.pnColumn));
    const quantityColumn = sourceColumn(this.config.quantityColumn);
    const clauses = [`${dateColumn} >= @startDate`, `${dateColumn} < DATEADD(day, 1, @endDate)`];
    addConfiguredFilters(request, this.config, clauses);
    addFilterForKey(request, this.config, 'product', filters.product, clauses);
    addFilterForKey(request, this.config, 'process', filters.process, clauses);
    addFilterForKey(request, this.config, 'serie', filters.serie, clauses);
    addFilterForKey(request, this.config, 'case', filters.case, clauses);
    addFilterForKey(request, this.config, 'pn', filters.pn, clauses);
    (this.config.chartExcludedValues || []).forEach((value, index) => {
      const parameterName = `excludedChartValue${index}`;
      request.input(parameterName, sql.NVarChar(4000), value);
      clauses.push(`CAST(${chartColumn} AS nvarchar(4000)) <> @${parameterName}`);
    });
    const result = await request.query(`
      SELECT
        CAST(${chartColumn} AS nvarchar(4000)) AS chartName,
        CAST(${seriesColumn} AS nvarchar(4000)) AS seriesName,
        ${fromRouteStepColumn ? `MIN(CAST(${fromRouteStepColumn} AS nvarchar(4000))) AS fromRouteStepName,` : ''}
        ${toRouteStepColumn ? `MIN(CAST(${toRouteStepColumn} AS nvarchar(4000))) AS toRouteStepName,` : ''}
        ${fromRouteStepColumn ? `MIN(TRY_CONVERT(decimal(18, 4), ${fromRouteStepColumn})) AS fromRouteStepOrder,` : ''}
        ${toRouteStepColumn ? `MIN(TRY_CONVERT(decimal(18, 4), ${toRouteStepColumn})) AS toRouteStepOrder,` : ''}
        ${fromRouteSequenceColumn ? `MIN(TRY_CONVERT(decimal(18, 4), ${fromRouteSequenceColumn})) AS fromRouteSequence,` : ''}
        ${toRouteSequenceColumn ? `MIN(TRY_CONVERT(decimal(18, 4), ${toRouteSequenceColumn})) AS toRouteSequence,` : ''}
        SUM(TRY_CONVERT(decimal(18, 4), ${quantityColumn})) AS quantityMoved
      FROM ${quoted(this.config.view)} AS [source]
      ${series?.join || ''}
      WHERE ${clauses.join(' AND ')} 
      GROUP BY CAST(${chartColumn} AS nvarchar(4000)), CAST(${seriesColumn} AS nvarchar(4000))
      ORDER BY chartName ASC, seriesName ASC`);
    return result.recordset.map((row) => ({
      ...row,
      chartName: String(row.chartName || '').trim() || 'Unspecified',
      seriesName: String(row.seriesName || '').trim() || 'Unspecified',
      fromRouteStepName: String(row.fromRouteStepName || '').trim(),
      toRouteStepName: String(row.toRouteStepName || '').trim(),
      fromRouteStepOrder: row.fromRouteStepOrder === null || row.fromRouteStepOrder === undefined ? undefined : Number(row.fromRouteStepOrder),
      toRouteStepOrder: row.toRouteStepOrder === null || row.toRouteStepOrder === undefined ? undefined : Number(row.toRouteStepOrder),
      fromRouteSequence: row.fromRouteSequence === null || row.fromRouteSequence === undefined ? undefined : Number(row.fromRouteSequence),
      toRouteSequence: row.toRouteSequence === null || row.toRouteSequence === undefined ? undefined : Number(row.toRouteSequence),
      quantityMoved: Number(row.quantityMoved || 0)
    }));
  }

  async getDispositionSummary(filters) {
    if (!this.config.dispositionColumn) return [];
    const pool = await this.getPool();
    const request = pool.request();
    addSerieBlankFallbackParameters(request, this.config);
    request.input('startDate', sql.Date, filters.startDate);
    request.input('endDate', sql.Date, filters.endDate);
    const dateColumn = sourceColumn(this.config.dateColumn);
    const dispositionColumn = sourceColumn(this.config.dispositionColumn);
    const quantityColumn = sourceColumn(this.config.quantityColumn);
    const clauses = [`${dateColumn} >= @startDate`, `${dateColumn} < DATEADD(day, 1, @endDate)`];
    addFilterForKey(request, this.config, 'product', filters.product, clauses);
    addFilterForKey(request, this.config, 'process', filters.process, clauses);
    addFilterForKey(request, this.config, 'serie', filters.serie, clauses);
    addFilterForKey(request, this.config, 'case', filters.case, clauses);
    addFilterForKey(request, this.config, 'pn', filters.pn, clauses);
    const result = await request.query(`
      SELECT
        COALESCE(NULLIF(LTRIM(RTRIM(CAST(${dispositionColumn} AS nvarchar(4000)))), N''), N'Unspecified') AS disposition,
        COUNT_BIG(*) AS [recordCount],
        SUM(TRY_CONVERT(decimal(18, 4), ${quantityColumn})) AS quantityMoved
      FROM ${quoted(this.config.view)} AS [source]
      WHERE ${clauses.join(' AND ')}
      GROUP BY COALESCE(NULLIF(LTRIM(RTRIM(CAST(${dispositionColumn} AS nvarchar(4000)))), N''), N'Unspecified')
      ORDER BY quantityMoved DESC`);
    return result.recordset.map((row) => ({ ...row, rowCount: Number(row.rowCount || 0), quantityMoved: Number(row.quantityMoved || 0) }));
  }

  async getOperationTransitions(filters) {
    if (!this.config.chartColumn || !this.config.processColumn) return [];
    const pool = await this.getPool();
    const request = pool.request();
    addSerieBlankFallbackParameters(request, this.config);
    request.input('startDate', sql.Date, filters.startDate);
    request.input('endDate', sql.Date, filters.endDate);
    const dateColumn = sourceColumn(this.config.dateColumn);
    const fromOperation = sourceColumn(this.config.chartColumn);
    const toOperation = sourceColumn(this.config.processColumn);
    const quantityColumn = sourceColumn(this.config.quantityColumn);
    const clauses = [`${dateColumn} >= @startDate`, `${dateColumn} < DATEADD(day, 1, @endDate)`];
    addConfiguredFilters(request, this.config, clauses);
    addFilterForKey(request, this.config, 'product', filters.product, clauses);
    addFilterForKey(request, this.config, 'process', filters.process, clauses);
    addFilterForKey(request, this.config, 'serie', filters.serie, clauses);
    addFilterForKey(request, this.config, 'case', filters.case, clauses);
    addFilterForKey(request, this.config, 'pn', filters.pn, clauses);
    const result = await request.query(`
      SELECT
        COALESCE(NULLIF(LTRIM(RTRIM(CAST(${fromOperation} AS nvarchar(4000)))), N''), N'Unspecified') AS fromOperation,
        COALESCE(NULLIF(LTRIM(RTRIM(CAST(${toOperation} AS nvarchar(4000)))), N''), N'Unspecified') AS toOperation,
        SUM(TRY_CONVERT(decimal(18, 4), ${quantityColumn})) AS quantityMoved
      FROM ${quoted(this.config.view)} AS [source]
      WHERE ${clauses.join(' AND ')}
      GROUP BY
        COALESCE(NULLIF(LTRIM(RTRIM(CAST(${fromOperation} AS nvarchar(4000)))), N''), N'Unspecified'),
        COALESCE(NULLIF(LTRIM(RTRIM(CAST(${toOperation} AS nvarchar(4000)))), N''), N'Unspecified')
      ORDER BY quantityMoved DESC`);
    return result.recordset.map((row) => ({ ...row, quantityMoved: Number(row.quantityMoved || 0) }));
  }

  async getWipFlow(filters) {
    if (!this.config.chartColumn || !this.config.processColumn) return [];
    const pool = await this.getPool();
    const request = pool.request();
    addSerieBlankFallbackParameters(request, this.config);
    request.input('startDate', sql.Date, filters.startDate);
    request.input('endDate', sql.Date, filters.endDate);
    const dateColumn = sourceColumn(this.config.dateColumn);
    const fromOperation = sourceColumn(this.config.chartColumn);
    const toOperation = sourceColumn(this.config.processColumn);
    const quantityColumn = sourceColumn(this.config.quantityColumn);
    const clauses = [`${dateColumn} >= @startDate`, `${dateColumn} < DATEADD(day, 1, @endDate)`];
    addConfiguredFilters(request, this.config, clauses);
    addFilterForKey(request, this.config, 'product', filters.product, clauses);
    addFilterForKey(request, this.config, 'process', filters.process, clauses);
    addFilterForKey(request, this.config, 'serie', filters.serie, clauses);
    addFilterForKey(request, this.config, 'case', filters.case, clauses);
    addFilterForKey(request, this.config, 'pn', filters.pn, clauses);
    (this.config.chartExcludedValues || []).forEach((value, index) => {
      const parameterName = `excludedFlowValue${index}`;
      request.input(parameterName, sql.NVarChar(4000), value);
      clauses.push(`CAST(${fromOperation} AS nvarchar(4000)) <> @${parameterName}`);
    });
    const result = await request.query(`
      WITH [movement] AS (
        SELECT
          NULLIF(LTRIM(RTRIM(CAST(${toOperation} AS nvarchar(4000)))), N'') AS operationName,
          SUM(TRY_CONVERT(decimal(18, 4), ${quantityColumn})) AS inboundQuantity,
          CAST(0 AS decimal(18, 4)) AS outboundQuantity,
          MAX(${dateColumn}) AS lastActivity
        FROM ${quoted(this.config.view)} AS [source]
        WHERE ${clauses.join(' AND ')}
        GROUP BY NULLIF(LTRIM(RTRIM(CAST(${toOperation} AS nvarchar(4000)))), N'')
        UNION ALL
        SELECT
          NULLIF(LTRIM(RTRIM(CAST(${fromOperation} AS nvarchar(4000)))), N'') AS operationName,
          CAST(0 AS decimal(18, 4)) AS inboundQuantity,
          SUM(TRY_CONVERT(decimal(18, 4), ${quantityColumn})) AS outboundQuantity,
          MAX(${dateColumn}) AS lastActivity
        FROM ${quoted(this.config.view)} AS [source]
        WHERE ${clauses.join(' AND ')}
        GROUP BY NULLIF(LTRIM(RTRIM(CAST(${fromOperation} AS nvarchar(4000)))), N'')
      )
      SELECT TOP (50)
        operationName,
        SUM(inboundQuantity) AS inboundQuantity,
        SUM(outboundQuantity) AS outboundQuantity,
        SUM(inboundQuantity) - SUM(outboundQuantity) AS netQuantity,
        MAX(lastActivity) AS lastActivity
      FROM [movement]
      WHERE operationName IS NOT NULL
      GROUP BY operationName
      ORDER BY ABS(SUM(inboundQuantity) - SUM(outboundQuantity)) DESC, operationName ASC`);
    return result.recordset.map((row) => ({ ...row, inboundQuantity: Number(row.inboundQuantity || 0), outboundQuantity: Number(row.outboundQuantity || 0), netQuantity: Number(row.netQuantity || 0) }));
  }

  async getYieldSummary(filters) {
    if (!this.config.chartColumn || !this.config.dispositionColumn) return [];
    const pool = await this.getPool();
    const request = pool.request();
    addSerieBlankFallbackParameters(request, this.config);
    request.input('startDate', sql.Date, filters.startDate);
    request.input('endDate', sql.Date, filters.endDate);
    const dateColumn = sourceColumn(this.config.dateColumn);
    const operationColumn = sourceColumn(this.config.chartColumn);
    const dispositionColumn = sourceColumn(this.config.dispositionColumn);
    const quantityColumn = sourceColumn(this.config.quantityColumn);
    const clauses = [`${dateColumn} >= @startDate`, `${dateColumn} < DATEADD(day, 1, @endDate)`];
    addFilterForKey(request, this.config, 'product', filters.product, clauses);
    addFilterForKey(request, this.config, 'process', filters.process, clauses);
    addFilterForKey(request, this.config, 'serie', filters.serie, clauses);
    addFilterForKey(request, this.config, 'case', filters.case, clauses);
    addFilterForKey(request, this.config, 'pn', filters.pn, clauses);
    const result = await request.query(`
      SELECT
        COALESCE(NULLIF(LTRIM(RTRIM(CAST(${operationColumn} AS nvarchar(4000)))), N''), N'Unspecified') AS operationName,
        COALESCE(NULLIF(LTRIM(RTRIM(CAST(${dispositionColumn} AS nvarchar(4000)))), N''), N'Unspecified') AS disposition,
        SUM(TRY_CONVERT(decimal(18, 4), ${quantityColumn})) AS quantityMoved
      FROM ${quoted(this.config.view)} AS [source]
      WHERE ${clauses.join(' AND ')}
      GROUP BY
        COALESCE(NULLIF(LTRIM(RTRIM(CAST(${operationColumn} AS nvarchar(4000)))), N''), N'Unspecified'),
        COALESCE(NULLIF(LTRIM(RTRIM(CAST(${dispositionColumn} AS nvarchar(4000)))), N''), N'Unspecified')
      ORDER BY operationName ASC, disposition ASC`);
    return result.recordset.map((row) => ({ ...row, quantityMoved: Number(row.quantityMoved || 0) }));
  }

  async getBlankSeriesDiagnostics() {
    const pool = await this.getPool();
    const request = pool.request();
    const serie = sourceColumn(this.config.serieColumn);
    const product = this.config.processColumn ? sourceColumn(this.config.processColumn) : `N''`;
    const source = this.config.serieBlankSourceColumn ? sourceColumn(this.config.serieBlankSourceColumn) : `N''`;
    const quantity = sourceColumn(this.config.quantityColumn);
    const result = await request.query(`
      WITH [seriesLink] AS (
        SELECT
          CAST(${product} AS nvarchar(4000)) AS [product],
          CAST(${source} AS nvarchar(4000)) AS [sourceValue],
          MIN(NULLIF(LTRIM(RTRIM(CAST(${serie} AS nvarchar(4000)))), N'')) AS [linkedSerie],
          COUNT(DISTINCT NULLIF(LTRIM(RTRIM(CAST(${serie} AS nvarchar(4000)))), N'')) AS [linkedSerieCount]
        FROM ${quoted(this.config.view)} AS [source]
        WHERE NULLIF(LTRIM(RTRIM(CAST(${serie} AS nvarchar(4000)))), N'') IS NOT NULL
          AND UPPER(LTRIM(RTRIM(CAST(${serie} AS nvarchar(4000))))) <> N'UNSPECIFIED'
        GROUP BY CAST(${product} AS nvarchar(4000)), CAST(${source} AS nvarchar(4000))
      )
      SELECT TOP (100)
        CAST(${product} AS nvarchar(4000)) AS [product],
        CAST(${source} AS nvarchar(4000)) AS [sourceValue],
        MAX([seriesLink].[linkedSerie]) AS [linkedSerie],
        COALESCE(MAX([seriesLink].[linkedSerieCount]), 0) AS [linkedSerieCount],
        COUNT_BIG(*) AS [recordCount],
        SUM(TRY_CONVERT(decimal(18, 4), ${quantity})) AS quantityMoved
      FROM ${quoted(this.config.view)} AS [source]
      LEFT JOIN [seriesLink] ON [seriesLink].[product] = CAST(${product} AS nvarchar(4000))
        AND [seriesLink].[sourceValue] = CAST(${source} AS nvarchar(4000))
      WHERE NULLIF(LTRIM(RTRIM(CAST(${serie} AS nvarchar(4000)))), N'') IS NULL
      GROUP BY CAST(${product} AS nvarchar(4000)), CAST(${source} AS nvarchar(4000))
      ORDER BY [recordCount] DESC`);
    return result.recordset.map((row) => ({ ...row, linkedSerieCount: Number(row.linkedSerieCount || 0), recordCount: Number(row.recordCount || 0), quantityMoved: Number(row.quantityMoved || 0) }));
  }

  async getSeriesLinkDiagnostics() {
    const lookup = seriesLookupDefinition(this.config);
    if (!lookup) return [];
    const pool = await this.getPool();
    const rawSerie = sourceColumn(this.config.serieColumn);
    const quantity = sourceColumn(this.config.quantityColumn);
    const result = await pool.request().query(`
      SELECT TOP (100)
        CAST(${rawSerie} AS nvarchar(4000)) AS sourceSerie,
        CAST(${lookup.column} AS nvarchar(4000)) AS linkedSerie,
        COUNT_BIG(*) AS [recordCount],
        SUM(TRY_CONVERT(decimal(18, 4), ${quantity})) AS quantityMoved
      FROM ${quoted(this.config.view)} AS [source]
      ${lookup.join}
      GROUP BY CAST(${rawSerie} AS nvarchar(4000)), CAST(${lookup.column} AS nvarchar(4000))
      ORDER BY [recordCount] DESC`);
    return result.recordset.map((row) => ({ ...row, recordCount: Number(row.recordCount || 0), quantityMoved: Number(row.quantityMoved || 0) }));
  }
}
