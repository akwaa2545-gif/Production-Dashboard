import sql from 'mssql';
import { SqlRepository } from './sqlRepository.js';

const quoted = (identifier) => identifier.split('.').map((part) => `[${part}]`).join('.');
const thaiUtcBoundary = (dateExpression) => `CAST((CAST(${dateExpression} AS datetime2) AT TIME ZONE 'SE Asia Standard Time' AT TIME ZONE 'UTC') AS datetime2)`;
const taYieldRequestTimeout = (config, override) => { const requested = Number(override ?? config.requestTimeout); return Number.isFinite(requested) && requested > 0 ? Math.min(Math.max(requested, 30000), 900000) : 120000; };
const optionalParameterViewUnavailable = (error, parameterView) => {
  const message = String(error?.message || '');
  const viewName = parameterView.split('.').at(-1);
  return error?.code === 'EREQUEST'
    && message.includes(viewName)
    && /invalid object name|permission.*denied|select permission/i.test(message);
};

export class TaYieldRepository extends SqlRepository {
  constructor(config) {
    super({ ...config, requestTimeout: taYieldRequestTimeout(config) });
  }

  async getDefectModes() {
    const pool = await this.getPool();
    const request = pool.request();
    request.timeout = 15000;
    request.input('taProduct', sql.NVarChar(100), this.config.productValue);
    const result = await request.query(`
      SELECT DISTINCT
        LTRIM(RTRIM(CAST([action].[DispositionCode] AS nvarchar(4000)))) AS [mode],
        LTRIM(RTRIM(CAST([action].[DispositionDescription] AS nvarchar(4000)))) AS [description]
      FROM ${quoted(this.config.defectView)} AS [action]
      WHERE [action].[ProdType] = @taProduct
        AND UPPER(LTRIM(RTRIM(CAST([action].[CatMajor] AS nvarchar(100))))) = N'FG'
        AND [action].[OccuredOn] >= DATEFROMPARTS(2025, 1, 1)
        AND NULLIF(LTRIM(RTRIM(CAST([action].[DispositionCode] AS nvarchar(4000)))), N'') IS NOT NULL
      ORDER BY [mode]
    `);
    return result.recordset.map((row) => ({ mode: row.mode, description: row.description || '' }));
  }

