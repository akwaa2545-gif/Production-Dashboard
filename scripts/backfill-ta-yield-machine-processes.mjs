import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { readTaYieldConfig, readTaYieldStagingConfig } from '../src/config.js';
import { TaYieldRepository } from '../src/taYieldRepository.js';
import { TaYieldStagingRepository } from '../src/taYieldStagingRepository.js';
import { loadTaWorkbookReconciliationMapping } from '../src/taYieldMapping.js';
import { backfillTaYieldMachineProcesses, parseTaYieldMachineBackfillArguments } from '../src/taYieldMachineProcessBackfill.js';

const help = `Usage: node scripts/backfill-ta-yield-machine-processes.mjs --start=YYYY-MM --end=YYYY-MM [--apply]

Default: inventory existing calculated TA Yield lots; no MES queries or writes.
--apply replaces only normalized Machine rows with all process events for those lots.
An explicit ordered range of at most 12 months is required. Historical months need
complete workbook staging. Current-month coverage must not extend beyond Bangkok today.
Workbook snapshots, Yield calculations and monthly summaries are never replaced.
Requires normalized Machine tables; legacy JSON machine snapshots are not updated.
MES access uses existing silent authentication only; sign in through the dashboard first.`;

export async function runTaYieldMachineProcessBackfillCli(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') { console.log(help); return; }
  const options = parseTaYieldMachineBackfillArguments(args);
  const stagingConfig = readTaYieldStagingConfig(process.env);
  if (!stagingConfig.ready) throw new Error('TA Yield staging configuration is incomplete.');
  const sourceConfig = options.apply ? readTaYieldConfig(process.env) : undefined;
  if (sourceConfig && !sourceConfig.ready) throw new Error('TA Yield MES configuration is incomplete.');
  const staging = new TaYieldStagingRepository(stagingConfig);
  const source = sourceConfig ? new TaYieldRepository(sourceConfig) : undefined;
  try {
    const result = await backfillTaYieldMachineProcesses(options, {
      staging, source,
      loadMapping: () => loadTaWorkbookReconciliationMapping('TA/Yield_Data_Aug2026.xlsx')
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    const pools = [...new Set([staging.pool, source?.pool].filter(Boolean))];
    const closed = await Promise.allSettled(pools.map((pool) => pool.close()));
    const failures = closed.filter((result) => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), 'Could not close backfill database pools.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTaYieldMachineProcessBackfillCli().catch((error) => {
    console.error(`TA Yield machine process backfill failed: ${error.message}`);
    process.exitCode = 1;
  });
}
