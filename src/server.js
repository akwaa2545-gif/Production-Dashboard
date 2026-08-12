import 'dotenv/config';
import { createApp } from './app.js';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const app = createApp();
const warmIntervalMs = Math.max(Number(process.env.DASHBOARD_CACHE_WARM_INTERVAL_MS) || 270000, 60000);
const warmEnabled = process.env.DASHBOARD_CACHE_WARMER_ENABLED !== 'false';
app.listen(port, host, () => {
  console.log(`OneMES dashboard listening on http://${host}:${port}`);
  if (!warmEnabled) return;
  const warm = () => app.warmCurrentMonthCaches().catch((error) => console.warn(`Dashboard cache warmer skipped: ${error.message}`));
  setTimeout(warm, 120000).unref();
  setInterval(warm, warmIntervalMs).unref();
});
