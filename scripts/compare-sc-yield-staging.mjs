import 'dotenv/config';
import sql from 'mssql';
import { readScYieldConfig, readScYieldStagingConfig } from '../src/config.js';
import { ScYieldRepository } from '../src/scYieldRepository.js';
import { ScYieldStagingRepository } from '../src/scYieldStagingRepository.js';
import { loadScYieldMapping, mapScYieldRows } from '../src/scYieldMapping.js';

const dateText = (value) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);
const quote = (identifier) => identifier.split('.').map((part) => `[${part}]`).join('.');
const rowKey = (row, defect = false) => [row.bucketMonth, row.line, defect ? row.dispositionCode : ''].map((value) => String(value || '').trim()).join('|');
const normalize = (rows, defect = false) => rows.reduce((totals, row) => {
  const key = rowKey(row, defect);
  totals.set(key, (totals.get(key) || 0) + Number(row.quantity || 0));
  return totals;
}, new Map());
const differences = (liveRows, stagedRows, defect = false) => {
  const live = normalize(liveRows, defect);
  const staged = normalize(stagedRows, defect);
  return [...new Set([...live.keys(), ...staged.keys()])].sort().flatMap((key) => {
    const mes = live.get(key) || 0;
    const staging = staged.get(key) || 0;
    return mes === staging ? [] : [{ key, mes, staging, difference: staging - mes }];
  });
};

const stagingConfig = readScYieldStagingConfig(process.env);
const sourceConfig = readScYieldConfig({ ...process.env, SQL_REQUEST_TIMEOUT: process.env.SQL_REQUEST_TIMEOUT || '900000' });
if (!stagingConfig.ready || !sourceConfig.ready) throw new Error('SC Yield MES or staging configuration is incomplete.');

const staging = new ScYieldStagingRepository(stagingConfig);
const source = new ScYieldRepository(sourceConfig);

try {
  const activityRequest = (await staging.getPool()).request();
  activityRequest.input('bucket', sql.NVarChar(10), 'month');
  const activity = (await activityRequest.query(`SELECT COUNT(*) AS [rowCount], MIN(ScopeStart) AS [firstDataDate], MAX(ScopeEnd) AS [lastDataDate], MAX(RefreshedAt) AS [lastRefreshedAt] FROM ${quote(stagingConfig.table)} WHERE Bucket=@bucket`)).recordset[0];
  const requestedStart = process.argv[2];
  const requestedEnd = process.argv[3];
  const endDate = requestedEnd || dateText(activity.lastDataDate);
  if (!endDate) throw new Error('SC Yield staging has no snapshots.');
  const filters = { startDate: requestedStart || `${endDate.slice(0, 7)}-01`, endDate };
  const stagingComparable = filters.startDate === `${filters.startDate.slice(0, 7)}-01`;
  const [mes, staged, mapping] = await Promise.all([
    source.getYieldRows(filters),
    stagingComparable ? staging.getYieldRows(filters) : Promise.resolve({ inputs: [], defects: [] }),
    loadScYieldMapping(sourceConfig.mappingFile)
  ]);
  const inputDifferences = stagingComparable ? differences(mes.inputs, staged.inputs) : [];
  const defectDifferences = stagingComparable ? differences(mes.defects, staged.defects, true) : [];
  const mesYield = mapScYieldRows(mes, mapping);
  const stagedYield = stagingComparable ? mapScYieldRows(staged, mapping) : [];
  const rangeYields = [...mesYield.reduce((totals, row) => {
    const current = totals.get(row.line) || { series: row.line, input: 0, includedDefect: 0 };
    totals.set(row.line, { ...current, input: current.input + row.input, includedDefect: current.includedDefect + row.defect });
    return totals;
  }, new Map()).values()].map((row) => ({ ...row, yieldPercent: row.input ? (row.input - row.includedDefect) / row.input * 100 : undefined }));
  const yieldDifferences = stagingComparable ? differences(
    mesYield.map((row) => ({ bucketMonth: row.month, line: row.line, quantity: row.yield })),
    stagedYield.map((row) => ({ bucketMonth: row.month, line: row.line, quantity: row.yield }))
  ) : [];
  console.log(JSON.stringify({
    filters,
    stagingComparable,
    stagingLimitation: stagingComparable ? undefined : 'SC Yield staging stores monthly and weekly aggregates; this partial-month range cannot be reproduced exactly.',
    stagingActivity: { rowCount: Number(activity.rowCount || 0), firstDataDate: dateText(activity.firstDataDate), lastDataDate: dateText(activity.lastDataDate), lastRefreshedAt: activity.lastRefreshedAt },
    counts: { mesInputs: mes.inputs.length, stagingInputs: staged.inputs.length, mesDefects: mes.defects.length, stagingDefects: staged.defects.length },
    mismatchCounts: stagingComparable ? { inputs: inputDifferences.length, defects: defectDifferences.length, yields: yieldDifferences.length } : undefined,
    inputDifferences,
    defectDifferences,
    yieldDifferences,
    rangeYields,
    yields: mesYield.map((row) => ({
      month: row.month,
      series: row.line,
      input: row.input,
      includedDefect: row.defect,
      yieldPercent: row.yield,
      stagingYieldPercent: stagedYield.find((stagedRow) => stagedRow.month === row.month && stagedRow.line === row.line)?.yield
    }))
  }, null, 2));
} finally {
  await source.resetConnection().catch(() => undefined);
  if (staging.pool) await staging.pool.close().catch(() => undefined);
}
