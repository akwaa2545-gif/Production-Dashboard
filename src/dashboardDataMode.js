import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const MODES = new Set(['staging', 'live']);
const UNTRACKED_PATHS = new Set(['/api/data-mode', '/api/data-mode/local-token', '/api/staging-status', '/api/health', '/api/config']);
const CHANGE_ERROR = 'Unable to switch dashboard data mode.';

export function createDashboardDataMode({ initialMode = 'staging', onChange = () => {} } = {}) {
  if (!MODES.has(initialMode)) throw new Error('Invalid initial dashboard data mode.');
  let state = { mode: initialMode, requestedMode: initialMode, transitioning: false, revision: 0, activeWork: 0, startupMode: initialMode };
  const status = () => ({ ...state });
  const canStartBackgroundWork = () => state.mode === 'staging' && !state.transitioning;

  function applyPendingChange() {
    if (!state.transitioning || state.activeWork !== 0) return null;
    try {
      onChange(state.requestedMode);
      state = { ...state, mode: state.requestedMode, transitioning: false, revision: state.revision + 1 };
      return null;
    } catch {
      // Deferred failures remain visible through the status endpoint; existing work still completes normally.
      state = { ...state, requestedMode: state.mode, transitioning: false, error: CHANGE_ERROR };
      return new Error(CHANGE_ERROR);
    }
  }

  function release() {
    state = { ...state, activeWork: state.activeWork - 1 };
    applyPendingChange();
  }

  async function track(task) {
    state = { ...state, activeWork: state.activeWork + 1 };
    try {
      return await task();
    } finally {
      release();
    }
  }

  function setMode(mode) {
    if (!MODES.has(mode)) throw new Error('Invalid dashboard data mode.');
    if (state.transitioning) {
      if (mode !== state.requestedMode) throw Object.assign(new Error('A dashboard data mode change is already in progress.'), { statusCode: 409 });
      return status();
    }
    if (mode === state.mode) return status();
    const { error: _previousError, ...previous } = state;
    state = { ...previous, requestedMode: mode, transitioning: true };
    const failure = applyPendingChange();
    if (failure) throw failure;
    return status();
  }

  function middleware(req, res, next) {
    // Express routes are case-insensitive by default, so admission must be too.
    const path = String(req.path || '').toLowerCase().replace(/\/+$/, '');
    if (!path.startsWith('/api/') || UNTRACKED_PATHS.has(path)) return next();
    if (state.transitioning) {
      return res.status(503).json({ success: false, code: 'DATA_MODE_TRANSITION', error: 'Dashboard data source is changing. Please retry shortly.' });
    }
    state = { ...state, activeWork: state.activeWork + 1 };
    let released = false;
    const finish = () => {
      if (released) return;
      released = true;
      res.removeListener('finish', finish);
      res.removeListener('close', finish);
      release();
    };
    res.once('finish', finish);
    res.once('close', finish);
    return next();
  }

  return {
    status,
    setMode,
    isLive: () => state.mode === 'live',
    canStartBackgroundWork,
    track,
    runBackground: async (task) => canStartBackgroundWork()
      ? track(task)
      : { status: 'SKIPPED', reason: state.transitioning ? 'MODE_SWITCH' : 'LIVE_MODE' },
    middleware
  };
}

function splitSetting(value, fallback) {
  return String(value ?? fallback).split(',').map((entry) => entry.trim()).filter(Boolean);
}

function authorize(req, environment) {
  const token = String(environment.DASHBOARD_DATA_MODE_TOKEN || '');
  if (token.length < 32) return { status: 503, error: 'Dashboard data mode operator authorization is not configured.' };
  const authorization = String(req.get('authorization') || '');
  const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const hash = (value) => createHash('sha256').update(value).digest();
  if (!supplied || !timingSafeEqual(hash(token), hash(supplied))) {
    return { status: 401, code: 'OPERATOR_AUTH_REQUIRED', error: 'Operator authorization required.' };
  }
  const port = Number(environment.PORT || 3000);
  const origins = splitSetting(environment.DASHBOARD_DATA_MODE_ALLOWED_ORIGINS, `http://localhost:${port},http://127.0.0.1:${port},http://[::1]:${port}`);
  if (!origins.includes(req.get('origin'))) return { status: 403, error: 'Cross-origin data mode changes are not allowed.' };
  const addresses = splitSetting(environment.DASHBOARD_DATA_MODE_ALLOWED_IPS, '127.0.0.1,::1');
  const remote = String(req.socket.remoteAddress || '');
  if (!addresses.includes(remote) && !addresses.includes(remote.replace(/^::ffff:/, ''))) {
    return { status: 403, error: 'This computer is not authorized to change dashboard data mode.' };
  }
  return null;
}

