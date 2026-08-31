const ids = ['process', 'serie', 'case', 'pn'];
const format = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const compactFormat = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const byId = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
const pnState = { items: [], hasMore: false, offset: 0, requestId: 0, loading: false, query: '', error: '', selected: [] };
const clientResponseCache = new Map();
const clientCacheLimit = 80;
const scYieldTargetSettingsKey = 'onemes-sc-yield-target-settings-v1';
function readScYieldTargetSettings() { try { const settings = JSON.parse(localStorage.getItem(scYieldTargetSettingsKey) || '{}'); return settings && typeof settings === 'object' ? settings : {}; } catch { return {}; } }
let scYieldTargetSettings = readScYieldTargetSettings();
let scYieldTargetStorageRemote = true;
let scYieldTargetSettingsLoaded = false;
let scYieldTargetSettingsLoading = false;
async function loadScYieldTargetSettings() { if (!scYieldTargetStorageRemote) return; const local = readScYieldTargetSettings(); let rows = await request('/api/sc-yield-targets'); const stored = new Set(rows.map((row) => `${row.serie}|${row.period}`)); const missing = Object.entries(local).flatMap(([serie, periods]) => Object.entries(periods || {}).filter(([, target]) => Number.isFinite(Number(target))).map(([period, target]) => ({ serie, period, target: Number(target) }))).filter((target) => !stored.has(`${target.serie}|${target.period}`)); if (missing.length) { await Promise.all(missing.map((target) => request('/api/sc-yield-targets', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(target) }))); rows = await request('/api/sc-yield-targets'); } scYieldTargetSettings = rows.reduce((settings, row) => ({ ...settings, [row.serie]: { ...(settings[row.serie] || {}), [row.period]: row.target } }), {}); localStorage.removeItem(scYieldTargetSettingsKey); scYieldTargetSettingsLoaded = true; }
function scYieldTargetFor(serie, month) { const value = Number(scYieldTargetSettings?.[serie]?.[month]); return Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined; }
function renderScYieldTargetParameters(rows) { const months = [...new Set(rows.map((row) => row.month))].sort(); const series = [...new Set(rows.map((row) => row.line || 'Unspecified'))].sort(); byId('scYieldTargetParameters').innerHTML = `<table><thead><tr><th>Series</th>${months.map((month) => `<th>${escapeHtml(month)}</th>`).join('')}</tr></thead><tbody>${series.map((serie) => `<tr><td>${escapeHtml(serie)}</td>${months.map((month) => { const value = scYieldTargetSettings?.[serie]?.[month]; return `<td><input class="sc-yield-series-target-input" type="number" min="0" max="100" step="0.01" inputmode="decimal" data-sc-yield-target-serie="${escapeHtml(serie)}" data-sc-yield-target-month="${month}" value="${value ?? ''}" placeholder="Default" aria-label="${escapeHtml(serie)} yield target for ${month}" /></td>`; }).join('')}</tr>`).join('')}</tbody></table><button id="scYieldTargetSave" type="button">Save targets</button><span id="scYieldTargetStatus" class="parameter-status" role="status"></span>`; }
let pnSearchTimer;
let dataRequestId = 0;
const selectedDataset = () => byId('dataSource').value;
const selectedPartNumbers = () => pnState.selected;
// Keep TA dashboard charts at the reporting-family level.  The DataTable still
// shows each source line, but yield trend charts combine those lines exactly as
// the production report does.
const taChartGroup = (line) => {
  const value = String(line || '').trim();
  // MES ProdLine values begin with "Ta NEO Capacitor ...", so match the
  // actual series token rather than only the start of the full description.
  if (/\bGPS\b/i.test(value)) return 'GPS';
  if (/\bFPS\b/i.test(value)) return 'Facedown';
  return 'Standard Production';
};
const shortTaSeries = (line) => {
  const value = String(line || '').trim();
  const match = value.match(/\b(FPS|GPS|PSG|PSH|PSL|PSU)\s+series\s+([A-Z]\d*)\b/i);
  return match ? `${match[1].toUpperCase()} ${match[2].toUpperCase()}` : value;
};
function taYieldTargetPeriod(bucket) {
  if (/^\d{4}-\d{2}/.test(bucket)) return bucket.slice(0, 7);
  const match = String(bucket).match(/^(\d{4})-W(\d{2})$/);
  if (!match) return '';
  const year = Number(match[1]); const week = Number(match[2]);
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const mondayOffset = (firstThursday.getUTCDay() + 6) % 7;
  const thursday = new Date(Date.UTC(year, 0, 4 - mondayOffset + (week - 1) * 7 + 3));
  return thursday.toISOString().slice(0, 7);
}
function taYieldTargetFor(serie, bucket) {
  const period = taYieldTargetPeriod(bucket);
  const directTarget = Number(taYieldTargets[shortTaSeries(serie)]?.[period]);
  if (Number.isFinite(directTarget)) return directTarget;
  const targetSerie = taChartGroup(serie);
  const groupTarget = Number(taYieldTargets[targetSerie]?.[period]);
  return Number.isFinite(groupTarget) ? groupTarget : undefined;
}
let currentConfig = { chartAxis: 'date' };
let chartMode = 'stacked';
let processChartFit = false;
let latestData = [];
let latestChartData = [];
let latestMtdData = [];
let latestWipFlow = [];
let latestYieldData = { goodDisposition: 'good', rows: [] };
let latestScYieldData = [];
let latestScYieldWeeklyData = [];
let latestTaYieldData = { summary: [], details: [] };
let latestTaYieldWeeklyData = [];
let latestTaYieldTendencyData = [];
let latestTaYieldGroupTendencyData = [];
let latestTaYieldActions = [];
let taYieldActionStatus = 'IN_PROGRESS';
let taYieldDetailVisible = false;
let latestTaWorkbookRows = [];
let taWorkbookVisibleRows = 50;
let taYieldSummaryVisibleRows = 20;
let taWorkbookDateDirection = 'desc';
let taYieldInterval = 'month';
let taYieldTrendSeries = 'Total';
let taYieldTrendChartType = 'summary';
let taYieldTrendPartNumber = 'All';
let taYieldTrendPartNumbers = [];
let taYieldTargets = {};
let taYieldTargetTab = 'current';
let taYieldTargetSearch = '';
let taYieldTableView = 'summary';
let latestTaYieldLotsUrl = '';
let latestTaYieldLotsRequestId = 0;
let taYieldLotSearch = '';
let taYieldLotSeries = '';
let taYieldLogSeries = '';
let taYieldLogMode = '';
let taYieldLogCategory = '';
let taYieldLogSearch = '';
let taYieldMachineState = { process: '', serie: '', pn: '', machine: '', defectType: '', defect: '', groupBy: 'day' };
let appliedTaYieldMachineControlSnapshot = '';
let selectedScYieldWeeks = [];
let selectedTaYieldWeeks = [];
let latestOperationTransitions = [];
let operationTransitionRequestKey = '';
let reportLoadingCount = 0;
let appliedReportControlSnapshot = '';
function reportControlSnapshot() { return JSON.stringify({ dataset: selectedDataset(), product: byId('product').value, startDate: byId('startDate').value, endDate: byId('endDate').value, process: byId('process').value, series: [...selectedSeries()].sort(), case: byId('case').value, partNumbers: [...selectedPartNumbers()].sort() }); }
function updateReportPendingNotice() { const notice = byId('reportPendingNotice'); const pending = Boolean(appliedReportControlSnapshot) && reportControlSnapshot() !== appliedReportControlSnapshot; notice.hidden = !pending; byId('apply').classList.toggle('has-pending-changes', pending); }
function markReportControlsApplied() { appliedReportControlSnapshot = reportControlSnapshot(); updateReportPendingNotice(); }
let mtdChartStyle = 'bullet';
let dailyTargetStatusEnabled = true;
let hideInProgressDay = false;
let showZeroSeries = false;
let hasInitializedDashboard = false;
let inProgressReportingDate = '';
let latestSourceReportingDate = '';
let parameterEditReturnFocus;
const targetSettingsKey = 'onemes.mtd-target-settings.v1';
const wipInsightVisibilityKey = 'onemes.wip-insight-visibility.v1';
let targetStorageRemote = false;
let targetSettings = localTargetSettings();
let wipInsightVisibility = localWipInsightVisibility();
let commentsEnabled = false;
let selectedCommentCell;
const commentsByCell = new Map();

function setStatus(message, loading = false) {
  const status = byId('status');
  status.textContent = message;
  status.className = loading ? 'status loading' : 'status';
}

function setReportControlsLoading(loading) { reportLoadingCount = Math.max(0, reportLoadingCount + (loading ? 1 : -1)); const active = reportLoadingCount > 0; const toolbar = byId('reportControls'); byId('reportLoading').hidden = !active; toolbar.setAttribute('aria-busy', String(active)); if (active) { ['startDate', 'endDate', 'processSelect', 'serie', 'serieTrigger', 'case', 'pn', 'apply', 'dataSource'].forEach((id) => { byId(id).disabled = true; }); document.querySelectorAll('.process-option').forEach((button) => { button.disabled = true; }); return; } const filters = currentConfig.filters || {}; byId('startDate').disabled = false; byId('endDate').disabled = false; byId('dataSource').disabled = false; byId('apply').disabled = false; document.querySelectorAll('.process-option').forEach((button) => { button.disabled = false; }); byId('processSelect').disabled = selectedDataset() !== 'lot' || filters.process === false; byId('serie').disabled = filters.serie === false; byId('serieTrigger').disabled = filters.serie === false; byId('case').disabled = filters.case === false; byId('pn').disabled = filters.pn === false; }

