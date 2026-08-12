import sql from 'mssql';
import { SqlRepository } from './sqlRepository.js';

const quoted = (identifier) => identifier.split('.').map((part) => `[${part}]`).join('.');
const thaiUtcBoundary = (dateExpression) => `CAST((CAST(${dateExpression} AS datetime2) AT TIME ZONE 'SE Asia Standard Time' AT TIME ZONE 'UTC') AS datetime2)`;
const optionalParameterViewUnavailable = (error, parameterView) => {
  const message = String(error?.message || '');
  const viewName = parameterView.split('.').at(-1);
  return error?.code === 'EREQUEST'
    && message.includes(viewName)
    && /invalid object name|permission.*denied|select permission/i.test(message);
};

export class TaYieldRepository extends SqlRepository {
  async getWorkbookReconciliationRows(filters) {
    const pool = await this.getPool();
    const request = pool.request();
    const config = this.config;
    request.input('taProduct', sql.NVarChar(100), config.productValue);
    request.input('taFinalGoodDisposition', sql.NVarChar(4000), config.finalGoodDispositionCode);
    request.input('startDate', sql.Date, filters.startDate);
    request.input('endDate', sql.Date, filters.endDate);
    return (await request.query(`
      WITH [finalLots] AS (
        SELECT CAST([final].[JobName] AS nvarchar(4000)) AS [lotNo], MAX([final].[OccuredOn]) AS [tapingDate]
        FROM ${quoted(config.defectView)} AS [final]
        WHERE [final].[ProdType] = @taProduct
          AND UPPER(LTRIM(RTRIM(CAST([final].[CatMajor] AS nvarchar(100))))) = N'FG'
          AND LTRIM(RTRIM(CAST([final].[DispositionCode] AS nvarchar(4000)))) = @taFinalGoodDisposition
          AND [final].[OccuredOn] >= ${thaiUtcBoundary('@startDate')}
          AND [final].[OccuredOn] < ${thaiUtcBoundary('DATEADD(day, 1, @endDate)')}
        GROUP BY CAST([final].[JobName] AS nvarchar(4000))
      )
      SELECT CAST([action].[ProdLine] AS nvarchar(4000)) AS line,
        CAST([action].[JobName] AS nvarchar(4000)) AS lotNo,
        CAST([action].[From_ItemName] AS nvarchar(4000)) AS itemName,
        [lots].[tapingDate] AS tapingDate,
        CASE WHEN LTRIM(RTRIM(CAST([action].[DispositionDescription] AS nvarchar(4000)))) = N'SH pulse defective'
          AND EXISTS (
            SELECT 1 FROM ${quoted(config.parameterView || 'PowerBIThailand.ParametersECP_v')} AS [parameters]
            WHERE LTRIM(RTRIM(CAST([parameters].[PartType] AS nvarchar(4000)))) = LTRIM(RTRIM(CAST([action].[From_ItemName] AS nvarchar(4000))))
              AND TRY_CONVERT(decimal(19, 4), LTRIM(RTRIM(CAST([parameters].[ParameterValue] AS nvarchar(4000))))) > 0
          ) THEN N'ACC'
          ELSE LTRIM(RTRIM(CAST([action].[DispositionDescription] AS nvarchar(4000)))) END AS dispositionDescription,
        COALESCE(TRY_CONVERT(decimal(19, 4), [action].[QuantityMoved]), 0) AS quantity
      FROM ${quoted(config.defectView)} AS [action]
      INNER JOIN [finalLots] AS [lots] ON CAST([action].[JobName] AS nvarchar(4000)) = [lots].[lotNo]
      WHERE [action].[ProdType] = @taProduct
        AND UPPER(LTRIM(RTRIM(CAST([action].[CatMajor] AS nvarchar(100))))) = N'FG'
        AND [action].[OccuredOn] >= ${thaiUtcBoundary('DATEADD(month, -3, @startDate)')}
        AND [action].[OccuredOn] < ${thaiUtcBoundary('DATEADD(day, 1, @endDate)')}
        AND LTRIM(RTRIM(CAST([action].[From_OperationName] AS nvarchar(4000)))) <> N'Taping'
    `)).recordset.map((row) => ({ ...row, quantity: Number(row.quantity || 0) }));
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
        MAX(CAST([closed].[JobType] AS nvarchar(100))) AS jobType,
        MAX([closed].[GrossQty]) AS inputQ
      FROM ${quoted(config.view)} AS [closed]
      INNER JOIN [selectedLots] AS [lots] ON CAST([closed].[JobName] AS nvarchar(4000)) = [lots].[lotNo]
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
}