function localIdentity(req, environment, requireOrigin) {
  const setting = String(environment.DASHBOARD_DATA_MODE_LOCAL_AUTOFILL ?? '').toLowerCase();
  if (setting !== 'true') return null;
  if (Object.keys(req.headers).some((name) => /^(forwarded|via|x-real-ip)$|^x-forwarded-/i.test(name))) return null;
  const rawAddress = String(req.socket.remoteAddress || '');
  const address = rawAddress.replace(/^::ffff:/, '');
  if (!['127.0.0.1', '::1'].includes(address)) return null;
  const host = String(req.get('host') || '');
  const matched = /^(localhost|127\.0\.0\.1|\[::1\])(?::([1-9]\d{0,4}))?$/.exec(host);
  const scheme = req.socket.encrypted ? 'https' : 'http';
  const defaultPort = scheme === 'https' ? 443 : 80;
  if (!matched || Number(matched[2] || defaultPort) !== req.socket.localPort) return null;
  const origin = `${scheme}://${matched[1]}${req.socket.localPort === defaultPort ? '' : `:${req.socket.localPort}`}`;
  const suppliedOrigin = req.get('origin');
  if ((requireOrigin || suppliedOrigin !== undefined) && suppliedOrigin !== origin) return null;
  if (environment.DASHBOARD_DATA_MODE_ALLOWED_ORIGINS !== undefined && !splitSetting(environment.DASHBOARD_DATA_MODE_ALLOWED_ORIGINS, '').includes(origin)) return null;
  if (environment.DASHBOARD_DATA_MODE_ALLOWED_IPS !== undefined) {
    const allowed = splitSetting(environment.DASHBOARD_DATA_MODE_ALLOWED_IPS, '');
    if (!allowed.includes(address) && !allowed.includes(rawAddress)) return null;
  }
  return { address, origin };
}

function createLocalCredentials(environment) {
  let credentials = new Map();
  const digest = (token) => createHash('sha256').update(token).digest('hex');
  const prune = () => { credentials = new Map([...credentials].filter(([, value]) => value.expiresAt > Date.now())); };
  const unavailable = { status: 403, error: 'Local token autofill is only available from an authorized browser on this computer.' };
  return {
    available: (req) => Boolean(localIdentity(req, environment, false)),
    issue(req) {
      const identity = localIdentity(req, environment, true);
      if (!identity) return { denied: unavailable };
      prune();
      if (credentials.size >= 128) return { denied: { status: 429, error: 'Too many unused local tokens. Please wait two minutes and retry.' } };
      const token = `local-mode-${randomBytes(32).toString('base64url')}`;
      const expiresAt = Date.now() + 120_000;
      credentials = new Map([...credentials, [digest(token), { ...identity, expiresAt }]]);
      return { data: { token, expiresAt: new Date(expiresAt).toISOString() } };
    },
    authorize(req) {
      const authorization = String(req.get('authorization') || '');
      if (!authorization.startsWith('Bearer local-mode-')) return undefined;
      const key = digest(authorization.slice(7));
      const credential = credentials.get(key);
      // Every attempt consumes the credential, including a wrong origin or invalid mode.
      credentials = new Map([...credentials].filter(([stored]) => stored !== key));
      prune();
      if (!credential || credential.expiresAt <= Date.now()) return { status: 401, code: 'OPERATOR_AUTH_REQUIRED', error: 'Local token expired or already used. Autofill a new token.' };
      const identity = localIdentity(req, environment, true);
      if (!identity || identity.address !== credential.address || identity.origin !== credential.origin) return unavailable;
      return null;
    }
  };
}

export function registerDashboardDataModeRoutes(app, { controller, environment = process.env }) {
  const localCredentials = createLocalCredentials(environment);
  const status = (req) => ({ ...controller.status(), controlConfigured: String(environment.DASHBOARD_DATA_MODE_TOKEN || '').length >= 32, localAutofillAvailable: localCredentials.available(req) });
  const deny = (res, denied) => {
    const { status: statusCode, ...body } = denied;
    return res.status(statusCode).json({ success: false, ...body });
  };
  app.get('/api/data-mode', (req, res) => res.set('Cache-Control', 'no-store').json({ success: true, data: status(req) }));
  app.post('/api/data-mode/local-token', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const result = localCredentials.issue(req);
    if (result.denied) return deny(res, result.denied);
    return res.json({ success: true, data: result.data });
  });
  app.put('/api/data-mode', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const staticDenied = authorize(req, environment);
    const localDenied = staticDenied ? localCredentials.authorize(req) : undefined;
    const denied = localDenied === undefined ? staticDenied : localDenied;
    if (denied) return deny(res, denied);
    if (!MODES.has(req.body?.mode)) return res.status(400).json({ success: false, error: 'mode must be staging or live.' });
    try {
      controller.setMode(req.body.mode);
      const data = status(req);
      return res.status(data.transitioning ? 202 : 200).json({ success: true, data });
    } catch (error) {
      return res.status(error.statusCode === 409 ? 409 : 500).json({ success: false, error: error.statusCode === 409 ? error.message : CHANGE_ERROR });
    }
  });
}
