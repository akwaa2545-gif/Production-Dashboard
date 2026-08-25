import 'dotenv/config';
import { createApp } from './app.js';

const app = createApp();

const refresh = process.argv.includes('--history') ? app.refreshTaYieldStagingHistory() : app.refreshTaYieldStaging();
const keepAlive = setInterval(() => {}, 1000);

try {
  const result = await refresh;
  console.log(`TA Yield staging refreshed: ${result.workbookRows || 0} DataTable rows.`);
} catch (error) {
  console.error(`TA Yield staging refresh failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  clearInterval(keepAlive);
}