  async getWorkbookReconciliationRows(filters, { descriptions = [], timeoutMs, actionLookbackMonths = 3 } = {}) {
    const pool = await this.getPool();
    const config = this.config;
    const requestTimeout = taYieldRequestTimeout(config, timeoutMs);
    const finalRequest = pool.request();
    finalRequest.timeout = requestTimeout;
    finalRequest.input('taProduct', sql.NVarChar(100), config.productValue);
    finalRequest.input('taFinalGoodDisposition', sql.NVarChar(4000), config.finalGoodDispositionCode);
    finalRequest.input('taInputDispositionDescription', sql.NVarChar(4000), config.palletAssemblyDispositionDescription);
    finalRequest.input('startDate', sql.Date, filters.startDate);
    finalRequest.input('endDate', sql.Date, filters.endDate);
    const finalLots = (await finalRequest.query(`
      WITH [rankedFinal] AS (
        SELECT CAST([final].[JobName] AS nvarchar(4000)) AS [lotNo],
          CAST([final].[ProdLine] AS nvarchar(4000)) AS [line],
          CAST([final].[From_ItemName] AS nvarchar(4000)) AS [fallbackItemName],
          [final].[OccuredOn] AS [tapingDate],
          COALESCE(TRY_CONVERT(decimal(19, 4), [final].[QuantityMoved]), 0) AS [finalGoodQ],
          ROW_NUMBER() OVER (PARTITION BY [final].[JobName] ORDER BY [final].[OccuredOn] DESC) AS [sequence]
        FROM ${quoted(config.defectView)} AS [final]
        WHERE [final].[ProdType] = @taProduct
          AND UPPER(LTRIM(RTRIM(CAST([final].[CatMajor] AS nvarchar(100))))) = N'FG'
          AND UPPER(LTRIM(RTRIM(CAST([final].[DispositionType] AS nvarchar(100))))) = N'GOOD'
          AND LTRIM(RTRIM(CAST([final].[DispositionCode] AS nvarchar(4000)))) = @taFinalGoodDisposition
          AND NOT EXISTS (
            SELECT 1 FROM ${quoted(config.releasedJobView)} AS [releasedJob]
            WHERE [releasedJob].[LotID] = [final].[JobName]
              AND UPPER(LTRIM(RTRIM(CAST([releasedJob].[JobClass] AS nvarchar(100))))) = N'E'
          )
          AND [final].[OccuredOn] >= ${thaiUtcBoundary('@startDate')}
          AND [final].[OccuredOn] < ${thaiUtcBoundary('DATEADD(day, 1, @endDate)')}
      ), [finalLots] AS (
        SELECT [lotNo], [line], [fallbackItemName], [tapingDate], [finalGoodQ]
        FROM [rankedFinal]
        WHERE [sequence] = 1
      ), [inputParts] AS (
        SELECT CAST([inputAction].[JobName] AS nvarchar(4000)) AS [lotNo],
          CAST([inputAction].[From_ItemName] AS nvarchar(4000)) AS [itemName],
          [inputAction].[OccuredOn] AS [inputStart],
          ROW_NUMBER() OVER (PARTITION BY [inputAction].[JobName] ORDER BY [inputAction].[OccuredOn]) AS [sequence]
        FROM ${quoted(config.defectView)} AS [inputAction]
        INNER JOIN [finalLots] AS [lots] ON [inputAction].[JobName] = [lots].[lotNo]
        WHERE [inputAction].[ProdType] = @taProduct
          AND UPPER(LTRIM(RTRIM(CAST([inputAction].[CatMajor] AS nvarchar(100))))) = N'FG'
          AND LTRIM(RTRIM(CAST([inputAction].[DispositionDescription] AS nvarchar(4000)))) IN (N'To rtePelletAssembly', @taInputDispositionDescription)
      )
      SELECT [lots].[lotNo], [lots].[line], COALESCE([input].[itemName], [lots].[fallbackItemName]) AS [itemName],
        [lots].[tapingDate], [lots].[finalGoodQ], [input].[inputStart]
      FROM [finalLots] AS [lots]
      LEFT JOIN [inputParts] AS [input] ON [input].[lotNo] = [lots].[lotNo] AND [input].[sequence] = 1
    `)).recordset;
    if (!finalLots.length) return [];
    const request = pool.request();
    request.timeout = requestTimeout;
    request.input('taProduct', sql.NVarChar(100), config.productValue);
    request.input('taFinalGoodDisposition', sql.NVarChar(4000), config.finalGoodDispositionCode);
    request.input('endDate', sql.Date, filters.endDate);
    request.input('taLots', sql.NVarChar(sql.MAX), JSON.stringify(finalLots));
    request.input('taDescriptions', sql.NVarChar(sql.MAX), JSON.stringify([...new Set(descriptions.map((value) => String(value).trim()).filter(Boolean))]));
    const actionStart = Number(actionLookbackMonths) > 0 ? `DATEADD(month, -${Math.min(Math.floor(Number(actionLookbackMonths)), 12)}, @startDate)` : '@startDate';
    request.input('startDate', sql.Date, filters.startDate);
    const actionRows = (await request.query(`
      WITH [finalLots] AS (
        SELECT [json].[lotNo], [json].[itemName], [json].[tapingDate], [json].[inputStart]
        FROM OPENJSON(@taLots) WITH ([lotNo] nvarchar(4000) '$.lotNo', [itemName] nvarchar(4000) '$.itemName', [tapingDate] datetime2 '$.tapingDate', [inputStart] datetime2 '$.inputStart') AS [json]
      ), [selectedDescriptions] AS (
        SELECT LTRIM(RTRIM(CAST([value] AS nvarchar(4000)))) AS [description]
        FROM OPENJSON(@taDescriptions)
        WHERE [type] = 1
      )
      SELECT CAST([action].[ProdLine] AS nvarchar(4000)) AS line,
        CAST([action].[JobName] AS nvarchar(4000)) AS lotNo,
        [lots].[itemName] AS itemName,
        [lots].[tapingDate] AS tapingDate,
        CASE WHEN LTRIM(RTRIM(CAST([action].[DispositionCode] AS nvarchar(4000)))) = @taFinalGoodDisposition
          THEN @taFinalGoodDisposition
          WHEN LTRIM(RTRIM(CAST([action].[DispositionDescription] AS nvarchar(4000)))) = N'SH pulse defective'
          AND EXISTS (
            SELECT 1 FROM ${quoted(config.parameterView || 'PowerBIThailand.ParametersECP_v')} AS [parameters]
            WHERE LTRIM(RTRIM(CAST([parameters].[PartType] AS nvarchar(4000)))) = LTRIM(RTRIM(CAST([action].[From_ItemName] AS nvarchar(4000))))
              AND LOWER(LTRIM(RTRIM(CAST([parameters].[ParameterName] AS nvarchar(4000))))) = N'acc_volt'
              AND TRY_CONVERT(decimal(19, 4), LTRIM(RTRIM(CAST([parameters].[ParameterValue] AS nvarchar(4000))))) > 0
          ) THEN N'ACC'
          ELSE LTRIM(RTRIM(CAST([action].[DispositionDescription] AS nvarchar(4000)))) END AS dispositionDescription,
        COALESCE(TRY_CONVERT(decimal(19, 4), [action].[QuantityMoved]), 0) AS quantity
      FROM ${quoted(config.defectView)} AS [action]
      INNER JOIN [finalLots] AS [lots] ON [action].[JobName] = [lots].[lotNo]
      LEFT JOIN [selectedDescriptions] AS [selected] ON
        LTRIM(RTRIM(CAST([action].[DispositionDescription] AS nvarchar(4000)))) = [selected].[description]
      WHERE [action].[ProdType] = @taProduct
        AND UPPER(LTRIM(RTRIM(CAST([action].[CatMajor] AS nvarchar(100))))) = N'FG'
        AND [action].[OccuredOn] >= COALESCE([lots].[inputStart], ${thaiUtcBoundary(actionStart)})
        AND [action].[OccuredOn] < ${thaiUtcBoundary('DATEADD(day, 1, @endDate)')}
        AND [selected].[description] IS NOT NULL
        AND LTRIM(RTRIM(CAST([action].[DispositionCode] AS nvarchar(4000)))) <> @taFinalGoodDisposition
        AND LTRIM(RTRIM(CAST([action].[From_OperationName] AS nvarchar(4000)))) <> N'Taping'
    `)).recordset.map((row) => ({ ...row, quantity: Number(row.quantity || 0) }));
    const finalGoodRows = finalLots.filter((lot) => Number(lot.finalGoodQ) > 0).map((lot) => ({
      line: lot.line,
      lotNo: lot.lotNo,
      itemName: lot.itemName,
      tapingDate: lot.tapingDate,
      dispositionDescription: config.finalGoodDispositionCode,
      quantity: Number(lot.finalGoodQ || 0)
    }));
    return [...actionRows, ...finalGoodRows];
  }

