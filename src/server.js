import 'dotenv/config';
import { createApp } from './app.js';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const app = createApp();
const warmIntervalMs = Math.max(Number(process.env.DASHBOARD_CACHE_WARM_INTERVAL_MS) || 270000, 60000);
const warmEnabled = process.env.DASHBOARD_CACHE_WARMER_ENABLED !== 'false';
const stagingIntervalMs = Math.max(Number(process.env.DASHBOARD_901_STAGING_INTERVAL_MS) || 300000, 60000);
const wipStagingIntervalMs = Math.max(Number(process.env.DASHBOARD_WIP_STAGING_INTERVAL_MS) || 300000, 60000);
app.listen(port, host, () => {
  console.log(`OneMES dashboard listening on http://${host}:${port}`);
  if (!warmEnabled) return;
  const warm = () => app.warmCurrentMonthCaches().catch((error) => console.warn(`Dashboard cache warmer skipped: ${error.message}`));
  setTimeout(warm, 120000).unref();
  setInterval(warm, warmIntervalMs).unref();
  const refresh901Staging = () => app.refresh901Staging().catch((error) => console.warn(`901 staging refresh skipped: ${error.message}`));
  setTimeout(refresh901Staging, 15000).unref();
  setInterval(refresh901Staging, stagingIntervalMs).unref();
  const refreshWipStaging = () => app.refreshWipStaging().catch((error) => console.warn(`WIP staging refresh skipped: ${error.message}`));
  setTimeout(refreshWipStaging, 45000).unref();
  setInterval(refreshWipStaging, wipStagingIntervalMs).unref();
});
