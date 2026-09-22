import { createHash, timingSafeEqual } from 'node:crypto';

function validCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function validatedRepairRange(value, today, label) {
  const startDate = value?.startDate;
  const endDate = value?.endDate;
  if (!validCalendarDate(startDate) || !validCalendarDate(endDate)) return { error: 'Provide valid startDate and endDate values in YYYY-MM-DD format.' };
  if (startDate > endDate) return { error: 'startDate must be on or before endDate.' };
  if (endDate > today) return { error: `${label} staging repair cannot include a future date.` };
  const days = (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000 + 1;
  if (days > 7) return { error: `${label} staging repair cannot exceed 7 days.` };
  return { filters: { startDate, endDate } };
}

function authorizedRepair(request, configuredToken) {
  const token = String(configuredToken || '');
  if (token.length < 32) return { configured: false, authorized: false };
  const authorization = String(request.get('authorization') || '');
  const suppliedToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const expectedDigest = createHash('sha256').update(token).digest();
  const suppliedDigest = createHash('sha256').update(suppliedToken).digest();
  return { configured: true, authorized: Boolean(suppliedToken) && timingSafeEqual(expectedDigest, suppliedDigest) };
}

export function registerStagingRepairRoute(app, { dataset, label, environment, today, enabled, busy, repair }) {
  const setting = (suffix) => environment[`DASHBOARD_${dataset.toUpperCase()}_REPAIR_${suffix}`];
  app.post(`/api/staging/${dataset}-repair`, (request, response) => {
    const operator = authorizedRepair(request, setting('TOKEN'));
    if (!operator.configured) return response.status(503).json({ success: false, error: `${label} staging repair operator authorization is not configured.` });
    if (!operator.authorized) return response.status(401).json({ success: false, code: 'OPERATOR_AUTH_REQUIRED', error: 'Operator authorization required.' });
    const port = Number(environment.PORT || 3000);
    const allowedOrigins = (setting('ALLOWED_ORIGINS') || `http://localhost:${port},http://127.0.0.1:${port},http://[::1]:${port}`).split(',').map((value) => value.trim()).filter(Boolean);
    if (!allowedOrigins.includes(request.get('origin'))) return response.status(403).json({ success: false, error: 'Cross-origin staging repair is not allowed.' });
    const remoteAddress = String(request.socket.remoteAddress || '');
    const allowedAddresses = (setting('ALLOWED_IPS') || '127.0.0.1,::1').split(',').map((value) => value.trim()).filter(Boolean);
    if (!allowedAddresses.includes(remoteAddress.replace(/^::ffff:/, '')) && !allowedAddresses.includes(remoteAddress)) return response.status(403).json({ success: false, error: `This computer is not authorized to repair ${label} staging.` });
    const validation = validatedRepairRange(request.body, today(), label);
    if (validation.error) return response.status(400).json({ success: false, error: validation.error });
    if (!enabled()) return response.status(503).json({ success: false, error: `${label} staging is not configured.` });
    if (busy()) return response.status(409).json({ success: false, error: `${label} staging repair is already running.` });
    // The repair acquires its lock synchronously and records failures in its pipeline status.
    void repair(validation.filters).catch(() => {});
    return response.status(202).json({ success: true, data: { status: 'RUNNING', ...validation.filters } });
  });
}
