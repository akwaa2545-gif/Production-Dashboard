import 'dotenv/config';
import { readDatasetConfig, readWipStagingConfig } from './config.js';
import { SqlRepository } from './sqlRepository.js';
import { StagingWipRepository } from './stagingWipRepository.js';
import { refreshWipStaging } from './stagingWipRefresh.js';

const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).reduce((out, part) => ({ ...out, [part.type]: part.value }), {});
const startDate = process.env.STAGING_WIP_START_DATE || `${parts.year}-${parts.month}-01`; const endDate = process.env.STAGING_WIP_END_DATE || `${parts.year}-${parts.month}-${parts.day}`;
const targetConfig = readWipStagingConfig(process.env); const sourceConfig = readDatasetConfig(process.env, 'lot');
if (!targetConfig.ready || !sourceConfig.ready) throw new Error('Staging or WIP MES configuration is incomplete.');
refreshWipStaging({ source: new SqlRepository(sourceConfig), target: new StagingWipRepository(targetConfig), targetConfig, startDate, endDate }).then((result) => console.log(`WIP staging refreshed: ${result.rows} rows for ${result.startDate} to ${result.endDate}.`)).catch((error) => { console.error(`WIP staging refresh failed: ${error.message}`); process.exitCode = 1; });