  async getYieldRows(filters) {
    const pool = await this.getPool();
    const request = pool.request();
    const config = this.config;
    request.input('taProduct', sql.NVarChar(100), config.productValue);
    request.input('taLinePrefix', sql.NVarChar(4000), config.linePrefix);
    request.input('taFinalGoodDisposition', sql.NVarChar(4000), config.finalGoodDispositionCode);
    request.input('startDate', sql.Date, filters.startDate);
    request.input('endDate', sql.Date, filters.endDate);
    const selectedSeries = filters.serie ? (Array.isArray(filters.serie) ? filters.serie : [filters.serie]) : [];
    const seriesFilter = selectedSeries.map((value, index) => {
      const name = `serie${index}`;
      request.input(name, sql.NVarChar(4000), value);
      return `@${name}`;
    });
    const parameterView = config.parameterView || 'PowerBIThailand.ParametersECP_v';
    const loadActions = async (includeParameterFlags) => {
      const actionRequest = pool.request();
      actionRequest.input('taProduct', sql.NVarChar(100), config.productValue);
      actionRequest.input('taFinalGoodDisposition', sql.NVarChar(4000), config.finalGoodDispositionCode);
      actionRequest.input('startDate', sql.Date, filters.startDate);
      actionRequest.input('endDate', sql.Date, filters.endDate);
      const parameterFlags = includeParameterFlags
        ? `CAST(CASE WHEN LTRIM(RTRIM(CAST([action].[DispositionCode] AS nvarchar(4000)))) = N'1812_SH_PLS' AND EXISTS (SELECT 1 FROM ${quoted(parameterView)} AS [parameters] WHERE LTRIM(RTRIM(CAST([parameters].[PartType] AS nvarchar(4000)))) = LTRIM(RTRIM(CAST([action].[From_ItemName] AS nvarchar(4000))))) THEN 1 ELSE 0 END AS bit) AS partTypeExists,
          CAST(CASE WHEN LTRIM(RTRIM(CAST([action].[DispositionCode] AS nvarchar(4000)))) = N'1812_SH_PLS' AND EXISTS (SELECT 1 FROM ${quoted(parameterView)} AS [parameters] WHERE LTRIM(RTRIM(CAST([parameters].[PartType] AS nvarchar(4000)))) = LTRIM(RTRIM(CAST([action].[From_ItemName] AS nvarchar(4000)))) AND LOWER(LTRIM(RTRIM(CAST([parameters].[ParameterName] AS nvarchar(4000))))) = N'acc_volt' AND TRY_CONVERT(decimal(19, 4), LTRIM(RTRIM(CAST([parameters].[ParameterValue] AS nvarchar(4000))))) = 0) THEN 1 ELSE 0 END AS bit) AS shAccVoltZero,`
        : 'CAST(0 AS bit) AS partTypeExists, CAST(0 AS bit) AS shAccVoltZero,';
      return actionRequest.query(`
        SELECT CAST([action].[JobName] AS nvarchar(4000)) AS lotNo, [action].[OccuredOn] AS occuredOn,
          CASE WHEN UPPER(CAST([action].[DispositionType] AS nvarchar(100))) = N'GOOD'
            AND LTRIM(RTRIM(CAST([action].[DispositionCode] AS nvarchar(4000)))) = @taFinalGoodDisposition
            THEN COALESCE(TRY_CONVERT(decimal(19, 4), [action].[QuantityMoved]), 0) ELSE CAST(0 AS decimal(19, 4)) END AS finalGoodQ,
          LTRIM(RTRIM(CAST([action].[DispositionCode] AS nvarchar(4000)))) AS dispositionCode,
          ${parameterFlags}
          COALESCE(TRY_CONVERT(decimal(19, 4), [action].[QuantityMoved]), 0) AS quantity,
          UPPER(CAST([action].[DispositionType] AS nvarchar(100))) AS dispositionType
        FROM ${quoted(config.defectView)} AS [action]
        WHERE [action].[ProdType] = @taProduct
          AND [action].[OccuredOn] >= ${thaiUtcBoundary('@startDate')}
          AND [action].[OccuredOn] < ${thaiUtcBoundary('DATEADD(day, 1, @endDate)')}
          AND (
            UPPER(CAST([action].[DispositionType] AS nvarchar(100))) = N'SCRAP'
            OR LTRIM(RTRIM(CAST([action].[DispositionCode] AS nvarchar(4000)))) IN (N'0201_Inp_Pellet_Assy', N'X01_Machine_Sample')
          OR LTRIM(RTRIM(CAST([action].[DispositionCode] AS nvarchar(4000)))) = @taFinalGoodDisposition
          )
      `);
    };
    let actions;
    try {
      actions = await loadActions(true);
    } catch (error) {
      if (!optionalParameterViewUnavailable(error, parameterView)) throw error;
      actions = await loadActions(false);
    }
    const actionLots = [...new Set(actions.recordset.map((action) => action.lotNo))];
    if (!actionLots.length) return [];
    request.input('taLots', sql.NVarChar(sql.MAX), JSON.stringify(actionLots));
    const closed = await request.query(`
      WITH [selectedLots] AS (
        SELECT DISTINCT CAST([json].[value] AS nvarchar(4000)) AS [lotNo]
        FROM OPENJSON(@taLots) AS [json]
        WHERE [json].[type] = 1
      )
      SELECT CAST([closed].[JobName] AS nvarchar(4000)) AS lotNo,
        MIN(CAST([closed].[Series] AS nvarchar(4000))) AS line,
        MAX([closed].[CloseDate]) AS closeDate,
        COALESCE(
          MAX(NULLIF(LTRIM(RTRIM(CAST([releasedJob].[JobClass] AS nvarchar(100)))), N'')),
          MAX(CAST([closed].[JobType] AS nvarchar(100)))
        ) AS jobType,
        MAX([closed].[GrossQty]) AS inputQ
      FROM ${quoted(config.view)} AS [closed]
      INNER JOIN [selectedLots] AS [lots] ON CAST([closed].[JobName] AS nvarchar(4000)) = [lots].[lotNo]
      LEFT JOIN ${quoted(config.releasedJobView)} AS [releasedJob]
        ON CAST([releasedJob].[LotID] AS nvarchar(4000)) = CAST([closed].[JobName] AS nvarchar(4000))
      WHERE [closed].[ProdType] = @taProduct AND [closed].[ProdLine] LIKE @taLinePrefix
        ${seriesFilter.length ? `AND [closed].[Series] IN (${seriesFilter.join(', ')})` : ''}
      GROUP BY CAST([closed].[JobName] AS nvarchar(4000))
    `);
    const lots = new Map(closed.recordset.map((row) => [row.lotNo, row]));
    const qualifyingLots = new Set(actions.recordset
      .filter((action) => action.dispositionCode === config.finalGoodDispositionCode)
      .map((action) => action.lotNo));
    const rows = closed.recordset.map((row) => ({ ...row, occuredOn: null, finalGoodQ: 0, dispositionCode: null, quantity: 0 }));
    actions.recordset.forEach((action) => {
      const lot = lots.get(action.lotNo); if (!lot) return;
      const includeQuantity = action.dispositionType === 'SCRAP' || ['0201_Inp_Pellet_Assy', 'X01_Machine_Sample'].includes(action.dispositionCode);
      const dispositionCode = action.dispositionCode === '1812_SH_PLS' && action.shAccVoltZero ? '1812_SH_PLS::SH_ACC_VOLT_ZERO' : action.dispositionCode === '1812_SH_PLS' && !action.partTypeExists ? '1812_SH_PLS::SH_FALLBACK' : action.dispositionCode;
      rows.push({ ...lot, occuredOn: action.occuredOn, inputQ: 0, finalGoodQ: action.finalGoodQ, dispositionCode: includeQuantity ? dispositionCode : null, quantity: includeQuantity ? action.quantity : 0 });
    });
    return rows.filter((row) => qualifyingLots.has(row.lotNo)).map((row) => ({
      ...row,
      inputQ: Number(row.inputQ || 0),
      finalGoodQ: Number(row.finalGoodQ || 0),
      quantity: Number(row.quantity || 0)
    }));
  }