function selectedSeries() { return [...byId('serie').selectedOptions].map((option) => option.value); }
function updateSerieTrigger() { const selected = selectedSeries(); byId('serieTrigger').textContent = selected.length ? (selected.length === 1 ? selected[0] : `${selected.length} series selected`) : 'All series'; }
function serieFamily(value) { return value.trim().match(/^[A-Za-z]+/)?.[0].toUpperCase() || 'Other'; }
function seriePickerOption(option, selected, nested = false) { const label = document.createElement('label'); label.className = `serie-option${nested ? ' serie-variant' : ''}`; const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(option.value); checkbox.addEventListener('change', () => { option.selected = checkbox.checked; renderSeriePicker(); refreshOptionsForSerie(); }); label.append(checkbox, document.createTextNode(option.text)); return label; }
function renderSeriePicker() { const select = byId('serie'); const menu = byId('serieOptions'); const sourceOptions = [...select.options]; const selected = new Set(selectedSeries()); if (byId('product').value !== 'NEO') { menu.replaceChildren(...sourceOptions.map((option) => seriePickerOption(option, selected))); updateSerieTrigger(); return; } const groups = sourceOptions.reduce((result, option) => { const family = serieFamily(option.value); return { ...result, [family]: [...(result[family] || []), option] }; }, {}); const nodes = Object.entries(groups).sort(([left], [right]) => left.localeCompare(right)).flatMap(([family, variants]) => { if (variants.length === 1) return [seriePickerOption(variants[0], selected)]; const group = document.createElement('div'); group.className = 'serie-group'; const label = document.createElement('label'); label.className = 'serie-group-label'; const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; const selectedCount = variants.filter((option) => selected.has(option.value)).length; checkbox.checked = selectedCount === variants.length; checkbox.indeterminate = selectedCount > 0 && selectedCount < variants.length; checkbox.addEventListener('change', () => { variants.forEach((option) => { option.selected = checkbox.checked; }); renderSeriePicker(); refreshOptionsForSerie(); }); label.append(checkbox, document.createTextNode(`${family} (${variants.length})`)); group.append(label, ...variants.map((option) => seriePickerOption(option, selected, true))); return [group]; }); menu.replaceChildren(...nodes); updateSerieTrigger(); }
function localTargetSettings() { try { const value = JSON.parse(localStorage.getItem(targetSettingsKey) || '{}'); return value && typeof value === 'object' ? value : {}; } catch { return {}; } }
function localWipInsightVisibility() { try { const value = JSON.parse(localStorage.getItem(wipInsightVisibilityKey) || '{}'); return { flow: value.flow !== false, yield: value.yield !== false }; } catch { return { flow: true, yield: true }; } }
function readTargetSettings() { return targetSettings; }
function writeTargetSettings(settings) { targetSettings = settings; if (!targetStorageRemote) localStorage.setItem(targetSettingsKey, JSON.stringify(settings)); }
function targetSettingsFromRecords(records) { return records.reduce((settings, record) => ({ ...settings, [record.product]: { ...(settings[record.product] || {}), [record.serie]: { periods: { ...(settings[record.product]?.[record.serie]?.periods || {}), [record.period]: { target: record.monthlyPlan, workingDay: record.workingDay } } } } }), {}); }
function targetRecords(settings) { return Object.entries(settings).flatMap(([product, series]) => Object.entries(series).flatMap(([serie, setting]) => Object.entries(setting.periods || {}).map(([period, value]) => ({ product, serie, period, monthlyPlan: value.target, workingDay: value.workingDay })))); }
async function loadTargetSettings(migrateLocal = false) { if (!targetStorageRemote) { targetSettings = localTargetSettings(); return; } const stored = await request('/api/mtd-targets'); if (migrateLocal) { const existing = new Set(stored.map((target) => `${target.product}|${target.serie}|${target.period}`)); const missing = targetRecords(localTargetSettings()).filter((target) => !existing.has(`${target.product}|${target.serie}|${target.period}`)); await Promise.all(missing.map((target) => request('/api/mtd-targets', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(target) }))); if (missing.length) return loadTargetSettings(false); } targetSettings = targetSettingsFromRecords(stored); }
function selectedReportingPeriod() { const start = byId('startDate').value; const end = byId('endDate').value; if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start.slice(0, 7) !== end.slice(0, 7)) return ''; return start.slice(0, 7); }
function bangkokToday() { const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).reduce((result, part) => ({ ...result, [part.type]: part.value }), {}); return `${parts.year}-${parts.month}-${parts.day}`; }
async function latestTaYieldStagingDate(todayString) { try { const rows = await request('/api/staging-status'); const stagingRows = rows.data || rows; const value = stagingRows.find((row) => row.name === 'TA Yield DataTable')?.lastDataDate; const latestDate = typeof value === 'string' ? value.slice(0, 10) : ''; return /^\d{4}-\d{2}-\d{2}$/.test(latestDate) && latestDate < todayString ? latestDate : todayString; } catch { return todayString; } }
function bangkokDate(value) { const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value)).reduce((result, part) => ({ ...result, [part.type]: part.value }), {}); return `${parts.year}-${parts.month}-${parts.day}`; }
function selectedDateAxisDates(data) { const start = byId('startDate').value; const end = byId('endDate').value; if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) return [...new Set(data.map((row) => row.bucketDate))]; const dates = []; const cursor = new Date(`${start}T00:00:00Z`); const last = new Date(`${end}T00:00:00Z`); while (cursor <= last) { dates.push(cursor.toISOString().slice(0, 10)); cursor.setUTCDate(cursor.getUTCDate() + 1); } return dates; }
function resolveInProgressReportingDate() { const today = bangkokToday(); return byId('startDate').value <= today && byId('endDate').value === today ? today : ''; }
function isInProgressDay(date) { return Boolean(inProgressReportingDate) && date === inProgressReportingDate; }
function isWipRefreshPendingDay(date) { return currentConfig.dataset === 'lot' && Boolean(inProgressReportingDate) && latestSourceReportingDate < inProgressReportingDate && date === latestSourceReportingDate; }
function reportingDateLabel(date) { if (isInProgressDay(date)) return `${date.slice(5)} (live)`; return isWipRefreshPendingDay(date) ? `${date.slice(5)} (refreshing)` : date.slice(5); }
function targetSetting(product, serie, period = selectedReportingPeriod(), includeZero = false) { if (!period) return undefined; const setting = readTargetSettings()[product]?.[serie]; const resolved = setting?.periods?.[period] || (setting?.period === period ? setting : undefined); return !includeZero && Number(resolved?.target) === 0 ? undefined : resolved; }
function savedSeriesForPeriod(product, period) { if (!product || !period) return []; return Object.entries(readTargetSettings()[product] || {}).filter(([, setting]) => Boolean(setting?.periods?.[period] || setting?.period === period)).map(([serie]) => serie); }
function dailyQuantityCell(value, product, serie, date) { const setting = dailyTargetStatusEnabled && currentConfig.dataset === 'closed' && !isInProgressDay(date) ? targetSetting(product, serie, date.slice(0, 7)) : undefined; if (!setting) return `<td>${format.format(value)}</td>`; const dailyTarget = setting.target / setting.workingDay; const passed = value >= dailyTarget; return `<td class="daily-${passed ? 'pass' : 'below'}" title="Daily target ${format.format(dailyTarget)}" aria-label="${escapeHtml(serie)} ${date}: ${passed ? 'meets' : 'is below'} daily target ${format.format(dailyTarget)}">${format.format(value)}</td>`; }
function mtdPlan(setting) { const currentDay = Number(byId('endDate').value.slice(-2)); const dailyTarget = setting.target / setting.workingDay; return { currentDay, dailyTarget, mtdTarget: dailyTarget * currentDay }; }
function commentScope() { return { product: byId('product').value, pn: byId('pn').value.trim(), process: byId('process').value.trim() }; }
function commentKey(cell) { return [cell.product, cell.serie, cell.pn || '', cell.process || '', cell.reportingDate].join('|'); }
async function loadCellComments(requestId) { const scope = commentScope(); if (!commentsEnabled || !scope.product) { if (requestId === undefined || requestId === dataRequestId) commentsByCell.clear(); return; } const params = new URLSearchParams({ ...scope, startDate: byId('startDate').value, endDate: byId('endDate').value }); const comments = await request(`/api/comments?${params}`); if (requestId !== undefined && requestId !== dataRequestId) return; commentsByCell.clear(); comments.forEach((comment) => commentsByCell.set(commentKey({ ...comment, reportingDate: String(comment.reportingDate).slice(0, 10) }), comment)); }
function commentDayCell(value, serie, reportingDate) { const scope = commentScope(); const setting = dailyTargetStatusEnabled && currentConfig.dataset === 'closed' && !isInProgressDay(reportingDate) ? targetSetting(scope.product, serie, reportingDate.slice(0, 7)) : undefined; const status = setting ? ` daily-${value >= setting.target / setting.workingDay ? 'pass' : 'below'}` : ''; const cell = { ...scope, serie, reportingDate }; const comment = commentsByCell.get(commentKey(cell)); const canComment = commentsEnabled && Boolean(scope.product); const prompt = canComment ? 'Add or edit a comment' : 'Select NEO or SC before adding a comment'; return `<td class="comment-cell${status}${comment ? ' has-comment' : ''}" data-comment-product="${escapeHtml(cell.product)}" data-comment-serie="${escapeHtml(serie)}" data-comment-pn="${escapeHtml(cell.pn)}" data-comment-process="${escapeHtml(cell.process)}" data-comment-date="${reportingDate}" title="${prompt}"><button class="cell-comment-value" type="button">${format.format(value)}</button></td>`; }
function closeCommentPopover() { selectedCommentCell = undefined; byId('cellCommentPopover').hidden = true; }
function openCellComment(cell, anchor) { if (!commentsEnabled || !cell.product) return; selectedCommentCell = cell; const comment = commentsByCell.get(commentKey(cell)); byId('commentCellLabel').textContent = `${cell.serie} / ${cell.reportingDate}`; byId('commentMeta').textContent = comment ? `Updated by ${comment.createdBy} on ${new Date(comment.updatedAt || comment.createdAt).toLocaleString()}` : 'New comment'; byId('commentExisting').hidden = !comment; byId('commentExisting').textContent = comment?.commentText || ''; byId('commentText').value = comment?.commentText || ''; byId('commentDelete').hidden = !comment; byId('commentStatus').textContent = ''; const bounds = anchor.getBoundingClientRect(); const popover = byId('cellCommentPopover'); popover.hidden = false; popover.style.left = `${Math.min(Math.max(bounds.left, 12), Math.max(window.innerWidth - 332, 12))}px`; popover.style.top = `${Math.min(bounds.bottom + 8, Math.max(window.innerHeight - 270, 12))}px`; byId('commentText').focus(); }
async function saveCellComment() { const cell = selectedCommentCell; const text = byId('commentText').value.trim(); const status = byId('commentStatus'); if (!cell || !text) { status.textContent = 'Enter a comment before saving.'; return; } const existing = commentsByCell.get(commentKey(cell)); const save = byId('commentSave'); save.disabled = true; status.textContent = 'Saving comment...'; try { if (existing) await request(`/api/comments/${existing.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commentText: text }) }); else await request('/api/comments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...cell, dataset: selectedDataset(), commentText: text }) }); await loadCellComments(); renderData(latestData, latestChartData, latestMtdData); if (!byId('commentView').hidden) await loadCommentLog(); closeCommentPopover(); } catch (error) { status.textContent = error.message; } finally { save.disabled = false; } }
async function deleteCellComment() { const cell = selectedCommentCell; const existing = cell && commentsByCell.get(commentKey(cell)); if (!existing || !window.confirm(`Delete the comment for ${cell.serie} on ${cell.reportingDate}?`)) return; const button = byId('commentDelete'); button.disabled = true; byId('commentStatus').textContent = 'Deleting comment...'; try { await request(`/api/comments/${existing.id}`, { method: 'DELETE' }); await loadCellComments(); renderData(latestData, latestChartData, latestMtdData); if (!byId('commentView').hidden) await loadCommentLog(); closeCommentPopover(); } catch (error) { byId('commentStatus').textContent = error.message; } finally { button.disabled = false; } }
function commentDate(value) { return String(value).slice(0, 10); }
function commentTimestamp(value) { return value ? new Date(value).toLocaleString() : '-'; }
async function loadCommentLog() { const table = byId('commentView').querySelector('.comment-log-table table'); const status = byId('commentLogStatus'); if (!commentsEnabled) { status.textContent = 'Cell comment storage has not been configured.'; table.innerHTML = '<tbody><tr><td>Comment storage is unavailable.</td></tr></tbody>'; return; } status.textContent = 'Loading comments...'; try { const comments = await request('/api/comments/all'); const dates = [...new Set(comments.map((comment) => commentDate(comment.reportingDate)))].sort(); const scopes = [...new Map(comments.map((comment) => [`${comment.product}|${comment.serie}|${comment.pn || ''}|${comment.process || ''}`, comment])).values()]; const byScopeDate = new Map(comments.map((comment) => [`${comment.product}|${comment.serie}|${comment.pn || ''}|${comment.process || ''}|${commentDate(comment.reportingDate)}`, comment])); table.innerHTML = `<thead><tr><th>Product</th><th>Serie</th><th>PN / Process</th>${dates.map((date) => `<th>${escapeHtml(date.slice(5))}</th>`).join('')}</tr></thead><tbody>${scopes.map((scope) => { const key = `${scope.product}|${scope.serie}|${scope.pn || ''}|${scope.process || ''}`; return `<tr><td>${escapeHtml(scope.product)}</td><td>${escapeHtml(scope.serie)}</td><td>${escapeHtml([scope.pn, scope.process].filter(Boolean).join(' / ') || '-')}</td>${dates.map((date) => { const comment = byScopeDate.get(`${key}|${date}`); return `<td class="comment-log-matrix-cell" title="${escapeHtml(comment ? `${comment.createdBy} · ${commentTimestamp(comment.updatedAt || comment.createdAt)}\n${comment.commentText}` : '')}">${comment ? escapeHtml(comment.commentText) : ''}</td>`; }).join('')}</tr>`; }).join('') || '<tr><td colspan="3">No active comments.</td></tr>'}</tbody>`; status.textContent = comments.length ? `${comments.length} active comment${comments.length === 1 ? '' : 's'} across ${dates.length} reporting date${dates.length === 1 ? '' : 's'}.` : ''; } catch (error) { table.innerHTML = '<tbody><tr><td>Comments could not be loaded.</td></tr></tbody>'; status.textContent = error.message; } }
function renderDataModel(models) { const labels = { reportingDate: 'Reporting date', productOrProcess: 'Product / process', serie: 'Serie', partNumber: 'Part number', quantity: 'Quantity', sourceOperation: 'Source operation', disposition: 'Disposition', prodLine: 'Product line fallback' }; const fields = (model, keys) => keys.filter((key) => model.columns[key]).map((key) => `<li><span>${labels[key]}</span><code>${escapeHtml(model.columns[key])}</code></li>`).join(''); const node = (title, model, keys, className = '') => `<article class="model-node ${className}"><div class="model-node-header"><span>${escapeHtml(title)}</span><code>${escapeHtml(model.view)}</code></div><ul>${fields(model, keys) || '<li>No configured report columns.</li>'}</ul></article>`; const closed = models?.closed; const lot = models?.lot; if (!closed || !lot) { byId('dataModelCanvas').innerHTML = '<p class="empty">Data model metadata is unavailable.</p>'; return; } const lookup = lot.seriesLookup; const join = lookup ? `<small><code>${escapeHtml(lookup.sourceJoinColumn)}</code> to <code>${escapeHtml(lookup.lookupJoinColumn)}</code></small>` : '<small>No lookup configured</small>'; byId('dataModelCanvas').innerHTML = `<div class="model-visual-diagram"><div class="model-source-stack">${node('WIP / Lot Complete Log', lot, ['reportingDate', 'productOrProcess', 'sourceOperation', 'partNumber', 'quantity', 'disposition'], 'model-primary')}<div class="model-branch-stack"><article class="model-use-node"><strong>WIP flow</strong><span><code>${escapeHtml(lot.columns.sourceOperation || '-')}</code> to <code>${escapeHtml(lot.columns.productOrProcess || '-')}</code></span><small>Inbound - outbound good quantity</small></article><article class="model-use-node"><strong>Yield / loss</strong><span><code>${escapeHtml(lot.columns.sourceOperation || '-')}</code> + <code>${escapeHtml(lot.columns.disposition || '-')}</code></span><small>Good versus non-good quantity</small></article></div></div><div class="model-arrow-link"><span>Series lookup</span><i></i>${join}</div>${node('901 / Closed Batch', closed, ['reportingDate', 'productOrProcess', 'serie', 'partNumber', 'quantity', 'prodLine'], 'model-primary')}<div class="model-target-use"><strong>Completion and MTD</strong><span><code>${escapeHtml(closed.columns.quantity || '-')}</code> by <code>${escapeHtml(closed.columns.serie || '-')}</code> and <code>${escapeHtml(closed.columns.reportingDate || '-')}</code></span></div></div><p class="model-note">Solid arrows show the configured relationship. Branches show which columns drive WIP flow, yield/loss, Completion 901, and MTD reporting.</p>`; }
function renderWipInsights(flow, yieldData) { const panel = byId('wipInsights'); if (currentConfig.dataset !== 'lot') { panel.hidden = true; return; } panel.hidden = false; applyWipInsightVisibility(); const flowRows = [...flow].sort((left, right) => Math.abs(right.netQuantity) - Math.abs(left.netQuantity)).slice(0, 15); byId('wipFlowRows').innerHTML = flowRows.map((row) => { const accumulating = row.netQuantity >= 0; return `<tr><td>${escapeHtml(row.operationName)}</td><td>${format.format(row.inboundQuantity)}</td><td>${format.format(row.outboundQuantity)}</td><td class="net-flow ${accumulating ? 'accumulating' : 'clearing'}">${accumulating ? '+' : ''}${format.format(row.netQuantity)}</td><td>${escapeHtml(commentTimestamp(row.lastActivity))}</td></tr>`; }).join('') || '<tr><td colspan="5">No good movement data matches the selected filters.</td></tr>'; const goodDisposition = String(yieldData?.goodDisposition || 'good').trim().toLowerCase(); const operations = (yieldData?.rows || []).reduce((items, row) => { const current = items.get(row.operationName) || { operationName: row.operationName, goodQuantity: 0, nonGoodQuantity: 0 }; const quantity = Number(row.quantityMoved || 0); const next = String(row.disposition || '').trim().toLowerCase() === goodDisposition ? { ...current, goodQuantity: current.goodQuantity + quantity } : { ...current, nonGoodQuantity: current.nonGoodQuantity + quantity }; items.set(row.operationName, next); return items; }, new Map()); const yieldRows = [...operations.values()].map((row) => ({ ...row, totalQuantity: row.goodQuantity + row.nonGoodQuantity, yieldPercent: row.goodQuantity + row.nonGoodQuantity ? row.goodQuantity / (row.goodQuantity + row.nonGoodQuantity) * 100 : 0 })).sort((left, right) => right.nonGoodQuantity - left.nonGoodQuantity || left.yieldPercent - right.yieldPercent).slice(0, 15); byId('yieldRows').innerHTML = yieldRows.map((row) => `<tr><td>${escapeHtml(row.operationName)}</td><td>${format.format(row.goodQuantity)}</td><td>${format.format(row.nonGoodQuantity)}</td><td>${format.format(row.totalQuantity)}</td><td class="${row.yieldPercent < 95 ? 'yield-low' : 'yield-good'}">${row.yieldPercent.toFixed(1)}%</td></tr>`).join('') || '<tr><td colspan="5">No disposition data matches the selected filters.</td></tr>'; }
let savedParameterTab = 'current';
function renderSavedParameters() {
  const currentPeriod = bangkokToday().slice(0, 7);
  const product = byId('parameterProduct').value;
  const saved = Object.entries(readTargetSettings()).flatMap(([savedProduct, series]) => Object.entries(series).flatMap(([serie, setting]) => Object.entries(setting.periods || {}).map(([period, value]) => ({ product: savedProduct, serie, period, ...value }))));
  const displayed = saved.filter((row) => savedParameterTab === 'history' ? row.period < currentPeriod : savedParameterTab === 'upcoming' ? row.period > currentPeriod : row.period === currentPeriod).sort((left, right) => left.product.localeCompare(right.product) || left.serie.localeCompare(right.serie) || right.period.localeCompare(left.period));
  const configured = new Set(saved.filter((row) => row.product === product && row.period === currentPeriod).map((row) => row.serie));
  const placeholders = savedParameterTab === 'current' && product ? [...byId('parameterSerie').options].map((option) => option.value).filter(Boolean).filter((serie) => !configured.has(serie)).sort().map((serie) => ({ product, serie, period: currentPeriod })) : [];
  const savedRows = displayed.map((row) => `<tr><td>${escapeHtml(row.product)}</td><td>${escapeHtml(row.serie)}</td><td>${escapeHtml(row.period)}</td><td>${format.format(row.target)}</td><td>${format.format(row.workingDay)}</td><td>${format.format(row.target / row.workingDay)}</td><td><span class="parameter-actions"><button class="edit-parameter" type="button" data-edit-product="${escapeHtml(row.product)}" data-edit-serie="${escapeHtml(row.serie)}" data-edit-period="${escapeHtml(row.period)}">Edit</button><button class="remove-parameter" type="button" data-remove-product="${escapeHtml(row.product)}" data-remove-serie="${escapeHtml(row.serie)}" data-remove-period="${escapeHtml(row.period)}">Remove</button></span></td></tr>`);
  const templateRows = placeholders.map((row) => `<tr class="parameter-template-row"><td>${escapeHtml(row.product)}</td><td>${escapeHtml(row.serie)}</td><td>${escapeHtml(row.period)}</td><td><input type="number" min="0" step="any" inputmode="decimal" data-template-target placeholder="Monthly plan" aria-label="${escapeHtml(row.serie)} monthly plan" /></td><td><input type="number" min="0.01" step="any" inputmode="decimal" data-template-working-day placeholder="Working days" aria-label="${escapeHtml(row.serie)} working days" /></td><td>—</td><td><button class="save-parameter-template" type="button" data-template-product="${escapeHtml(row.product)}" data-template-serie="${escapeHtml(row.serie)}" data-template-period="${escapeHtml(row.period)}">Save</button></td></tr>`);
  byId('savedParameterRows').innerHTML = [...savedRows, ...templateRows].join('') || `<tr><td colspan="7">No ${savedParameterTab} parameters saved.</td></tr>`;
  let tabs = byId('savedParameterTabs');
  if (!tabs) { tabs = document.createElement('div'); tabs.id = 'savedParameterTabs'; tabs.className = 'saved-parameter-tabs'; byId('savedParameterRows').closest('.table-wrap').insertAdjacentElement('beforebegin', tabs); }
  tabs.innerHTML = ['current', 'upcoming', 'history'].map((tab) => `<button type="button" data-saved-parameter-tab="${tab}" class="${savedParameterTab === tab ? 'active' : ''}" aria-pressed="${savedParameterTab === tab}">${tab === 'current' ? 'Current parameters' : tab === 'upcoming' ? 'Upcoming' : 'History'}</button>`).join('');
  tabs.querySelectorAll('[data-saved-parameter-tab]').forEach((button) => button.addEventListener('click', () => { savedParameterTab = button.dataset.savedParameterTab; renderSavedParameters(); }));
}function renderMtdGauge(entries) { const gauge = byId('mtdGauge'); if (!entries.length) { gauge.innerHTML = '<p class="empty">No MTD target available.</p>'; return; } const target = entries.reduce((sum, entry) => sum + entry.mtdTarget, 0); const actual = entries.reduce((sum, entry) => sum + entry.actual, 0); const achievement = target ? actual / target * 100 : 0; const progress = Math.min(Math.max(achievement, 0), 100); gauge.innerHTML = `<svg viewBox="0 0 300 218" role="img" aria-label="Product total MTD result ${format.format(actual)} against target ${format.format(target)}"><path class="gauge-track" d="M 35 168 A 115 115 0 0 1 265 168" pathLength="100"/><path class="gauge-value" d="M 35 168 A 115 115 0 0 1 265 168" pathLength="100" stroke-dasharray="${progress} 100"/><text class="gauge-caption" x="150" y="101" text-anchor="middle">RESULT MTD</text><text class="gauge-value-text" x="150" y="132" text-anchor="middle">${compactFormat.format(actual)}</text><text class="gauge-percent" x="150" y="156" text-anchor="middle">${achievement.toFixed(1)}% of target</text><text class="gauge-bound" x="35" y="194" text-anchor="start">0</text><text class="gauge-bound" x="265" y="194" text-anchor="end">${compactFormat.format(target)}</text><title>Result MTD: ${format.format(actual)}. MTD target: ${format.format(target)}. Achievement: ${achievement.toFixed(1)}%.</title></svg><p>MTD target ${format.format(target)}</p>`; }
function bindMtdChartTooltips(chart = byId('mtdChart')) { const tooltip = chart.querySelector('.chart-tooltip'); chart.querySelectorAll('.mtd-series').forEach((mark) => { const show = (event) => { const bounds = chart.getBoundingClientRect(); const x = event?.clientX || bounds.left + bounds.width / 2; const y = event?.clientY || bounds.top + bounds.height / 2; tooltip.innerHTML = `<strong>${escapeHtml(mark.dataset.mtdSerie)}</strong><span>Monthly plan: ${format.format(Number(mark.dataset.monthlyPlan))}</span><span>Daily target: ${format.format(Number(mark.dataset.dailyTarget))}</span><span>MTD target: ${format.format(Number(mark.dataset.mtdTarget))}</span><span>Result MTD: ${format.format(Number(mark.dataset.actual))}</span><b>Gap: ${format.format(Number(mark.dataset.gap))} | ${Number(mark.dataset.achievement).toFixed(1)}%</b>`; tooltip.hidden = false; tooltip.style.left = `${Math.min(Math.max(x - bounds.left + 14, 8), Math.max(bounds.width - 220, 8))}px`; tooltip.style.top = `${Math.max(y - bounds.top - 104, 8)}px`; }; mark.addEventListener('mousemove', show); mark.addEventListener('mouseleave', () => { tooltip.hidden = true; }); mark.addEventListener('focus', show); mark.addEventListener('blur', () => { tooltip.hidden = true; }); }); }
function sortedMtdEntries(entries) { const sort = byId('mtdSort').value; return [...entries].sort((left, right) => ({ gap: () => left.gap - right.gap, achievement: () => left.achievement - right.achievement, result: () => right.actual - left.actual, serie: () => left.serie.localeCompare(right.serie) }[sort]())); }
function mtdDataAttributes(entry) { return `tabindex="0" role="img" data-mtd-serie="${escapeHtml(entry.serie)}" data-monthly-plan="${entry.monthlyPlan}" data-daily-target="${entry.dailyTarget}" data-mtd-target="${entry.mtdTarget}" data-actual="${entry.actual}" data-gap="${entry.gap}" data-achievement="${entry.achievement}"`; }
function renderMtdBulletChart(entries) { const chart = byId('mtdChart'); if (!entries.length) { chart.innerHTML = '<p class="empty">Save a monthly plan to compare MTD Target and Result.</p>'; return; } const displayed = sortedMtdEntries(entries); const maximum = Math.max(...displayed.flatMap((entry) => [entry.monthlyPlan, entry.mtdTarget, entry.actual]), 1); const width = 940; const left = 165; const right = 155; const top = 36; const rowHeight = 48; const height = Math.max(250, top + displayed.length * rowHeight + 20); const plotWidth = width - left - right; const scaleTicks = [0, .25, .5, .75, 1].map((ratio) => { const x = left + plotWidth * ratio; return `<line class="mtd-scale-line" x1="${x}" y1="${top - 12}" x2="${x}" y2="${height - 14}"/><text class="mtd-scale-label" x="${x}" y="${top - 20}" text-anchor="middle">${format.format(maximum * ratio)}</text>`; }).join(''); const rows = displayed.map((entry, index) => { const y = top + index * rowHeight; const barY = y + 13; const planX = left + entry.monthlyPlan / maximum * plotWidth; const planWidth = Math.max(0, planX - left); const targetX = left + entry.mtdTarget / maximum * plotWidth; const resultWidth = Math.max(entry.actual ? 2 : 0, entry.actual / maximum * plotWidth); const onTarget = entry.actual >= entry.mtdTarget; const resultColor = onTarget ? '#138f60' : '#38a3d1'; return `<g class="mtd-series" ${mtdDataAttributes(entry)}><text class="mtd-serie-label" x="${left - 14}" y="${y + 28}" text-anchor="end">${escapeHtml(entry.serie)}</text><rect class="mtd-track" x="${left}" y="${barY}" width="${plotWidth}" height="14" rx="7"/><rect class="mtd-plan-range" x="${left}" y="${barY}" width="${planWidth}" height="14" rx="7"/><rect class="chart-mark" x="${left}" y="${barY}" width="${resultWidth}" height="14" rx="7" fill="${resultColor}"/><line class="mtd-month-marker" x1="${planX}" y1="${barY - 4}" x2="${planX}" y2="${barY + 21}"/><path class="mtd-month-marker-head" d="M ${planX} ${barY - 11} l 6 6 l -6 6 l -6 -6 Z"/><line class="mtd-target-marker" x1="${targetX}" y1="${barY - 7}" x2="${targetX}" y2="${barY + 21}"/><text class="mtd-value-label" x="${width - right + 12}" y="${y + 22}">${format.format(entry.actual)}</text><text class="mtd-achievement-label ${onTarget ? 'on-target' : 'below-target'}" x="${width - right + 12}" y="${y + 36}">${entry.achievement.toFixed(1)}%</text></g>`; }).join(''); chart.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="MTD result bullet chart with monthly plan and target markers by series">${scaleTicks}${rows}</svg><div class="chart-tooltip" hidden></div>`; bindMtdChartTooltips(); }
function renderMtdColumnChart(entries) { const chart = byId('mtdChart'); if (!entries.length) { chart.innerHTML = '<p class="empty">Save a monthly plan to compare MTD Target and Result.</p>'; return; } const displayed = sortedMtdEntries(entries); const maximum = Math.max(...displayed.flatMap((entry) => [entry.monthlyPlan, entry.mtdTarget, entry.actual]), 1); const width = 940; const height = 310; const left = 66; const right = 24; const top = 26; const bottom = 72; const plotWidth = width - left - right; const plotHeight = height - top - bottom; const base = top + plotHeight; const slot = plotWidth / displayed.length; const barWidth = Math.max(16, Math.min(56, slot * .54)); const grid = [0, .25, .5, .75, 1].map((ratio) => { const y = base - plotHeight * ratio; return `<line class="gridline" x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"/><text class="axis" x="${left - 10}" y="${y + 4}" text-anchor="end">${format.format(maximum * ratio)}</text>`; }).join(''); const marks = displayed.map((entry, index) => { const center = left + index * slot + slot / 2; const x = center - barWidth / 2; const planY = base - entry.monthlyPlan / maximum * plotHeight; const targetY = base - entry.mtdTarget / maximum * plotHeight; const resultHeight = entry.actual / maximum * plotHeight; const onTarget = entry.actual >= entry.mtdTarget; return `<g class="mtd-series" ${mtdDataAttributes(entry)}><rect class="chart-mark" x="${x}" y="${base - resultHeight}" width="${barWidth}" height="${resultHeight}" rx="3" fill="${onTarget ? '#138f60' : '#38a3d1'}"/><line class="mtd-month-marker" x1="${x - 7}" y1="${planY}" x2="${x + barWidth + 7}" y2="${planY}"/><line class="mtd-target-marker" x1="${x - 7}" y1="${targetY}" x2="${x + barWidth + 7}" y2="${targetY}"/><text class="mtd-column-label" x="${center}" y="${base + 21}" text-anchor="middle">${escapeHtml(entry.serie)}</text></g>`; }).join(''); chart.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="MTD result column chart with monthly plan and target markers by series">${grid}<line x1="${left}" y1="${base}" x2="${width - right}" y2="${base}" stroke="#b8c7bf"/>${marks}</svg><div class="chart-tooltip" hidden></div>`; bindMtdChartTooltips(); }
function renderMtdTrendChart(entries, area) { const chart = byId('mtdChart'); if (!entries.length) { chart.innerHTML = '<p class="empty">Save a monthly plan to compare MTD Target and Result.</p>'; return; } const displayed = sortedMtdEntries(entries); const maximum = Math.max(...displayed.flatMap((entry) => [entry.monthlyPlan, entry.mtdTarget, entry.actual]), 1); const width = 940; const height = 310; const left = 66; const right = 24; const top = 26; const bottom = 72; const plotWidth = width - left - right; const plotHeight = height - top - bottom; const base = top + plotHeight; const slot = plotWidth / displayed.length; const labelEvery = Math.max(1, Math.ceil(displayed.length / 12)); const grid = [0, .25, .5, .75, 1].map((ratio) => { const y = base - plotHeight * ratio; return `<line class="gridline" x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"/><text class="axis" x="${left - 10}" y="${y + 4}" text-anchor="end">${format.format(maximum * ratio)}</text>`; }).join(''); const pointFor = (entry, index, value) => `${left + index * slot + slot / 2},${base - value / maximum * plotHeight}`; const monthlyPlanPoints = displayed.map((entry, index) => pointFor(entry, index, entry.monthlyPlan)).join(' '); const targetPoints = displayed.map((entry, index) => pointFor(entry, index, entry.mtdTarget)).join(' '); const resultPoints = displayed.map((entry, index) => pointFor(entry, index, entry.actual)).join(' '); const areaFill = area ? `<polygon class="mtd-result-area" points="${left + slot / 2},${base} ${resultPoints} ${left + (displayed.length - 1) * slot + slot / 2},${base}"/>` : ''; const marks = displayed.map((entry, index) => { const x = left + index * slot + slot / 2; const resultY = base - entry.actual / maximum * plotHeight; const targetY = base - entry.mtdTarget / maximum * plotHeight; const planY = base - entry.monthlyPlan / maximum * plotHeight; const label = index % labelEvery === 0 ? `<text class="mtd-column-label" x="${x}" y="${base + 21}" text-anchor="middle">${escapeHtml(entry.serie)}</text>` : ''; return `<g class="mtd-series" ${mtdDataAttributes(entry)}><circle class="mtd-month-point" cx="${x}" cy="${planY}" r="3.5"/><circle class="mtd-target-point" cx="${x}" cy="${targetY}" r="3.5"/><circle class="mtd-result-point" cx="${x}" cy="${resultY}" r="4"/>${label}</g>`; }).join(''); chart.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="MTD monthly plan, target, and result ${area ? 'area' : 'line'} chart by series">${grid}<line x1="${left}" y1="${base}" x2="${width - right}" y2="${base}" stroke="#b8c7bf"/>${areaFill}<polyline class="mtd-month-line" points="${monthlyPlanPoints}"/><polyline class="mtd-target-line" points="${targetPoints}"/><polyline class="mtd-result-line" points="${resultPoints}"/>${marks}</svg><div class="chart-tooltip" hidden></div>`; bindMtdChartTooltips(); }
function bindAccumulatedMtdTooltips(chart = byId('mtdChart')) { const tooltip = chart.querySelector('.chart-tooltip'); chart.querySelectorAll('.mtd-accumulated-point').forEach((point) => { const show = (event) => { const bounds = chart.getBoundingClientRect(); const x = event?.clientX || bounds.left + bounds.width / 2; const y = event?.clientY || bounds.top + bounds.height / 2; const actual = Number(point.dataset.actual); const target = Number(point.dataset.target); tooltip.innerHTML = `<strong>${escapeHtml(point.dataset.date)}</strong><span>Accumulated result: ${format.format(actual)}</span><span>Accumulated target: ${format.format(target)}</span><b>Gap: ${format.format(actual - target)}</b>`; tooltip.hidden = false; tooltip.style.left = `${Math.min(Math.max(x - bounds.left + 14, 8), Math.max(bounds.width - 220, 8))}px`; tooltip.style.top = `${Math.max(y - bounds.top - 90, 8)}px`; }; point.addEventListener('mousemove', show); point.addEventListener('mouseleave', () => { tooltip.hidden = true; }); point.addEventListener('focus', show); point.addEventListener('blur', () => { tooltip.hidden = true; }); }); }
function renderMtdAccumulatedChart(entries) { const chart = byId('mtdChart'); if (!entries.length) { chart.innerHTML = '<p class="empty">Save a monthly plan to compare accumulated MTD target and result.</p>'; return; } const period = entries[0].period; const end = byId('endDate').value; const cursor = new Date(`${period}-01T00:00:00Z`); const last = new Date(`${end}T00:00:00Z`); const dates = []; while (cursor <= last) { dates.push(cursor.toISOString().slice(0, 10)); cursor.setUTCDate(cursor.getUTCDate() + 1); } const series = new Set(entries.map((entry) => entry.serie)); const quantities = latestMtdData.filter((row) => series.has(row.itemName)).reduce((values, row) => ({ ...values, [row.bucketDate]: (values[row.bucketDate] || 0) + row.quantityMoved }), {}); const dailyTarget = entries.reduce((sum, entry) => sum + entry.dailyTarget, 0); let cumulative = 0; const points = dates.map((date, index) => { cumulative += quantities[date] || 0; return { date, actual: cumulative, target: dailyTarget * (index + 1) }; }); const maximum = Math.max(...points.flatMap((point) => [point.actual, point.target]), 1); const width = 940; const height = 310; const left = 68; const right = 28; const top = 24; const bottom = 60; const plotWidth = width - left - right; const plotHeight = height - top - bottom; const base = top + plotHeight; const slot = plotWidth / points.length; const barWidth = Math.max(3, Math.min(24, slot * .56)); const grid = [0, .25, .5, .75, 1].map((ratio) => { const y = base - plotHeight * ratio; return `<line class="gridline" x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"/><text class="axis" x="${left - 10}" y="${y + 4}" text-anchor="end">${format.format(maximum * ratio)}</text>`; }).join(''); const labelsEvery = Math.max(1, Math.ceil(points.length / 12)); const bars = points.map((point, index) => { const center = left + index * slot + slot / 2; const heightValue = point.actual / maximum * plotHeight; const label = index % labelsEvery === 0 || index === points.length - 1 ? `<text class="mtd-column-label" x="${center}" y="${base + 21}" text-anchor="middle">${point.date.slice(5)}</text>` : ''; return `<g class="mtd-accumulated-point" tabindex="0" role="img" data-date="${point.date}" data-actual="${point.actual}" data-target="${point.target}"><rect class="mtd-accum-bar" x="${center - barWidth / 2}" y="${base - heightValue}" width="${barWidth}" height="${heightValue}" rx="2"/>${label}</g>`; }).join(''); const targetPoints = points.map((point, index) => `${left + index * slot + slot / 2},${base - point.target / maximum * plotHeight}`).join(' '); chart.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Accumulated MTD result bars and cumulative target line by day">${grid}<line x1="${left}" y1="${base}" x2="${width - right}" y2="${base}" stroke="#b8c7bf"/>${bars}<polyline class="mtd-accum-target" points="${targetPoints}"/></svg><div class="chart-tooltip" hidden></div>`; bindAccumulatedMtdTooltips(); }
function renderMtdComboChart(entries) { const chart = byId('mtdChart'); if (!entries.length) { chart.innerHTML = '<p class="empty">Save a monthly plan to compare MTD Target and Result.</p>'; return; } const displayed = sortedMtdEntries(entries); const maximum = Math.max(...displayed.flatMap((entry) => [entry.monthlyPlan, entry.mtdTarget, entry.actual]), 1); const width = 940; const height = 310; const left = 66; const right = 24; const top = 26; const bottom = 72; const plotWidth = width - left - right; const plotHeight = height - top - bottom; const base = top + plotHeight; const slot = plotWidth / displayed.length; const barWidth = Math.max(16, Math.min(56, slot * .5)); const grid = [0, .25, .5, .75, 1].map((ratio) => { const y = base - plotHeight * ratio; return `<line class="gridline" x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"/><text class="axis" x="${left - 10}" y="${y + 4}" text-anchor="end">${format.format(maximum * ratio)}</text>`; }).join(''); const pointFor = (entry, index, value) => `${left + index * slot + slot / 2},${base - value / maximum * plotHeight}`; const monthlyPlanPoints = displayed.map((entry, index) => pointFor(entry, index, entry.monthlyPlan)).join(' '); const targetPoints = displayed.map((entry, index) => pointFor(entry, index, entry.mtdTarget)).join(' '); const bars = displayed.map((entry, index) => { const center = left + index * slot + slot / 2; const resultHeight = entry.actual / maximum * plotHeight; const onTarget = entry.actual >= entry.mtdTarget; return `<g class="mtd-series" ${mtdDataAttributes(entry)}><rect class="chart-mark" x="${center - barWidth / 2}" y="${base - resultHeight}" width="${barWidth}" height="${resultHeight}" rx="3" fill="${onTarget ? '#138f60' : '#38a3d1'}"/><text class="mtd-column-label" x="${center}" y="${base + 21}" text-anchor="middle">${escapeHtml(entry.serie)}</text></g>`; }).join(''); chart.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="MTD result bars with monthly plan and MTD target lines by series">${grid}<line x1="${left}" y1="${base}" x2="${width - right}" y2="${base}" stroke="#b8c7bf"/>${bars}<polyline class="mtd-month-line" points="${monthlyPlanPoints}"/><polyline class="mtd-target-line" points="${targetPoints}"/></svg><div class="chart-tooltip" hidden></div>`; bindMtdChartTooltips(); }
function renderMtdChartLegend() { const accumulated = mtdChartStyle === 'accumulated'; byId('mtdSortControl').hidden = accumulated; byId('mtdChartLegend').innerHTML = accumulated ? '<span><i class="accumulated-result-key"></i>Accumulated result</span><span><i class="accumulated-target-key"></i>Accumulated MTD target</span>' : '<span><i class="monthly-plan-key"></i>Monthly plan</span><span><i class="target-key"></i>MTD target</span><span><i class="result-key"></i>Result</span>'; }
function renderMtdChart(entries) { renderMtdChartLegend(); if (mtdChartStyle === 'accumulated') return renderMtdAccumulatedChart(entries); if (mtdChartStyle === 'column') return renderMtdColumnChart(entries); if (mtdChartStyle === 'line') return renderMtdTrendChart(entries, false); if (mtdChartStyle === 'area') return renderMtdTrendChart(entries, true); return renderMtdBulletChart(entries); }
let mtdChartModalTrigger = null;
function openMtdChartModal() { const chart = byId('mtdChart'); const modal = byId('mtdChartModal'); const expanded = byId('mtdChartExpanded'); mtdChartModalTrigger = document.activeElement; expanded.innerHTML = chart.innerHTML; if (mtdChartStyle === 'accumulated') bindAccumulatedMtdTooltips(expanded); else bindMtdChartTooltips(expanded); modal.hidden = false; byId('mtdChartModalClose').focus(); }
function closeMtdChartModal() { const modal = byId('mtdChartModal'); if (modal.hidden) return; modal.hidden = true; byId('mtdChartExpanded').innerHTML = ''; mtdChartModalTrigger?.focus(); mtdChartModalTrigger = null; }
function renderMtd(data) { const product = byId('product').value; const period = selectedReportingPeriod(); const selected = selectedSeries(); const visibleSeries = selected.length ? selected : [...new Set([...data.map((row) => row.itemName), ...savedSeriesForPeriod(product, period)])]; const entries = period ? visibleSeries.map((serie) => { const setting = targetSetting(product, serie, period); if (!setting) return undefined; const actual = data.filter((row) => row.itemName === serie).reduce((sum, row) => sum + row.quantityMoved, 0); const plan = mtdPlan(setting); const remainingPlan = Math.max(setting.target - actual, 0); const remainingWorkingDays = Math.max(setting.workingDay - Math.min(plan.currentDay, setting.workingDay), 0); return { serie, period, monthlyPlan: setting.target, workingDay: setting.workingDay, actual, ...plan, gap: actual - plan.mtdTarget, achievement: actual / plan.mtdTarget * 100, remainingPlan, recoveryPerDay: remainingWorkingDays ? remainingPlan / remainingWorkingDays : 0 }; }).filter(Boolean) : []; byId('mtdRows').innerHTML = entries.map((entry) => `<tr><td>${escapeHtml(product)}</td><td>${escapeHtml(entry.serie)}</td><td>${escapeHtml(entry.period)}</td><td>${format.format(entry.monthlyPlan)}</td><td>${format.format(entry.workingDay)}</td><td>${format.format(entry.currentDay)}</td><td>${format.format(entry.dailyTarget)}</td><td>${format.format(entry.mtdTarget)}</td><td>${format.format(entry.actual)}</td><td>${format.format(entry.gap)}</td><td>${entry.achievement.toFixed(1)}%</td><td>${format.format(entry.remainingPlan)}</td><td>${format.format(entry.recoveryPerDay)}</td></tr>`).join('') || `<tr><td colspan="13">${period ? 'No monthly MTD target matches the current Product, Serie, and period.' : 'Choose a date range within one calendar month to apply an MTD target.'}</td></tr>`; renderMtdGauge(entries); renderMtdChart(entries); byId('mtdMessage').textContent = !period ? 'MTD targets apply only when the selected start and end dates are in the same month.' : product && entries.length ? `MTD target uses monthly plan / working days multiplied by ${byId('endDate').value.slice(-2)} elapsed days.` : `Add a monthly plan for ${period} in Parameter Setting.`; }
function fillParameterSetting() { const product = byId('parameterProduct').value; const serie = byId('parameterSerie').value; const period = byId('parameterPeriod').value; const setting = product && serie && period ? targetSetting(product, serie, period, true) : undefined; byId('parameterTarget').value = setting?.target ?? ''; byId('parameterWorkingDay').value = setting?.workingDay || ''; }
async function loadParameterSeries() { const product = byId('parameterProduct').value; const serie = byId('parameterSerie'); if (!product) { serie.replaceChildren(new Option('Select product first', '')); serie.disabled = true; return; } byId('parameterStatus').textContent = ''; try { const options = await request(`/api/options?${new URLSearchParams({ dataset: selectedDataset(), product })}`); serie.replaceChildren(new Option('Select serie', ''), ...options.serie.map((value) => new Option(value, value))); serie.disabled = false; const dashboardSelection = selectedSeries(); if (dashboardSelection.length === 1 && options.serie.includes(dashboardSelection[0])) serie.value = dashboardSelection[0]; fillParameterSetting(); } catch (error) { byId('parameterStatus').textContent = error.message; } }
function ensureScYieldLogView() { let view = byId('scYieldLogView'); if (!view) { view = document.createElement('section'); view.id = 'scYieldLogView'; view.className = 'parameter-view sc-yield-log-view'; view.hidden = true; view.setAttribute('aria-labelledby', 'scYieldLogTitle'); byId('scYieldParameterView').insertAdjacentElement('afterend', view); } return view; }
function ensureTaYieldLogView() { let view = byId('taYieldLogView'); if (!view) { view = document.createElement('section'); view.id = 'taYieldLogView'; view.className = 'parameter-view sc-yield-log-view'; view.hidden = true; view.setAttribute('aria-labelledby', 'taYieldLogTitle'); ensureScYieldLogView().insertAdjacentElement('afterend', view); } return view; }
function ensureTaYieldMachineView() { return byId('taYieldMachineView'); }
function taYieldMachineControlSnapshot() { return JSON.stringify({ startDate: byId('taMachineStartDate').value, endDate: byId('taMachineEndDate').value, serie: byId('taMachineSerie').value, process: byId('taMachineProcess').value, partNumber: byId('taMachinePartNumber').value, defect: byId('taMachineDefect').value }); }
function updateTaYieldMachinePendingNotice() { const notice = byId('taMachinePendingNotice'); const pending = Boolean(appliedTaYieldMachineControlSnapshot) && taYieldMachineControlSnapshot() !== appliedTaYieldMachineControlSnapshot; notice.hidden = !pending; byId('taMachineApply').classList.toggle('has-pending-changes', pending); }
function markTaYieldMachineControlsApplied(snapshot = taYieldMachineControlSnapshot()) { appliedTaYieldMachineControlSnapshot = snapshot; updateTaYieldMachinePendingNotice(); }
function machineChart(rows) { const values = new Map(); rows.forEach((row) => { const key = `${row.date}|${row.machineName}`; values.set(key, { date: row.date, machineName: row.machineName, quantity: Number(values.get(key)?.quantity || 0) + Number(row.quantity || 0) }); }); const points = [...values.values()]; const machines = [...new Set(points.map((row) => row.machineName))].sort(); const dates = [...new Set(points.map((row) => row.date))].sort(); const maximum = Math.max(...points.map((row) => row.quantity), 1); const colors = ['#6f3cc3', '#f15a24', '#16835b', '#1596c4', '#d39300']; const colorFor = (machine) => colors[machines.indexOf(machine) % colors.length]; const width = Math.max(720, dates.length * 106); const height = 300; const left = 58; const right = 24; const top = 22; const bottom = 54; const plotWidth = width - left - right; const plotHeight = height - top - bottom; const x = (date) => left + dates.indexOf(date) * (dates.length > 1 ? plotWidth / (dates.length - 1) : plotWidth / 2); const y = (quantity) => top + plotHeight - quantity / maximum * plotHeight; const ticks = [0, .25, .5, .75, 1]; const machineLabel = machines.length === 1 ? machines[0] : `${machines.length} machines`; const grid = ticks.map((tick) => `<g><line x1="${left}" y1="${y(maximum * tick)}" x2="${width - right}" y2="${y(maximum * tick)}" class="ta-machine-grid"/><text x="${left - 10}" y="${y(maximum * tick) + 4}" text-anchor="end">${format.format(maximum * tick)}</text></g>`).join(''); const series = machines.map((machine) => { const machinePoints = dates.map((date) => ({ date, quantity: points.find((point) => point.date === date && point.machineName === machine)?.quantity || 0 })); const line = machinePoints.map((point) => `${x(point.date)},${y(point.quantity)}`).join(' '); return `<g class="ta-machine-line-series"><polyline points="${line}" stroke="${colorFor(machine)}"/><g>${machinePoints.map((point) => `<circle cx="${x(point.date)}" cy="${y(point.quantity)}" r="4" fill="${colorFor(machine)}"><title>${escapeHtml(`${machine} · ${point.date} · ${format.format(point.quantity)} defects`)}</title></circle>`).join('')}</g></g>`; }).join(''); return `<header class="ta-machine-chart-heading"><div class="ta-machine-identity"><span class="ta-machine-icon" aria-hidden="true">M</span><div><p>Machine trend</p><h3>${escapeHtml(machineLabel)}</h3><small>Process: ${escapeHtml(taYieldMachineState.process || '—')} · Defect quantity by occurrence date</small></div></div><div class="ta-machine-chart-summary"><span><b>${format.format(dates.length)}</b> reporting dates</span><span><b>${format.format(points.reduce((sum, point) => sum + point.quantity, 0))}</b> total defects</span></div></header><div class="ta-machine-legend" aria-label="Machine legend">${machines.map((machine) => `<span><i style="background:${colorFor(machine)}"></i>${escapeHtml(machine)}</span>`).join('')}</div><div class="ta-machine-line-scroll"><svg class="ta-machine-line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="TA Yield defect quantity trend by machine">${grid}${series}${dates.map((date) => `<text x="${x(date)}" y="${height - 18}" text-anchor="middle">${escapeHtml(date.slice(5))}</text>`).join('')}</svg></div>`; }
function machineDateBars(rows) { const points = new Map(); rows.forEach((row) => { const key = `${row.date}|${row.machineName}`; points.set(key, { date: row.date, machineName: row.machineName, quantity: Number(points.get(key)?.quantity || 0) + Number(row.quantity || 0) }); }); const values = [...points.values()].sort((left, right) => `${left.date}|${left.machineName}`.localeCompare(`${right.date}|${right.machineName}`)); const maximum = Math.max(...values.map((row) => row.quantity), 1); const totalQuantity = values.reduce((sum, row) => sum + row.quantity, 0); const percentage = (quantity) => totalQuantity ? quantity / totalQuantity * 100 : 0; return `<header class="ta-machine-chart-heading"><div class="ta-machine-identity"><span class="ta-machine-icon" aria-hidden="true">M</span><div><p>Machine output by date</p><h3>${format.format(values.length)} date / machine records</h3><small>Process: ${escapeHtml(taYieldMachineState.process || '—')} · Defect share (%) · Machine name is shown below each date</small></div></div><div class="ta-machine-chart-summary"><label class="ta-machine-order">Order<select aria-label="Chart order" onchange="const bars=this.closest('.ta-machine-chart-wrap').querySelector('.ta-machine-date-bars');const items=[...bars.children];const key=(item)=>this.value==='machine-date'?item.dataset.machine+'|'+item.dataset.date:item.dataset.date+'|'+item.dataset.machine;items.sort((a,b)=>key(a).localeCompare(key(b)));bars.replaceChildren(...items)"><option value="date-machine">Date → Machine</option><option value="machine-date">Machine → Date</option></select></label><span><b>${format.format(new Set(values.map((row) => row.machineName)).size)}</b> machines</span><span><b>${format.format(totalQuantity)}</b> total defects</span></div></header><div class="ta-machine-bars-scroll"><div class="ta-machine-date-bars">${values.map((row) => `<article data-date="${escapeHtml(row.date)}" data-machine="${escapeHtml(row.machineName)}" title="${escapeHtml(`${row.date} · ${row.machineName} · ${format.format(row.quantity)} defects · ${percentage(row.quantity).toFixed(1)}% of selected total`)}"><span>${percentage(row.quantity).toFixed(1)}%</span><i style="height:${Math.max(3, row.quantity / maximum * 190)}px"></i><strong>${escapeHtml(row.date.slice(5))}</strong><small>${escapeHtml(row.machineName)}</small></article>`).join('')}</div></div>`; }
async function renderTaYieldMachineView() { const view = ensureTaYieldMachineView(); const { process, serie, pn, defectType, defect } = taYieldMachineState; view.innerHTML = `<div class="parameter-heading"><p class="section-kicker">TA Yield analysis</p><h2 id="taYieldMachineTitle">Machine</h2><p></p></div><div class="ta-machine-filters"><label>Start date<input id="taMachineStartDate" type="date" value="${byId('startDate').value}" /></label><label>End date<input id="taMachineEndDate" type="date" value="${byId('endDate').value}" /></label><label>Series<select id="taMachineSerie"><option value="">All series</option></select></label><label>Process<select id="taMachineProcess"><option value="">Select process</option><option value="1.1stAnodization">1.1stAnodization</option><option value="2.Welding">2.Welding</option><option value="3.Ei">3.Ei</option></select></label><label>Part number<select id="taMachinePartNumber"><option value="">All part numbers</option></select></label><label>Defect view<select id="taMachineDefect" disabled><option value="">Select process first</option></select></label><button id="taMachineApply" type="button">Analyze all machines</button></div><p id="taMachineLink" class="ta-machine-link" role="status"></p><div id="taMachineChart" class="ta-machine-chart-wrap"><p class="sc-yield-empty">Select a process and defect view, then analyze all machines.</p></div>`; byId('taMachineProcess').value = process;
  byId('taMachineApply').insertAdjacentHTML('afterend', '<p id="taMachinePendingNotice" class="ta-machine-pending-notice" role="status" hidden>Filters changed. Click Analyze all machines to update the analysis.</p>');
  const loadLotFilters = async () => { const options = await request('/api/options?dataset=ta-yield'); const setOptions = (id, values, selected, label) => { const control = byId(id); control.innerHTML = `<option value="">${label}</option>${values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('')}`; control.value = values.includes(selected) ? selected : ''; }; setOptions('taMachineSerie', options.serie || [], serie, 'All series'); setOptions('taMachinePartNumber', options.pn || [], pn, 'All part numbers'); }; const loadOptions = async () => { if (!byId('taMachineProcess').value) return; byId('taMachineDefect').disabled = true; byId('taMachineDefect').innerHTML = '<option>Loading defect views…</option>'; byId('taMachineApply').disabled = true; const params = new URLSearchParams({ dataset: 'ta-yield', startDate: byId('startDate').value, endDate: byId('endDate').value, process: byId('taMachineProcess').value }); const data = await request(`/api/ta-yield-machine-options?${params}`); byId('taMachineDefect').disabled = false; byId('taMachineApply').disabled = false; byId('taMachineDefect').innerHTML = `<option value="">Select defect view</option><optgroup label="Disposition code">${data.codes.map((value) => `<option value="code|${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('')}</optgroup><optgroup label="Yield Category">${data.categories.map((value) => `<option value="category|${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('')}</optgroup>`; byId('taMachineDefect').value = defectType && defect ? `${defectType}|${defect}` : ''; }; loadLotFilters().catch((error) => { byId('taMachineLink').textContent = error.message; });
  const analyze = async () => { const selectedProcess = byId('taMachineProcess').value; const selectedMachine = '__ALL__'; const [selectedDefectType, selectedDefect] = byId('taMachineDefect').value.split('|'); taYieldMachineState = { process: selectedProcess, machine: selectedMachine, defectType: selectedDefectType || '', defect: selectedDefect || '' }; if (!selectedProcess || !selectedDefect) { byId('taMachineChart').innerHTML = '<p class="sc-yield-empty">Select a process and defect view before analyzing.</p>'; return; } byId('taMachineApply').disabled = true; byId('taMachineApply').textContent = 'Loading…'; byId('taMachineChart').innerHTML = '<p class="sc-yield-empty">Loading Machine analysis…</p>'; const params = new URLSearchParams({ dataset: 'ta-yield', startDate: byId('taMachineStartDate').value, endDate: byId('taMachineEndDate').value, process: selectedProcess, machine: selectedMachine, defectType: selectedDefectType, defect: selectedDefect }); try { const data = await request(`/api/ta-yield-machine?${params}`); byId('taMachineLink').textContent = selectedDefectType === 'category' ? `Linked disposition codes: ${data.linkedModes.join(', ') || 'None'}` : ''; byId('taMachineChart').innerHTML = data.rows.length ? machineDateBars(data.rows) : '<p class="sc-yield-empty">No matching TA Yield defects were found for this selection.</p>'; } catch (error) { byId('taMachineChart').innerHTML = `<p class="sc-yield-empty">${escapeHtml(error.message)}</p>`; } finally { byId('taMachineApply').disabled = false; byId('taMachineApply').textContent = 'Analyze all machines'; } };
  byId('taMachineStartDate').addEventListener('change', (event) => { byId('startDate').value = event.target.value; renderTaYieldMachineView(); }); byId('taMachineEndDate').addEventListener('change', (event) => { byId('endDate').value = event.target.value; renderTaYieldMachineView(); });
  byId('taMachineProcess').addEventListener('change', async (event) => { taYieldMachineState = { process: event.target.value, machine: '__ALL__', defectType: '', defect: '' }; await renderTaYieldMachineView(); });
  byId('taMachineSerie').addEventListener('change', (event) => { taYieldMachineState = { ...taYieldMachineState, serie: event.target.value }; }); byId('taMachinePartNumber').addEventListener('change', (event) => { taYieldMachineState = { ...taYieldMachineState, pn: event.target.value }; }); byId('taMachineDefect').addEventListener('change', (event) => { const [type, value] = event.target.value.split('|'); taYieldMachineState = { ...taYieldMachineState, defectType: type || '', defect: value || '' }; }); byId('taMachineApply').addEventListener('click', analyze);
  byId('taMachineApply').addEventListener('click', () => { if (byId('taMachineProcess').value && byId('taMachineDefect').value) markTaYieldMachineControlsApplied(); });
  view.querySelector('.ta-machine-filters').addEventListener('change', () => requestAnimationFrame(updateTaYieldMachinePendingNotice));
  updateTaYieldMachinePendingNotice();
  if (process) { try { await loadOptions(); } catch (error) { byId('taMachineDefect').disabled = false; byId('taMachineDefect').innerHTML = `<option value="">${escapeHtml(error.message)}</option>`; byId('taMachineApply').disabled = false; byId('taMachineChart').innerHTML = `<p class="sc-yield-empty">${escapeHtml(error.message)}</p>`; } }
}
function ensureUtilityView(id) { let view = byId(id); if (!view) { view = document.createElement('section'); view.id = id; view.className = 'parameter-view'; view.hidden = true; ensureTaYieldLogView().insertAdjacentElement('afterend', view); } return view; }
async function renderDefectSettings() { const view = ensureUtilityView('defectSettingsView'); const data = await request('/api/defect-settings'); const isSc = currentConfig.dataset === 'yield'; const dataset = isSc ? 'SC' : 'TA'; const maps = (isSc ? data.sc.map((x) => ({ mode: x.mode, group: x.group, included: x.included })) : data.ta.map((x) => ({ mode: x.source, description: x.description, group: x.target, included: x.included }))).sort((a, b) => a.mode.localeCompare(b.mode)); const title = isSc ? 'SC Yield defect rule studio' : 'TA Yield defect rule studio'; const groups = [...new Set([...maps.map((x) => x.group), 'Unmapped'])].sort(); const sourceRows = maps.map((x) => `<button type="button" class="defect-rule-row" data-defect-mode="${escapeHtml(x.mode)}"><span class="defect-rule-code">${escapeHtml(x.mode)}${x.description ? `<small>${escapeHtml(x.description)}</small>` : ''}</span><span class="defect-rule-state ${x.included ? 'on' : 'off'}">${x.included ? 'Included' : 'Unmapped'}</span></button>`).join(''); const groupNodes = groups.map((group) => `<button type="button" class="defect-group-node" data-defect-group="${escapeHtml(group)}"><span>${escapeHtml(group)}</span><small>${maps.filter((x) => x.group === group).length} rules</small></button>`).join(''); view.innerHTML = `<div class="section-heading defect-studio-heading"><div><p class="section-kicker">Yield configuration</p><h2>${title}</h2><p>All source modes are loaded from MES. Unmapped modes are safe by default until you assign a Yield group and save.</p></div><div class="defect-studio-summary"><b>${maps.length}</b><span>MES modes</span><b>${groups.length}</b><span>groups</span></div></div><section class="defect-studio" aria-label="Defect rule flow"><aside class="defect-studio-source"><div class="defect-pane-title"><span>01</span><div><strong>Source mode</strong><small>MES defect disposition</small></div></div><label class="defect-search-label">Find mode<input id="defectModeSearch" type="search" placeholder="Search code or name" /></label><div id="defectRuleList" class="defect-rule-list">${sourceRows}</div></aside><div class="defect-studio-flow"><div class="defect-flow-line"></div><article class="defect-route-card"><span class="defect-step">02 · Routing rule</span><h3 id="defectSelectedMode">Select a source mode</h3><p>When the MES reports this disposition, send quantity to the selected Yield group.</p><form id="defectSettingForm" novalidate><label>Yield group<select id="defectSettingGroup">${groups.map((group) => `<option value="${escapeHtml(group)}">${escapeHtml(group)}</option>`).join('')}</select></label><label class="defect-include-control"><input id="defectSettingIncluded" type="checkbox" checked /><span><b>Count in Yield</b><small>Include quantity in the defect rate</small></span></label><button type="submit">Save rule</button></form><p id="defectSettingStatus" class="parameter-status" role="status"></p></article></div><aside class="defect-studio-target"><div class="defect-pane-title"><span>03</span><div><strong>Yield outcome</strong><small>Reporting group</small></div></div><div class="defect-group-list">${groupNodes}</div><div class="defect-outcome-preview"><span>Selected route</span><strong id="defectFlowGroup">—</strong><small id="defectFlowState">Select a source rule to inspect its outcome.</small></div></aside></section>`; let selected; const list = byId('defectRuleList'); const selectRule = (mode) => { const item = maps.find((x) => x.mode === mode); if (!item) return; selected = item; view.querySelectorAll('.defect-rule-row').forEach((row) => row.classList.toggle('active', row.dataset.defectMode === mode)); byId('defectSelectedMode').textContent = item.description ? `${item.mode} — ${item.description}` : item.mode; byId('defectSettingGroup').value = item.group; byId('defectSettingIncluded').checked = item.included; byId('defectFlowGroup').textContent = item.group; byId('defectFlowState').textContent = item.included ? 'Included in Yield calculation' : 'Not counted until you map and include it'; }; selectRule(maps[0]?.mode); list.addEventListener('click', (event) => { const row = event.target.closest('[data-defect-mode]'); if (row) selectRule(row.dataset.defectMode); }); byId('defectModeSearch').addEventListener('input', (event) => { const search = event.target.value.trim().toLowerCase(); view.querySelectorAll('.defect-rule-row').forEach((row) => { row.hidden = Boolean(search) && !row.textContent.toLowerCase().includes(search); }); }); view.querySelectorAll('[data-defect-group]').forEach((node) => node.addEventListener('click', () => { if (selected) { byId('defectSettingGroup').value = node.dataset.defectGroup; byId('defectFlowGroup').textContent = node.dataset.defectGroup; } })); byId('defectSettingForm').addEventListener('submit', async (event) => { event.preventDefault(); if (!selected) return; const button = event.currentTarget.querySelector('button'); button.disabled = true; try { const group = byId('defectSettingGroup').value; const included = byId('defectSettingIncluded').checked; await request('/api/defect-settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataset, mode: selected.mode, group, included }) }); Object.assign(selected, { group, included }); byId('defectSettingStatus').textContent = 'Rule saved to ProductionMES. Apply the report filters to recalculate Yield.'; byId('defectSettingStatus').className = 'parameter-status success'; selectRule(selected.mode); } catch (error) { byId('defectSettingStatus').textContent = error.message; } finally { button.disabled = false; } }); }
async function renderStagingStatus() { const view = ensureUtilityView('stagingStatusView'); const response = await request('/api/staging-status'); const formatTime = (value) => value ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'Asia/Bangkok' }).format(new Date(value)) : 'No refresh recorded'; const formatDate = (value) => value ? String(value).slice(0, 10) : '—'; const rows = response.data || response; view.innerHTML = `<div class="section-heading"><div><p class="section-kicker">System activity</p><h2>Staging status and freshness</h2><p>Checked ${escapeHtml(formatTime(response.checkedAt))}. Staging jobs refresh the current month from MES; data outside the current month remains history.</p></div></div><div class="table-wrap"><table><thead><tr><th>Area</th><th>Source → staging</th><th>State</th><th>Last refresh</th><th>Rows</th><th>Data range</th><th>Schedule / plan</th></tr></thead><tbody>${rows.map((x) => `<tr><td>${escapeHtml(x.name)}</td><td><span>${escapeHtml(x.source)}</span><br><small>${escapeHtml(x.table)}</small></td><td>${x.enabled ? (x.activityError ? escapeHtml(x.activityError) : x.activityAvailable ? 'Active' : 'Waiting for first refresh') : 'Not staged'}</td><td>${escapeHtml(formatTime(x.lastRefreshedAt))}</td><td>${x.activityAvailable ? format.format(x.rowCount || 0) : '—'}</td><td>${escapeHtml(formatDate(x.firstDataDate))} to ${escapeHtml(formatDate(x.lastDataDate))}</td><td>${x.enabled ? `Every ${Math.round(x.intervalMs / 60000)} min` : escapeHtml(x.plan || 'Not enabled')}</td></tr>`).join('')}</tbody></table></div><p>Plan source: <code>YIELD_STAGING_PLAN.md</code></p>`; }
function showView(view) { const parameters = view === 'parameters'; const comments = view === 'comments'; const model = view === 'model'; const defects = view === 'defects'; const staging = view === 'staging'; const dataTable = view === 'ta-data-table'; const taMachine = view === 'ta-yield-machine'; const scCalculationLog = view === 'sc-yield-log'; const taCalculationLog = view === 'ta-yield-log'; const calculationLog = scCalculationLog || taCalculationLog; const scYieldParameters = parameters && currentConfig.dataset === 'yield'; const scLogView = ensureScYieldLogView(); const taLogView = ensureTaYieldLogView(); const machineView = ensureTaYieldMachineView(); const defectView = ensureUtilityView('defectSettingsView'); const stagingView = ensureUtilityView('stagingStatusView'); const dataTableView = byId('taDataTableView'); byId('dashboardView').hidden = parameters || comments || model || calculationLog || defects || staging || dataTable || taMachine; dataTableView.hidden = !dataTable; machineView.hidden = !taMachine; byId('parameterView').hidden = !parameters || scYieldParameters; byId('scYieldParameterView').hidden = !scYieldParameters; scLogView.hidden = !scCalculationLog; taLogView.hidden = !taCalculationLog; defectView.hidden = !defects; stagingView.hidden = !staging; byId('commentView').hidden = !comments; byId('dataModelView').hidden = !model; document.querySelectorAll('.app-tab').forEach((button) => { const active = button.dataset.view === view; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); }); if (taMachine) renderTaYieldMachineView(); if (dataTable) ensureTaWorkbookVerificationView().loadRows().catch((error) => { byId('taWorkbookRows').innerHTML = `<tr><td colspan="6">${escapeHtml(error.message)}</td></tr>`; }); if (defects) renderDefectSettings().catch((error) => { defectView.textContent = error.message; }); if (staging) renderStagingStatus().catch((error) => { stagingView.textContent = error.message; }); if (parameters) { if (scYieldParameters) renderScYieldTargetParameters(latestScYieldData); else { if (!byId('parameterProduct').value && byId('product').value) byId('parameterProduct').value = byId('product').value; loadParameterSeries(); renderSavedParameters(); } } if (scCalculationLog) renderScYieldCalculationLog(); if (taCalculationLog) renderTaYieldCalculationLog(); if (comments) loadCommentLog(); if (model) renderDataModel(currentConfig.dataModels); }

function populateOptions(options, selected = {}) {
  const placeholders = { process: 'All processes', serie: 'All series', case: 'All cases' };
  ids.forEach((id) => {
    const select = byId(id);
    if (id === 'pn') return;
    const values = options[id] || [];
    const currentValue = selected[id] || '';
    if (id === 'process') {
      const usesLotOperation = selectedDataset() === 'lot';
      byId('lotProcessField').hidden = !usesLotOperation;
      const validValue = values.includes(currentValue) ? currentValue : '';
      if (usesLotOperation) {
        const processSelect = byId('processSelect');
        processSelect.replaceChildren(new Option('All operations', ''));
        values.forEach((value) => processSelect.add(new Option(value, value)));
        processSelect.value = validValue;
      }
      setSelectedProcess(validValue);
      return;
    }
    if (id === 'serie') { const selectedValues = Array.isArray(currentValue) ? currentValue : currentValue ? [currentValue] : []; select.replaceChildren(...values.map((value) => new Option(value, value, false, selectedValues.includes(value)))); renderSeriePicker(); return; }
    select.replaceChildren(new Option(placeholders[id], ''));
    values.forEach((value) => select.add(new Option(value, value)));
    select.value = values.includes(currentValue) ? currentValue : '';
  });
}

function setSelectedProcess(value) {
  byId('process').value = value;
}

function usesOperationDateAxis() { return currentConfig.dataset === 'lot' && Boolean(byId('process').value); }

function setSelectedProduct(value) { byId('product').value = value; document.querySelectorAll('.process-option').forEach((button) => button.classList.toggle('active', button.dataset.product === value)); }

function resetPartNumbers() {
  pnState.items = []; pnState.hasMore = false; pnState.offset = 0; pnState.loading = false; pnState.query = ''; pnState.error = ''; pnState.selected = [];
  byId('pn').value = ''; byId('pnOptions').replaceChildren(); byId('pnMenu').hidden = true;
  renderPartNumberSelection();
}

function renderPartNumberSelection() {
  byId('pnSelected').replaceChildren(...selectedPartNumbers().map((pn) => {
    const chip = document.createElement('span'); chip.className = 'pn-chip'; chip.textContent = pn;
    const remove = document.createElement('button'); remove.type = 'button'; remove.dataset.removePn = pn; remove.setAttribute('aria-label', `Remove ${pn}`); remove.textContent = 'x'; chip.append(remove); return chip;
  }));
}

function renderPartNumbers() {
  const options = byId('pnOptions');
  if (pnState.loading || !pnState.items.length) {
    const message = document.createElement('p'); message.className = 'pn-empty';
    message.textContent = pnState.loading ? 'Searching part numbers...' : pnState.error || (pnState.query.trim() ? 'No matching part numbers.' : 'All part numbers are included. Type to search or choose a PN.');
    options.replaceChildren(message); byId('pnLoadMore').hidden = true; return;
  }
  options.replaceChildren(...pnState.items.map((match) => {
    const option = document.createElement('button'); option.type = 'button'; option.className = 'pn-option'; option.role = 'option'; option.title = match.serie ? `PN ${match.value}, series ${match.serie}` : `PN ${match.value}`;
    const value = document.createElement('span'); value.className = 'pn-option-value'; value.textContent = match.value;
    const serie = document.createElement('span'); serie.className = 'pn-option-serie'; serie.textContent = match.serie ? `Series: ${match.serie}` : 'Series: not mapped';
    option.append(value, serie);
    option.addEventListener('click', () => { if (!selectedPartNumbers().includes(match.value) && selectedPartNumbers().length < 12) pnState.selected = [...selectedPartNumbers(), match.value]; byId('pn').value = ''; pnState.query = ''; renderPartNumberSelection(); renderPartNumbers(); byId('pnMenu').hidden = true; byId('pn').setAttribute('aria-expanded', 'false'); });
    return option;
  }));
  byId('pnLoadMore').hidden = !pnState.hasMore;
}

async function loadPartNumbers(reset = false) {
  const input = byId('pn'); const requestId = ++pnState.requestId;
  if (reset) { pnState.items = []; pnState.offset = 0; pnState.loading = true; pnState.query = input.value; pnState.error = ''; renderPartNumbers(); byId('pnMenu').hidden = false; input.setAttribute('aria-expanded', 'true'); }
  if (reset && input.value.trim().length < 2) { pnState.loading = false; renderPartNumbers(); return; }
  const params = new URLSearchParams({ dataset: selectedDataset(), limit: '100', offset: String(pnState.offset), ...(byId('product').value ? { product: byId('product').value } : {}), ...(byId('process').value ? { process: byId('process').value } : {}), ...(input.value ? { search: input.value } : {}) }); selectedSeries().forEach((serie) => params.append('serie', serie));
  try {
    const result = await request(`/api/part-numbers?${params}`);
    if (requestId !== pnState.requestId) return;
    const matches = result.matches || result.items.map((value) => ({ value, serie: '' }));
    pnState.items = reset ? matches : [...pnState.items, ...matches]; pnState.offset = pnState.items.length; pnState.hasMore = result.hasMore; pnState.loading = false;
    renderPartNumbers(); byId('pnMenu').hidden = false; input.setAttribute('aria-expanded', 'true');
  } catch (error) {
    if (requestId === pnState.requestId) { pnState.loading = false; pnState.items = []; pnState.hasMore = false; pnState.error = `Part numbers could not be loaded: ${error.message}`; renderPartNumbers(); }
    throw error;
  }
}

function setFilterAvailability(filters) {
  ids.forEach((id) => {
    const available = Boolean(filters[id]);
    byId(id).disabled = !available;
    byId(id).closest('label, .process-field').hidden = !available;
    if (id === 'serie') byId('serieTrigger').disabled = !available;
  });
}

const chartColors = ['#28358c', '#4c6edb', '#38a3d1', '#ec8f34', '#7d62b4', '#c7546d', '#16835b', '#c19b20', '#1c7e8c', '#b8572a', '#975c91', '#6b7489', '#e05285', '#417141', '#a55f31', '#3c5a9b', '#008b8b', '#8a692e', '#ae3c4e', '#6464b8'];

function bindChartTooltips() {
  const chart = byId('chart'); const tooltip = chart.querySelector('.chart-tooltip');
  chart.querySelectorAll('[data-chart-category]').forEach((mark) => {
    mark.addEventListener('mousemove', (event) => { const bounds = chart.getBoundingClientRect(); tooltip.innerHTML = `<strong>${escapeHtml(mark.dataset.chartSerie)}</strong><span>${escapeHtml(mark.dataset.chartCategory)}</span><b>${format.format(Number(mark.dataset.chartValue))}</b>`; tooltip.hidden = false; tooltip.style.left = `${Math.min(event.clientX - bounds.left + 14, bounds.width - 185)}px`; tooltip.style.top = `${Math.max(event.clientY - bounds.top - 74, 8)}px`; });
    mark.addEventListener('mouseleave', () => { tooltip.hidden = true; });
  });
}

function renderCategoricalChart(categories, series, valueFor, options) {
  const chart = byId('chart');
  if (!categories.length) { chart.innerHTML = `<p class="empty">${options.emptyMessage}</p>`; return; }
  const totals = categories.map((category) => series.reduce((sum, serie) => sum + valueFor(category, serie), 0));
  const individualValues = categories.flatMap((category) => series.map((serie) => valueFor(category, serie)));
  const totalFor = (category) => totals[categories.indexOf(category)] || 0;
  const displayValue = (category, serie) => chartMode === 'percent' ? (valueFor(category, serie) / totalFor(category)) * 100 || 0 : valueFor(category, serie);
  const maximum = chartMode === 'percent' ? 100 : Math.max(...(['stacked'].includes(chartMode) ? totals : individualValues), 1);
  const readableOperationLabels = options.showAllLabels && !processChartFit;
  const width = readableOperationLabels ? Math.max(1080, categories.length * 86 + 94) : 1080; const height = 360; const left = 72; const right = 22; const top = 24; const bottom = options.rotateLabels ? 84 : 56;
  const plotWidth = width - left - right; const plotHeight = height - top - bottom; const base = top + plotHeight;
  const slot = plotWidth / categories.length; const clusterWidth = Math.max(5, Math.min(52, slot * 0.68)); const labelEvery = readableOperationLabels ? 1 : Math.max(1, Math.ceil(categories.length / 12));
  const grid = [0, 0.25, 0.5, 0.75, 1].map((ratio) => { const y = base - plotHeight * ratio; const value = maximum * ratio; return `<line class="gridline" x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"/><text class="axis" x="${left - 10}" y="${y + 4}" text-anchor="end">${chartMode === 'percent' ? `${value}%` : format.format(value)}</text>`; }).join('');
  const labels = categories.map((category, index) => { if (index % labelEvery && index !== categories.length - 1) return ''; const x = left + index * slot + slot / 2; const text = escapeHtml(options.label(category)); return options.rotateLabels ? `<text class="axis" x="${x}" y="${base + 16}" text-anchor="end" transform="rotate(-40 ${x} ${base + 16})">${text}</text>` : `<text class="axis" x="${x}" y="${base + 24}" text-anchor="middle">${text}</text>`; }).join('');
  const lineMarks = series.map((serie, seriesIndex) => { const points = categories.map((category, index) => `${left + index * slot + slot / 2},${base - (displayValue(category, serie) / maximum) * plotHeight}`).join(' '); const dots = categories.map((category, index) => { const value = valueFor(category, serie); const x = left + index * slot + slot / 2; const y = base - (displayValue(category, serie) / maximum) * plotHeight; return value ? `<circle class="chart-point" data-chart-category="${escapeHtml(options.label(category))}" data-chart-serie="${escapeHtml(serie)}" data-chart-value="${value}" cx="${x}" cy="${y}" r="3" fill="${chartColors[seriesIndex % chartColors.length]}"/>` : ''; }).join(''); const fill = chartMode === 'area' ? `<polygon points="${left + slot / 2},${base} ${points} ${left + (categories.length - 1) * slot + slot / 2},${base}" fill="${chartColors[seriesIndex % chartColors.length]}" opacity=".18"/>` : ''; return `${fill}<polyline class="chart-line" points="${points}" fill="none" stroke="${chartColors[seriesIndex % chartColors.length]}" stroke-width="2.5"/>${dots}`; }).join('');
  const barMarks = categories.map((category, index) => { const startX = left + index * slot + (slot - clusterWidth) / 2; let stacked = 0; return series.map((serie, seriesIndex) => { const rawValue = valueFor(category, serie); if (!rawValue) return ''; const height = (displayValue(category, serie) / maximum) * plotHeight; const width = ['stacked', 'percent'].includes(chartMode) ? clusterWidth : clusterWidth / series.length; const x = ['stacked', 'percent'].includes(chartMode) ? startX : startX + seriesIndex * width; const y = ['stacked', 'percent'].includes(chartMode) ? base - (stacked += height) : base - height; return `<rect class="chart-mark" data-chart-category="${escapeHtml(options.label(category))}" data-chart-serie="${escapeHtml(serie)}" data-chart-value="${rawValue}" x="${x}" y="${y}" width="${Math.max(width - (chartMode === 'grouped' ? 1 : 0), 2)}" height="${height}" rx="2" fill="${chartColors[seriesIndex % chartColors.length]}" stroke="#ffffff" stroke-width="0.6"/>`; }).join(''); }).join('');
  const marks = ['line', 'area'].includes(chartMode) ? lineMarks : barMarks;
  byId('chartLegend').innerHTML = series.map((serie, index) => `<span class="chart-legend-item"><i style="background:${chartColors[index % chartColors.length]}"></i>${escapeHtml(serie)}</span>`).join('');
  const svgWidth = options.fitToPanel ? '100%' : `${width}px`;
  chart.innerHTML = `<div class="chart-scroll${options.fitToPanel ? ' chart-scroll-fit' : ''}"><svg viewBox="0 0 ${width} ${height}" style="width:${svgWidth}" role="img" aria-label="${escapeHtml(options.accessibleLabel)}">${grid}<line x1="${left}" y1="${base}" x2="${width - right}" y2="${base}" stroke="#b8c7bf"/>${labels}${marks}</svg></div><div class="chart-tooltip" hidden></div>`; bindChartTooltips();
}

function renderChart(data, chartData) {
  const isProcessChart = currentConfig.chartAxis === 'process' && !usesOperationDateAxis();
  byId('chartFit').hidden = !isProcessChart;
  if (isProcessChart) return renderProcessChart(chartData || []);
  const dates = selectedDateAxisDates(data).filter((date) => !hideInProgressDay || !isInProgressDay(date)); const series = [...new Set(data.map((row) => row.itemName))].sort();
  const values = new Map(data.map((row) => [`${row.bucketDate}|${row.itemName}`, row.quantityMoved]));
  byId('chart-title').textContent = currentConfig.dataset === 'lot' ? 'Quantity moved by day' : 'Completed qty by day';
  renderCategoricalChart(dates, series, (date, serie) => values.get(`${date}|${serie}`) || 0, { label: (date) => date.slice(5), emptyMessage: currentConfig.dataset === 'lot' ? 'No good quantity data matches the selected operation and filters.' : 'No completion data matches the selected filters.', accessibleLabel: currentConfig.dataset === 'lot' ? 'Quantity moved by day and series' : 'Completed quantity by date and series' });
}

function renderProcessChart(data) {
  ensureOperationTransitions();
  const series = [...new Set(data.map((row) => row.seriesName || 'Unspecified'))].sort(); const values = new Map(data.map((row) => [`${row.chartName || 'Unspecified'}|${row.seriesName || 'Unspecified'}`, row.quantityMoved]));
  const names = [...new Set(data.map((row) => row.chartName || 'Unspecified'))];
  const routeOrder = new Map();
  data.forEach((row) => {
    const operation = row.chartName || 'Unspecified';
    const next = [(row.fromRouteStepOrder ?? row.fromRouteStepName) || '', (row.toRouteStepOrder ?? row.toRouteStepName) || '', row.fromRouteSequence, row.toRouteSequence];
    const current = routeOrder.get(operation);
    if (!current || compareRouteOrder(next, current) < 0) routeOrder.set(operation, next);
  });
  const fallbackOrder = [...names].sort((left, right) => compareRouteOrder(routeOrder.get(left) || [], routeOrder.get(right) || []) || left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }));
  const processes = orderOperationsByTransition(fallbackOrder);
  byId('chart-title').textContent = 'Quantity moved by process';
  renderCategoricalChart(processes, series, (process, serie) => values.get(`${process}|${serie}`) || 0, { label: (process) => process, rotateLabels: true, showAllLabels: true, fitToPanel: processChartFit, emptyMessage: 'No good quantity data matches the selected filters.', accessibleLabel: 'Quantity moved by process and series' });
}

function compareRouteOrder(left, right) {
  const compareSequence = (leftValue, rightValue) => {
    const leftText = String(leftValue ?? '').trim(); const rightText = String(rightValue ?? '').trim();
    const leftNumber = leftText ? Number(leftText) : Number.NaN; const rightNumber = rightText ? Number(rightText) : Number.NaN;
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
    if (Number.isFinite(leftNumber)) return -1;
    if (Number.isFinite(rightNumber)) return 1;
    return leftText.localeCompare(rightText, undefined, { numeric: true, sensitivity: 'base' });
  };
  const fromStep = compareSequence(left[0], right[0]); const toStep = compareSequence(left[1], right[1]);
  const fromRoute = compareSequence(left[2], right[2]); const toRoute = compareSequence(left[3], right[3]);
  return fromStep || toStep || fromRoute || toRoute;
}

function orderOperationsByTransition(fallbackOrder) {
  const available = new Set(fallbackOrder); const neighbors = new Map(fallbackOrder.map((operation) => [operation, new Set()])); const incoming = new Map(fallbackOrder.map((operation) => [operation, 0]));
  latestOperationTransitions.forEach(({ fromOperation, toOperation }) => {
    if (!available.has(fromOperation) || !available.has(toOperation) || fromOperation === toOperation || neighbors.get(fromOperation).has(toOperation)) return;
    neighbors.get(fromOperation).add(toOperation); incoming.set(toOperation, incoming.get(toOperation) + 1);
  });
  const fallbackIndex = new Map(fallbackOrder.map((operation, index) => [operation, index])); const compare = (left, right) => fallbackIndex.get(left) - fallbackIndex.get(right) || left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
  const queue = fallbackOrder.filter((operation) => incoming.get(operation) === 0).sort(compare); const ordered = [];
  while (queue.length) { const operation = queue.shift(); ordered.push(operation); neighbors.get(operation).forEach((next) => { incoming.set(next, incoming.get(next) - 1); if (incoming.get(next) === 0) { queue.push(next); queue.sort(compare); } }); }
  return ordered.length === fallbackOrder.length ? ordered : [...ordered, ...fallbackOrder.filter((operation) => !ordered.includes(operation))];
}

function ensureOperationTransitions() {
  if (currentConfig.dataset !== 'lot' || usesOperationDateAxis()) return;
  const key = exportReportParams().toString();
  if (key === operationTransitionRequestKey) return;
  operationTransitionRequestKey = key; latestOperationTransitions = [];
  request(`/api/operation-transitions?${key}`).then((rows) => { if (operationTransitionRequestKey !== key) return; latestOperationTransitions = rows; renderChart(latestData, latestChartData); }).catch(() => { if (operationTransitionRequestKey === key) latestOperationTransitions = []; });
}

function renderData(data, chartData, mtdData = data) {
  latestData = data;
  latestChartData = chartData || [];
  latestMtdData = mtdData;
  inProgressReportingDate = resolveInProgressReportingDate();
  latestSourceReportingDate = data.map((row) => row.bucketDate).filter((date) => date <= byId('endDate').value).sort().at(-1) || '';
  const hasInProgressDay = Boolean(inProgressReportingDate);
  const displayData = hideInProgressDay ? data.filter((row) => !isInProgressDay(row.bucketDate)) : data;
  const dates = selectedDateAxisDates(displayData).filter((date) => !hideInProgressDay || !isInProgressDay(date));
  const groupedByPn = selectedPartNumbers().length > 0;
  const selectedSerieNames = selectedSeries();
  const zeroSeries = currentConfig.dataset === 'closed' && !groupedByPn && showZeroSeries ? (selectedSerieNames.length ? selectedSerieNames : [...byId('serie').options].map((option) => option.value).filter(Boolean)) : [];
  const series = [...new Set([...displayData.map((row) => row.itemName), ...zeroSeries])].sort();
  const amounts = displayData.reduce((result, row) => ({ ...result, [`${row.itemName}|${row.bucketDate}`]: row.quantityMoved }), {});
  byId('totalQuantity').textContent = format.format(displayData.reduce((total, row) => total + row.quantityMoved, 0));
  byId('seriesCount').textContent = format.format(series.length);
  byId('groupCountLabel').textContent = groupedByPn ? 'Part numbers' : 'Series';
  byId('dayCount').textContent = format.format(dates.length);
  byId('inProgressDayControl').hidden = false;
  byId('zeroSeriesControl').hidden = currentConfig.dataset !== 'closed' || groupedByPn;
  byId('inProgressDayMessage').hidden = !hasInProgressDay || hideInProgressDay;
  byId('inProgressDayMessage').textContent = hasInProgressDay ? currentConfig.dataset === 'closed' ? `${inProgressReportingDate.slice(5)} is live; MTD includes day ${Number(byId('endDate').value.slice(-2))}.` : latestSourceReportingDate && latestSourceReportingDate < inProgressReportingDate ? `${inProgressReportingDate.slice(5)} is live; WIP source data is currently reported through ${latestSourceReportingDate.slice(5)}. ${latestSourceReportingDate.slice(5)} may still increase while the source refreshes.` : `${inProgressReportingDate.slice(5)} is live; WIP quantities may still increase.` : '';
  byId('commentHint').hidden = commentsEnabled && Boolean(byId('product').value);
  byId('commentHint').textContent = commentsEnabled ? 'Select a Product to add comments' : 'Comment storage is unavailable';
  byId('tableHead').innerHTML = `<tr><th rowspan="2">${groupedByPn ? 'PN' : 'Series'}</th><th rowspan="2">Qty</th><th colspan="${dates.length}">Day</th></tr><tr>${dates.map((date) => `<th class="${isInProgressDay(date) ? 'in-progress-day' : ''}${isWipRefreshPendingDay(date) ? ' refresh-pending-day' : ''}">${reportingDateLabel(date)}</th>`).join('')}</tr>`;
  byId('rows').innerHTML = series.map((name) => { const total = displayData.filter((row) => row.itemName === name).reduce((sum, row) => sum + row.quantityMoved, 0); const mtdTotal = mtdData.filter((row) => row.itemName === name).reduce((sum, row) => sum + row.quantityMoved, 0); const target = targetSetting(byId('product').value, name); const belowTarget = target && mtdTotal < mtdPlan(target).mtdTarget; return `<tr class="${belowTarget ? 'below-target' : ''}"${belowTarget ? ` aria-label="${escapeHtml(name)} is below its MTD target"` : ''}><td>${escapeHtml(name)}</td><td>${format.format(total)}</td>${dates.map((date) => commentDayCell(amounts[`${name}|${date}`] || 0, name, date)).join('')}</tr>`; }).join('');
  renderMtd(mtdData);
  renderChart(displayData, chartData);
}

function bindScYieldWeeklyTooltips(holder) {
  holder.querySelectorAll('.sc-yield-weekly-point').forEach((point) => {
    const card = point.closest('.sc-yield-series-card');
    const tooltip = card.querySelector('.sc-yield-weekly-tooltip');
    const show = (event) => {
      const bounds = card.getBoundingClientRect();
      const pointBounds = point.getBoundingClientRect();
      const x = event?.clientX ?? pointBounds.left + pointBounds.width / 2;
      const y = event?.clientY ?? pointBounds.top + pointBounds.height / 2;
      tooltip.innerHTML = `<strong>${escapeHtml(point.dataset.serie)}</strong><span>${escapeHtml(point.dataset.week)}</span><b>Yield: ${Number(point.dataset.yield).toFixed(2)}%</b>`;
      tooltip.hidden = false;
      tooltip.style.left = `${Math.min(Math.max(x - bounds.left + 12, 8), Math.max(bounds.width - 146, 8))}px`;
      tooltip.style.top = `${Math.max(y - bounds.top - 84, 42)}px`;
    };
    point.addEventListener('mousemove', show);
    point.addEventListener('mouseleave', () => { tooltip.hidden = true; });
    point.addEventListener('focus', show);
    point.addEventListener('blur', () => { tooltip.hidden = true; });
  });
}

function bindTaYieldTrendTooltips(holder) {
  holder.querySelectorAll('.ta-yield-tendency-panel .yield-column, .ta-yield-tendency-panel .yield-point, .ta-yield-tendency-panel .target-point, .ta-yield-tendency-panel .ta-yield-line-point, .ta-yield-tendency-panel rect[fill]').forEach((mark) => {
    const panel = mark.closest('.ta-yield-tendency-panel');
    const tooltip = panel.querySelector('.ta-yield-trend-tooltip');
    const show = (event) => {
      const bounds = panel.getBoundingClientRect();
      const markBounds = mark.getBoundingClientRect();
      const x = event?.clientX ?? markBounds.left + markBounds.width / 2;
      const y = event?.clientY ?? markBounds.top + markBounds.height / 2;
      const detail = mark.querySelector('title')?.textContent || '';
      const [period, value] = detail.split(/:\s(.+)/, 2);
      tooltip.innerHTML = `<strong>${escapeHtml(panel.querySelector('h4')?.textContent || 'TA Yield')}</strong><span>${escapeHtml(period)}</span><b>${escapeHtml(value || detail)}</b>`;
      tooltip.hidden = false;
      tooltip.style.left = `${Math.min(Math.max(x - bounds.left + 12, 8), Math.max(bounds.width - 210, 8))}px`;
      tooltip.style.top = `${Math.max(y - bounds.top - 94, 34)}px`;
    };
    mark.addEventListener('mousemove', show);
    mark.addEventListener('mouseleave', () => { tooltip.hidden = true; });
    mark.addEventListener('focus', show);
    mark.addEventListener('blur', () => { tooltip.hidden = true; });
  });
}

function renderScYieldWeeklyChartsBase(rows) {
  latestScYieldWeeklyData = rows;
  let holder = byId('scYieldWeeklyCharts');
  if (!holder) {
    byId('scYieldOverviewCharts').insertAdjacentHTML('beforebegin', '<section id="scYieldWeeklyCharts" class="sc-yield-series-section"><div><p class="section-kicker">Weekly performance</p><h3>Weekly yield tendency</h3></div></section>');
    holder = byId('scYieldWeeklyCharts');
  }
  const allWeeks = [...new Set(rows.map((row) => row.month))].sort();
  if (!selectedScYieldWeeks.length) selectedScYieldWeeks = allWeeks;
  const weeks = allWeeks.filter((week) => selectedScYieldWeeks.includes(week));
  const series = ['CAN', 'FC', 'FM'];
  const value = (week, serie, accumulated) => {
    const selected = rows.filter((row) => selectedScYieldWeeks.includes(row.month) && row.month <= week && (accumulated || row.month === week) && (serie === 'Total' || row.line === serie));
    const input = selected.reduce((sum, row) => sum + row.input, 0);
    const defect = selected.reduce((sum, row) => sum + row.defect, 0);
    return input ? (input - defect) / input * 100 : undefined;
  };
  const chart = (title, accumulated) => {
    const width = 620; const height = 230;
    const colors = { Total: '#7b5aac', CAN: '#4472c4', FC: '#c64f5f', FM: '#7fa843' };
    const plottedSeries = series.concat('Total');
    const values = plottedSeries.flatMap((serie) => weeks.map((week) => value(week, serie, accumulated)).filter((item) => item !== undefined));
    const min = Math.max(0, Math.floor((Math.min(...values) - .5) * 2) / 2);
    const max = Math.min(100, Math.ceil((Math.max(...values) + .5) * 2) / 2);
    const x = (index) => 52 + index * (width - 88) / Math.max(weeks.length - 1, 1);
    const y = (item) => 28 + (max - item) / Math.max(max - min, .1) * 155;
    const lines = plottedSeries.map((serie) => {
      const points = weeks.map((week, index) => value(week, serie, accumulated)).map((item, index) => item === undefined ? '' : `${x(index)},${y(item)}`).filter(Boolean).join(' ');
      return `<polyline fill="none" stroke="${colors[serie]}" stroke-width="2.5" points="${points}"/>`;
    }).join('');
    const marks = plottedSeries.flatMap((serie) => weeks.map((week, index) => {
      const item = value(week, serie, accumulated);
      return item === undefined ? '' : `<circle class="sc-yield-weekly-point" cx="${x(index)}" cy="${y(item)}" r="4" fill="${colors[serie]}" tabindex="0" data-serie="${serie}" data-week="${week}" data-yield="${item}" aria-label="${serie}, ${week}, yield ${item.toFixed(2)} percent"/>`;
    })).join('');
    return `<article class="sc-yield-series-card"><h4>${title}</h4><svg viewBox="0 0 ${width} ${height}" role="group" aria-label="${title}"><text x="8" y="28" font-size="11">${max.toFixed(1)}%</text><text x="8" y="183" font-size="11">${min.toFixed(1)}%</text>${lines}${marks}${weeks.map((week, index) => `<text x="${x(index)}" y="208" text-anchor="middle" font-size="10">${week.slice(-3)}</text>`).join('')}</svg><div class="sc-yield-weekly-tooltip" role="status" hidden></div></article>`;
  };
  holder.innerHTML = `<div><p class="section-kicker">Weekly performance</p><h3>Weekly yield tendency</h3><label>Select weeks <select id="scYieldWeekSelect" multiple size="4">${allWeeks.map((week) => `<option value="${week}" ${selectedScYieldWeeks.includes(week) ? 'selected' : ''}>${week}</option>`).join('')}</select></label></div><div class="sc-yield-series-grid">${chart('Weekly yield tendency', false)}${chart('Accumulated weekly yield tendency', true)}</div>`;
  bindScYieldWeeklyTooltips(holder);
  byId('scYieldWeekSelect').addEventListener('change', (event) => { selectedScYieldWeeks = [...event.target.selectedOptions].map((option) => option.value); renderScYieldWeeklyCharts(latestScYieldWeeklyData); });
}

function renderScYieldWeeklyCharts(rows) {
  const allWeeks = [...new Set(rows.map((row) => row.month))].sort();
  selectedScYieldWeeks = selectedScYieldWeeks.filter((week) => allWeeks.includes(week));
  if (!selectedScYieldWeeks.length) selectedScYieldWeeks = allWeeks;
  renderScYieldWeeklyChartsBase(rows);
  const selector = byId('scYieldWeekSelect');
  if (!selector) return;
  const start = selectedScYieldWeeks[0] || allWeeks[0]; const end = selectedScYieldWeeks.at(-1) || allWeeks.at(-1);
  selector.outerHTML = `<div class="sc-yield-week-range" role="group" aria-label="Weekly chart display range"><span class="sc-yield-week-range-title">Display range</span><label><span>From week</span><select id="scYieldWeekStart" aria-label="Start week">${allWeeks.map((week) => `<option value="${week}" ${week === start ? 'selected' : ''}>${week}</option>`).join('')}</select></label><span class="sc-yield-week-range-divider" aria-hidden="true">to</span><label><span>To week</span><select id="scYieldWeekEnd" aria-label="End week">${allWeeks.map((week) => `<option value="${week}" ${week === end ? 'selected' : ''}>${week}</option>`).join('')}</select></label></div>`;
  const update = () => { const first = byId('scYieldWeekStart').value; const last = byId('scYieldWeekEnd').value; selectedScYieldWeeks = allWeeks.filter((week) => week >= first && week <= last); renderScYieldWeeklyCharts(rows); };
  byId('scYieldWeekStart').addEventListener('change', update); byId('scYieldWeekEnd').addEventListener('change', update);
}

function renderScYieldInputRatioChart(rows) {
  const chart = byId('scYieldInputRatioChart');
  const series = ['CAN', 'FC', 'FM'];
  const colors = { CAN: '#4472c4', FC: '#d5413e', FM: '#7fa843' };
  const months = [...new Set(rows.map((row) => row.month).filter((month) => typeof month === 'string' && month))].sort();
  const entries = months.map((month) => {
    const quantities = Object.fromEntries(series.map((serie) => [serie, rows.filter((row) => row.month === month && row.line === serie).reduce((sum, row) => sum + row.input, 0)]));
    const total = Object.values(quantities).reduce((sum, quantity) => sum + quantity, 0);
    return { month, quantities, total };
  }).filter((entry) => entry.total > 0);
  if (!entries.length) {
    chart.innerHTML = '<p class="sc-yield-empty">No CAN, FC, or FM FG input is available to calculate the input ratio.</p>';
    return;
  }
  const width = Math.max(640, entries.length * 80 + 120); const height = 310;
  const left = 52; const right = 24; const top = 32; const bottom = 42;
  const plotWidth = width - left - right; const plotHeight = height - top - bottom; const base = top + plotHeight;
  const slot = plotWidth / entries.length; const barWidth = Math.min(64, slot * .68);
  const grid = [0, .2, .4, .6, .8, 1].map((ratio) => { const y = base - plotHeight * ratio; return `<line class="gridline" x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"/><text class="axis" x="${left - 10}" y="${y + 4}" text-anchor="end">${(ratio * 100).toFixed(0)}%</text>`; }).join('');
  const bars = entries.map((entry, index) => {
    const x = left + index * slot + (slot - barWidth) / 2; let stacked = 0;
    const parts = series.map((serie) => {
      const ratio = entry.quantities[serie] / entry.total * 100; const heightValue = ratio / 100 * plotHeight; const y = base - stacked - heightValue; stacked += heightValue;
      const label = heightValue >= 22 ? `<text class="sc-yield-ratio-label" x="${x + barWidth / 2}" y="${y + heightValue / 2 + 4}" text-anchor="middle">${ratio.toFixed(1)}%</text>` : '';
      return ratio ? `<g><rect x="${x}" y="${y}" width="${barWidth}" height="${heightValue}" fill="${colors[serie]}"><title>${entry.month} | ${serie}: ${format.format(entry.quantities[serie])} input (${ratio.toFixed(2)}%)</title></rect>${label}</g>` : '';
    }).join('');
    return `${parts}<text class="axis" x="${x + barWidth / 2}" y="${base + 24}" text-anchor="middle">${entry.month.slice(5)}</text>`;
  }).join('');
  const legend = series.map((serie) => `<span><i style="background:${colors[serie]}"></i>${serie}</span>`).join('');
  const description = entries.map((entry) => `${entry.month}: ${series.map((serie) => `${serie} ${format.format(entry.quantities[serie])} input, ${(entry.quantities[serie] / entry.total * 100).toFixed(1)} percent`).join('; ')}`).join('. ');
  chart.innerHTML = `<div class="sc-yield-legend"><strong>Series</strong>${legend}</div><div class="sc-yield-chart-scroll"><svg style="min-width:${width}px" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="scYieldInputRatioSvgTitle" aria-describedby="scYieldInputRatioSvgDescription"><title id="scYieldInputRatioSvgTitle">Monthly CAN, FC, and FM input ratio</title><desc id="scYieldInputRatioSvgDescription">${escapeHtml(description)}</desc><text class="axis axis-title" x="${left}" y="20">Input ratio</text>${grid}<line x1="${left}" y1="${base}" x2="${width - right}" y2="${base}" stroke="#b8c7bf"/>${bars}</svg></div>`;
}

function renderScYieldSeriesCharts(rows, groups) {
  const series = [...new Set(rows.map((row) => row.line || 'Unspecified'))].sort();
  byId('scYieldSeriesCharts').innerHTML = series.map((serie) => {
    const serieRows = rows.filter((row) => (row.line || 'Unspecified') === serie);
    const months = [...new Set(serieRows.map((row) => row.month))].sort();
    const points = months.map((month) => serieRows.filter((row) => row.month === month).reduce((result, row) => ({ input: result.input + row.input, defect: result.defect + row.defect, groups: row.groups.reduce((values, group) => ({ ...values, [group.group]: (values[group.group] || 0) + group.quantity }), result.groups) }), { input: 0, defect: 0, groups: {} })).map((entry, index) => ({ ...entry, month: months[index], target: scYieldTargetFor(serie, months[index]), defectRate: entry.input ? entry.defect / entry.input * 100 : undefined, yield: entry.input ? (entry.input - entry.defect) / entry.input * 100 : undefined }));
    if (!points.some((point) => point.input > 0)) return '';
    const width = Math.max(520, points.length * 62 + 108); const height = 250; const left = 44; const right = 45; const top = 28; const bottom = 40; const plotWidth = width - left - right; const plotHeight = height - top - bottom; const base = top + plotHeight; const slot = plotWidth / points.length; const barWidth = Math.min(32, slot * .58); const defectMax = Math.max(1, Math.ceil(Math.max(...points.map((point) => point.defectRate || 0)) * 10) / 10); const yields = [...points.filter((point) => point.yield !== undefined).map((point) => point.yield), ...points.filter((point) => point.target !== undefined).map((point) => point.target)]; let yieldMin = Math.max(0, Math.floor((Math.min(...yields) - .5) * 2) / 2); let yieldMax = Math.min(100, Math.ceil((Math.max(...yields) + .5) * 2) / 2); if (yieldMax - yieldMin < 1) { yieldMin = Math.max(0, yieldMin - .5); yieldMax = Math.min(100, yieldMax + .5); } const yYield = (value) => base - (value - yieldMin) / (yieldMax - yieldMin) * plotHeight;
    const grid = [0, .5, 1].map((ratio) => { const y = base - plotHeight * ratio; return `<line class="gridline" x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"/><text class="axis" x="${left - 6}" y="${y + 4}" text-anchor="end">${(defectMax * ratio).toFixed(1)}%</text><text class="axis" x="${width - right + 6}" y="${y + 4}">${(yieldMin + (yieldMax - yieldMin) * ratio).toFixed(1)}%</text>`; }).join('');
    const bars = points.map((point, index) => { const x = left + index * slot + (slot - barWidth) / 2; let stacked = 0; const parts = groups.map((group, groupIndex) => { const value = point.input ? (point.groups[group] || 0) / point.input * 100 : 0; const barHeight = value / defectMax * plotHeight; const y = base - stacked - barHeight; stacked += barHeight; return value ? `<rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" fill="${chartColors[groupIndex % chartColors.length]}"><title>${point.month} | ${group}: ${value.toFixed(3)}%</title></rect>` : ''; }).join(''); return `${parts}<text class="axis" x="${x + barWidth / 2}" y="${base + 18}" text-anchor="middle">${point.month.slice(5)}</text>`; }).join('');
    const lineSegments = []; let currentSegment = []; points.forEach((point, index) => { if (point.yield === undefined) { if (currentSegment.length) lineSegments.push(currentSegment); currentSegment = []; return; } currentSegment.push(`${left + index * slot + slot / 2},${yYield(point.yield)}`); }); if (currentSegment.length) lineSegments.push(currentSegment); const linePaths = lineSegments.map((segment) => `<polyline class="yield-line" points="${segment.join(' ')}"/>`).join(''); const dots = points.map((point, index) => point.yield === undefined ? '' : `<circle class="yield-point" cx="${left + index * slot + slot / 2}" cy="${yYield(point.yield)}" r="3"><title>${point.month} | Yield: ${point.yield.toFixed(3)}%</title></circle>`).join('');
    const targetPoints = points.map((point, index) => point.target === undefined ? '' : `${left + index * slot + slot / 2},${yYield(point.target)}`).filter(Boolean).join(' '); const targetPath = targetPoints ? `<polyline class="target-line" points="${targetPoints}"/>` : ''; const targetDots = points.map((point, index) => point.target === undefined ? '' : `<circle class="target-point" cx="${left + index * slot + slot / 2}" cy="${yYield(point.target)}" r="2.5"><title>${point.month} | Target: ${point.target.toFixed(2)}%</title></circle>`).join('');
    const legend = groups.map((group, index) => `<span><i style="background:${chartColors[index % chartColors.length]}"></i>${escapeHtml(group)}</span>`).join('');
    return `<article class="sc-yield-series-card"><h4>Yield of ${escapeHtml(serie)}</h4><div class="sc-yield-chart"><div class="sc-yield-legend"><strong>Mode group</strong>${legend}${targetPath ? '<span><i class="target-line-key"></i>Target</span>' : ''}<span><i class="yield-line-key"></i>Yield</span></div><div class="sc-yield-chart-scroll"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(serie)} monthly defect rate by mode group and yield"><text class="axis axis-title" x="${left}" y="16">%Defect</text><text class="axis axis-title" x="${width - right}" y="16" text-anchor="end">%Yield</text>${grid}<line x1="${left}" y1="${base}" x2="${width - right}" y2="${base}" stroke="#b8c7bf"/>${bars}${targetPath}${targetDots}${linePaths}${dots}</svg></div></div></article>`;
  }).join('') || '<p class="sc-yield-series-empty">No series data matches the selected filters.</p>';
}

function renderScYieldArSummary(rates, rows) {
  let holder = byId('scYieldArSummary');
  if (!holder) {
    byId('reportControls').insertAdjacentHTML('beforebegin', '<section id="scYieldArSummary" class="sc-yield-ar-summary" aria-live="polite"></section>');
    holder = byId('scYieldArSummary');
  }
  const latest = rates.at(-1);
  if (!latest?.month) {
    holder.innerHTML = '';
    holder.hidden = true;
    return;
  }
  const latestRows = rows.filter((row) => row.month === latest.month);
  const series = [...new Set(latestRows.map((row) => row.line).filter(Boolean))].sort((left, right) => left.localeCompare(right));
  const details = series.map((serie) => {
    const serieRows = latestRows.filter((row) => row.line === serie);
    const input = serieRows.reduce((sum, row) => sum + row.input, 0);
    const defect = serieRows.reduce((sum, row) => sum + row.defect, 0);
    const yieldResult = input ? (input - defect) / input * 100 : undefined;
    const target = scYieldTargetFor(serie, latest.month);
    return { label: serie, input, yield: yieldResult, target, ar: yieldResult !== undefined && target > 0 ? yieldResult / target * 100 : undefined };
  }).filter((entry) => entry.input > 0);
  const targetedDetails = details.filter((entry) => entry.target > 0 && entry.ar !== undefined);
  const targetedInput = targetedDetails.reduce((sum, entry) => sum + entry.input, 0);
  const totalAr = targetedInput ? targetedDetails.reduce((sum, entry) => sum + entry.input * entry.ar, 0) / targetedInput : undefined;
  const cards = [{ label: 'Total', yield: latest.yield, target: latest.target, ar: totalAr }, ...details]
    .map((entry) => `<div class="sc-yield-ar-metric"><strong>${escapeHtml(entry.label)}</strong><span><em>Yield result</em><b>${entry.yield === undefined ? '-' : `${entry.yield.toFixed(1)}%`}</b></span><span><em>Achievement rate</em><b>${entry.ar === undefined ? '-' : `${entry.ar.toFixed(1)}%`}</b></span></div>`)
    .join('');
  holder.hidden = !cards;
  holder.innerHTML = cards ? `<div class="sc-yield-ar-month">${escapeHtml(new Date(`${latest.month}-01T00:00:00`).toLocaleString(undefined, { month: 'long', year: 'numeric' }))}</div><div class="sc-yield-ar-metrics">${cards}</div>` : '';
}

function renderScYield(rows = latestScYieldData) {
  latestScYieldData = rows;
  byId('scYieldLogTab')?.removeAttribute('hidden');
  if (document.querySelector('.app-tab.active')?.dataset.view === 'sc-yield-log') renderScYieldCalculationLog(rows);
  if (scYieldTargetStorageRemote && !scYieldTargetSettingsLoaded && !scYieldTargetSettingsLoading) { scYieldTargetSettingsLoading = true; loadScYieldTargetSettings().then(() => renderScYield(rows)).catch((error) => setStatus(error.message)).finally(() => { scYieldTargetSettingsLoading = false; }); }
  const months = [...new Set(rows.map((row) => row.month))].sort(); const groups = [...new Set(rows.flatMap((row) => row.groups.map((group) => group.group)))].sort();
  const byMonth = months.map((month) => ({ month, ...rows.filter((row) => row.month === month).reduce((result, row) => ({ input: result.input + row.input, defect: result.defect + row.defect, excluded: result.excluded + row.excluded, unmapped: result.unmapped + row.unmapped, groups: row.groups.reduce((values, group) => ({ ...values, [group.group]: (values[group.group] || 0) + group.quantity }), result.groups) }), { input: 0, defect: 0, excluded: 0, unmapped: 0, groups: {} }) }));
  const totals = rows.reduce((result, row) => ({ input: result.input + row.input, defect: result.defect + row.defect, excluded: result.excluded + row.excluded, unmapped: result.unmapped + row.unmapped }), { input: 0, defect: 0, excluded: 0, unmapped: 0 });
  const totalYield = totals.input ? (totals.input - totals.defect) / totals.input * 100 : undefined; const totalDefectRate = totals.input ? totals.defect / totals.input * 100 : undefined;
  byId('scYieldInput').textContent = format.format(totals.input); byId('scYieldDefect').textContent = format.format(totals.defect); byId('scYieldDefectRate').textContent = totalDefectRate === undefined ? '-' : `${totalDefectRate.toFixed(2)}%`; byId('scYieldTotal').textContent = totalYield === undefined ? '-' : `${totalYield.toFixed(2)}%`;
  byId('scYieldScope').textContent = `${rows.length} month-series record${rows.length === 1 ? '' : 's'} | Completion 901 eligible jobs only`;
  const tableGroups = groups;
  const singleMonth = months.length === 1;
  byId('scYieldTableHead').innerHTML = `<tr><th>${singleMonth ? 'Series' : 'Month'}</th>${singleMonth ? '' : '<th>Series</th>'}<th>InputQ</th>${tableGroups.map((group) => `<th>${group}</th>`).join('')}<th>Defective</th></tr>`;
  byId('scYieldRows').innerHTML = rows.map((row) => { const quantities = Object.fromEntries(row.groups.map((group) => [group.group, group.quantity])); return `<tr><td>${escapeHtml(singleMonth ? row.line : row.month)}</td>${singleMonth ? '' : `<td>${escapeHtml(row.line)}</td>`}<td>${format.format(row.input)}</td>${tableGroups.map((group) => `<td>${format.format(quantities[group] || 0)}</td>`).join('')}<td>${format.format(row.defect)}</td></tr>`; }).join('') || `<tr><td colspan="${singleMonth ? 9 : 10}">No eligible SC Yield data matches the selected filters.</td></tr>`;
  renderScYieldInputRatioChart(rows);
  if (!months.length) { byId('scYieldArSummary')?.setAttribute('hidden', ''); byId('scYieldChart').innerHTML = '<h2 id="scYieldTitle" class="sc-yield-chart-title">Total Yield of Super Capacitor</h2><p class="sc-yield-empty">No included SC Yield data matches the selected filters.</p>'; byId('scYieldSeriesCharts').innerHTML = ''; return; }
  const rates = byMonth.map((entry) => { const targetRows = rows.filter((row) => row.month === entry.month && row.input > 0).map((row) => ({ input: row.input, target: scYieldTargetFor(row.line, entry.month) })).filter((row) => row.target !== undefined); const targetInput = targetRows.reduce((sum, row) => sum + row.input, 0); const target = targetInput ? targetRows.reduce((sum, row) => sum + row.input * row.target, 0) / targetInput : undefined; return { ...entry, target, defectRate: entry.input ? entry.defect / entry.input * 100 : undefined, yield: entry.input ? (entry.input - entry.defect) / entry.input * 100 : undefined, groupRates: Object.fromEntries(groups.map((group) => [group, entry.input ? (entry.groups[group] || 0) / entry.input * 100 : 0])) }; });
  if (!rates.some((entry) => entry.yield !== undefined)) { byId('scYieldArSummary')?.setAttribute('hidden', ''); byId('scYieldChart').innerHTML = '<h2 id="scYieldTitle" class="sc-yield-chart-title">Total Yield of Super Capacitor</h2><p class="sc-yield-empty">No eligible SC input quantity is available to calculate yield for the selected period.</p>'; renderScYieldSeriesCharts(rows, groups); return; }
  renderScYieldArSummary(rates, rows);
  const hasTarget = rates.some((entry) => entry.target !== undefined); const yieldValues = [...rates.filter((entry) => entry.yield !== undefined).map((entry) => entry.yield), ...rates.filter((entry) => entry.target !== undefined).map((entry) => entry.target)]; let yieldMin = Math.max(0, Math.floor((Math.min(...yieldValues) - .5) * 2) / 2); let yieldMax = Math.min(100, Math.ceil((Math.max(...yieldValues) + .5) * 2) / 2); if (yieldMax - yieldMin < 1) { yieldMin = Math.max(0, yieldMin - .5); yieldMax = Math.min(100, yieldMax + .5); }
  const width = Math.max(760, months.length * 92 + 116); const height = 310; const left = 62; const right = 62; const top = 42; const bottom = 52; const plotWidth = width - left - right; const plotHeight = height - top - bottom; const base = top + plotHeight; const defectMax = Math.max(1, Math.ceil(Math.max(...rates.map((entry) => entry.defectRate || 0)) * 10) / 10); const slot = plotWidth / months.length; const barWidth = Math.min(48, slot * .56); const yYield = (value) => base - (value - yieldMin) / (yieldMax - yieldMin) * plotHeight;
  const grid = [0, .25, .5, .75, 1].map((ratio) => { const y = base - plotHeight * ratio; return `<line class="gridline" x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"/><text class="axis" x="${left - 9}" y="${y + 4}" text-anchor="end">${(defectMax * ratio).toFixed(2)}%</text><text class="axis" x="${width - right + 9}" y="${y + 4}">${(yieldMin + (yieldMax - yieldMin) * ratio).toFixed(1)}%</text>`; }).join('');
  const bars = rates.map((entry, index) => { const x = left + index * slot + (slot - barWidth) / 2; let stacked = 0; const parts = groups.map((group, groupIndex) => { const value = entry.groupRates[group]; const heightValue = value / defectMax * plotHeight; const y = base - stacked - heightValue; stacked += heightValue; return value ? `<rect x="${x}" y="${y}" width="${barWidth}" height="${heightValue}" fill="${chartColors[groupIndex % chartColors.length]}"><title>${entry.month} | ${group}: ${value.toFixed(3)}%</title></rect>` : ''; }).join(''); return `${parts}<text class="axis" x="${x + barWidth / 2}" y="${base + 23}" text-anchor="middle">${entry.month.slice(5)}</text>`; }).join('');
  const yieldSegments = []; let currentYieldSegment = []; rates.forEach((entry, index) => { if (entry.yield === undefined) { if (currentYieldSegment.length) yieldSegments.push(currentYieldSegment); currentYieldSegment = []; return; } currentYieldSegment.push(`${left + index * slot + slot / 2},${yYield(entry.yield)}`); }); if (currentYieldSegment.length) yieldSegments.push(currentYieldSegment); const points = yieldSegments.map((segment) => `<polyline class="yield-line" points="${segment.join(' ')}"/>`).join(''); const dots = rates.map((entry, index) => entry.yield === undefined ? '' : `<circle class="yield-point" cx="${left + index * slot + slot / 2}" cy="${yYield(entry.yield)}" r="4"><title>${entry.month} | Yield: ${entry.yield.toFixed(3)}%</title></circle>`).join('');
  const targetPoints = rates.map((entry, index) => entry.target === undefined ? '' : `${left + index * slot + slot / 2},${yYield(entry.target)}`).filter(Boolean).join(' '); const targetDots = rates.map((entry, index) => entry.target === undefined ? '' : `<circle class="target-point" cx="${left + index * slot + slot / 2}" cy="${yYield(entry.target)}" r="3"><title>${entry.month} | Target: ${entry.target.toFixed(2)}%</title></circle>`).join('');
  const legend = groups.map((group, index) => `<span><i style="background:${chartColors[index % chartColors.length]}"></i>${escapeHtml(group)}</span>`).join('');
  byId('scYieldChart').innerHTML = `<h2 id="scYieldTitle" class="sc-yield-chart-title">Total Yield of Super Capacitor</h2><div class="sc-yield-legend"><strong>Mode group</strong>${legend}${hasTarget ? '<span><i class="target-line-key"></i>Target</span>' : ''}<span><i class="yield-line-key"></i>Yield</span></div><div class="sc-yield-chart-scroll"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Monthly SC defect rate by mode group and total yield"><text class="axis axis-title" x="${left}" y="18">%Defect</text><text class="axis axis-title" x="${width - right}" y="18" text-anchor="end">%Yield</text>${grid}<line x1="${left}" y1="${base}" x2="${width - right}" y2="${base}" stroke="#b8c7bf"/>${bars}${hasTarget ? `<polyline class="target-line" points="${targetPoints}"/>${targetDots}` : ''}${points}${dots}</svg></div>`;
  renderScYieldSeriesCharts(rows, groups);
}

async function refreshDatabaseAuthentication() {
  setStatus('Microsoft Entra sign-in is required. Complete the browser sign-in to continue.', true);
  const response = await fetch(`/api/auth/login?dataset=${selectedDataset()}`);
  const payload = await readApiPayload(response, '/api/auth/login');
  if (!response.ok || !payload.success) throw new Error(payload.error || 'Microsoft Entra sign-in failed.');
}

async function readApiPayload(response, url) {
  const responseText = await response.text();
  try { return JSON.parse(responseText); } catch { throw new Error(`The dashboard server returned a non-JSON response for ${url}. Restart the dashboard server and refresh the browser.`); }
}

function ensureTaYieldLotSeriesControl() { let select = byId('taYieldLotSeries'); if (!select) { const label = document.createElement('label'); label.htmlFor = 'taYieldLotSeries'; label.textContent = 'Series'; select = document.createElement('select'); select.id = 'taYieldLotSeries'; select.setAttribute('aria-label', 'TA lot detail series'); label.append(select); byId('taYieldLotFilter').prepend(label); byId('taYieldLotSearch').previousElementSibling.textContent = 'Find Lot No'; select.addEventListener('change', () => { taYieldLotSeries = select.value; if (taYieldTableView === 'lots') renderTaYield(latestTaYieldData); }); } return select; }
function bindTaYieldGroupTrendTooltips(holder) {
  holder.querySelectorAll('.sc-yield-series-card').forEach((card, index) => {
    const tooltip = card.querySelector('.ta-yield-group-tooltip');
    if (!tooltip) return;
    tooltip.id = `ta-yield-group-tooltip-${index}`;
    card.querySelectorAll('.yield-point, .target-point').forEach((mark) => {
      const detail = mark.querySelector('title')?.textContent || '';
      const show = (event) => {
        const cardBounds = card.getBoundingClientRect();
        const markBounds = mark.getBoundingClientRect();
        const x = event?.clientX ?? markBounds.left + markBounds.width / 2;
        const y = event?.clientY ?? markBounds.top + markBounds.height / 2;
        const [period, value] = detail.split(/:\s(.+)/, 2);
        tooltip.innerHTML = `<strong>${escapeHtml(card.querySelector('h4')?.textContent || 'TTL Yield')}</strong><span>${escapeHtml(period)}</span><b>${escapeHtml(value || detail)}</b>`;
        tooltip.hidden = false;
        tooltip.style.left = `${Math.min(Math.max(x - cardBounds.left + 12, 8), Math.max(cardBounds.width - 170, 8))}px`;
        tooltip.style.top = `${Math.max(y - cardBounds.top - 82, 38)}px`;
      };
      mark.tabIndex = 0;
      mark.setAttribute('aria-label', `${card.querySelector('h4')?.textContent || 'TTL Yield'}: ${detail}`);
      mark.setAttribute('aria-describedby', tooltip.id);
      mark.addEventListener('mousemove', show);
      mark.addEventListener('mouseleave', () => { tooltip.hidden = true; });
      mark.addEventListener('focus', show);
      mark.addEventListener('blur', () => { tooltip.hidden = true; });
    });
  });
}
function renderTaYieldGroupTendencyCharts(rows, buckets) {
  const holder = byId('taYieldGroupYieldCharts');
  const productGroupOrder = ['Standard Production', 'Facedown', 'GPS'];
  if (!buckets.length) { holder.innerHTML = ''; return; }
  const chart = (serie) => {
    const pointsByMonth = buckets.map((month) => {
      const matches = rows.filter((row) => row.month === month && taChartGroup(row.line) === serie);
      const input = matches.reduce((sum, row) => sum + Number(row.input || 0), 0);
      const finalGood = matches.reduce((sum, row) => sum + Number(row.finalGood || 0), 0);
      const contributing = matches.filter((row) => Number(row.input || 0) > 0);
      const targeted = contributing.map((row) => ({ input: Number(row.input || 0), target: taYieldTargetFor(row.line, month) })).filter((row) => Number.isFinite(row.target));
      const targetInput = targeted.reduce((sum, row) => sum + row.input, 0);
      return { yield: input ? finalGood / input * 100 : undefined, target: contributing.length && targeted.length === contributing.length ? targeted.reduce((sum, row) => sum + row.input * row.target, 0) / targetInput : undefined };
    });
    const valid = pointsByMonth.flatMap((point) => [point.yield, point.target]).filter(Number.isFinite);
    if (!valid.length) return `<article class="sc-yield-series-card"><h4>%TTL Yield of ${escapeHtml(serie)}</h4><p class="sc-yield-series-empty">No ${escapeHtml(serie)} data for the selected part number and period.</p></article>`;
    let min = Math.max(0, Math.floor((Math.min(...valid) - .5) * 2) / 2);
    let max = Math.min(100, Math.ceil((Math.max(...valid) + .5) * 2) / 2);
    if (max - min < 1) { min = Math.max(0, min - .5); max = Math.min(100, max + .5); }
    const width = 520; const height = 250; const left = 50; const right = 20; const top = 28; const bottom = 42; const base = height - bottom;
    const x = (index) => left + index * (width - left - right) / Math.max(buckets.length - 1, 1);
    const y = (value) => top + (max - value) / (max - min) * (base - top);
    const points = pointsByMonth.map((point, index) => Number.isFinite(point.yield) ? `${x(index)},${y(point.yield)}` : '').filter(Boolean).join(' ');
    const dots = pointsByMonth.map((point, index) => Number.isFinite(point.yield) ? `<circle class="yield-point" cx="${x(index)}" cy="${y(point.yield)}" r="3.5"><title>${escapeHtml(buckets[index])}: ${point.yield.toFixed(2)}%</title></circle>` : '').join('');
    const targetPoints = pointsByMonth.map((point, index) => Number.isFinite(point.target) ? `${x(index)},${y(point.target)}` : '').filter(Boolean).join(' ');
    const targetDots = pointsByMonth.map((point, index) => Number.isFinite(point.target) ? `<circle class="target-point" cx="${x(index)}" cy="${y(point.target)}" r="2.5"><title>${escapeHtml(buckets[index])}: target ${point.target.toFixed(2)}%</title></circle>` : '').join('');
    const labelStep = Math.max(1, Math.ceil(buckets.length / 12));
    const labels = buckets.map((month, index) => index % labelStep === 0 || index === buckets.length - 1 ? `<text class="axis" x="${x(index)}" y="${base + 20}" text-anchor="middle">${escapeHtml(taYieldInterval === 'day' ? month.slice(5) : taYieldInterval === 'week' ? month.slice(-3) : month.slice(5))}</text>` : '').join('');
    return `<article class="sc-yield-series-card"><h4>%TTL Yield of ${escapeHtml(serie)}</h4><div class="sc-yield-chart">${targetPoints ? '<div class="sc-yield-legend"><span><i class="target-line-key"></i>Target</span><span><i class="yield-line-key"></i>Yield</span></div>' : ''}<div class="sc-yield-chart-scroll"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="TA total yield and target for ${escapeHtml(serie)}"><text class="axis" x="4" y="${top + 4}">${max.toFixed(1)}%</text><text class="axis" x="4" y="${base + 4}">${min.toFixed(1)}%</text><line class="gridline" x1="${left}" y1="${top}" x2="${width - right}" y2="${top}"/><line class="gridline" x1="${left}" y1="${base}" x2="${width - right}" y2="${base}"/>${targetPoints ? `<polyline class="target-line" points="${targetPoints}"/>${targetDots}` : ''}<polyline class="yield-line" points="${points}"/>${dots}${labels}</svg></div></div></article>`;
  };
  holder.innerHTML = productGroupOrder.map(chart).join('');
  holder.querySelectorAll('.sc-yield-series-card').forEach((card) => card.insertAdjacentHTML('beforeend', '<div class="ta-yield-group-tooltip" role="tooltip" hidden></div>'));
  bindTaYieldGroupTrendTooltips(holder);
}

function renderTaYieldTendencySkeleton() {
  const holder = byId('taYieldChart');
  if (!holder) return;
  const skeleton = '<div class="ta-yield-chart-skeleton" role="status" aria-busy="true" aria-label="Loading chart"><span class="ta-yield-skeleton-label">Loading trend data…</span><i></i><i></i><i></i><b></b><b></b><b></b><b></b><b></b><b></b></div>';
  holder.querySelectorAll('.ta-yield-tendency-panel').forEach((panel) => {
    panel.setAttribute('aria-busy', 'true');
    const chart = panel.querySelector('#taYieldYieldChart, #taYieldDefectChart');
    if (chart) chart.innerHTML = skeleton;
  });
}

function renderTaYieldTendencyLoadError(message) {
  const holder = byId('taYieldChart');
  if (!holder) return;
  holder.querySelectorAll('.ta-yield-tendency-panel').forEach((panel) => {
    panel.setAttribute('aria-busy', 'false');
    const chart = panel.querySelector('#taYieldYieldChart, #taYieldDefectChart');
    if (!chart) return;
    const error = document.createElement('p');
    error.className = 'sc-yield-empty';
    error.textContent = `Trend data could not be loaded: ${message}`;
    chart.replaceChildren(error);
  });
}

function renderTaYieldTendencyCharts(rows = latestTaYieldTendencyData, groupRows = latestTaYieldGroupTendencyData) {
  latestTaYieldTendencyData = rows;
  latestTaYieldGroupTendencyData = groupRows;
  const holder = byId('taYieldChart');
  const trendSeries = [...new Map(rows.map((row) => [row.line, shortTaSeries(row.line)])).entries()].sort((left, right) => left[1].localeCompare(right[1]));
  taYieldTrendPartNumbers = [...new Set(groupRows.flatMap((row) => row.partNumbers || []))].sort();
  if (taYieldTrendPartNumber !== 'All' && !taYieldTrendPartNumbers.includes(taYieldTrendPartNumber)) taYieldTrendPartNumber = 'All';
  if (taYieldTrendSeries !== 'Total' && !trendSeries.some(([serie]) => serie === taYieldTrendSeries)) taYieldTrendSeries = 'Total';
  const selectedTrendScope = [taYieldTrendSeries === 'Total' ? 'Total' : shortTaSeries(taYieldTrendSeries), taYieldTrendPartNumber === 'All' ? '' : `P/N: ${taYieldTrendPartNumber}`].filter(Boolean).join(' · ');
  holder.innerHTML = `<div class="table-heading"><div><p class="section-kicker">Total quality trend</p><h3>Yield and defect tendency</h3></div><label class="yield-interval-control" for="taYieldTrendPartNumber" title="Filter only the Yield and defect tendency charts by part number.">Part number<select id="taYieldTrendPartNumber" title="Choose a part number. The chart targets use the selected series target rules."><option value="All">All part numbers</option>${taYieldTrendPartNumbers.map((pn) => `<option value="${escapeHtml(pn)}" ${pn === taYieldTrendPartNumber ? 'selected' : ''}>${escapeHtml(pn)}</option>`).join('')}</select></label><label class="yield-interval-control" for="taYieldTrendSeries" title="Choose Total or a series. A specific series uses its own target; Total uses the fixed monthly Total target.">Series<select id="taYieldTrendSeries" title="Choose the series to display for the selected part number."><option value="Total">Total</option>${trendSeries.map(([serie, label]) => `<option value="${escapeHtml(serie)}" ${serie === taYieldTrendSeries ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select></label><label class="yield-interval-control" for="taYieldInterval">Group by<select id="taYieldInterval"><option value="day" ${taYieldInterval === 'day' ? 'selected' : ''}>Day</option><option value="week" ${taYieldInterval === 'week' ? 'selected' : ''}>Week</option><option value="month" ${taYieldInterval === 'month' ? 'selected' : ''}>Month</option></select></label></div><section class="ta-yield-tendency-panel"><h4>${escapeHtml(selectedTrendScope)} yield</h4><div id="taYieldYieldChart"></div></section><section class="ta-yield-tendency-panel"><h4>${taYieldTrendPartNumber === 'All' ? 'Defect rate by mode group' : `Defect rate by mode group · P/N: ${escapeHtml(taYieldTrendPartNumber)}`}</h4><div id="taYieldDefectChart"></div></section>`;
  const productGroupPanel = document.createElement('section');
  productGroupPanel.className = 'sc-yield-series-section';
  productGroupPanel.setAttribute('aria-labelledby', 'taYieldGroupTrendTitle');
  productGroupPanel.innerHTML = '<div><p class="section-kicker">Product group trend</p><h4 id="taYieldGroupTrendTitle">TTL Yield by product group</h4></div><div id="taYieldGroupYieldCharts" class="sc-yield-series-grid"></div>';
  holder.append(productGroupPanel);
  byId('taYieldInterval').addEventListener('change', () => { taYieldInterval = byId('taYieldInterval').value; loadData(); });
  byId('taYieldTrendSeries').addEventListener('change', () => { taYieldTrendSeries = byId('taYieldTrendSeries').value; renderTaYieldTendencyCharts(latestTaYieldTendencyData, latestTaYieldGroupTendencyData); });
  byId('taYieldTrendPartNumber').addEventListener('change', () => { taYieldTrendPartNumber = byId('taYieldTrendPartNumber').value; loadData(); });
  const chartTypeLabel = document.createElement('label'); chartTypeLabel.className = 'yield-interval-control'; chartTypeLabel.innerHTML = 'Chart view<select id="taYieldTrendChartType"><option value="summary">Column</option><option value="multi-line">Line</option></select>'; holder.querySelector('.table-heading').append(chartTypeLabel); byId('taYieldTrendChartType').value = taYieldTrendChartType; byId('taYieldTrendChartType').addEventListener('change', () => { taYieldTrendChartType = byId('taYieldTrendChartType').value; renderTaYieldTendencyCharts(latestTaYieldTendencyData, latestTaYieldGroupTendencyData); });
  const trendRows = taYieldTrendSeries === 'Total' ? rows : rows.filter((row) => row.line === taYieldTrendSeries);
  const groups = [...new Set(trendRows.flatMap((row) => row.groups.map((group) => group.group)))].sort();
  const buckets = [...new Set(trendRows.map((row) => row.month))].sort().map((month) => trendRows.filter((row) => row.month === month).reduce((total, row) => ({ month, input: total.input + Number(row.input || 0), finalGood: total.finalGood + Number(row.finalGood || 0), groups: row.groups.reduce((values, group) => ({ ...values, [group.group]: (values[group.group] || 0) + Number(group.quantity || 0) }), total.groups) }), { month, input: 0, finalGood: 0, groups: {} })).map((row) => ({ ...row, yield: row.input ? row.finalGood / row.input * 100 : undefined }));
  renderTaYieldGroupTendencyCharts(groupRows, [...new Set(groupRows.map((row) => row.month))].sort());
  if (!buckets.some((row) => Number.isFinite(row.yield))) { byId('taYieldYieldChart').innerHTML = '<p class="sc-yield-empty">No eligible TA Yield data matches the selected filters.</p>'; byId('taYieldDefectChart').innerHTML = '<p class="sc-yield-empty">No mapped defect data is available.</p>'; return; }
  const dailyColumnCount = taYieldInterval === 'day' ? Math.max(31, buckets.length) : buckets.length;
  const width = Math.max(taYieldInterval === 'day' ? 760 : 860, dailyColumnCount * (taYieldInterval === 'day' ? 50 : 86) + 116); const height = 250; const left = 54; const right = 54; const top = 30; const bottom = 48; const base = height - bottom; const plotHeight = base - top; const slot = (width - left - right) / buckets.length; const label = (value) => taYieldInterval === 'day' ? value.slice(5) : taYieldInterval === 'week' ? value.slice(-3) : value.slice(5);
  const taYieldDayChartViewportStyle = taYieldInterval === 'day' ? ` style="width:min(100%, ${31 * 50 + 116}px)"` : '';
  const taYieldChartSvgStyle = ` style="width:clamp(${width}px, 100%, 1280px); min-width:${width}px; max-width:none; margin-inline:auto"`;
  const targetsByBucket = new Map(buckets.map((row) => [row.month, taYieldTargetFor(taYieldTrendSeries, row.month)]));
  const valuesForScale = [...buckets.map((row) => row.yield), ...targetsByBucket.values()].filter(Number.isFinite); let minimum = Math.max(0, Math.floor((Math.min(...valuesForScale) - .5) * 2) / 2); let maximum = Math.min(100, Math.ceil((Math.max(...valuesForScale) + .5) * 2) / 2); if (maximum - minimum < 1) { minimum = Math.max(0, minimum - .5); maximum = Math.min(100, maximum + .5); }
  const yieldY = (value) => base - (value - minimum) / (maximum - minimum) * plotHeight; const x = (index) => left + index * slot + slot / 2;
  const yieldGrid = [0, .5, 1].map((ratio) => { const y = base - plotHeight * ratio; return `<line class="gridline" x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"/><text class="axis" x="${left - 8}" y="${y + 4}" text-anchor="end">${(minimum + (maximum - minimum) * ratio).toFixed(1)}%</text>`; }).join('');
  const targetPoints = buckets.map((row, index) => Number.isFinite(targetsByBucket.get(row.month)) ? `${x(index)},${yieldY(targetsByBucket.get(row.month))}` : '').filter(Boolean).join(' '); const targetDots = buckets.map((row, index) => Number.isFinite(targetsByBucket.get(row.month)) ? `<circle class="target-point" cx="${x(index)}" cy="${yieldY(targetsByBucket.get(row.month))}" r="3"><title>${escapeHtml(row.month)}: target ${targetsByBucket.get(row.month).toFixed(2)}%</title></circle>` : '').join(''); const labels = buckets.map((row, index) => `<text class="axis" x="${x(index)}" y="${base + 22}" text-anchor="middle">${escapeHtml(label(row.month))}</text>`).join('');
  const yieldColumns = buckets.map((row, index) => {
    if (!Number.isFinite(row.yield)) return '';
    const widthValue = Math.min(48, slot * .62); const heightValue = base - yieldY(row.yield); const target = targetsByBucket.get(row.month); const belowTarget = Number.isFinite(target) && row.yield < target;
    return `<rect class="yield-column${belowTarget ? ' below-target' : ''}" x="${x(index) - widthValue / 2}" y="${yieldY(row.yield)}" width="${widthValue}" height="${heightValue}"><title>${escapeHtml(row.month)}: yield ${row.yield.toFixed(2)}%${Number.isFinite(target) ? `; target ${target.toFixed(2)}%` : '; target incomplete'}</title></rect><text class="ta-yield-column-value" x="${x(index)}" y="${Math.max(top + 12, yieldY(row.yield) - 7)}" text-anchor="middle">${row.yield.toFixed(2)}%</text>`;
  }).join('');
  byId('taYieldYieldChart').innerHTML = `<div class="sc-yield-legend"><span><i class="yield-column-key"></i>Yield column</span>${targetPoints ? '<span><i class="target-line-key"></i>Target</span>' : ''}</div><div class="sc-yield-chart-scroll"${taYieldDayChartViewportStyle}><svg${taYieldChartSvgStyle} viewBox="0 0 ${width} ${height}" role="img" aria-label="TA ${escapeHtml(taYieldTrendSeries === 'Total' ? 'total' : shortTaSeries(taYieldTrendSeries))} yield by ${taYieldInterval}"><text class="axis axis-title" x="${left}" y="18">%Yield</text>${yieldGrid}<line x1="${left}" y1="${base}" x2="${width - right}" y2="${base}" stroke="#b8c7bf"/>${yieldColumns}${targetPoints ? `<polyline class="target-line" points="${targetPoints}"/>${targetDots}` : ''}${labels}</svg></div>`;
  if (taYieldTrendChartType === 'multi-line') renderTaYieldMultiSeriesChart(trendRows, buckets, targetsByBucket, label, taYieldTrendSeries === 'Total', `${taYieldTrendSeries === 'Total' ? 'Total' : shortTaSeries(taYieldTrendSeries)} Target`);
  const displayedDefectRates = buckets.map((row) => groups.reduce((total, group) => total + Math.max(0, row.input ? (row.groups[group] || 0) / row.input * 100 : 0), 0)); const defectMaximum = Math.max(1, Math.ceil(Math.max(...displayedDefectRates) * 10) / 10); const defectGrid = [0, .5, 1].map((ratio) => { const y = base - plotHeight * ratio; return `<line class="gridline" x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"/><text class="axis" x="${left - 8}" y="${y + 4}" text-anchor="end">${(defectMaximum * ratio).toFixed(1)}%</text>`; }).join('');
  const bars = buckets.map((row, index) => { const barWidth = Math.min(48, slot * .62); const barX = x(index) - barWidth / 2; let stacked = 0; return groups.map((group, groupIndex) => { const signedRate = row.input ? (row.groups[group] || 0) / row.input * 100 : 0; const rate = Math.max(0, signedRate); const barHeight = rate / defectMaximum * plotHeight; const y = base - stacked - barHeight; stacked += barHeight; return rate ? `<rect x="${barX}" y="${y}" width="${barWidth}" height="${barHeight}" fill="${chartColors[groupIndex % chartColors.length]}"><title>${escapeHtml(row.month)} | ${escapeHtml(group)}: ${signedRate.toFixed(3)}%</title></rect>` : ''; }).join(''); }).join(''); const legend = groups.map((group, index) => `<span><i style="background:${chartColors[index % chartColors.length]}"></i>${escapeHtml(group)}</span>`).join('');
  const defectTotalLabels = displayedDefectRates.map((rate, index) => {
    return rate ? `<text class="ta-yield-column-value" x="${x(index)}" y="${Math.max(top + 12, base - rate / defectMaximum * plotHeight - 7)}" text-anchor="middle">${rate.toFixed(2)}%</text>` : '';
  }).join('');
  byId('taYieldDefectChart').innerHTML = `<div class="sc-yield-legend"><strong>Mode group</strong>${legend}</div><div class="sc-yield-chart-scroll"${taYieldDayChartViewportStyle}><svg${taYieldChartSvgStyle} viewBox="0 0 ${width} ${height}" role="img" aria-label="TA defect rate by ${taYieldInterval}"><text class="axis axis-title" x="${left}" y="18">%Defect</text>${defectGrid}<line x1="${left}" y1="${base}" x2="${width - right}" y2="${base}" stroke="#b8c7bf"/>${bars}${defectTotalLabels}${labels}</svg></div>`;
  holder.querySelectorAll('.ta-yield-tendency-panel').forEach((panel) => panel.insertAdjacentHTML('beforeend', '<div class="ta-yield-trend-tooltip" role="status" hidden></div>'));
  bindTaYieldTrendTooltips(holder);
  requestAnimationFrame(scrollTaYieldTendencyToLatest);
}
function taYieldTargetTimeline(target, period) { return target.period === period ? 'current' : target.period > period ? 'upcoming' : 'history'; }
function renderTaYieldTargetSavedList(targets) {
  const currentPeriod = bangkokToday().slice(0, 7);
  const query = taYieldTargetSearch.trim().toLowerCase();
  const visible = targets.filter((target) => taYieldTargetTimeline(target, currentPeriod) === taYieldTargetTab && (!query || `${target.serie} ${target.period}`.toLowerCase().includes(query))).sort((left, right) => left.serie.localeCompare(right.serie) || (taYieldTargetTab === 'history' ? right.period.localeCompare(left.period) : left.period.localeCompare(right.period)));
  const groups = visible.reduce((result, target) => ({ ...result, [target.serie]: [...(result[target.serie] || []), target] }), {});
  document.querySelectorAll('[data-ta-yield-target-tab]').forEach((button) => { const active = button.dataset.taYieldTargetTab === taYieldTargetTab; button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; });
  byId('taYieldTargetResultCount').textContent = `${visible.length} target${visible.length === 1 ? '' : 's'} in ${taYieldTargetTab === 'current' ? 'current parameters' : taYieldTargetTab}.`;
  byId('taYieldTargetGroups').innerHTML = Object.entries(groups).map(([serie, rows]) => `<section class="ta-yield-target-group" aria-labelledby="taYieldTargetGroup-${escapeHtml(serie)}"><header><h4 id="taYieldTargetGroup-${escapeHtml(serie)}">${escapeHtml(serie)}</h4><span>${rows.length} target${rows.length === 1 ? '' : 's'}</span></header><div class="table-wrap"><table><thead><tr><th>Period</th><th>Yield target</th><th>Action</th></tr></thead><tbody>${rows.map((target) => `<tr><td>${escapeHtml(target.period)}</td><td>${Number(target.target).toFixed(2)}%</td><td><button class="remove-ta-yield-target" data-serie="${escapeHtml(target.serie)}" data-period="${target.period}" type="button">Remove</button></td></tr>`).join('')}</tbody></table></div></section>`).join('') || `<p class="empty ta-yield-target-empty">No ${taYieldTargetTab} TA Yield targets${query ? ' match this search' : ' saved'}.</p>`;
}
async function renderTaYieldTargetParameters() {
  const holder = byId('parameterView');
  const targets = await request('/api/ta-yield-targets');
  const savedSeries = targets.map((target) => target.serie);
  const currentSeries = (latestTaYieldData.summary || []).map((row) => shortTaSeries(row.line)).filter(Boolean);
  const fixedSeries = ['Total', 'Facedown', 'Standard Production'];
  const series = [...fixedSeries, ...[...new Set([...currentSeries, ...savedSeries].filter((serie) => !fixedSeries.includes(serie)))].sort()];
  taYieldTargets = targets.reduce((settings, target) => ({ ...settings, [target.serie]: { ...(settings[target.serie] || {}), [target.period]: target.target } }), {});
  const period = bangkokToday().slice(0, 7);
  holder.innerHTML = `<div class="parameter-heading"><p class="section-kicker">Configuration</p><h2>TA Yield target parameters</h2><p>Set monthly targets for Total, product groups, and individual TA series. This date selector is independent from the dashboard reporting range.</p></div><form id="taYieldTargetForm" class="parameter-form ta-yield-target-form"><label>Target scope<select id="taYieldTargetSerie" required><option value="">Select target</option>${series.map((serie) => `<option value="${escapeHtml(serie)}">${escapeHtml(serie)}</option>`).join('')}</select></label><label>Period<input id="taYieldTargetPeriod" type="month" value="${period}" required /></label><label>Yield target (%)<input id="taYieldTargetValue" type="number" min="0" max="100" step="0.01" inputmode="decimal" required /></label><button type="submit">Save target</button></form><p id="taYieldTargetStatus" class="parameter-status" role="status"></p><section class="saved-parameters ta-yield-saved-parameters" aria-labelledby="taYieldSavedTargetsTitle"><div class="ta-yield-target-list-heading"><h3 id="taYieldSavedTargetsTitle">Saved TA Yield targets</h3><label class="ta-yield-target-search"><span>Search targets</span><input id="taYieldTargetSearch" type="search" value="${escapeHtml(taYieldTargetSearch)}" placeholder="Target scope or month" autocomplete="off" /></label></div><div class="ta-yield-target-tabs" role="tablist" aria-label="Saved TA Yield target period"><button id="taYieldTargetCurrentTab" type="button" role="tab" data-ta-yield-target-tab="current" aria-controls="taYieldTargetGroups">Current parameters</button><button id="taYieldTargetUpcomingTab" type="button" role="tab" data-ta-yield-target-tab="upcoming" aria-controls="taYieldTargetGroups">Upcoming</button><button id="taYieldTargetHistoryTab" type="button" role="tab" data-ta-yield-target-tab="history" aria-controls="taYieldTargetGroups">History</button></div><p id="taYieldTargetResultCount" class="ta-yield-target-result-count" role="status" aria-live="polite"></p><div id="taYieldTargetGroups" class="ta-yield-target-groups" role="tabpanel" aria-labelledby="taYieldTargetCurrentTab"></div></section>`;
  renderTaYieldTargetSavedList(targets);
  byId('taYieldTargetForm').addEventListener('submit', async (event) => { event.preventDefault(); const serie = byId('taYieldTargetSerie').value; const periodValue = byId('taYieldTargetPeriod').value; const target = Number(byId('taYieldTargetValue').value); const status = byId('taYieldTargetStatus'); if (!serie || !/^\d{4}-\d{2}$/.test(periodValue) || !Number.isFinite(target) || target < 0 || target > 100) { status.textContent = 'Provide a series, month, and target from 0 to 100.'; return; } await request('/api/ta-yield-targets', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serie, period: periodValue, target }) }); status.textContent = 'Target saved.'; await renderTaYieldTargetParameters(); renderTaYieldTendencyCharts(); });
  holder.addEventListener('click', async (event) => { const tab = event.target.closest('[data-ta-yield-target-tab]'); if (tab) { taYieldTargetTab = tab.dataset.taYieldTargetTab; byId('taYieldTargetGroups').setAttribute('aria-labelledby', tab.id); renderTaYieldTargetSavedList(targets); return; } const remove = event.target.closest('.remove-ta-yield-target'); if (!remove) return; await request(`/api/ta-yield-targets?${new URLSearchParams(remove.dataset)}`, { method: 'DELETE' }); await renderTaYieldTargetParameters(); renderTaYieldTendencyCharts(); });
  holder.addEventListener('keydown', (event) => { const tab = event.target.closest('[data-ta-yield-target-tab]'); if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; const tabs = [...holder.querySelectorAll('[data-ta-yield-target-tab]')]; const current = tabs.indexOf(tab); const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length; const next = tabs[nextIndex]; event.preventDefault(); taYieldTargetTab = next.dataset.taYieldTargetTab; byId('taYieldTargetGroups').setAttribute('aria-labelledby', next.id); renderTaYieldTargetSavedList(targets); next.focus(); });
  byId('taYieldTargetSearch').addEventListener('input', (event) => { taYieldTargetSearch = event.target.value; renderTaYieldTargetSavedList(targets); });
}
function ensureTaWorkbookVerificationView() {
  let button = document.querySelector('[data-ta-yield-table="workbook"]');
  if (!button) { button = document.createElement('button'); button.type = 'button'; button.dataset.taYieldTable = 'workbook'; }
  button.hidden = true;
  let holder = byId('taWorkbookVerification');
  if (!holder) { holder = document.createElement('section'); holder.id = 'taWorkbookVerification'; holder.className = 'sc-yield-series-section'; holder.innerHTML = '<div class="table-heading"><div><p class="section-kicker">Excel reference</p><h3>TA Yield DataTable</h3><p>Uses the active TA Yield date and series filters from Production dashboard.</p></div><div class="table-actions"><button id="exportTaWorkbook" class="export-completion" type="button">Export Excel</button><span id="taWorkbookCount" role="status"></span></div></div><div class="ta-yield-lot-filter"><label>Line<select id="taWorkbookLine"></select></label><label>Category<select id="taWorkbookCategory"></select></label><label>Find lot/item<input id="taWorkbookSearch" type="search" /></label></div><div class="table-wrap"><table><thead><tr><th>ProdLine</th><th>JobName</th><th>From ItemName</th><th>Taping Date</th><th>Category</th><th>Quantity</th></tr></thead><tbody id="taWorkbookRows"></tbody></table></div>'; byId('taDataTableView').append(holder); }
  const render = () => { const line = byId('taWorkbookLine').value; const category = byId('taWorkbookCategory').value; const search = byId('taWorkbookSearch').value.trim().toLowerCase(); const categories = ['ACC', 'App', 'CO', 'Cap', 'DF', 'ESR', 'Good', 'Inproc Dw', 'Inproc Up', 'Input', 'Input-', 'LC', 'La/Ex1', 'La/Ex2-6', 'PULSE', 'SH'].filter((value) => latestTaWorkbookRows.some((row) => Object.hasOwn(row.categories, value))); const calculated = ['Defect', 'Other1', 'InputF', 'Other2', '%Good', '%Defect', 'TTL', 'Check']; const rows = latestTaWorkbookRows.filter((row) => (!line || row.line === line) && (!category || row.categories[category]) && (!search || `${row.lotNo} ${row.itemName}`.toLowerCase().includes(search))); const numberCell = (value) => Number.isFinite(value) ? format.format(value) : ''; const percentCell = (value) => Number.isFinite(value) ? `${value.toFixed(6)}%` : ''; const sortDirection = taWorkbookDateDirection === 'asc' ? 'ascending' : 'descending'; byId('taWorkbookCount').textContent = `${rows.length} of ${latestTaWorkbookRows.length} lots`; holder.querySelector('thead').innerHTML = `<tr><th>ProdLine</th><th>JobName</th><th>From ItemName</th><th aria-sort="${sortDirection}"><button type="button" class="ta-workbook-date-sort" aria-label="Sort Taping Date ${sortDirection}; activate to reverse">Taping Date</button></th>${categories.map((value) => `<th>${escapeHtml(value)}</th>`).join('')}${calculated.map((value) => `<th>${value}</th>`).join('')}</tr>`; byId('taWorkbookRows').innerHTML = rows.map((row) => { const calc = row.calculation || {}; return `<tr><td>${escapeHtml(row.line)}</td><td>${escapeHtml(row.lotNo)}</td><td>${escapeHtml(row.itemName)}</td><td>${escapeHtml(bangkokDate(row.tapingDate))}</td>${categories.map((value) => `<td>${row.categories[value] ? format.format(row.categories[value]) : '0'}</td>`).join('')}<td>${numberCell(calc.defect)}</td><td>${numberCell(calc.other1)}</td><td>${numberCell(calc.inputF)}</td><td>${numberCell(calc.other2)}</td><td>${percentCell(calc.goodRate)}</td><td>${percentCell(calc.defectRate)}</td><td>${numberCell(calc.ttl)}</td><td>${numberCell(calc.check)}</td></tr>`; }).join('') || `<tr><td colspan="${4 + categories.length + calculated.length}">No workbook rows match these filters.</td></tr>`; };
  const load = async () => { const requestId = dataRequestId; const startDate = byId('taWorkbookStartDate')?.value || byId('startDate').value; const endDate = byId('taWorkbookEndDate')?.value || byId('endDate').value; if (!startDate || !endDate || startDate > endDate) throw new Error('Choose a valid DataTable date range.'); const params = new URLSearchParams({ dataset: 'ta-yield', startDate, endDate }); const rows = await request(`/api/ta-yield-workbook-reconciliation?${params}`); if (requestId !== dataRequestId) return; latestTaWorkbookRows = rows; const lines = [...new Set(latestTaWorkbookRows.map((row) => row.line))].sort(); const categories = [...new Set(latestTaWorkbookRows.flatMap((row) => Object.keys(row.categories)))].sort(); byId('taWorkbookLine').replaceChildren(new Option('All lines', ''), ...lines.map((value) => new Option(value, value))); byId('taWorkbookCategory').replaceChildren(new Option('All categories', ''), ...categories.map((value) => new Option(value, value))); render(); };
  holder.loadRows = load;
  if (!holder.dataset.dateControlsBound) { holder.dataset.dateControlsBound = 'true'; holder.querySelector('.ta-yield-lot-filter').insertAdjacentHTML('beforebegin', '<div class="ta-yield-lot-filter"><label>Start date<input id="taWorkbookStartDate" type="date" /></label><label>End date<input id="taWorkbookEndDate" type="date" /></label><button id="taWorkbookApply" type="button">Apply DataTable</button><span id="taWorkbookDateStatus" role="status"></span></div>'); byId('taWorkbookStartDate').value = byId('startDate').value; byId('taWorkbookEndDate').value = byId('endDate').value; byId('taWorkbookApply').addEventListener('click', async () => { const button = byId('taWorkbookApply'); const status = byId('taWorkbookDateStatus'); button.disabled = true; button.textContent = 'Loading…'; status.textContent = ''; taWorkbookVisibleRows = 50; try { await load(); } catch (error) { status.textContent = error.message; } finally { button.disabled = false; button.textContent = 'Apply DataTable'; } }); }
  if (!holder.dataset.filtersBound) { holder.dataset.filtersBound = 'true'; byId('taWorkbookLine').addEventListener('change', render); byId('taWorkbookCategory').addEventListener('change', render); byId('taWorkbookSearch').addEventListener('input', render); }
  if (!holder.dataset.exportBound) { holder.dataset.exportBound = 'true'; byId('exportTaWorkbook').addEventListener('click', async () => { const button = byId('exportTaWorkbook'); const startDate = byId('taWorkbookStartDate').value; const endDate = byId('taWorkbookEndDate').value; if (!startDate || !endDate || startDate > endDate) { byId('taWorkbookDateStatus').textContent = 'Choose a valid DataTable date range before exporting.'; return; } button.disabled = true; button.textContent = 'Exporting…'; try { const params = new URLSearchParams({ dataset: 'ta-yield', startDate, endDate }); const response = await fetch(`/api/export/ta-yield-datatable?${params}`); if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(payload.error || 'TA Yield DataTable export could not be created.'); } const blob = await response.blob(); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `ta-yield-datatable-${startDate}-to-${endDate}.xlsx`; document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(link.href); byId('taWorkbookDateStatus').textContent = ''; } catch (error) { byId('taWorkbookDateStatus').textContent = error.message; } finally { button.disabled = false; button.textContent = 'Export Excel'; } }); }
  const applyWorkbookLimit = () => { const header = holder.querySelector('thead tr'); if (header && ![...header.cells].some((cell) => cell.textContent.trim() === 'ACC')) { const cell = document.createElement('th'); cell.textContent = 'ACC'; header.insertBefore(cell, header.cells[4]); [...byId('taWorkbookRows').querySelectorAll('tr')].forEach((row) => row.insertBefore(document.createElement('td'), row.cells[4])); } const rows = [...byId('taWorkbookRows').querySelectorAll('tr')]; rows.forEach((row, index) => { row.hidden = index >= taWorkbookVisibleRows; }); const loadMore = byId('taWorkbookLoadMore'); loadMore.hidden = rows.length <= taWorkbookVisibleRows; loadMore.textContent = `Load 50 more (${Math.max(rows.length - taWorkbookVisibleRows, 0)} remaining)`; };
  if (!byId('taWorkbookLoadMore')) { const loadMore = document.createElement('button'); loadMore.id = 'taWorkbookLoadMore'; loadMore.type = 'button'; holder.append(loadMore); loadMore.addEventListener('click', () => { taWorkbookVisibleRows += 50; applyWorkbookLimit(); }); }
  if (!holder.dataset.tableBound) { holder.dataset.tableBound = 'true'; new MutationObserver(applyWorkbookLimit).observe(byId('taWorkbookRows'), { childList: true }); holder.addEventListener('click', (event) => { if (!event.target.closest('.ta-workbook-date-sort')) return; taWorkbookDateDirection = taWorkbookDateDirection === 'asc' ? 'desc' : 'asc'; const rows = [...byId('taWorkbookRows').querySelectorAll('tr')].sort((left, right) => { const comparison = left.cells[3].textContent.localeCompare(right.cells[3].textContent); return taWorkbookDateDirection === 'asc' ? comparison : -comparison; }); byId('taWorkbookRows').append(...rows); const header = holder.querySelector('th:nth-child(4)'); header?.setAttribute('aria-sort', taWorkbookDateDirection === 'asc' ? 'ascending' : 'descending'); const button = header?.querySelector('.ta-workbook-date-sort'); if (button) button.setAttribute('aria-label', `Sort Taping Date ${taWorkbookDateDirection === 'asc' ? 'ascending' : 'descending'}; activate to reverse`); applyWorkbookLimit(); }); }
  applyWorkbookLimit();
  return holder;
}
function ensureTaYieldActionsView() {
  let view = byId('taYieldActions');
  if (!view) { view = document.createElement('section'); view.id = 'taYieldActions'; view.className = 'ta-yield-actions'; byId('taYieldHead').closest('section').before(view); }
  const formatDate = (value) => value ? String(value).slice(0, 10) : '—';
  const inProgress = latestTaYieldActions.filter((action) => action.status !== 'CLOSED');
  const closed = latestTaYieldActions.filter((action) => action.status === 'CLOSED');
  const visible = taYieldActionStatus === 'CLOSED' ? closed : inProgress;
  const dateRowCounts = visible.reduce((counts, action) => {
    const actionDate = formatDate(action.actionDate);
    return { ...counts, [actionDate]: (counts[actionDate] || 0) + 1 };
  }, {});
  const renderedDates = new Set();
  const rows = visible.map((action) => {
    const actionDate = formatDate(action.actionDate);
    const dateCell = renderedDates.has(actionDate) ? '' : `<td class="ta-action-date-cell" rowspan="${dateRowCounts[actionDate]}">${escapeHtml(actionDate)}</td>`;
    renderedDates.add(actionDate);
    return `<tr data-action-date="${escapeHtml(actionDate)}">${dateCell}<td data-action-label="Series"><strong>${escapeHtml(action.serie)}</strong></td><td data-action-label="Problem">${escapeHtml(action.problem)}</td><td data-action-label="Analysis / action">${escapeHtml(action.analysisAction || '—')}</td><td data-action-label="Progress">${escapeHtml(action.progress || '—')}</td><td data-action-label="PIC">${escapeHtml(action.pic || '—')}</td><td data-action-label="Due">${escapeHtml(formatDate(action.dueDate))}</td><td data-action-label="Status"><span class="ta-action-status ${action.status.toLowerCase().replace('_', '-')}">${escapeHtml(action.status === 'CLOSED' ? 'Closed' : action.status === 'OPEN' ? 'Open' : 'In progress')}</span></td><td data-action-label="Action"><button type="button" data-edit-ta-action="${action.id}">Edit</button></td></tr>`;
  }).join('') || `<tr><td colspan="9" class="ta-action-empty">No ${taYieldActionStatus === 'CLOSED' ? 'closed' : 'in-progress'} actions.</td></tr>`;
  view.innerHTML = `<div class="ta-action-heading"><div><p class="section-kicker">Corrective action tracker</p><h3>TA Yield actions</h3><p>Problems, owners, analysis, and follow-up progress from the TA Yield review.</p></div><div><button id="toggleTaYieldDetail" class="ta-action-secondary" type="button">${taYieldDetailVisible ? 'Hide yield detail' : 'Show yield detail'}</button><button id="addTaYieldAction" class="ta-action-primary" type="button">Add action</button></div></div><div class="ta-action-tabs" role="tablist" aria-label="Action status"><button class="ta-action-tab${taYieldActionStatus === 'IN_PROGRESS' ? ' active' : ''}" type="button" data-ta-action-filter="IN_PROGRESS" role="tab" aria-selected="${taYieldActionStatus === 'IN_PROGRESS'}">In progress <b>${inProgress.length}</b></button><button class="ta-action-tab${taYieldActionStatus === 'CLOSED' ? ' active' : ''}" type="button" data-ta-action-filter="CLOSED" role="tab" aria-selected="${taYieldActionStatus === 'CLOSED'}">Closed <b>${closed.length}</b></button></div><div class="ta-action-table-wrap"><table><thead><tr><th scope="col">Date</th><th scope="col">Series</th><th scope="col">Problem</th><th scope="col">Analysis / action</th><th scope="col">Progress</th><th scope="col">PIC</th><th scope="col">Due</th><th scope="col">Status</th><th scope="col">Action</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  byId('toggleTaYieldDetail').addEventListener('click', () => { taYieldDetailVisible = !taYieldDetailVisible; renderTaYield(latestTaYieldData); });
  byId('addTaYieldAction').addEventListener('click', () => openTaYieldActionModal());
  view.querySelectorAll('[data-ta-action-filter]').forEach((button) => button.addEventListener('click', () => { taYieldActionStatus = button.dataset.taActionFilter; ensureTaYieldActionsView(); }));
  view.querySelectorAll('[data-edit-ta-action]').forEach((button) => button.addEventListener('click', () => openTaYieldActionModal(latestTaYieldActions.find((action) => action.id === Number(button.dataset.editTaAction)))));
  return view;
}

function ensureTaYieldActionModal() {
  let modal = byId('taYieldActionModal');
  if (!modal) { modal = document.createElement('div'); modal.id = 'taYieldActionModal'; modal.className = 'ta-action-modal'; modal.hidden = true; modal.innerHTML = '<form class="ta-action-dialog" novalidate><header><div><p class="section-kicker">TA Yield corrective action</p><h3 id="taActionModalTitle">Add action</h3></div><button type="button" data-close-ta-action aria-label="Close">×</button></header><input id="taActionId" type="hidden" /><div class="ta-action-form-grid"><label>Date<input id="taActionDate" type="date" required /></label><label>Series<input id="taActionSerie" maxlength="100" required /></label><label>Status<select id="taActionStatus"><option value="OPEN">Open</option><option value="IN_PROGRESS">In progress</option><option value="CLOSED">Closed</option></select></label><label>Due date<input id="taActionDueDate" type="date" /></label></div><label>Problem<textarea id="taActionProblem" maxlength="2000" required></textarea></label><label>Analysis / action<textarea id="taActionAnalysis" maxlength="8000"></textarea></label><div class="ta-action-form-grid"><label>PIC<input id="taActionPic" maxlength="255" /></label><label>Progress<textarea id="taActionProgress" maxlength="8000"></textarea></label></div><p id="taActionModalStatus" role="status"></p><footer><button type="button" data-close-ta-action>Cancel</button><button id="saveTaYieldAction" type="submit">Save action</button></footer></form>'; document.body.append(modal); modal.querySelectorAll('[data-close-ta-action]').forEach((button) => button.addEventListener('click', () => { modal.hidden = true; })); modal.addEventListener('click', (event) => { if (event.target === modal) modal.hidden = true; }); modal.querySelector('form').addEventListener('submit', saveTaYieldAction); }
  return modal;
}

function openTaYieldActionModal(action) {
  const modal = ensureTaYieldActionModal(); const set = (id, value) => { byId(id).value = value || ''; };
  set('taActionId', action?.id); set('taActionDate', action?.actionDate || byId('endDate').value); set('taActionSerie', action?.serie || ''); set('taActionStatus', action?.status || 'OPEN'); set('taActionDueDate', action?.dueDate); set('taActionProblem', action?.problem); set('taActionAnalysis', action?.analysisAction); set('taActionPic', action?.pic); set('taActionProgress', action?.progress); byId('taActionModalTitle').textContent = action ? 'Edit action' : 'Add action'; byId('taActionModalStatus').textContent = ''; modal.hidden = false; byId('taActionProblem').focus();
}

async function saveTaYieldAction(event) {
  event.preventDefault(); const id = Number(byId('taActionId').value); const payload = { actionDate: byId('taActionDate').value, serie: byId('taActionSerie').value.trim(), problem: byId('taActionProblem').value.trim(), analysisAction: byId('taActionAnalysis').value.trim(), pic: byId('taActionPic').value.trim(), progress: byId('taActionProgress').value.trim(), dueDate: byId('taActionDueDate').value, status: byId('taActionStatus').value }; const status = byId('taActionModalStatus'); const save = byId('saveTaYieldAction'); save.disabled = true; status.textContent = 'Saving action…'; try { await request(id ? `/api/ta-yield-actions/${id}` : '/api/ta-yield-actions', { method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); latestTaYieldActions = await request('/api/ta-yield-actions'); byId('taYieldActionModal').hidden = true; renderTaYield(latestTaYieldData); } catch (error) { status.textContent = error.message; } finally { save.disabled = false; }
}

function renderTaYield(payload) {
  const weeklySection = byId('taYieldWeeklySection');
  weeklySection?.remove();
  byId('taWorkbookStaticControl').hidden = true;
  const workbookHolder = ensureTaWorkbookVerificationView();
  workbookHolder.hidden = false;
  byId('taYieldHead').closest('section').hidden = !taYieldDetailVisible;
  ensureTaYieldActionsView();
  taWorkbookVisibleRows = 50;
  latestTaYieldLotsRequestId = dataRequestId;
  byId('taYieldLogTab')?.removeAttribute('hidden');
  const parameterTab = document.querySelector('.app-tab[data-view="parameters"]'); parameterTab.hidden = false; parameterTab.textContent = 'TA Yield target setting';
  if (document.querySelector('.app-tab.active')?.dataset.view === 'ta-yield-log') renderTaYieldCalculationLog();
  const rows = payload.summary || [];
  const details = payload.details || [];
  const groups = [...new Set(rows.flatMap((row) => row.groups.map((group) => group.group)))].sort();
  const chartRows = rows.filter((row) => Number.isFinite(row.defectRate) && Number.isFinite(row.yield));
  const totals = rows.reduce((sum, row) => ({ input: sum.input + Number(row.input || 0), finalGood: sum.finalGood + Number(row.finalGood || 0), defect: sum.defect + Number(row.defect || 0) }), { input: 0, finalGood: 0, defect: 0 });
  const defectRate = totals.input ? totals.defect / totals.input * 100 : undefined;
  const yieldValue = totals.input ? totals.finalGood / totals.input * 100 : undefined;
  byId('taYieldInput').textContent = format.format(totals.input); byId('taYieldDefect').textContent = format.format(totals.defect); byId('taYieldDefectRate').textContent = defectRate === undefined ? '-' : `${defectRate.toFixed(2)}%`; byId('taYieldTotal').textContent = yieldValue === undefined ? '-' : `${yieldValue.toFixed(2)}%`;
  byId('taYieldScope').textContent = `${rows.length} month-series record${rows.length === 1 ? '' : 's'} | valid production lots only`;
  const lotSeries = [...new Set(details.map((row) => row.series))].sort();
  if (!lotSeries.includes(taYieldLotSeries)) taYieldLotSeries = '';
  const lotSeriesSelect = ensureTaYieldLotSeriesControl();
  lotSeriesSelect.replaceChildren(new Option('Select a series', ''), ...lotSeries.map((series) => new Option(shortTaSeries(series), series)));
  lotSeriesSelect.value = taYieldLotSeries;
  const normalizedLotSearch = taYieldLotSearch.trim().toLowerCase();
  const visibleDetails = taYieldLotSeries ? details.filter((row) => row.series === taYieldLotSeries && (!normalizedLotSearch || row.lotNo.toLowerCase().includes(normalizedLotSearch))) : [];
  const detailGroups = [...new Set(details.flatMap((row) => row.groups.map((group) => group.group)))].sort();
  byId('taYieldLotFilter').hidden = taYieldTableView !== 'lots';
  if (taYieldTableView === 'lots') {
    byId('taYieldSummaryLoadMore')?.setAttribute('hidden', '');
    byId('taYieldDetailTitle').textContent = 'Excel-style lot detail';
    byId('taYieldHead').innerHTML = `<tr><th>Series</th><th>Lot No</th><th>Close date</th><th>Input Q</th><th>Final Good Q</th>${detailGroups.map((group) => `<th>${escapeHtml(group)}</th>`).join('')}<th>Total defect</th><th>Yield</th></tr>`;
    byId('taYieldLotCount').textContent = taYieldLotSeries ? `${visibleDetails.length} of ${details.filter((row) => row.series === taYieldLotSeries).length} lots` : 'Select a series to display lot details.';
    byId('taYieldRows').innerHTML = visibleDetails.map((row) => { const quantities = Object.fromEntries(row.groups.map((group) => [group.group, group.quantity])); return `<tr><td>${escapeHtml(shortTaSeries(row.series))}</td><td>${escapeHtml(row.lotNo)}</td><td>${escapeHtml(row.closeDate)}</td><td>${format.format(row.input)}</td><td>${format.format(row.finalGood)}</td>${detailGroups.map((group) => `<td>${format.format(quantities[group] || 0)}</td>`).join('')}<td>${format.format(row.defect)}</td><td>${row.yield === undefined ? '-' : `${row.yield.toFixed(2)}%`}</td></tr>`; }).join('') || `<tr><td colspan="${7 + detailGroups.length}">${taYieldLotSeries ? 'No TA lots match this table filter.' : 'Select a series to display lot details.'}</td></tr>`;
  } else {
    byId('taYieldLotCount').textContent = '';
    byId('taYieldDetailTitle').textContent = 'Yield and defects by TA series';
    byId('taYieldHead').innerHTML = `<tr><th>Month</th><th>Series</th><th>Adjusted input</th><th>Final good</th>${groups.map((group) => `<th>${escapeHtml(group)}</th>`).join('')}<th>Defective rate</th><th>Yield</th></tr>`;
    byId('taYieldRows').innerHTML = rows.map((row) => { const quantities = Object.fromEntries(row.groups.map((group) => [group.group, group.quantity])); return `<tr><td>${escapeHtml(row.month)}</td><td>${escapeHtml(shortTaSeries(row.line))}</td><td>${format.format(row.input)}</td><td>${format.format(row.finalGood)}</td>${groups.map((group) => `<td>${format.format(quantities[group] || 0)}</td>`).join('')}<td>${row.defectRate === undefined ? '-' : `${row.defectRate.toFixed(2)}%`}</td><td>${row.yield === undefined ? '-' : `${row.yield.toFixed(2)}%`}</td></tr>`; }).join('') || `<tr><td colspan="${6 + groups.length}">No eligible TA Yield data matches the selected filters.</td></tr>`;
    const summaryRows = [...byId('taYieldRows').querySelectorAll('tr')];
    summaryRows.forEach((row, index) => { row.hidden = index >= taYieldSummaryVisibleRows; });
    let loadMore = byId('taYieldSummaryLoadMore');
    if (!loadMore) { loadMore = document.createElement('button'); loadMore.id = 'taYieldSummaryLoadMore'; loadMore.type = 'button'; loadMore.className = 'ta-yield-load-more'; byId('taYieldHead').closest('section').append(loadMore); loadMore.addEventListener('click', () => { taYieldSummaryVisibleRows += 20; renderTaYield(latestTaYieldData); }); }
    loadMore.hidden = summaryRows.length <= taYieldSummaryVisibleRows;
    loadMore.textContent = `Load 20 more (${Math.max(summaryRows.length - taYieldSummaryVisibleRows, 0)} remaining)`;
  }
  if (!chartRows.length) { renderTaYieldTendencyCharts(latestTaYieldTendencyData); return; }
  const width = Math.max(760, chartRows.length * 112 + 120); const height = 300; const left = 58; const right = 58; const top = 38; const bottom = 58; const base = height - bottom; const plotHeight = base - top; const slot = (width - left - right) / chartRows.length; const defectMax = Math.max(1, ...chartRows.map((row) => row.defectRate)); const yieldMin = Math.max(0, Math.floor((Math.min(...chartRows.map((row) => row.yield)) - .5) * 2) / 2); const yieldMax = Math.min(100, Math.max(yieldMin + 1, Math.ceil((Math.max(...chartRows.map((row) => row.yield)) + .5) * 2) / 2)); const yYield = (value) => base - (value - yieldMin) / (yieldMax - yieldMin) * plotHeight;
  const grid = [0, .25, .5, .75, 1].map((ratio) => { const y = base - plotHeight * ratio; return `<line class="gridline" x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"/><text class="axis" x="${left - 8}" y="${y + 4}" text-anchor="end">${(defectMax * ratio).toFixed(2)}%</text><text class="axis" x="${width - right + 8}" y="${y + 4}">${(yieldMin + (yieldMax - yieldMin) * ratio).toFixed(1)}%</text>`; }).join('');
  const bars = chartRows.map((row, index) => { const x = left + index * slot + slot * .28; const barWidth = Math.min(42, slot * .44); const quantities = Object.fromEntries(row.groups.map((group) => [group.group, group.quantity])); let stacked = 0; const segments = groups.map((group, groupIndex) => { const signedRate = row.input ? (quantities[group] || 0) / row.input * 100 : 0; const rate = Math.max(0, signedRate); const h = rate / defectMax * plotHeight; const y = base - stacked - h; stacked += h; return rate ? `<rect x="${x}" y="${y}" width="${barWidth}" height="${h}" fill="${chartColors[groupIndex % chartColors.length]}"><title>${escapeHtml(row.month)} ${escapeHtml(row.line)} | ${escapeHtml(group)}: ${signedRate.toFixed(3)}%</title></rect>` : ''; }).join(''); return `${segments}<text class="axis" x="${x + barWidth / 2}" y="${base + 20}" text-anchor="middle">${escapeHtml(row.line)}</text><text class="axis" x="${x + barWidth / 2}" y="${base + 35}" text-anchor="middle">${escapeHtml(row.month.slice(5))}</text>`; }).join('');
  const points = chartRows.map((row, index) => `${left + index * slot + slot / 2},${yYield(row.yield)}`).join(' '); const dots = chartRows.map((row, index) => `<circle class="yield-point" cx="${left + index * slot + slot / 2}" cy="${yYield(row.yield)}" r="4"><title>${escapeHtml(row.month)} ${escapeHtml(row.line)}: yield ${row.yield.toFixed(2)}%</title></circle>`).join('');
  const legend = groups.map((group, index) => `<span><i style="background:${chartColors[index % chartColors.length]}"></i>${escapeHtml(group)}</span>`).join('');
  renderTaYieldTendencyCharts(latestTaYieldTendencyData);
}

function renderTaYieldWeeklyChartsBase(rows) {
  const holder = byId('taYieldWeeklyChart');
  const allWeeks = [...new Set(rows.map((row) => row.month))].sort();
  const weeks = allWeeks.filter((week) => selectedTaYieldWeeks.includes(week));
  const series = [...new Set(rows.map((row) => taChartGroup(row.line)).filter(Boolean))].sort();
  const value = (week, line, accumulated) => {
    const selected = rows.filter((row) => selectedTaYieldWeeks.includes(row.month) && row.month <= week && (accumulated || row.month === week) && (line === 'Total' || taChartGroup(row.line) === line));
    const input = selected.reduce((sum, row) => sum + Number(row.input || 0), 0);
    const finalGood = selected.reduce((sum, row) => sum + Number(row.finalGood || 0), 0);
    return input ? finalGood / input * 100 : undefined;
  };
  const chart = (title, accumulated) => {
    const width = 620; const height = 230; const plottedSeries = series.concat('Total'); const colors = { Total: '#7b5aac' };
    const values = plottedSeries.flatMap((line) => weeks.map((week) => value(week, line, accumulated)).filter(Number.isFinite));
    if (!values.length) return `<article class="sc-yield-series-card"><h4>${title}</h4><p class="sc-yield-empty">No eligible weekly TA Yield data matches the selected filters.</p></article>`;
    let min = Math.max(0, Math.floor((Math.min(...values) - .5) * 2) / 2); let max = Math.min(100, Math.ceil((Math.max(...values) + .5) * 2) / 2); if (max - min < 1) { min = Math.max(0, min - .5); max = Math.min(100, max + .5); }
    const x = (index) => 52 + index * (width - 88) / Math.max(weeks.length - 1, 1); const y = (item) => 28 + (max - item) / (max - min) * 155;
    const color = (line, index) => colors[line] || chartColors[index % chartColors.length];
    const lines = plottedSeries.map((line, index) => { const points = weeks.map((week, weekIndex) => value(week, line, accumulated)).map((item, weekIndex) => Number.isFinite(item) ? `${x(weekIndex)},${y(item)}` : '').filter(Boolean).join(' '); return points ? `<polyline fill="none" stroke="${color(line, index)}" stroke-width="2.5" points="${points}"/>` : ''; }).join('');
    const marks = plottedSeries.flatMap((line, index) => weeks.map((week, weekIndex) => { const item = value(week, line, accumulated); return Number.isFinite(item) ? `<circle class="sc-yield-weekly-point" cx="${x(weekIndex)}" cy="${y(item)}" r="4" fill="${color(line, index)}" tabindex="0" data-serie="${escapeHtml(line)}" data-week="${escapeHtml(week)}" data-yield="${item}" aria-label="${escapeHtml(line)}, ${escapeHtml(week)}, yield ${item.toFixed(2)} percent"/>` : ''; })).join('');
    const legend = plottedSeries.map((line, index) => `<span><i style="background:${color(line, index)}"></i>${escapeHtml(line)}</span>`).join('');
    return `<article class="sc-yield-series-card"><h4>${title}</h4><div class="sc-yield-chart"><div class="sc-yield-legend"><strong>Series</strong>${legend}</div><div class="sc-yield-chart-scroll"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="TA ${title.toLowerCase()} by series"><text x="8" y="28" font-size="11">${max.toFixed(1)}%</text><text x="8" y="183" font-size="11">${min.toFixed(1)}%</text>${lines}${marks}${weeks.map((week, index) => `<text x="${x(index)}" y="208" text-anchor="middle" font-size="10">${escapeHtml(week.slice(-3))}</text>`).join('')}</svg></div></div><div class="sc-yield-weekly-tooltip" role="status" hidden></div></article>`;
  };
  holder.innerHTML = `<div class="sc-yield-week-range" role="group" aria-label="TA weekly chart display range"><span class="sc-yield-week-range-title">Display range</span><label><span>From week</span><select id="taYieldWeekStart" aria-label="TA start week">${allWeeks.map((week) => `<option value="${week}" ${week === selectedTaYieldWeeks[0] ? 'selected' : ''}>${week}</option>`).join('')}</select></label><span class="sc-yield-week-range-divider" aria-hidden="true">to</span><label><span>To week</span><select id="taYieldWeekEnd" aria-label="TA end week">${allWeeks.map((week) => `<option value="${week}" ${week === selectedTaYieldWeeks.at(-1) ? 'selected' : ''}>${week}</option>`).join('')}</select></label></div><div class="sc-yield-series-grid">${chart('Weekly yield tendency', false)}${chart('Accumulated weekly yield tendency', true)}</div>`;
  bindScYieldWeeklyTooltips(holder);
  const update = (event) => { const startControl = byId('taYieldWeekStart'); const endControl = byId('taYieldWeekEnd'); if (startControl.value > endControl.value) { if (event.target === startControl) endControl.value = startControl.value; else startControl.value = endControl.value; } selectedTaYieldWeeks = allWeeks.filter((week) => week >= startControl.value && week <= endControl.value); renderTaYieldWeeklyChart(rows); };
  byId('taYieldWeekStart').addEventListener('change', update); byId('taYieldWeekEnd').addEventListener('change', update);
}

function renderTaYieldWeeklyChart(rows = latestTaYieldWeeklyData) {
  if (!byId('taYieldWeeklyChart')) return;
  const allWeeks = [...new Set(rows.map((row) => row.month))].sort();
  selectedTaYieldWeeks = selectedTaYieldWeeks.filter((week) => allWeeks.includes(week));
  if (!selectedTaYieldWeeks.length) selectedTaYieldWeeks = allWeeks;
  renderTaYieldWeeklyChartsBase(rows);
}

async function request(url, options = {}, retriedAfterAuthentication = false) {
  const method = options.method || 'GET';
  const cacheable = method === 'GET' && /^\/api\/(?:config|part-numbers|quantity|mtd-quantity|chart|wip-flow|yield|operation-transitions)/.test(url);
  const cached = cacheable ? clientResponseCache.get(url) : undefined;
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  const response = await fetch(url, /^\/api\/options(?:\?|$)/.test(url) ? { ...options, cache: 'no-store' } : options);
  const payload = await readApiPayload(response, url);
  if (response.status === 401 && payload.code === 'AUTH_REQUIRED' && !retriedAfterAuthentication) {
    clientResponseCache.clear();
    await refreshDatabaseAuthentication();
    return request(url, options, true);
  }
  if (!response.ok || !payload.success) throw new Error(payload.error || 'Request failed.');
  if (cacheable) {
    const maxAge = Number(response.headers.get('cache-control')?.match(/max-age=(\d+)/)?.[1] || 120);
    clientResponseCache.set(url, { data: payload.data, expiresAt: Date.now() + maxAge * 1000 });
    while (clientResponseCache.size > clientCacheLimit) clientResponseCache.delete(clientResponseCache.keys().next().value);
  }
  return payload.data;
}
async function loadData() {
  const requestId = ++dataRequestId;
  let loadFailed = false;
  const params = new URLSearchParams({ dataset: selectedDataset(), startDate: byId('startDate').value, endDate: byId('endDate').value });
  const apply = byId('apply');
  ids.filter((id) => !['serie', 'pn'].includes(id)).forEach((id) => { if (byId(id).value) params.set(id, byId(id).value); });
  if (byId('product').value) params.set('product', byId('product').value);
  selectedSeries().forEach((serie) => params.append('serie', serie)); selectedPartNumbers().forEach((pn) => params.append('pn', pn));
  const period = selectedReportingPeriod(); const isLot = currentConfig.dataset === 'lot'; const isScYield = currentConfig.dataset === 'yield'; const isTaYield = currentConfig.dataset === 'ta-yield'; if (isTaYield) taYieldSummaryVisibleRows = 20; if (isTaYield) renderTaYieldTendencySkeleton();
  const mtdParams = period && currentConfig.dataset === 'closed' ? new URLSearchParams(params) : undefined; if (mtdParams) mtdParams.set('startDate', `${period}-01`);
  apply.textContent = 'Loading'; setReportControlsLoading(true); setStatus(isScYield ? 'Loading SC Yield data...' : isTaYield ? 'Loading TA Yield data...' : 'Loading quantity data...', true);
  try {
    if (isScYield) { const [rows, weeklyRows] = await Promise.all([request(`/api/sc-yield?${params}`), request(`/api/sc-yield-weekly?${params}`)]); if (requestId !== dataRequestId) return; renderScYield(rows); renderScYieldWeeklyCharts(weeklyRows); setStatus(''); return; }
    if (isTaYield) { const groupTendencyParams = new URLSearchParams(params); groupTendencyParams.set('interval', taYieldInterval); const groupTendencyRequest = request(`/api/ta-yield-tendency?${groupTendencyParams}`); const tendencyParams = new URLSearchParams(groupTendencyParams); if (taYieldTrendPartNumber !== 'All') tendencyParams.set('trendPn', taYieldTrendPartNumber); const tendencyRequest = taYieldTrendPartNumber === 'All' ? groupTendencyRequest : request(`/api/ta-yield-tendency?${tendencyParams}`); const [summary, groupTendencyRows, tendencyRows, targets, actions] = await Promise.all([request(`/api/ta-yield?${params}`), groupTendencyRequest, tendencyRequest, request('/api/ta-yield-targets'), request('/api/ta-yield-actions').catch(() => [])]); if (requestId !== dataRequestId) return; taYieldTargets = targets.reduce((settings, target) => ({ ...settings, [target.serie]: { ...(settings[target.serie] || {}), [target.period]: target.target } }), {}); latestTaYieldActions = actions; latestTaYieldLotsUrl = `/api/ta-yield-lots?${params}`; latestTaYieldData = { summary, details: [] }; latestTaYieldTendencyData = tendencyRows; latestTaYieldGroupTendencyData = groupTendencyRows; if (taYieldTableView === 'lots') { const details = await request(latestTaYieldLotsUrl); if (requestId !== dataRequestId) return; latestTaYieldData = { ...latestTaYieldData, details }; } renderTaYield(latestTaYieldData); setStatus(''); return; }
    if (isLot) {
      const data = await request(`/api/quantity?${params}`);
      if (requestId !== dataRequestId) return;
      renderData(data, null, []);
      if (currentConfig.chartAxis === 'process' && !usesOperationDateAxis()) { byId('chart-title').textContent = 'Quantity moved by process'; byId('chart').innerHTML = '<div class="chart-loading" role="status"><i aria-hidden="true"></i><span>Loading process analysis from MES…</span></div>'; }
      setStatus('WIP table loaded. Loading analysis in the background...', true);
      let stagedChartData = null;
      const renderStagedWipTable = () => { if (requestId === dataRequestId) renderData(data, stagedChartData, []); };
      loadCellComments(requestId).then(renderStagedWipTable).catch(() => {});
      Promise.all([currentConfig.chartAxis === 'process' && !usesOperationDateAxis() ? request(`/api/chart?${params}`) : Promise.resolve(null)]).then(([chartData]) => {
        if (requestId !== dataRequestId) return;
        stagedChartData = chartData; renderStagedWipTable(); setStatus('');
      }).catch((error) => { if (requestId === dataRequestId) setStatus(`WIP table loaded; analysis is unavailable: ${error.message}`); });
      return;
    }
    const [data, chartData, mtdData, wipFlow, yieldData] = await Promise.all([request(`/api/quantity?${params}`), currentConfig.chartAxis === 'process' && !usesOperationDateAxis() ? request(`/api/chart?${params}`) : Promise.resolve(null), mtdParams ? request(`/api/mtd-quantity?${mtdParams}`) : Promise.resolve([]), Promise.resolve([]), Promise.resolve({ goodDisposition: 'good', rows: [] }), loadCellComments()]);
    if (requestId !== dataRequestId) return; renderData(data, chartData, mtdData); setStatus('');
  } catch (error) { loadFailed = true; if (requestId === dataRequestId) { if (isTaYield) renderTaYieldTendencyLoadError(error.message); setStatus(error.message); } } finally { setReportControlsLoading(false); if (requestId === dataRequestId) { apply.textContent = 'Apply'; if (!loadFailed) markReportControlsApplied(); } }
}
async function refreshOptionsForProduct() { const product = byId('product').value; setReportControlsLoading(true); setStatus('Refreshing available series...', true); try { const options = await request(`/api/options?${new URLSearchParams({ dataset: selectedDataset(), ...(product ? { product } : {}) })}`); populateOptions(options); resetPartNumbers(); setStatus(''); } catch (error) { setStatus(error.message); } finally { setReportControlsLoading(false); } }
async function refreshOptionsForProcess() { const process = byId('process').value; const product = byId('product').value; setReportControlsLoading(true); setStatus('Refreshing available series...', true); try { const options = await request(`/api/options?${new URLSearchParams({ dataset: selectedDataset(), ...(product ? { product } : {}), ...(process ? { process } : {}) })}`); populateOptions(options, { process }); setSelectedProcess(process); resetPartNumbers(); setStatus(''); } catch (error) { setStatus(error.message); } finally { setReportControlsLoading(false); } }
function refreshOptionsForSerie() { resetPartNumbers(); setStatus(''); }
async function initialize() { if (!hasInitializedDashboard && !byId('product').value) setSelectedProduct('NEO'); hasInitializedDashboard = true; const isLot = selectedDataset() === 'lot'; const isScYield = selectedDataset() === 'yield'; const isTaYield = selectedDataset() === 'ta-yield'; if (isScYield) setSelectedProduct('SC'); if (isTaYield) setSelectedProduct('NEO'); const todayString = bangkokToday(); const initialEndDate = isTaYield ? await latestTaYieldStagingDate(todayString) : todayString; if (isTaYield && selectedDataset() !== 'ta-yield') return; byId('endDate').value = initialEndDate; byId('startDate').value = `${initialEndDate.slice(0, 7)}-01`; if (!byId('parameterPeriod').value) byId('parameterPeriod').value = todayString.slice(0, 7); byId('lotProcessField').hidden = !isLot; document.querySelector('.process-field').hidden = isScYield || isTaYield; try { const config = await request(`/api/config?dataset=${selectedDataset()}`); if (!config.ready) throw new Error(`Dashboard configuration is incomplete: ${config.missing.join(', ')}.`); currentConfig = config; commentsEnabled = Boolean(config.commentStorage?.enabled); const usesSharedTargetStorage = Boolean(config.mtdTargetStorage?.enabled); targetStorageRemote = usesSharedTargetStorage; if (config.dataset === 'closed') await loadTargetSettings(usesSharedTargetStorage); const supportsMtd = config.dataset === 'closed'; byId('mtdSection').hidden = !supportsMtd; byId('dailyTargetControl').hidden = !supportsMtd; document.querySelector('.app-tab[data-view="parameters"]').hidden = !supportsMtd && !isScYield; document.querySelector('.app-tab[data-view="parameters"]').textContent = isScYield ? 'Yield target setting' : 'MTD Parameter setting'; byId('scYieldLogTab').hidden = !isScYield; byId('taYieldLogTab').hidden = !isTaYield; byId('taYieldMachineTab').hidden = !isTaYield; byId('taDataTableTab').hidden = !isTaYield; document.querySelector('.app-tab[data-view="comments"]').hidden = !commentsEnabled; const activeView = document.querySelector('.app-tab.active')?.dataset.view; if ((!supportsMtd && !isScYield && activeView === 'parameters') || (!isScYield && activeView === 'sc-yield-log') || (!isTaYield && ['ta-yield-log', 'ta-yield-machine', 'ta-data-table'].includes(activeView)) || (!commentsEnabled && activeView === 'comments')) showView('dashboard'); byId('dashboardTitle').textContent = isScYield ? 'SC Yield Control' : isTaYield ? 'TA Yield Control' : config.dataset === 'lot' ? 'WIP Production Volume' : 'Completion 901'; byId('chart-title').textContent = config.chartAxis === 'process' ? 'Quantity moved by process' : 'Completed qty by day'; document.querySelector('.report-top').hidden = isScYield || isTaYield; document.querySelector('.table-section').hidden = isScYield || isTaYield; byId('scYieldSection').hidden = !isScYield; byId('taYieldSection').hidden = !isTaYield; setFilterAvailability(config.filters); const optionParams = new URLSearchParams({ dataset: selectedDataset(), ...(byId('product').value ? { product: byId('product').value } : {}) }); populateOptions(await request(`/api/options?${optionParams}`)); resetPartNumbers(); await loadData(); } catch (error) { setStatus(error.message); } }
function exportReportParams() { const params = new URLSearchParams({ dataset: selectedDataset(), startDate: byId('startDate').value, endDate: byId('endDate').value }); ids.filter((id) => !['serie', 'pn'].includes(id)).forEach((id) => { if (byId(id).value) params.set(id, byId(id).value); }); if (byId('product').value) params.set('product', byId('product').value); selectedSeries().forEach((serie) => params.append('serie', serie)); selectedPartNumbers().forEach((pn) => params.append('pn', pn)); return params; }
async function exportCompletion() { if (!latestData.length) { setStatus('Load report data before exporting.'); return; } const button = byId('exportCompletion'); button.disabled = true; button.textContent = 'Exporting...'; try { const response = await fetch(`/api/export/completion?${exportReportParams()}`); if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(payload.error || 'Excel export could not be created.'); } const blob = await response.blob(); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${selectedDataset() === 'closed' ? '901' : 'wip'}-series-completion-${byId('startDate').value}-to-${byId('endDate').value}.xlsx`; document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(link.href); setStatus(''); } catch (error) { setStatus(error.message); } finally { button.disabled = false; button.textContent = 'Export Excel'; } }
byId('apply').addEventListener('click', loadData); byId('exportCompletion').addEventListener('click', exportCompletion); byId('process').addEventListener('change', refreshOptionsForProcess); byId('serie').addEventListener('change', refreshOptionsForSerie);
byId('reportControls').addEventListener('change', updateReportPendingNotice);
byId('reportControls').addEventListener('click', (event) => { if (event.target.closest('.process-option, .serie-option input, .pn-option, [data-remove-pn]')) requestAnimationFrame(updateReportPendingNotice); });
document.querySelectorAll('.app-tab').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
document.addEventListener('click', (event) => { if (event.target.closest('.app-tab')?.dataset.view === 'dashboard' && selectedDataset() === 'ta-yield') { [...byId('taYieldSection').children].forEach((child) => { child.hidden = false; }); byId('taYieldHead').closest('section').hidden = !taYieldDetailVisible; byId('taYieldLotFilter').hidden = taYieldTableView !== 'lots'; } });
document.querySelector('.app-tab[data-view="parameters"]').addEventListener('click', () => { if (selectedDataset() === 'ta-yield') renderTaYieldTargetParameters(); });
byId('parameterProduct').addEventListener('change', loadParameterSeries);
byId('parameterSerie').addEventListener('change', fillParameterSetting);
byId('parameterPeriod').addEventListener('change', fillParameterSetting);
async function removeParameter(product, serie, period) { if (!window.confirm(`Remove the saved target for ${product} / ${serie} / ${period}?`)) return; if (targetStorageRemote) await request(`/api/mtd-targets?${new URLSearchParams({ product, serie, period })}`, { method: 'DELETE' }); else writeTargetSettings(removeTargetSetting(product, serie, period)); if (targetStorageRemote) await loadTargetSettings(); byId('parameterStatus').className = 'parameter-status success'; byId('parameterStatus').textContent = `Parameter removed for ${period}.`; renderSavedParameters(); renderMtd(latestMtdData); fillParameterSetting(); }
async function saveParameter() { const product = byId('parameterProduct').value; const serie = byId('parameterSerie').value; const period = byId('parameterPeriod').value; const target = Number(byId('parameterTarget').value); const workingDay = Number(byId('parameterWorkingDay').value); const status = byId('parameterStatus'); if (!['NEO', 'SC'].includes(product) || !serie || !/^\d{4}-\d{2}$/.test(period) || !Number.isFinite(target) || target < 0 || !Number.isFinite(workingDay) || workingDay <= 0) { status.className = 'parameter-status'; status.textContent = 'Provide a valid Product, Serie, period, monthly plan, and working day.'; return; } if (targetStorageRemote) await request('/api/mtd-targets', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ product, serie, period, monthlyPlan: target, workingDay }) }); else { const settings = readTargetSettings(); const existing = settings[product]?.[serie] || {}; writeTargetSettings({ ...settings, [product]: { ...(settings[product] || {}), [serie]: { periods: { ...(existing.periods || {}), [period]: { target, workingDay } } } } }); } if (targetStorageRemote) await loadTargetSettings(); status.className = 'parameter-status success'; status.textContent = target === 0 ? `Parameter saved for ${period}; calculations are disabled.` : `Parameter saved for ${period}.`; renderSavedParameters(); renderMtd(latestMtdData); }
function openParameterEditModal(product, serie, period, trigger) { const setting = targetSetting(product, serie, period, true); if (!setting) return; parameterEditReturnFocus = trigger; const form = byId('parameterEditForm'); form.dataset.product = product; form.dataset.serie = serie; form.dataset.period = period; byId('parameterEditProduct').textContent = product; byId('parameterEditSerie').textContent = serie; byId('parameterEditPeriod').textContent = period; byId('parameterEditTarget').value = setting.target; byId('parameterEditWorkingDay').value = setting.workingDay; byId('parameterEditStatus').textContent = ''; byId('parameterEditModal').hidden = false; byId('parameterEditTarget').focus(); }
function closeParameterEditModal() { byId('parameterEditModal').hidden = true; parameterEditReturnFocus?.focus(); parameterEditReturnFocus = undefined; }
async function saveParameterEdit() { const form = byId('parameterEditForm'); const { product, serie, period } = form.dataset; const target = Number(byId('parameterEditTarget').value); const workingDay = Number(byId('parameterEditWorkingDay').value); const status = byId('parameterEditStatus'); if (!['NEO', 'SC'].includes(product) || !serie || !/^\d{4}-\d{2}$/.test(period) || !Number.isFinite(target) || target < 0 || !Number.isFinite(workingDay) || workingDay <= 0) { status.className = 'parameter-status'; status.textContent = 'Provide a valid monthly plan and working day.'; return; } const submit = form.querySelector('[type="submit"]'); submit.disabled = true; status.textContent = 'Saving changes...'; try { if (targetStorageRemote) await request('/api/mtd-targets', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ product, serie, period, monthlyPlan: target, workingDay }) }); else { const settings = readTargetSettings(); const existing = settings[product]?.[serie] || {}; writeTargetSettings({ ...settings, [product]: { ...(settings[product] || {}), [serie]: { periods: { ...(existing.periods || {}), [period]: { target, workingDay } } } } }); } if (targetStorageRemote) await loadTargetSettings(); renderSavedParameters(); renderMtd(latestMtdData); byId('parameterStatus').className = 'parameter-status success'; byId('parameterStatus').textContent = target === 0 ? `Parameter saved for ${period}; calculations are disabled.` : `Parameter saved for ${period}.`; closeParameterEditModal(); } catch (error) { status.className = 'parameter-status'; status.textContent = error.message; } finally { submit.disabled = false; } }
byId('savedParameterRows').addEventListener('click', (event) => { const edit = event.target.closest('.edit-parameter'); if (edit) { const { editProduct: product, editSerie: serie, editPeriod: period } = edit.dataset; openParameterEditModal(product, serie, period, edit); return; } const remove = event.target.closest('.remove-parameter'); if (!remove) return; const { removeProduct: product, removeSerie: serie, removePeriod: period } = remove.dataset; removeParameter(product, serie, period).catch((error) => { byId('parameterStatus').className = 'parameter-status'; byId('parameterStatus').textContent = error.message; }); });
byId('parameterForm').addEventListener('submit', (event) => { event.preventDefault(); saveParameter().catch((error) => { byId('parameterStatus').className = 'parameter-status'; byId('parameterStatus').textContent = error.message; }); });
byId('parameterEditForm').addEventListener('submit', (event) => { event.preventDefault(); saveParameterEdit(); });
byId('parameterEditClose').addEventListener('click', closeParameterEditModal);
byId('parameterEditCancel').addEventListener('click', closeParameterEditModal);
byId('parameterEditModal').addEventListener('click', (event) => { if (event.target === byId('parameterEditModal')) closeParameterEditModal(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !byId('parameterEditModal').hidden) closeParameterEditModal(); });
byId('serieTrigger').addEventListener('click', () => { const menu = byId('serieMenu'); menu.hidden = !menu.hidden; byId('serieTrigger').setAttribute('aria-expanded', String(!menu.hidden)); });
document.querySelectorAll('.chart-mode').forEach((button) => button.addEventListener('click', () => { chartMode = button.dataset.chartMode; document.querySelectorAll('.chart-mode').forEach((mode) => { const active = mode === button; mode.classList.toggle('active', active); mode.setAttribute('aria-pressed', String(active)); }); renderChart(latestData, latestChartData); }));
document.querySelectorAll('.ta-yield-table-mode').forEach((button) => button.addEventListener('click', async () => { taYieldTableView = button.dataset.taYieldTable; document.querySelectorAll('.ta-yield-table-mode').forEach((mode) => { const active = mode === button; mode.classList.toggle('active', active); mode.setAttribute('aria-pressed', String(active)); }); if (taYieldTableView === 'lots' && !latestTaYieldData.details.length && latestTaYieldLotsUrl) { const detailUrl = latestTaYieldLotsUrl; const requestId = dataRequestId; byId('taYieldDetailTitle').textContent = 'Loading Excel-style lot detail…'; byId('taYieldHead').innerHTML = ''; byId('taYieldRows').innerHTML = '<tr><td>Loading lot detail…</td></tr>'; try { const details = await request(detailUrl); if (requestId !== dataRequestId || detailUrl !== latestTaYieldLotsUrl || taYieldTableView !== 'lots') return; latestTaYieldData = { ...latestTaYieldData, details }; } catch (error) { if (requestId !== dataRequestId || detailUrl !== latestTaYieldLotsUrl) return; setStatus(error.message); taYieldTableView = 'summary'; } } renderTaYield(latestTaYieldData); }));
byId('taYieldLotSearch').addEventListener('input', () => { taYieldLotSearch = byId('taYieldLotSearch').value; if (taYieldTableView === 'lots') renderTaYield(latestTaYieldData); });
byId('chartFit').addEventListener('click', () => { processChartFit = !processChartFit; const button = byId('chartFit'); button.classList.toggle('active', processChartFit); button.setAttribute('aria-pressed', String(processChartFit)); button.textContent = processChartFit ? 'Readable chart' : 'Fit chart'; renderChart(latestData, latestChartData); });
byId('dailyTargetStatus').checked = true;
byId('parameterTarget').min = '0';
const accumulatedChartMode = document.querySelector('[data-mtd-chart-style="accumulated"]'); if (accumulatedChartMode) { accumulatedChartMode.textContent = 'Cumulative'; accumulatedChartMode.setAttribute('aria-label', 'Cumulative MTD progress by day'); }
document.querySelectorAll('.mtd-chart-mode').forEach((button) => button.addEventListener('click', () => { mtdChartStyle = button.dataset.mtdChartStyle; document.querySelectorAll('.mtd-chart-mode').forEach((mode) => { const active = mode === button; mode.classList.toggle('active', active); mode.setAttribute('aria-pressed', String(active)); }); renderMtd(latestMtdData); }));
byId('expandMtdChart').addEventListener('click', openMtdChartModal);
byId('mtdChartModalClose').addEventListener('click', closeMtdChartModal);
byId('mtdChartModal').addEventListener('click', (event) => { if (event.target === byId('mtdChartModal')) closeMtdChartModal(); });
byId('mtdChartModal').addEventListener('keydown', (event) => { if (event.key !== 'Tab') return; const focusable = [...byId('mtdChartModal').querySelectorAll('button:not([disabled]), [tabindex="0"]')]; const first = focusable[0]; const last = focusable.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } });
byId('mtdSort').addEventListener('change', () => renderMtd(latestMtdData));
byId('scYieldTargetParameters').addEventListener('change', async (event) => { const input = event.target; if (!input.matches('.sc-yield-series-target-input')) return; const serie = input.dataset.scYieldTargetSerie; const month = input.dataset.scYieldTargetMonth; const value = Number(input.value); const next = { ...scYieldTargetSettings, [serie]: { ...(scYieldTargetSettings[serie] || {}) } }; if (input.value === '') delete next[serie][month]; else if (Number.isFinite(value) && value >= 0 && value <= 100) next[serie][month] = value; else { input.setCustomValidity('Enter a target from 0 to 100.'); input.reportValidity(); return; } try { if (scYieldTargetStorageRemote) { if (input.value === '') await request(`/api/sc-yield-targets?${new URLSearchParams({ serie, period: month })}`, { method: 'DELETE' }); else await request('/api/sc-yield-targets', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serie, period: month, target: value }) }); } scYieldTargetSettings = next; if (!scYieldTargetStorageRemote) localStorage.setItem(scYieldTargetSettingsKey, JSON.stringify(next)); renderScYield(); } catch (error) { input.setCustomValidity(error.message); input.reportValidity(); } });
byId('scYieldTargetParameters').addEventListener('click', (event) => { if (event.target.id !== 'scYieldTargetSave') return; const status = byId('scYieldTargetStatus'); status.className = 'parameter-status success'; status.textContent = 'Targets saved to the database.'; });
byId('dailyTargetStatus').addEventListener('change', () => { dailyTargetStatusEnabled = byId('dailyTargetStatus').checked; renderData(latestData, latestChartData, latestMtdData); });
byId('hideInProgressDay').addEventListener('change', () => { hideInProgressDay = byId('hideInProgressDay').checked; renderData(latestData, latestChartData, latestMtdData); });
byId('showZeroSeries').addEventListener('change', () => { showZeroSeries = byId('showZeroSeries').checked; renderData(latestData, latestChartData, latestMtdData); });
document.querySelectorAll('.process-option').forEach((button) => button.addEventListener('click', () => { setSelectedProduct(byId('product').value === button.dataset.product ? '' : button.dataset.product); refreshOptionsForProduct(); requestAnimationFrame(updateReportPendingNotice); }));
byId('processSelect').addEventListener('change', () => { setSelectedProcess(byId('processSelect').value); refreshOptionsForProcess(); });
byId('dataSource').addEventListener('change', initialize);
byId('dataSource').addEventListener('change', () => { const isScYield = selectedDataset() === 'yield'; const isTaYield = selectedDataset() === 'ta-yield'; byId('scYieldLogTab').hidden = !isScYield; byId('taYieldLogTab').hidden = !isTaYield; byId('taYieldMachineTab').hidden = !isTaYield; byId('taDataTableTab').hidden = !isTaYield; const activeView = document.querySelector('.app-tab.active')?.dataset.view; if ((!isScYield && activeView === 'sc-yield-log') || (!isTaYield && ['ta-yield-log', 'ta-yield-machine', 'ta-data-table'].includes(activeView))) showView('dashboard'); });
byId('dataSource').addEventListener('change', () => byId('scYieldArSummary')?.setAttribute('hidden', ''));
byId('pn').addEventListener('focus', () => { pnState.query = byId('pn').value; pnState.loading = false; pnState.error = ''; renderPartNumbers(); byId('pnMenu').hidden = false; byId('pn').setAttribute('aria-expanded', 'true'); });
byId('pn').addEventListener('input', () => { pnState.requestId += 1; clearTimeout(pnSearchTimer); pnSearchTimer = setTimeout(() => loadPartNumbers(true).catch((error) => setStatus(error.message)), 250); });
byId('pn').addEventListener('keydown', (event) => { if (event.key === 'Escape') { byId('pnMenu').hidden = true; byId('pn').setAttribute('aria-expanded', 'false'); } });
byId('pnLoadMore').addEventListener('click', () => loadPartNumbers(false).catch((error) => setStatus(error.message)));
byId('pnSelected').addEventListener('click', (event) => { const remove = event.target.closest('[data-remove-pn]'); if (!remove) return; pnState.selected = selectedPartNumbers().filter((pn) => pn !== remove.dataset.removePn); renderPartNumberSelection(); });
byId('rows').addEventListener('click', (event) => { const cell = event.target.closest('.comment-cell[data-comment-date]'); if (!cell) return; if (!commentsEnabled) { setStatus('Comment storage is unavailable.'); return; } if (!cell.dataset.commentProduct) { setStatus('Select NEO or SC in Product before adding a comment.'); return; } openCellComment({ product: cell.dataset.commentProduct, serie: cell.dataset.commentSerie, pn: cell.dataset.commentPn, process: cell.dataset.commentProcess, reportingDate: cell.dataset.commentDate }, cell); });
byId('commentClose').addEventListener('click', closeCommentPopover);
byId('commentSave').addEventListener('click', () => saveCellComment());
byId('commentDelete').addEventListener('click', () => deleteCellComment());
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeCommentPopover(); });
document.addEventListener('click', (event) => { if (!event.target.closest('.pn-picker')) { byId('pnMenu').hidden = true; byId('pn').setAttribute('aria-expanded', 'false'); } if (!event.target.closest('.serie-picker')) { byId('serieMenu').hidden = true; byId('serieTrigger').setAttribute('aria-expanded', 'false'); } if (!event.target.closest('#cellCommentPopover, .comment-cell')) closeCommentPopover(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMtdChartModal(); });
async function renderTaYieldCalculationLog({ focusTarget = '', selectionStart, selectionEnd } = {}) {
  const holder = ensureTaYieldLogView();
  if (!latestTaYieldLotsUrl || latestTaYieldLotsRequestId !== dataRequestId) { holder.innerHTML = '<p class="sc-yield-empty">Load TA Yield data to see the calculation log.</p>'; return; }
  if (!latestTaYieldData.details.length) {
    holder.innerHTML = '<p class="sc-yield-empty">Loading TA lot calculation evidence…</p>';
    const detailUrl = latestTaYieldLotsUrl;
    const requestId = dataRequestId;
    try {
      const details = await request(detailUrl);
      if (requestId !== dataRequestId || detailUrl !== latestTaYieldLotsUrl || latestTaYieldLotsRequestId !== requestId || document.querySelector('.app-tab.active')?.dataset.view !== 'ta-yield-log') return;
      latestTaYieldData = { ...latestTaYieldData, details };
    } catch (error) {
      if (requestId === dataRequestId && detailUrl === latestTaYieldLotsUrl && document.querySelector('.app-tab.active')?.dataset.view === 'ta-yield-log') holder.innerHTML = `<p class="sc-yield-empty">${escapeHtml(error.message)}</p>`;
      return;
    }
  }
  const period = `${byId('startDate').value || '—'} to ${byId('endDate').value || '—'}`;
  const evidence = latestTaYieldData.details.flatMap((lot) => (lot.modes || []).map((mode) => ({ ...mode, lotNo: lot.lotNo, series: lot.series })));
  const total = evidence.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
  const logSeries = [...new Set(evidence.map((row) => row.series))].sort();
  const logModes = [...new Set(evidence.map((row) => row.mode))].sort();
  const logCategories = [...new Set(evidence.map((row) => row.category))].sort();
  if (!logSeries.includes(taYieldLogSeries)) taYieldLogSeries = '';
  if (!logModes.includes(taYieldLogMode)) taYieldLogMode = '';
  if (!logCategories.includes(taYieldLogCategory)) taYieldLogCategory = '';
  const normalizedLogSearch = taYieldLogSearch.trim().toLowerCase();
  const filteredEvidence = evidence.filter((row) => (!taYieldLogSeries || row.series === taYieldLogSeries) && (!taYieldLogMode || row.mode === taYieldLogMode) && (!taYieldLogCategory || row.category === taYieldLogCategory) && (!normalizedLogSearch || `${row.lotNo} ${row.mode} ${row.category}`.toLowerCase().includes(normalizedLogSearch)));
  const seriesEvidence = [...new Set(filteredEvidence.map((row) => row.series))].sort().map((series) => ({ series, rows: filteredEvidence.filter((row) => row.series === series) }));
  const details = seriesEvidence.map(({ series, rows }) => `<details class="sc-yield-log-detail"><summary>${escapeHtml(series)} — TA mode evidence (${rows.length})</summary><div class="table-wrap"><table><thead><tr><th>Lot No</th><th>Mode</th><th>Defect Yield Category</th><th>Calculation role</th><th>Quantity</th><th>Review</th></tr></thead><tbody>${rows.map((row) => `<tr class="${row.accParameterMatch ? 'ta-yield-acc-match' : row.shAccVoltZero || row.shFallback ? 'ta-yield-sh-fallback' : ''}"><td>${escapeHtml(row.lotNo)}</td><td>${escapeHtml(row.mode)}</td><td>${escapeHtml(row.category)}</td><td>${escapeHtml(row.role || 'Defect')}</td><td>${format.format(row.quantity)}</td><td>${row.accParameterMatch ? '<strong class="ta-yield-acc-flag">ACC — PartType found in ParametersECP_v</strong>' : row.shAccVoltZero ? '<strong class="ta-yield-fallback-flag">SH — acc_volt is 0 in ParametersECP_v</strong>' : row.shFallback ? '<strong class="ta-yield-fallback-flag">SH fallback — PartType not in ParametersECP_v</strong>' : '—'}</td></tr>`).join('')}</tbody></table></div></details>`).join('');
  holder.innerHTML = `<div class="parameter-heading"><p class="section-kicker">TA Yield verification</p><h2 id="taYieldLogTitle">Calculation log</h2><p>Mode and category evidence for the active TA Yield filter (${escapeHtml(period)}).</p></div><div class="sc-yield-log-rules"><article><strong>1. Eligible lots</strong><span>Closed TA lots with the required final-good disposition in the selected period.</span></article><article><strong>2. Input calculation</strong><span>Gross input less exact configured input-deduction modes.</span></article><article><strong>3. Mode mapping</strong><span>Each raw MES DispositionCode is shown with its configured Defect Yield Category.</span></article></div><div class="sc-yield-log-totals"><span>Lots <b>${format.format(latestTaYieldData.details.length)}</b></span><span>Mode quantity <b>${format.format(total)}</b></span><span>Evidence rows <b>${format.format(evidence.length)}</b></span></div><div class="ta-yield-log-filter"><label>Series<select id="taYieldLogSeries" aria-label="TA calculation-log series"></select></label><label>Mode<select id="taYieldLogMode" aria-label="TA calculation-log mode"></select></label><label>Defect Yield Category<select id="taYieldLogCategory" aria-label="TA calculation-log defect yield category"></select></label><label>Search Lot No or Mode<input id="taYieldLogSearch" type="search" placeholder="Example: 1812_SH_PLS or 6G02N01741" autocomplete="off" /></label><span id="taYieldLogCount" role="status" aria-live="polite"></span></div><section class="sc-yield-log-evidence"><h3>TA mode evidence by series</h3><p>Open a series to review only its lots and MES modes.</p>${details || '<p class="sc-yield-empty">No mapped TA mode evidence matches the selected filter.</p>'}</section>`;
  const seriesSelect = byId('taYieldLogSeries'); seriesSelect.replaceChildren(new Option('All series', ''), ...logSeries.map((series) => new Option(series, series))); seriesSelect.value = taYieldLogSeries;
  const modeSelect = byId('taYieldLogMode'); modeSelect.replaceChildren(new Option('All modes', ''), ...logModes.map((mode) => new Option(mode, mode))); modeSelect.value = taYieldLogMode;
  const categorySelect = byId('taYieldLogCategory'); categorySelect.replaceChildren(new Option('All categories', ''), ...logCategories.map((category) => new Option(category, category))); categorySelect.value = taYieldLogCategory;
  const searchInput = byId('taYieldLogSearch'); searchInput.value = taYieldLogSearch;
  byId('taYieldLogCount').textContent = `${filteredEvidence.length} of ${evidence.length} evidence rows`;
  seriesSelect.addEventListener('change', () => { taYieldLogSeries = seriesSelect.value; renderTaYieldCalculationLog({ focusTarget: 'series' }); });
  modeSelect.addEventListener('change', () => { taYieldLogMode = modeSelect.value; renderTaYieldCalculationLog({ focusTarget: 'mode' }); });
  categorySelect.addEventListener('change', () => { taYieldLogCategory = categorySelect.value; renderTaYieldCalculationLog({ focusTarget: 'category' }); });
  searchInput.addEventListener('input', () => { taYieldLogSearch = searchInput.value; renderTaYieldCalculationLog({ focusTarget: 'search', selectionStart: searchInput.selectionStart, selectionEnd: searchInput.selectionEnd }); });
  if (focusTarget === 'search') { searchInput.focus(); searchInput.setSelectionRange(selectionStart ?? searchInput.value.length, selectionEnd ?? searchInput.value.length); }
  if (focusTarget === 'series') seriesSelect.focus();
  if (focusTarget === 'mode') modeSelect.focus();
  if (focusTarget === 'category') categorySelect.focus();
}
function renderScYieldCalculationLog(rows = latestScYieldData) {
  const holder = ensureScYieldLogView();
  const preferredGroups = ['Assembly', 'Appearance', 'CAP', 'LC', 'SD', 'ESR', 'Other'];
  const discoveredGroups = [...new Set(rows.flatMap((row) => (row.groups || []).map((group) => group.group)))];
  const groups = [...preferredGroups.filter((group) => discoveredGroups.includes(group)), ...discoveredGroups.filter((group) => !preferredGroups.includes(group)).sort()];
  const period = `${byId('startDate').value || '—'} to ${byId('endDate').value || '—'}`;
  const auditRows = rows.map((row) => {
    const values = Object.fromEntries((row.groups || []).map((group) => [group.group, group.quantity]));
    const groupedDefect = (row.groups || []).reduce((sum, group) => sum + group.quantity, 0);
    return { ...row, values, groupedDefect, reconciled: groupedDefect === row.defect };
  });
  const totals = auditRows.reduce((sum, row) => ({ input: sum.input + row.input, defect: sum.defect + row.defect, excluded: sum.excluded + row.excluded, unmapped: sum.unmapped + row.unmapped }), { input: 0, defect: 0, excluded: 0, unmapped: 0 });
  const reconciliation = auditRows.every((row) => row.reconciled);
  const summary = auditRows.length ? `<div class="sc-yield-log-status ${reconciliation ? 'pass' : 'warn'}"><strong>${reconciliation ? 'Reconciled' : 'Needs review'}</strong><span>${reconciliation ? 'Visible mode groups equal Defective for every displayed row.' : 'At least one row does not reconcile.'}</span></div>` : '<p class="sc-yield-empty">Load SC Yield data to see the calculation log.</p>';
  const rowsHtml = auditRows.map((row) => `<tr><td>${escapeHtml(row.month)}</td><td>${escapeHtml(row.line)}</td><td>${format.format(row.input)}</td>${groups.map((group) => `<td>${format.format(row.values[group] || 0)}</td>`).join('')}<td>${format.format(row.defect)}</td><td>${format.format(row.excluded)}</td><td>${format.format(row.unmapped)}</td><td>${row.reconciled ? 'Pass' : 'Check'}</td></tr>`).join('');
  const details = auditRows.map((row) => `<details class="sc-yield-log-detail"><summary>${escapeHtml(row.month)} · ${escapeHtml(row.line)} — included Sheet1 modes (${(row.modes || []).length})</summary><div class="table-wrap"><table><thead><tr><th>Mode</th><th>Group</th><th>Quantity</th><th>Rate</th></tr></thead><tbody>${(row.modes || []).map((mode) => `<tr><td>${escapeHtml(mode.mode)}</td><td>${escapeHtml(mode.group)}</td><td>${format.format(mode.quantity)}</td><td>${Number.isFinite(mode.rate) ? `${mode.rate.toFixed(3)}%` : '—'}</td></tr>`).join('')}</tbody></table></div></details>`).join('');
  holder.innerHTML = `<div class="parameter-heading"><p class="section-kicker">SC Yield verification</p><h2 id="scYieldLogTitle">Calculation log</h2><p>Audit the calculation behind the current SC Yield result. This page uses the active date range and series filter; it shows aggregate evidence only, not individual jobs.</p></div><div class="sc-yield-log-rules"><article><strong>1. Eligible input</strong><span>SUM(Closed Batch GrossQty) where Product = SC, Category = FG, and CloseDate is inside ${escapeHtml(period)}.</span></article><article><strong>2. Included defects</strong><span>SUM(Complete Action QuantityMoved) for SCRAP actions linked to those eligible jobs.</span></article><article><strong>3. Mode mapping</strong><span>Only Sheet1 modes with Calculate Yield = Y are included and grouped by their configured mode group.</span></article></div>${summary}<div class="sc-yield-log-totals"><span>InputQ <b>${format.format(totals.input)}</b></span><span>Included Defective <b>${format.format(totals.defect)}</b></span><span>Excluded (N) <b>${format.format(totals.excluded)}</b></span><span>Unmapped <b>${format.format(totals.unmapped)}</b></span></div><div class="table-wrap"><table><thead><tr><th>Month</th><th>Series</th><th>InputQ</th>${groups.map((group) => `<th>${escapeHtml(group)}</th>`).join('')}<th>Defective</th><th>Excluded</th><th>Unmapped</th><th>Check</th></tr></thead><tbody>${rowsHtml || `<tr><td colspan="${groups.length + 7}">No SC Yield rows match the active filters.</td></tr>`}</tbody></table></div><section class="sc-yield-log-evidence"><h3>Included mode evidence</h3><p></p>${details}</section>`;
}

byId('savedParameterRows').addEventListener('click', async (event) => {
  const button = event.target.closest('.save-parameter-template');
  if (!button) return;
  const row = button.closest('tr');
  const target = Number(row.querySelector('[data-template-target]').value);
  const workingDay = Number(row.querySelector('[data-template-working-day]').value);
  if (!Number.isFinite(target) || target < 0 || !Number.isFinite(workingDay) || workingDay <= 0) { byId('parameterStatus').className = 'parameter-status'; byId('parameterStatus').textContent = 'Enter a valid monthly plan and working day before saving.'; return; }
  button.disabled = true;
  try {
    const { templateProduct: product, templateSerie: serie, templatePeriod: period } = button.dataset;
    if (targetStorageRemote) await request('/api/mtd-targets', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ product, serie, period, monthlyPlan: target, workingDay }) });
    else { const settings = readTargetSettings(); const existing = settings[product]?.[serie] || {}; writeTargetSettings({ ...settings, [product]: { ...(settings[product] || {}), [serie]: { periods: { ...(existing.periods || {}), [period]: { target, workingDay } } } } }); }
    if (targetStorageRemote) await loadTargetSettings();
    byId('parameterStatus').className = 'parameter-status success'; byId('parameterStatus').textContent = `${serie} parameter saved for ${period}.`; renderSavedParameters(); renderMtd(latestMtdData);
  } catch (error) { byId('parameterStatus').className = 'parameter-status'; byId('parameterStatus').textContent = error.message; } finally { button.disabled = false; }
});

async function drawDefectMappingGraph(studio) { if (window.innerWidth <= 900) return; try { const data = studio._defectMappingData || await request('/api/defect-settings'); studio._defectMappingData = data; const isSc = currentConfig.dataset === 'yield'; const sourceToGroup = new Map((isSc ? data.sc.map((item) => [item.mode, item.group]) : data.ta.map((item) => [item.source, item.target]))); const draw = () => { studio.querySelector('.defect-mapping-graph')?.remove(); const bounds = studio.getBoundingClientRect(); const list = studio.querySelector('.defect-rule-list'); const listBounds = list.getBoundingClientRect(); const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.classList.add('defect-mapping-graph'); svg.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`); svg.setAttribute('aria-hidden', 'true'); studio.querySelectorAll('.defect-rule-row').forEach((source) => { const left = source.getBoundingClientRect(); if (source.hidden || left.bottom < listBounds.top || left.top > listBounds.bottom) return; const group = sourceToGroup.get(source.dataset.defectMode); const target = [...studio.querySelectorAll('.defect-group-node')].find((node) => node.dataset.defectGroup === group); if (!target) return; const right = target.getBoundingClientRect(); const startX = left.right - bounds.left; const startY = left.top - bounds.top + left.height / 2; const endX = right.left - bounds.left; const endY = right.top - bounds.top + right.height / 2; const bend = (endX - startX) * .35; const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`); path.dataset.defectMode = source.dataset.defectMode; path.classList.add('defect-mapping-link'); path.classList.toggle('selected', source.classList.contains('active') || source.classList.contains('group-selected')); svg.append(path); }); studio.prepend(svg); }; draw(); const list = studio.querySelector('.defect-rule-list'); if (!list.dataset.mappingGraphListener) { let frame; list.addEventListener('scroll', () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(draw); }, { passive: true }); list.dataset.mappingGraphListener = 'true'; } } catch { studio.dataset.graphReady = ''; } }
document.addEventListener('click', async (event) => { const source = event.target.closest('.defect-rule-row'); const groupNode = event.target.closest('.defect-group-node'); if (!source && !groupNode) return; const studio = (source || groupNode).closest('.defect-studio'); const sourceRows = [...studio.querySelectorAll('.defect-rule-row')]; studio.classList.add('mapping-selection-active'); if (source) { studio.querySelectorAll('.defect-mapping-link').forEach((line) => line.classList.toggle('selected', line.dataset.defectMode === source.dataset.defectMode)); studio.querySelectorAll('.defect-rule-row').forEach((row) => row.classList.remove('group-selected')); studio.querySelectorAll('.defect-group-node').forEach((node) => node.classList.remove('active')); return; } const group = groupNode.dataset.defectGroup; const data = studio._defectMappingData || await request('/api/defect-settings'); studio._defectMappingData = data; const maps = currentConfig.dataset === 'yield' ? data.sc.map((item) => ({ mode: item.mode, group: item.group })) : data.ta.map((item) => ({ mode: item.source, group: item.target })); const matches = sourceRows.map((row) => ({ row, map: maps.find((item) => item.mode === row.dataset.defectMode) })).filter((item) => item.map?.group === group); studio.querySelectorAll('.defect-group-node').forEach((node) => node.classList.toggle('active', node === groupNode)); sourceRows.forEach((row) => row.classList.toggle('group-selected', matches.some((item) => item.row === row))); studio.querySelectorAll('.defect-mapping-link').forEach((line) => line.classList.toggle('selected', matches.some((item) => item.row.dataset.defectMode === line.dataset.defectMode))); });
const defectGraphObserver = new MutationObserver(() => { const studio = document.querySelector('.defect-studio'); if (studio && !studio.querySelector('.defect-mapping-graph')) drawDefectMappingGraph(studio); });
defectGraphObserver.observe(document.body, { childList: true, subtree: true });
window.addEventListener('resize', () => { document.querySelectorAll('.defect-mapping-graph').forEach((graph) => graph.remove()); document.querySelectorAll('.defect-studio').forEach((studio) => { studio.dataset.graphReady = ''; drawDefectMappingGraph(studio); }); });
function updateYieldUtilityTabs() { const isYield = ['yield', 'ta-yield'].includes(selectedDataset()); byId('defectSettingsTab').hidden = !isYield; byId('stagingStatusTab').hidden = false; const activeView = document.querySelector('.app-tab.active')?.dataset.view; if (!isYield && activeView === 'defects') showView('dashboard'); }
byId('dataSource').addEventListener('change', updateYieldUtilityTabs);
updateYieldUtilityTabs();

let taYieldMachineLineRows = [];
let taYieldMachineTotalMachines = 0;
let taYieldMachineRows = [];
let taYieldMachineSelectedMachines = new Set();
let taYieldMachineSelectionScope = '';
function machineDateLines(rows, order = 'machine-date') {
  taYieldMachineLineRows = rows;
  const pointsByKey = new Map();
  rows.forEach((row) => {
    const key = `${row.date}|${row.machineName}`;
    const current = pointsByKey.get(key) || { date: row.date, machineName: row.machineName, quantity: 0 };
    pointsByKey.set(key, { ...current, quantity: current.quantity + Number(row.quantity || 0) });
  });
  const orderKey = order === 'machine-date'
    ? (row) => `${row.machineName}|${row.date}`
    : (row) => `${row.date}|${row.machineName}`;
  const points = [...pointsByKey.values()].sort((left, right) => orderKey(left).localeCompare(orderKey(right)));
  const totalQuantity = points.reduce((sum, row) => sum + row.quantity, 0);
  const share = (quantity) => totalQuantity ? quantity / totalQuantity * 100 : 0;
  const maximum = Math.max(...points.map((row) => share(row.quantity)), 1);
  const machines = [...new Set(points.map((row) => row.machineName))].sort();
  const totalMachines = Math.max(machines.length, Number(taYieldMachineTotalMachines) || 0);
  const colors = ['#5b17bd', '#ef5b25', '#008b6d', '#1686c3', '#c58100', '#c03b8f', '#3046a4', '#5e8b1c'];
  const colorFor = (machine) => colors[machines.indexOf(machine) % colors.length];
  const width = 1440;
  const height = 440;
  const left = 58;
  const right = 24;
  const top = 20;
  const bottom = 170;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const x = (index) => left + (points.length > 1 ? index * plotWidth / (points.length - 1) : plotWidth / 2);
  const y = (value) => top + plotHeight - value / maximum * plotHeight;
  const ticks = [0, .25, .5, .75, 1];
  const groupProperty = order === 'machine-date' ? 'machineName' : 'date';
  const groupStarts = points.map((point, index) => ({ point, index })).filter(({ point, index }) => index === 0 || point[groupProperty] !== points[index - 1][groupProperty]);
  const groupStep = Math.max(1, Math.ceil(groupStarts.length / 12));
  const visibleGroupStarts = groupStarts.filter((_, index) => index % groupStep === 0 || index === groupStarts.length - 1);
  const labelStarts = order === 'machine-date' ? groupStarts : visibleGroupStarts;
  const dividers = visibleGroupStarts.slice(1).map(({ index }) => `<line x1="${(x(index - 1) + x(index)) / 2}" y1="${top}" x2="${(x(index - 1) + x(index)) / 2}" y2="${height - 130}" class="ta-machine-group-divider"/>`).join('');
  const grid = ticks.map((tick) => `<g><line x1="${left}" y1="${y(maximum * tick)}" x2="${width - right}" y2="${y(maximum * tick)}" class="ta-machine-grid"/><text x="${left - 9}" y="${y(maximum * tick) + 4}" text-anchor="end">${(maximum * tick).toFixed(1)}%</text></g>`).join('') + dividers;
  const lines = machines.map((machine) => {
    const machinePoints = points.map((point, index) => ({ ...point, index })).filter((point) => point.machineName === machine);
    const line = machinePoints.map((point) => `${x(point.index)},${y(share(point.quantity))}`).join(' ');
    return `<g class="ta-machine-line-series"><polyline points="${line}" stroke="${colorFor(machine)}"/><g>${machinePoints.map((point) => `<circle cx="${x(point.index)}" cy="${y(share(point.quantity))}" r="3" fill="${colorFor(machine)}"><title>${escapeHtml(`${point.date} · ${machine} · ${share(point.quantity).toFixed(1)}% · ${format.format(point.quantity)} defects`)}</title></circle>`).join('')}</g></g>`;
  }).join('');
  const groupLabel = (point) => order === 'machine-date' ? point.machineName : point.date.slice(5);
  const labels = labelStarts.map(({ point, index }) => order === 'machine-date'
    ? `<text x="${x(index)}" y="${height - 16}" text-anchor="start" transform="rotate(-90 ${x(index)} ${height - 16})" class="ta-machine-date-label ta-machine-vertical-label">${escapeHtml(groupLabel(point))}</text>`
    : `<text x="${x(index)}" y="${height - 142}" text-anchor="middle" class="ta-machine-date-label">${escapeHtml(groupLabel(point))}</text>`).join('');
  const orderLabel = order === 'machine-date' ? 'Machine → Date' : 'Date → Machine';
  return `<header class="ta-machine-chart-heading"><div class="ta-machine-identity"><span class="ta-machine-icon" aria-hidden="true">M</span><div><p>Machine trend</p><h3>${format.format(machines.length)} matching machines</h3><small>${format.format(machines.length)} of ${format.format(totalMachines)} process machines have the selected defect · Defect share (%) · ${orderLabel}</small></div></div><div class="ta-machine-chart-summary"><label class="ta-machine-order">Order<select class="ta-machine-line-order" aria-label="Chart order"><option value="date-machine"${order === 'date-machine' ? ' selected' : ''}>Date → Machine</option><option value="machine-date"${order === 'machine-date' ? ' selected' : ''}>Machine → Date</option></select></label><span><b>${format.format(totalQuantity)}</b> total defects</span></div></header><div class="ta-machine-line-scroll"><svg class="ta-machine-line-chart ta-machine-date-machine-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="TA Yield machine defect-share trend">${grid}${lines}${labels}</svg></div>`;
}
machineDateBars = machineDateLines;
document.addEventListener('change', (event) => {
  if (!event.target.matches('.ta-machine-line-order')) return;
  const chart = event.target.closest('#taMachineChart');
  if (chart && taYieldMachineLineRows.length) { chart.innerHTML = machineDateLines(taYieldMachineLineRows, event.target.value); renderTaMachineGroupByControl(); }
});
function hideMachinePointTooltip(point) { point?.closest('.ta-machine-line-scroll')?.querySelector('.ta-machine-point-tooltip')?.remove(); }
function showMachinePointTooltip(point, clientX, clientY) { const scroll = point.closest('.ta-machine-line-scroll'); const value = point.querySelector('title')?.textContent; if (!scroll || !value) return; hideMachinePointTooltip(point); const tooltip = document.createElement('div'); tooltip.className = 'ta-machine-point-tooltip'; tooltip.setAttribute('role', 'tooltip'); tooltip.textContent = value; const bounds = scroll.getBoundingClientRect(); const rawLeft = Math.max(8, clientX - bounds.left + scroll.scrollLeft + 12); const rawTop = Math.max(8, clientY - bounds.top + scroll.scrollTop + 12); scroll.append(tooltip); tooltip.style.left = `${Math.min(rawLeft, Math.max(8, scroll.clientWidth + scroll.scrollLeft - tooltip.offsetWidth - 8))}px`; tooltip.style.top = `${Math.min(rawTop, Math.max(8, scroll.clientHeight + scroll.scrollTop - tooltip.offsetHeight - 8))}px`; }
document.addEventListener('pointerover', (event) => { const point = event.target.closest('.ta-machine-date-machine-chart circle'); if (point) showMachinePointTooltip(point, event.clientX, event.clientY); });
document.addEventListener('pointerout', (event) => { const point = event.target.closest('.ta-machine-date-machine-chart circle'); if (point && !point.contains(event.relatedTarget)) hideMachinePointTooltip(point); });
document.addEventListener('focusin', (event) => { const point = event.target.closest('.ta-machine-date-machine-chart circle'); if (point) { const bounds = point.getBoundingClientRect(); showMachinePointTooltip(point, bounds.left + bounds.width / 2, bounds.top + bounds.height / 2); } });
document.addEventListener('focusout', (event) => { const point = event.target.closest('.ta-machine-date-machine-chart circle'); if (point) hideMachinePointTooltip(point); });
const enableMachinePointTooltips = () => document.querySelectorAll('.ta-machine-date-machine-chart circle').forEach((point) => { point.tabIndex = 0; point.setAttribute('aria-label', point.querySelector('title')?.textContent || 'Machine chart point'); });
new MutationObserver(enableMachinePointTooltips).observe(document.body, { childList: true, subtree: true });
enableMachinePointTooltips();

function renderTaYieldMultiSeriesChart(rows, buckets, targetsByBucket, label, isTotal, targetLabel) {
  const lines = [...new Set(rows.map((row) => row.line))].sort();
  const series = lines.map((line) => ({ name: shortTaSeries(line), color: chartColors[lines.indexOf(line) % chartColors.length], values: buckets.map((bucket) => { const matches = rows.filter((row) => row.line === line && row.month === bucket.month); const input = matches.reduce((sum, row) => sum + Number(row.input || 0), 0); return input ? matches.reduce((sum, row) => sum + Number(row.finalGood || 0), 0) / input * 100 : undefined; }) }));
  const values = [...buckets.map((row) => row.yield), ...targetsByBucket.values(), ...series.flatMap((row) => row.values)].filter(Number.isFinite);
  const min = Math.max(0, Math.floor((Math.min(...values) - .5) * 2) / 2); const max = Math.min(100, Math.ceil((Math.max(...values) + .5) * 2) / 2);
  const width = Math.max(760, buckets.length * 86 + 100); const height = 270; const left = 52; const right = 52; const top = 30; const base = 218;
  const x = (index) => left + index * (width - left - right) / Math.max(1, buckets.length - 1);
  const y = (value) => base - (value - min) / Math.max(.1, max - min) * (base - top);
  const polyline = (lineValues) => lineValues.map((value, index) => Number.isFinite(value) ? `${x(index)},${y(value)}` : '').filter(Boolean).join(' ');
  const marks = (lineValues, color, name, radius = 3) => lineValues.map((value, index) => { if (!Number.isFinite(value)) return ''; const detail = `${buckets[index].month} | ${name}: ${value.toFixed(2)}%`; return `<circle class="ta-yield-line-point" cx="${x(index)}" cy="${y(value)}" r="${radius}" fill="${color}" tabindex="0" aria-label="${escapeHtml(detail)}"><title>${escapeHtml(detail)}</title></circle>`; }).join('');
  const total = buckets.map((row) => row.yield); const target = buckets.map((row) => targetsByBucket.get(row.month));
  const grid = [0, .5, 1].map((ratio) => { const value = min + (max - min) * ratio; const position = y(value); return `<line class="gridline" x1="${left}" y1="${position}" x2="${width - right}" y2="${position}"/><text class="axis" x="${left - 7}" y="${position + 4}" text-anchor="end">${value.toFixed(1)}%</text>`; }).join('');
  const regularPlot = series.map((row) => `<polyline points="${polyline(row.values)}" fill="none" stroke="${row.color}" stroke-width="2" opacity=".45"/>${marks(row.values, row.color, row.name, 2.5)}`).join('');
  const totalPlot = isTotal ? `<polyline class="ta-yield-total-line" points="${polyline(total)}" fill="none" stroke="#5b17bd" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>${marks(total, '#5b17bd', 'Total Yield', 5)}` : '';
  const targetPlot = target.some(Number.isFinite) ? `<polyline points="${polyline(target)}" fill="none" stroke="#ffffff" stroke-width="9"/><polyline class="ta-yield-total-target-line" points="${polyline(target)}" fill="none" stroke="#f15a24" stroke-width="4" stroke-dasharray="9 5"/>${marks(target, '#f15a24', targetLabel, 4)}` : '';
  const targetLegend = target.some(Number.isFinite) ? `<span class="ta-yield-priority-legend"><i class="ta-yield-total-target-key"></i>${escapeHtml(targetLabel)}</span>` : '';
  const seriesLegend = series.map((row) => `<span><i style="background:${row.color}"></i>${escapeHtml(row.name)}</span>`).join('');
  const totalLegend = isTotal ? '<span class="ta-yield-priority-legend"><i class="ta-yield-total-key"></i>Total Yield</span>' : '';
  const legend = `${totalLegend}${targetLegend}${seriesLegend}`;
  byId('taYieldYieldChart').innerHTML = `<div class="sc-yield-legend">${legend}</div><div class="sc-yield-chart-scroll"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="TA yield by series${isTotal ? ', total yield, and total target' : ''}">${grid}${regularPlot}${totalPlot}${targetPlot}${buckets.map((row, index) => `<text class="axis" x="${x(index)}" y="${base + 22}" text-anchor="middle">${escapeHtml(label(row.month))}</text>`).join('')}</svg></div>`;
}

function scrollTaYieldTendencyToLatest() {
  document.querySelectorAll('#taYieldYieldChart .sc-yield-chart-scroll, #taYieldDefectChart .sc-yield-chart-scroll').forEach((viewport) => {
    viewport.scrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
  });
}
const alignTaYieldTrendCharts = () => document.querySelectorAll('#taYieldYieldChart svg, #taYieldDefectChart svg').forEach((chart) => { const width = Number(chart.getAttribute('viewBox')?.split(/\s+/)[2]); chart.setAttribute('preserveAspectRatio', 'xMinYMid meet'); if (Number.isFinite(width) && width > 0) { chart.style.width = `clamp(${width}px, 100%, 1280px)`; chart.style.minWidth = `${width}px`; chart.style.maxWidth = 'none'; chart.style.marginInline = 'auto'; } });
new MutationObserver(alignTaYieldTrendCharts).observe(byId('taYieldChart'), { childList: true, subtree: true });
function renderTaMachineGroupByControl() {
  const summary = byId('taMachineChart')?.querySelector('.ta-machine-chart-summary');
  if (!summary || byId('taMachineGroupBy')) return;
  const label = document.createElement('label');
  label.className = 'ta-machine-order';
  label.innerHTML = 'Group by<select id="taMachineGroupBy" aria-label="Chart grouping"><option value="day">Day</option><option value="week">Week</option><option value="month">Month</option></select>';
  summary.prepend(label);
  const groupSelect = byId('taMachineGroupBy');
  groupSelect.value = taYieldMachineGroupBy;
  groupSelect.addEventListener('change', () => {
    taYieldMachineGroupBy = groupSelect.value;
    taYieldMachineState = { ...taYieldMachineState, groupBy: groupSelect.value };
    byId('taMachineApply')?.click();
  });
}
function renderTaMachineSelectionControl() {
  const summary = byId('taMachineChart')?.querySelector('.ta-machine-chart-summary');
  if (!summary || !taYieldMachineRows.length || byId('taMachineSelection')) return;
  const machines = [...new Set(taYieldMachineRows.map((row) => row.machineName).filter(Boolean))].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  if (!machines.length) return;
  const selectedCount = taYieldMachineSelectedMachines.size;
  const picker = document.createElement('details');
  picker.id = 'taMachineSelection';
  picker.className = 'ta-machine-picker';
  picker.innerHTML = `<summary class="ta-machine-picker-trigger"><span>Machine</span><b>${selectedCount ? `${selectedCount} selected` : 'All machines'}</b></summary><div class="ta-machine-picker-menu" role="group" aria-label="Filter displayed machines"><div class="ta-machine-picker-options">${machines.map((machine) => `<label><input type="checkbox" data-ta-machine-option value="${escapeHtml(machine)}"${taYieldMachineSelectedMachines.has(machine) ? ' checked' : ''} />${escapeHtml(machine)}</label>`).join('')}</div><div class="ta-machine-picker-actions"><button type="button" data-ta-machine-apply>Apply</button><button type="button" data-ta-machine-clear>All machines</button></div></div>`;
  summary.prepend(picker);
  picker.querySelector('[data-ta-machine-apply]').addEventListener('click', () => {
    taYieldMachineSelectedMachines = new Set([...picker.querySelectorAll('[data-ta-machine-option]:checked')].map((option) => option.value));
    const rows = taYieldMachineRows.filter((row) => !taYieldMachineSelectedMachines.size || taYieldMachineSelectedMachines.has(row.machineName));
    byId('taMachineChart').innerHTML = machineDateBars(rows);
    renderTaMachineGroupByControl();
    renderTaMachineSelectionControl();
  });
  picker.querySelector('[data-ta-machine-clear]').addEventListener('click', () => {
    taYieldMachineSelectedMachines = new Set();
    const rows = taYieldMachineRows.filter((row) => !taYieldMachineSelectedMachines.size || taYieldMachineSelectedMachines.has(row.machineName));
    byId('taMachineChart').innerHTML = machineDateBars(rows);
    renderTaMachineGroupByControl();
    renderTaMachineSelectionControl();
  });
}
const renderTaYieldMachineViewBase = renderTaYieldMachineView;
let taYieldMachineGroupBy = taYieldMachineState.groupBy || 'day';
renderTaYieldMachineView = async function renderTaYieldMachineViewWithGrouping() {
  await renderTaYieldMachineViewBase();
  const previousApply = byId('taMachineApply');
  const apply = previousApply.cloneNode(true);
  previousApply.replaceWith(apply);
  apply.addEventListener('click', async () => {
    const selectedProcess = byId('taMachineProcess').value;
    const selectedSerie = byId('taMachineSerie').value;
    const selectedPartNumber = byId('taMachinePartNumber').value;
    const selectedMachine = '__ALL__';
    const selectedGroupBy = taYieldMachineGroupBy;
    const [selectedDefectType, selectedDefect] = byId('taMachineDefect').value.split('|');
    taYieldMachineGroupBy = selectedGroupBy;
    const selectionScope = [byId('taMachineStartDate').value, byId('taMachineEndDate').value, selectedProcess, selectedSerie, selectedPartNumber, selectedDefectType, selectedDefect].join('|');
    if (taYieldMachineSelectionScope !== selectionScope) taYieldMachineSelectedMachines = new Set();
    taYieldMachineSelectionScope = selectionScope;
    taYieldMachineState = { process: selectedProcess, serie: selectedSerie, pn: selectedPartNumber, machine: selectedMachine, defectType: selectedDefectType || '', defect: selectedDefect || '', groupBy: selectedGroupBy };
    if (!selectedProcess || !selectedDefect) { byId('taMachineChart').innerHTML = '<p class="sc-yield-empty">Select a process and defect view before analyzing.</p>'; return; }
    const submittedSnapshot = taYieldMachineControlSnapshot();
    apply.disabled = true; apply.textContent = 'Loading…';
    byId('taMachineChart').innerHTML = '<p class="sc-yield-empty">Loading Machine analysis…</p>';
    const params = new URLSearchParams({ dataset: 'ta-yield', startDate: byId('taMachineStartDate').value, endDate: byId('taMachineEndDate').value, process: selectedProcess, machine: selectedMachine, defectType: selectedDefectType, defect: selectedDefect, groupBy: selectedGroupBy });
    if (selectedSerie) params.set('serie', selectedSerie);
    if (selectedPartNumber) params.set('pn', selectedPartNumber);
    try {
      const data = await request(`/api/ta-yield-machine?${params}`);
      taYieldMachineTotalMachines = Number(data.totalMachines) || 0;
      taYieldMachineRows = [...data.rows];
      byId('taMachineLink').textContent = selectedDefectType === 'category' ? `Linked disposition codes: ${data.linkedModes.join(', ') || 'None'}` : '';
      const visibleRows = taYieldMachineRows.filter((row) => !taYieldMachineSelectedMachines.size || taYieldMachineSelectedMachines.has(row.machineName));
      byId('taMachineChart').innerHTML = visibleRows.length ? machineDateBars(visibleRows) : '<p class="sc-yield-empty">No matching TA Yield defects were found for the selected machines.</p>';
      if (visibleRows.length) { renderTaMachineGroupByControl(); renderTaMachineSelectionControl(); }
      markTaYieldMachineControlsApplied(submittedSnapshot);
    } catch (error) { byId('taMachineChart').innerHTML = `<p class="sc-yield-empty">${escapeHtml(error.message)}</p>`; } finally { apply.disabled = false; apply.textContent = 'Analyze all machines'; }
  });
};

initialize();
