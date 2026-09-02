import 'dotenv/config';
import { createApp } from '../src/app.js';

const dates = process.argv.slice(2);
if (!dates.length || dates.some((date) => !/^\d{4}-\d{2}-\d{2}$/.test(date))) {
  console.error('Usage: node scripts/repair-ta-yield-staging-days.mjs YYYY-MM-DD [YYYY-MM-DD ...]');
  process.exit(1);
}

const app = createApp();

try {
  for (const date of dates) {
    console.log(`Repairing TA Yield staging for ${date}...`);
    console.log(JSON.stringify(await app.refreshTaYieldStagingDay({ date, timeoutMs: 900000 })));
  }
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
