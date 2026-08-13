import 'dotenv/config';
import { read901StagingConfig, readDatasetConfig } from './config.js';
import { SqlRepository } from './sqlRepository.js';
import { Staging901Repository } from './staging901Repository.js';
import { refresh901Staging } from './staging901Refresh.js';

const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).reduce((out, part) => ({ ...out, [part.type]: part.value }), {});
const startDate = process.env.STAGING_901_START_DATE || `${parts.year}-${parts.month}-01`;
const endDate = process.env.STAGING_901_END_DATE || `${parts.year}-${parts.month}-${parts.day}`;

async function main() {
  const targetConfig = read901StagingConfig(process.env); const sourceConfig = readDatasetConfig(process.env, 'closed');
  if (!targetConfig.ready || !sourceConfig.ready) throw new Error('Staging or MES configuration is incomplete.');
  const result = await refresh901Staging({ source: new SqlRepository(sourceConfig), sourceConfig, target: new Staging901Repository(targetConfig), targetConfig, startDate, endDate });
  console.log(`901 staging refreshed: ${result.rows} rows for ${result.startDate} to ${result.endDate}.`);
}
main().catch((error) => { console.error(`901 staging refresh failed: ${error.message}`); process.exitCode = 1; });
