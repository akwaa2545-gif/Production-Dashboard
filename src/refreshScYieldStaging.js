import 'dotenv/config';
import { createApp } from './app.js';

const app = createApp();
const refresh = process.argv.includes('--history') ? app.refreshScYieldStagingHistory() : app.refreshScYieldStaging();
refresh
  .then((result) => console.log(`SC Yield staging refreshed: ${result.inputRows || 0} input rows and ${result.defectRows || 0} defect rows.`))
  .catch((error) => { console.error(`SC Yield staging refresh failed: ${error.message}`); process.exitCode = 1; });