  async getOptions() {
    const pool = await this.getPool();
    const request = pool.request();
    request.input('taProduct', sql.NVarChar(100), this.config.productValue);
    request.input('taLinePrefix', sql.NVarChar(4000), this.config.linePrefix);
    const result = await request.query(`
      SELECT DISTINCT CAST([source].[Series] AS nvarchar(4000)) AS value
      FROM ${quoted(this.config.view)} AS [source]
      WHERE [source].[ProdType] = @taProduct AND [source].[ProdLine] LIKE @taLinePrefix AND [source].[Series] IS NOT NULL
      ORDER BY value
    `);
    return { process: [], serie: result.recordset.map((row) => row.value), case: [], pn: [] };
  }

  async getMtdSeriesOptions() {
    const request = (await this.getPool()).request();
    request.input('taProduct', sql.NVarChar(100), this.config.productValue);
    const result = await request.query(`
      SELECT DISTINCT LTRIM(RTRIM(CAST([source].[Series] AS nvarchar(4000)))) AS value
      FROM ${quoted(this.config.view)} AS [source]
      WHERE [source].[ProdType] = @taProduct
        AND NULLIF(LTRIM(RTRIM(CAST([source].[Series] AS nvarchar(4000)))), N'') IS NOT NULL
      ORDER BY value
    `);
    return { process: [], serie: result.recordset.map((row) => row.value), case: [], pn: [] };
  }

