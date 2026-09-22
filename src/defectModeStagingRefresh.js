import { settleAll } from './settleAll.js';

const distinct = (dataset, rows) => [...new Map(rows.map((row) => [String(row.mode || '').trim().toUpperCase(), { dataset, mode: String(row.mode || '').trim(), description: String(row.description || '').trim() }]).filter(([key]) => key)).values()];
export async function refreshDefectModeStaging({ taSource, scSource, target }) {
  const [ta, sc] = await settleAll([taSource.getDefectModes(), scSource.getDefectModes()]);
  if (!ta.length || !sc.length) throw new Error('MES returned no defect modes.');
  await settleAll([
    target.addModes('TA', distinct('TA', ta).map(({ mode, description }) => ({ mode, description }))),
    target.addModes('SC', distinct('SC', sc).map(({ mode, description }) => ({ mode, description })))
  ]);
  return { ta: ta.length, sc: sc.length };
}
