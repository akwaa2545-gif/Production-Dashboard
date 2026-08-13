import 'dotenv/config';
import { read901StagingConfig, readDatasetConfig, readWipStagingConfig } from './config.js';
import { SqlRepository } from './sqlRepository.js';
import { Staging901Repository } from './staging901Repository.js';
import { StagingWipRepository } from './stagingWipRepository.js';

const startDate = process.env.STAGING_VALIDATION_START_DATE || '2026-01-01';
const endDate = process.env.STAGING_VALIDATION_END_DATE || '2026-08-12';
const keyFor = (row) => `${row.bucketDate}|${row.itemName}`;
const compare = (directRows, stagedRows) => {
  const direct = new Map(directRows.map((row) => [keyFor(row), Number(row.quantityMoved || 0)]));
  const staged = new Map(stagedRows.map((row) => [keyFor(row), Number(row.quantityMoved || 0)]));
  const keys = new Set([...direct.keys(), ...staged.keys()]);
  return [...keys].flatMap((key) => Math.abs((direct.get(key) || 0) - (staged.get(key) || 0)) > 0.0001 ? [{ key, mes: direct.get(key) || 0, staging: staged.get(key) || 0 }] : []);
};

async function validate(label, sourceConfig, stagingConfig, StagingRepository) {
  if (!sourceConfig.ready || !stagingConfig.ready) throw new Error(`${label} source or staging configuration is incomplete.`);
  const source = new SqlRepository(sourceConfig); const staged = new StagingRepository(stagingConfig); const results = [];
  for (const product of ['NEO', 'SC']) {
    const filters = { startDate, endDate, product };
    const [directRows, stagedRows] = await Promise.all([source.getQuantity(filters), staged.getQuantity(filters)]);
    const mismatches = compare(directRows, stagedRows);
    results.push({ product, mesRows: directRows.length, stagingRows: stagedRows.length, mismatches: mismatches.length, samples: mismatches.slice(0, 10) });
  }
  return { label, results };
}

try {
  const selected = process.env.STAGING_VALIDATION_DATASET || 'all';
  const checks = [];
  if (selected === 'all' || selected === '901') checks.push(await validate('901', readDatasetConfig(process.env, 'closed'), read901StagingConfig(process.env), Staging901Repository));
  if (selected === 'all' || selected === 'wip') checks.push(await validate('WIP', readDatasetConfig(process.env, 'lot'), readWipStagingConfig(process.env), StagingWipRepository));
  console.log(JSON.stringify({ startDate, endDate, checks }, null, 2));
  if (checks.some((check) => check.results.some((result) => result.mismatches))) process.exitCode = 1;
} catch (error) { console.error(`Staging validation failed: ${error.message}`); process.exitCode = 1; }