  async getMachineEvents(filters, { lotNumbers, processPattern, machine, timeoutMs } = {}) {
    if (!Array.isArray(lotNumbers) || !lotNumbers.length) return [];
    const request = (await this.getPool()).request();
    request.timeout = taYieldRequestTimeout(this.config, timeoutMs);
    request.input('startDate', sql.Date, filters.startDate);
    request.input('endDate', sql.Date, filters.endDate);
    request.input('processPattern', sql.NVarChar(4000), processPattern);
    request.input('lots', sql.NVarChar(sql.MAX), JSON.stringify([...new Set(lotNumbers)]));
    if (machine) request.input('machine', sql.NVarChar(4000), machine);
    const result = await request.query(`
      WITH [selectedLots] AS (SELECT DISTINCT CAST([value] AS nvarchar(4000)) AS [lotNo] FROM OPENJSON(@lots) WHERE [type] = 1)
      SELECT CAST([log].[JobName] AS nvarchar(4000)) AS lotNo, CAST([log].[MachineName] AS nvarchar(4000)) AS machineName, CAST([log].[From_OperationName] AS nvarchar(4000)) AS operationName, [log].[OccuredOn] AS occuredOn
      FROM ${quoted(this.config.lotStartLogView)} AS [log]
      INNER JOIN [selectedLots] AS [lots] ON CAST([log].[JobName] AS nvarchar(4000)) = [lots].[lotNo]
      WHERE LTRIM(RTRIM(CAST([log].[From_OperationName] AS nvarchar(4000)))) LIKE @processPattern
        AND [log].[OccuredOn] >= ${thaiUtcBoundary('@startDate')}
        AND [log].[OccuredOn] < ${thaiUtcBoundary('DATEADD(day, 1, @endDate)')}
        ${machine ? 'AND LTRIM(RTRIM(CAST([log].[MachineName] AS nvarchar(4000)))) = @machine' : ''}
    `);
    return result.recordset;
  }
}
