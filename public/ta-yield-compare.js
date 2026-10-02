/* TA yield comparison uses the date range selected in dashboard Report controls. */
function taYieldCompareMonths(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit' }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === 'year').value);
  const month = Number(parts.find((part) => part.type === 'month').value);
  return { current: `${year}-${String(month).padStart(2, '0')}`, previous: `${month === 1 ? year - 1 : year}-${String(month === 1 ? 12 : month - 1).padStart(2, '0')}` };
}

function taYieldCompareToday() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return ['year', 'month', 'day'].map((type) => parts.find((part) => part.type === type).value).join('-');
}

function taYieldCompareScale(values) {
  const finite = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  const low = Math.min(0, ...finite);
  const high = Math.max(0, ...finite);
  if (low === 0 && high === 0) return { min: -1, max: 1, step: 0.5 };
  const raw = (high - low) / 6;
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  const step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
  return { min: Math.min(-step, Math.floor(low / step) * step), max: Math.max(step, Math.ceil(high / step) * step), step };
}

function taYieldCompareNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function taYieldCompareValue(value, unit = '') {
  const number = taYieldCompareNumber(value);
  return number === null ? 'N/A' : `${number < 0 ? `(${Math.abs(number).toFixed(2)})` : number.toFixed(2)}${unit}`;
}

function taYieldCompareQuantity(value) {
  const number = taYieldCompareNumber(value);
  return number === null ? 'N/A' : (number / 1000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function taYieldLookupLabel(group) {
  const label = String(group);
  return label.length > 24 ? `${label.slice(0, 23)}…` : label;
}

function taYieldLookupPeriod(range, fallback = 'Dates unavailable') {
  const parse = (value) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const date = new Date(`${value}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
    return { day: date.getUTCDate(), month: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getUTCMonth()], year: date.getUTCFullYear() };
  };
  const start = parse(range?.startDate);
  const end = parse(range?.endDate);
  if (!start || !end || range.startDate > range.endDate) return fallback;
  const endLabel = `${end.day} ${end.month} ${end.year}`;
  if (range.startDate === range.endDate) return endLabel;
  if (start.year !== end.year) return `${start.day} ${start.month} ${start.year}–${endLabel}`;
  if (start.month !== end.month) return `${start.day} ${start.month}–${endLabel}`;
  return `${start.day}–${endLabel}`;
}

function taYieldComparePeriods(data = {}) {
  return { current: taYieldLookupPeriod(data.currentRange, 'Report dates unavailable'), compare: taYieldLookupPeriod(data.compareRange, 'Compare dates unavailable') };
}

function taYieldLookupAxis(min, max, height, unit, plotWidth = 420) {
  const precision = Math.max(2, Math.min(12, Math.ceil(-Math.log10((max - min) / 4))));
  return Array.from({ length: 5 }, (_, index) => {
    const value = min + (max - min) * index / 4;
    const x = 190 + index * plotWidth / 4;
    const label = value < 0 ? `(${Math.abs(value).toFixed(precision)})` : value.toFixed(precision);
    return `<line class="ta-compare-grid" x1="${x}" x2="${x}" y1="20" y2="${height - 32}"/><text class="ta-compare-tick" x="${x}" y="${height - 12}" text-anchor="middle">${label}${unit}</text>`;
  }).join('');
}

function taYieldLookupRateGraph(groups, escapeHtml, periods = taYieldComparePeriods(), availableWidth = 760) {
  const width = Math.max(620, Number.isFinite(availableWidth) ? Math.floor(availableWidth) : 760);
  const plotWidth = width - 340;
  const rates = groups.flatMap((row) => [row.currentRate, row.compareRate]).filter((rate) => taYieldCompareNumber(rate) !== null);
  const min = Math.min(0, ...rates);
  const max = Math.max(0, ...rates) || (min === 0 ? 1 : 0);
  const x = (rate) => 190 + (rate - min) / (max - min) * plotWidth;
  const zero = x(0);
  const height = groups.length * 52 + 54;
  const rows = groups.map((row, index) => {
    const y = 24 + index * 52;
    const label = escapeHtml(row.group);
    const bars = [['current', row.currentRate, '#28358c'], ['compare', row.compareRate, '#007c91']].map(([period, value, color], side) => {
      const rate = taYieldCompareNumber(value);
      const barY = y + side * 18;
      const mark = rate === null ? '' : rate === 0
        ? `<line x1="${zero}" x2="${zero}" y1="${barY}" y2="${barY + 12}" stroke="${color}" stroke-width="3"/>`
        : `<rect data-period="${period}" data-rate="${rate}" x="${Math.min(zero, x(rate))}" y="${barY}" width="${Math.abs(x(rate) - zero)}" height="12" fill="${color}"/>`;
      return `${mark}<text class="ta-lookup-chart-value" data-period="${period}" x="${width - 16}" y="${barY + 11}" text-anchor="end">${taYieldCompareValue(rate, '%')}</text>`;
    }).join('');
    return `<g data-lookup-group="${label}"><title>${label}: Report dates ${escapeHtml(periods.current)} ${taYieldCompareValue(row.currentRate, '%')}; Compare with ${escapeHtml(periods.compare)} ${taYieldCompareValue(row.compareRate, '%')}</title><text class="ta-compare-label" x="178" y="${y + 22}" text-anchor="end">${escapeHtml(taYieldLookupLabel(row.group))}</text>${bars}</g>`;
  }).join('');
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Defect rates by group, percent: Report dates ${escapeHtml(periods.current)}; Compare with ${escapeHtml(periods.compare)}"><title>Defect rates by group: both periods use one shared scale</title>${taYieldLookupAxis(min, max, height, '%', plotWidth)}<line class="ta-compare-zero" x1="${zero}" x2="${zero}" y1="20" y2="${height - 32}"/>${rows}</svg>`;
}

function taYieldLookupChangeGraph(groups, escapeHtml, periods = taYieldComparePeriods(), availableWidth = 760) {
  const width = Math.max(620, Number.isFinite(availableWidth) ? Math.floor(availableWidth) : 760);
  const plotWidth = width - 340;
  const extent = Math.max(0, ...groups.map((row) => Math.abs(taYieldCompareNumber(row.deltaRate) || 0))) || 1;
  const height = groups.length * 38 + 54;
  const zero = 190 + plotWidth / 2;
  const rows = groups.map((row, index) => {
    const y = 24 + index * 38;
    const delta = taYieldCompareNumber(row.deltaRate);
    const direction = delta === null ? 'N/A' : delta > 0 ? 'Increased defects' : delta < 0 ? 'Decreased defects' : 'No change';
    const color = delta > 0 ? '#d32f2f' : delta < 0 ? '#008a3e' : '#68758d';
    const end = zero + (delta || 0) / extent * plotWidth / 2;
    const mark = delta === null ? '' : delta === 0
      ? `<line x1="${zero}" x2="${zero}" y1="${y}" y2="${y + 16}" stroke="${color}" stroke-width="3"/>`
      : `<rect x="${Math.min(zero, end)}" y="${y}" width="${Math.abs(end - zero)}" height="16" fill="${color}"/>`;
    const label = escapeHtml(row.group);
    return `<g data-lookup-group="${label}"><title>${label}: ${taYieldCompareValue(delta, ' pp')}; ${direction}</title><text class="ta-compare-label" x="178" y="${y + 13}" text-anchor="end">${escapeHtml(taYieldLookupLabel(row.group))}</text>${mark}<text class="ta-lookup-chart-value" x="${width - 16}" y="${y + 13}" text-anchor="end">${delta > 0 ? '+' : ''}${taYieldCompareValue(delta, ' pp')}</text></g>`;
  }).join('');
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Defect-rate change in percentage points: ${escapeHtml(periods.current)} minus ${escapeHtml(periods.compare)}; increases are red, decreases are green"><title>Defect-rate change: Increased defects red; Decreased defects green; No change neutral</title>${taYieldLookupAxis(-extent, extent, height, ' pp', plotWidth)}<line class="ta-compare-zero" x1="${zero}" x2="${zero}" y1="20" y2="${height - 32}"/>${rows}</svg>`;
}

function taYieldCompareLookupGraphs(data, escapeHtml) {
  const periods = taYieldComparePeriods(data);
  const currentLabel = escapeHtml(periods.current);
  const compareLabel = escapeHtml(periods.compare);
  const name = data.selection?.label ? ` · ${escapeHtml(data.selection.label)}` : '';
  const isAdjustment = (row) => String(row.group).trim().toLowerCase() === 'other2';
  const groups = (data.groups || []).filter((row) => !isAdjustment(row));
  const adjustments = (data.groups || []).filter(isAdjustment).map((row) => `<p class="ta-lookup-adjustment"><strong>Other2 — Reconciliation adjustment</strong><span>${currentLabel}: ${taYieldCompareValue(row.currentRate, '%')} · ${compareLabel}: ${taYieldCompareValue(row.compareRate, '%')} · Change: ${taYieldCompareValue(row.deltaRate, ' pp')}</span></p>`).join('');
  const charts = groups.length ? `<div class="ta-lookup-graphs"><section class="ta-lookup-graph-card"><h4>Defect rates by group${name}</h4><p>Rate (%) · common scale for both periods</p><div class="ta-lookup-legend"><span><i class="ta-lookup-selected"></i>${currentLabel} (Report dates)</span><span><i class="ta-lookup-comparison"></i>${compareLabel} (Compare with)</span></div><div class="ta-lookup-graph-scroll" tabindex="0" role="region" aria-label="Defect rates chart" data-lookup-rate-chart>${taYieldLookupRateGraph(groups, escapeHtml, periods)}</div></section><section class="ta-lookup-graph-card"><h4>Defect-rate change${name}</h4><p>${currentLabel} minus ${compareLabel} · percentage points</p><div class="ta-lookup-legend"><span><i class="ta-compare-negative"></i>Increased defects</span><span><i class="ta-compare-positive"></i>Decreased defects</span></div><div class="ta-lookup-graph-scroll" tabindex="0" role="region" aria-label="Defect-rate change chart" data-lookup-change-chart>${taYieldLookupChangeGraph(groups, escapeHtml, periods)}</div></section></div>` : '<p class="ta-lookup-empty">No defect-rate data to graph for these periods.</p>';
  const signedNote = groups.some((row) => row.currentRate < 0 || row.compareRate < 0) ? '<p class="ta-compare-detail-note">Negative rates are signed staged values; review the underlying records and adjustments.</p>' : '';
  return `<section class="ta-lookup-visuals" aria-label="LOOKUP visual analysis">${charts}${adjustments}${signedNote}</section>`;
}

function taYieldCompareAnalysisTable(rows, escapeHtml, data = {}) {
  if (!rows.length) return '';
  const periods = taYieldComparePeriods(data);
  return `<div class="ta-compare-table-scroll" tabindex="0" role="region" aria-label="Yield and production volumes"><table class="ta-compare-table"><caption>Yield and production volumes · kpcs. = 1,000 pieces</caption><thead><tr><th scope="col" rowspan="2">Series / case size</th><th scope="colgroup" colspan="3">${escapeHtml(periods.current)} (Report dates)</th><th scope="colgroup" colspan="3">${escapeHtml(periods.compare)} (Compare with)</th><th scope="col" rowspan="2">Change (pp)</th><th scope="col" rowspan="2">Details</th></tr><tr>${['Yield (%)', 'Input (kpcs.)', 'Good (kpcs.)', 'Yield (%)', 'Input (kpcs.)', 'Good (kpcs.)'].map((label) => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody>${rows.map((row, index) => `<tr><th scope="row">${escapeHtml(row.label)}</th><td>${taYieldCompareValue(row.currentYield, '%')}</td><td>${taYieldCompareQuantity(row.currentInput)}</td><td>${taYieldCompareQuantity(row.currentGood)}</td><td>${taYieldCompareValue(row.compareYield, '%')}</td><td>${taYieldCompareQuantity(row.compareInput)}</td><td>${taYieldCompareQuantity(row.compareGood)}</td><td>${taYieldCompareNumber(row.delta) > 0 ? '+' : ''}${taYieldCompareValue(row.delta)}</td><td><button type="button" data-compare-index="${index}" aria-label="LOOKUP ${escapeHtml(row.label)}" aria-controls="taYieldCompareDetail" aria-expanded="false">LOOKUP</button></td></tr>`).join('')}</tbody></table></div>`;
}

function taYieldCompareInvestigation(data, offset, escapeHtml) {
  const periods = taYieldComparePeriods(data);
  const groups = (data.groups || []).map((row) => {
    const adjustment = String(row.group).trim().toLowerCase() === 'other2';
    const label = adjustment ? 'Other2 — Reconciliation adjustment' : row.group;
    const rate = taYieldCompareNumber(row.deltaRate);
    return `<tr><th scope="row">${escapeHtml(label)}</th><td>${taYieldCompareQuantity(row.currentQty)}</td><td>${taYieldCompareValue(row.currentRate, '%')}</td><td>${taYieldCompareQuantity(row.compareQty)}</td><td>${taYieldCompareValue(row.compareRate, '%')}</td><td class="${adjustment ? '' : rate > 0 ? 'ta-compare-worse' : rate < 0 ? 'ta-compare-better' : ''}">${rate > 0 ? '+' : ''}${taYieldCompareValue(rate, ' pp')}</td></tr>`;
  }).join('');
  const jobs = ['current', 'compare'].map((side) => {
    const page = data.lots?.[side] || { rows: [], total: 0 };
    const rows = page.rows || [];
    const start = rows.length ? offset + 1 : 0;
    const end = rows.length ? Math.min(offset + rows.length, Number(page.total) || 0) : 0;
    const range = side === 'current' ? data.currentRange : data.compareRange;
    const lotCount = taYieldCompareNumber(data[side]?.lotCount);
    const countLabel = lotCount === null ? '' : ` · ${lotCount.toLocaleString('en-US')} distinct lotNo jobs across production in this date range`;
    return `<section class="ta-compare-jobs"><h4>${escapeHtml(periods[side])} (${side === 'current' ? 'Report dates' : 'Compare with'})</h4><p>${escapeHtml(range?.startDate || '')} to ${escapeHtml(range?.endDate || '')}${countLabel} · ${start}–${end} of ${Number(page.total) || 0} affected job records</p>${rows.length ? `<div class="ta-compare-table-scroll" tabindex="0" role="region" aria-label="${escapeHtml(periods[side])} staged jobs"><table class="ta-compare-table"><caption>Jobs with defects / adjustments (each line, part and taping date is a record)</caption><thead><tr>${['lotNo / JobName', 'Series', 'Part number', 'Taping date', 'Input (kpcs.)', 'Good (kpcs.)', 'Yield (%)', 'Defects / adjustments (kpcs.)', 'Groups (kpcs.)'].map((label) => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr><th scope="row">${escapeHtml(row.lotNo || '')}</th><td>${escapeHtml(row.line || '')}</td><td>${escapeHtml(row.itemName || '')}</td><td>${escapeHtml(row.tapingDate || '')}</td><td>${taYieldCompareQuantity(row.input)}</td><td>${taYieldCompareQuantity(row.good)}</td><td>${taYieldCompareValue(row.yield, '%')}</td><td>${taYieldCompareQuantity(row.defectQty)}</td><td>${(row.groups || []).map((group) => `${escapeHtml(String(group.group).toLowerCase() === 'other2' ? 'Other2 (adjustment)' : group.group)}: ${taYieldCompareQuantity(group.quantity)}`).join('; ') || '—'}</td></tr>`).join('')}</tbody></table></div>` : '<p>No staged jobs with defects / adjustments in this period or page.</p>'}</section>`;
  }).join('');
  return `<p class="ta-compare-detail-note">Staged data only. Rates use adjusted input; changes are percentage points. Other2 is a reconciliation adjustment, can be negative, and is not a confirmed physical defect or root cause.</p>${taYieldCompareLookupGraphs(data, escapeHtml)}<div class="ta-compare-table-scroll" tabindex="0" role="region" aria-label="Defect group quantity and rate changes"><table class="ta-compare-table"><caption>Defect groups and reconciliation adjustments</caption><thead><tr><th scope="col" rowspan="2">Group</th><th scope="colgroup" colspan="2">${escapeHtml(periods.current)} (Report dates)</th><th scope="colgroup" colspan="2">${escapeHtml(periods.compare)} (Compare with)</th><th scope="col" rowspan="2">Rate change (pp)</th></tr><tr>${['Qty (kpcs.)', 'Rate (%)', 'Qty (kpcs.)', 'Rate (%)'].map((label) => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody>${groups || '<tr><td colspan="6">No staged defect groups or adjustments.</td></tr>'}</tbody></table></div>${jobs}`;
}

function taYieldCompareChart(rows, escapeHtml, availableWidth = 900, data = {}) {
  if (!rows.length) return '<p class="ta-compare-message">No matching production data for these periods.</p>';
  const periods = taYieldComparePeriods(data);
  const width = Math.max(900, 90 + rows.length * 50, Number.isFinite(availableWidth) ? Math.floor(availableWidth) : 900);
  const labels = rows.map((row) => String(row.label).length > 30 ? `${String(row.label).slice(0, 29)}…` : String(row.label));
  const labelSpace = Math.max(115, Math.min(250, Math.max(...labels.map((label) => label.length)) * 7 + 35));
  const height = 325 + labelSpace;
  const left = 66;
  const right = width - 20;
  const top = 30;
  const bottom = 325;
  const scale = taYieldCompareScale(rows.map((row) => taYieldCompareNumber(row.delta)));
  const y = (value) => top + (scale.max - value) / (scale.max - scale.min) * (bottom - top);
  const zero = y(0);
  const slot = (right - left) / rows.length;
  const barWidth = Math.min(32, slot * 0.55);
  const grid = Array.from({ length: Math.round((scale.max - scale.min) / scale.step) + 1 }, (_, index) => {
    const value = scale.min + index * scale.step;
    return `<line class="${Math.abs(value) < scale.step / 100 ? 'ta-compare-zero' : 'ta-compare-grid'}" x1="${left}" x2="${right}" y1="${y(value)}" y2="${y(value)}"/><text class="ta-compare-tick" x="${left - 14}" y="${y(value) + 4}" text-anchor="end">${taYieldCompareValue(value)}</text>`;
  }).join('');
  const bars = rows.map((row, index) => {
    const x = left + slot * (index + 0.5);
    const delta = taYieldCompareNumber(row.delta);
    const color = delta === null || delta === 0 ? '#68758d' : delta > 0 ? '#008a3e' : '#d32f2f';
    const valueY = delta === null ? zero : y(delta);
    const labelY = delta === null || delta >= 0 ? valueY - 10 : valueY + 20;
    const direction = delta === null ? 'Not available' : delta > 0 ? 'Increase' : delta < 0 ? 'Decrease' : 'No change';
    const tip = `${row.label} | ${periods.current} (Report dates): ${taYieldCompareValue(row.currentYield, '%')} | ${periods.compare} (Compare with): ${taYieldCompareValue(row.compareYield, '%')} | Change: ${taYieldCompareValue(delta, ' percentage points')} | ${direction}`;
    const mark = delta === null ? '' : delta === 0
      ? `<line x1="${x - barWidth / 2}" x2="${x + barWidth / 2}" y1="${zero}" y2="${zero}" stroke="${color}" stroke-width="3"/>`
      : `<rect x="${x - barWidth / 2}" y="${Math.min(valueY, zero)}" width="${barWidth}" height="${Math.abs(valueY - zero)}" fill="${color}"/>`;
    return `<g class="ta-compare-bar" tabindex="0" role="button" aria-label="LOOKUP ${escapeHtml(tip)}" aria-controls="taYieldCompareDetail" aria-expanded="false" data-compare-index="${index}" data-compare-tooltip="${escapeHtml(tip)}"><title>${escapeHtml(tip)}</title><rect class="ta-compare-hit" x="${x - slot / 2}" y="${top}" width="${slot}" height="${bottom - top}" fill="transparent"/>${mark}<text class="ta-compare-value" x="${x}" y="${labelY}" text-anchor="middle">${taYieldCompareValue(delta)}</text><text class="ta-compare-label" transform="translate(${x + 4} ${height - 20}) rotate(-90)" text-anchor="start">${escapeHtml(labels[index])}</text></g>`;
  }).join('');
  return `<svg viewBox="0 0 ${width} ${height}" style="min-width:${width}px" role="group" aria-label="Compare: accumulated yield change by series and case size, in percentage points">${grid}${bars}</svg>`;
}

window.createTaYieldCompareWindow = function createTaYieldCompareWindow(options) {
  const { request, bindResize, escapeHtml } = options;
  const toggleButton = options.toggleButton || document.getElementById('taYieldCompareToggle');
  let available = false;
  let enabled = false;
  let panel;
  let filters = {};
  let sequence = 0;
  let lastKey = '';
  let bounds;
  let compareMonth = taYieldCompareMonths().previous;
  let compareMonthExplicit = false;
  let comparisonMode = 'same-dates';
  let applied;
  let detailSequence = 0;
  let investigation;
  let detailRequest;
  let detailOrigin;
  let chartWidth;
  let lookupData;
  let lookupWidths = {};
  let exportSequence = 0;
  let exporting = false;
  const reportRangeLabel = () => filters.startDate && filters.endDate
    ? `${filters.startDate} to ${filters.endDate}` : 'Select Report dates';
  const defaultComparisonMonth = () => {
    const month = String(filters.startDate || '').slice(0, 7);
    return /^\d{4}-(0[1-9]|1[0-2])$/.test(month)
      ? taYieldCompareMonths(new Date(`${month}-01T00:00:00+07:00`)).previous : taYieldCompareMonths().previous;
  };
  const query = (selector) => panel.querySelector(`[data-compare-${selector}]`);
  const canExport = () => enabled && available && applied && typeof options.fetchExport === 'function' && !exporting && (!investigation || lookupData);
  const updateExportButton = () => {
    if (!panel) return;
    query('export').disabled = !canExport();
    query('export').textContent = exporting ? 'Exporting…' : 'Export Excel';
    query('export').setAttribute('aria-busy', String(exporting));
  };
  const cancelExport = () => {
    exportSequence += 1;
    exporting = false;
    if (panel) query('export-status').textContent = '';
    updateExportButton();
  };
  const setSelectionExpanded = (selectedRow) => {
    (panel?.querySelectorAll('[data-compare-index]') || []).forEach((target) => {
      target.setAttribute('aria-expanded', String(Boolean(selectedRow && applied?.rows[Number(target.dataset.compareIndex)] === selectedRow)));
    });
  };
  const updateToggle = () => {
    if (!toggleButton) return;
    toggleButton.hidden = !available;
    toggleButton.textContent = `Compare: ${enabled ? 'On' : 'Off'}`;
    toggleButton.setAttribute('aria-pressed', String(enabled));
    toggleButton.setAttribute('aria-expanded', String(enabled));
    toggleButton.setAttribute('aria-controls', 'taYieldComparePanel');
  };
  const closeInvestigation = (returnFocus = false) => {
    detailSequence += 1;
    investigation = undefined;
    detailRequest = undefined;
    lookupData = undefined;
    lookupWidths = {};
    cancelExport();
    if (panel) {
      setSelectionExpanded();
      query('detail').hidden = true;
      query('detail-body').innerHTML = '';
      query('detail').setAttribute('aria-busy', 'false');
    }
    if (returnFocus && detailOrigin?.isConnected !== false) detailOrigin?.focus?.();
  };
  const invalidate = () => {
    sequence += 1; lastKey = ''; applied = undefined;
    closeInvestigation();
    if (panel) { query('summary').innerHTML = ''; query('notes').textContent = ''; }
  };
  const close = (returnFocus = true) => {
    enabled = false;
    invalidate();
    if (panel) panel.hidden = true;
    updateToggle();
    if (returnFocus) toggleButton?.focus();
  };
  const saveBounds = () => { const rect = panel.getBoundingClientRect(); bounds = { left: rect.left, top: rect.top, width: rect.width, height: rect.height }; };
  const restoreBounds = () => {
    if (!bounds) return;
    Object.entries(bounds).forEach(([name, value]) => { panel.style[name] = `${value}px`; });
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  };
  const updateWindowButtons = () => {
    const minimized = panel.classList.contains('is-minimized');
    const maximized = panel.classList.contains('is-maximized');
    query('minimize').setAttribute('aria-expanded', String(!minimized));
    query('minimize').setAttribute('aria-label', `${minimized ? 'Restore' : 'Minimize'} Compare panel`);
    query('minimize').title = minimized ? 'Restore panel' : 'Minimize panel';
    query('maximize').setAttribute('aria-pressed', String(maximized));
    query('maximize').setAttribute('aria-label', `${maximized ? 'Restore' : 'Maximize'} Compare panel`);
    query('maximize').title = maximized ? 'Restore panel' : 'Maximize panel';
  };
  const minimize = () => {
    if (!panel.classList.contains('is-minimized') && !panel.classList.contains('is-maximized')) saveBounds();
    const minimized = panel.classList.toggle('is-minimized');
    if (!minimized && !panel.classList.contains('is-maximized')) restoreBounds();
    updateWindowButtons();
  };
  const maximize = () => {
    const wasMinimized = panel.classList.contains('is-minimized');
    panel.classList.remove('is-minimized');
    if (!panel.classList.contains('is-maximized') && !wasMinimized) saveBounds();
    const maximized = panel.classList.toggle('is-maximized');
    if (!maximized) restoreBounds();
    updateWindowButtons();
  };
  const bringToFront = () => {
    const windows = Array.from(document.querySelectorAll?.('.daily-output-panel') || []).filter((item) => item !== panel && !item.hidden);
    const highest = Math.max(80, ...windows.map((item) => Number(getComputedStyle(item).zIndex) || 80));
    panel.style.zIndex = String(highest + 1);
  };

  async function exportExcel() {
    if (!canExport()) return;
    const params = new URLSearchParams(applied.params);
    if (investigation) {
      const selection = lookupData.selection || investigation.row;
      params.set('kind', selection.kind || investigation.row.kind || 'series');
      params.set('key', selection.key || investigation.row.key || investigation.row.label);
    }
    const token = ++exportSequence;
    const mainToken = sequence;
    const detailToken = detailSequence;
    const isCurrent = () => token === exportSequence && mainToken === sequence && detailToken === detailSequence && enabled && available && applied;
    exporting = true;
    updateExportButton();
    query('export-status').textContent = 'Creating Excel workbook with tables and graphs…';
    try {
      const response = await options.fetchExport(`/api/export/ta-yield-compare?${params}`);
      if (!isCurrent()) return;
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(typeof body?.error === 'string' ? body.error : 'Compare Excel export could not be created.');
      }
      const blob = await response.blob();
      if (!isCurrent()) return;
      const link = document.createElement('a');
      const objectUrl = URL.createObjectURL(blob);
      try {
        link.href = objectUrl;
        link.download = `ta-yield-compare-${params.get('startDate')}-to-${params.get('endDate')}-vs-${params.get('compareMonth')}.xlsx`;
        document.body.append(link);
        link.click();
      } finally {
        link.remove();
        URL.revokeObjectURL(objectUrl);
      }
      query('export-status').textContent = 'Excel download ready. All tables and graphs are included; open LOOKUP includes all affected job records.';
    } catch (error) {
      if (isCurrent()) query('export-status').textContent = error?.message || 'Compare Excel export could not be created. Please retry.';
    } finally {
      if (isCurrent()) { exporting = false; updateExportButton(); }
    }
  }

  function bindDrag() {
    const header = query('drag');
    let drag;
    header.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.isPrimary === false || event.target.closest('button, input, select') || panel.classList.contains('is-maximized')) return;
      const rect = panel.getBoundingClientRect();
      drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, width: rect.width };
      header.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    header.addEventListener('pointermove', (event) => {
      if (!drag || drag.pointer !== event.pointerId) return;
      panel.style.left = `${Math.max(8, Math.min(window.innerWidth - Math.min(drag.width, window.innerWidth - 16) - 8, drag.left + event.clientX - drag.x))}px`;
      panel.style.top = `${Math.max(8, Math.min(window.innerHeight - 64, drag.top + event.clientY - drag.y))}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    });
    const finish = (event) => {
      if (!drag || drag.pointer !== event.pointerId) return;
      drag = undefined;
      if (header.hasPointerCapture(event.pointerId)) header.releasePointerCapture(event.pointerId);
    };
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((name) => header.addEventListener(name, finish));
  }

  function bindTooltips() {
    const tooltip = query('tooltip');
    const hide = () => { tooltip.hidden = true; };
    query('chart').querySelectorAll('[data-compare-tooltip]').forEach((bar) => {
      const show = () => { tooltip.textContent = bar.dataset.compareTooltip; tooltip.hidden = false; };
      bar.addEventListener('pointerenter', show);
      bar.addEventListener('focus', show);
      bar.addEventListener('pointerleave', hide);
      bar.addEventListener('blur', hide);
      bar.addEventListener('keydown', (event) => { if (event.key === 'Escape') { hide(); event.stopPropagation(); } });
    });
  }

  function renderChart(force = false) {
    if (!enabled || !applied) return;
    const chart = query('chart');
    const width = Math.floor(chart.getBoundingClientRect().width);
    if (!force && width === chartWidth) return;
    chartWidth = width;
    const focusedIndex = chart.contains?.(document.activeElement) ? document.activeElement.dataset?.compareIndex : undefined;
    const originIndex = chart.contains?.(detailOrigin) ? detailOrigin.dataset?.compareIndex : undefined;
    chart.innerHTML = taYieldCompareChart(applied.rows, escapeHtml, width, applied);
    query('tooltip').hidden = true;
    bindTooltips();
    setSelectionExpanded(investigation?.row);
    if (originIndex !== undefined) detailOrigin = chart.querySelector?.(`[data-compare-index="${Number(originIndex)}"]`);
    if (focusedIndex !== undefined) chart.querySelector?.(`[data-compare-index="${Number(focusedIndex)}"]`)?.focus();
  }

  function renderLookupCharts() {
    if (!enabled || !investigation || !lookupData) return;
    const groups = (lookupData.groups || []).filter((row) => String(row.group).trim().toLowerCase() !== 'other2');
    const periods = taYieldComparePeriods(lookupData);
    for (const [kind, render] of [['rate', taYieldLookupRateGraph], ['change', taYieldLookupChangeGraph]]) {
      const host = query('detail-body').querySelector?.(`[data-lookup-${kind}-chart]`);
      if (!host) continue;
      const measured = host.clientWidth || host.getBoundingClientRect().width;
      if (!measured) continue;
      const width = Math.max(620, Math.floor(measured));
      if (lookupWidths[kind] === width) continue;
      lookupWidths = { ...lookupWidths, [kind]: width };
      const { scrollTop, scrollLeft } = host;
      host.innerHTML = render(groups, escapeHtml, periods, width);
      host.scrollTop = scrollTop;
      host.scrollLeft = scrollLeft;
    }
  }

  async function loadInvestigation(row, offset = 0, origin) {
    if (!enabled || !available || !applied || !row) return;
    const params = new URLSearchParams(applied.params);
    params.set('kind', row.kind || 'series');
    params.set('key', row.key || row.label);
    params.set('offset', String(offset));
    params.set('limit', '50');
    const key = params.toString();
    if (detailRequest?.key === key) return detailRequest.promise;
    const token = ++detailSequence;
    const mainToken = sequence;
    investigation = { row, offset };
    lookupData = undefined;
    lookupWidths = {};
    cancelExport();
    setSelectionExpanded(row);
    if (origin) detailOrigin = origin;
    query('detail').hidden = false;
    query('detail-heading').textContent = `LOOKUP ${row.label}`;
    query('detail').setAttribute('aria-busy', 'true');
    query('detail-body').innerHTML = '<p class="ta-compare-message" role="status">Loading staged defect groups and jobs…</p>';
    ['detail-previous', 'detail-next'].forEach((name) => { query(name).disabled = true; });
    query('detail-retry').hidden = true;
    query('detail-heading').focus();
    query('tooltip').hidden = true;
    const isCurrent = () => token === detailSequence && mainToken === sequence && enabled && available && investigation;
    const promise = (async () => {
      try {
        const data = await request(`/api/ta-yield-compare-details?${params}`);
        if (!isCurrent()) return;
        query('detail-body').innerHTML = taYieldCompareInvestigation(data, offset, escapeHtml);
        lookupData = data;
        renderLookupCharts();
        query('status').textContent = `LOOKUP loaded for ${row.label}. ${Number(data.lots?.current?.total) || 0} records for ${taYieldComparePeriods(data).current} and ${Number(data.lots?.compare?.total) || 0} records for ${taYieldComparePeriods(data).compare}.`;
        query('detail-previous').disabled = offset === 0;
        query('detail-next').disabled = Math.max(Number(data.lots?.current?.total) || 0, Number(data.lots?.compare?.total) || 0) <= offset + 50;
      } catch (error) {
        if (!isCurrent()) return;
        query('detail-body').innerHTML = `<p class="ta-compare-message" role="alert">${escapeHtml(error?.message || 'Could not load staged LOOKUP data.')}</p>`;
        query('detail-retry').hidden = false;
      } finally {
        if (isCurrent()) { query('detail').setAttribute('aria-busy', 'false'); updateExportButton(); }
        if (detailRequest?.token === token) detailRequest = undefined;
      }
    })();
    detailRequest = { key, token, promise };
    return promise;
  }

  function bindInvestigationSelection() {
    ['chart', 'summary'].forEach((name) => {
      const select = (event) => {
        const target = event.target.closest('[data-compare-index]');
        if (!target || !applied) return;
        if (event.key && event.key !== 'Enter' && event.key !== ' ') return;
        if (event.key) event.preventDefault();
        const index = Number(target.dataset.compareIndex);
        if (Number.isInteger(index)) loadInvestigation(applied.rows[index], 0, target);
      };
      query(name).addEventListener('click', select);
      if (name === 'chart') query(name).addEventListener('keydown', select);
    });
  }

  function ensurePanel() {
    if (panel) return;
    panel = document.createElement('section');
    panel.id = 'taYieldComparePanel';
    panel.className = 'daily-output-panel ta-yield-compare-panel';
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-labelledby', 'taYieldCompareHeading');
    panel.hidden = true;
    panel.innerHTML = `<header class="daily-output-panel-header" data-compare-drag>
      <div class="daily-output-panel-identity"><span class="daily-output-panel-mark" aria-hidden="true"><i></i><i></i><i></i></span><div><strong id="taYieldCompareHeading">Compare</strong><span>Accumulated yield / series + case size</span></div></div>
      <div class="daily-output-panel-actions"><button type="button" data-compare-maximize aria-pressed="false" aria-label="Maximize Compare panel" title="Maximize panel"><span class="daily-output-action-icon" aria-hidden="true">[ ]</span></button><button type="button" data-compare-minimize aria-expanded="true" aria-controls="taYieldCompareContent" aria-label="Minimize Compare panel" title="Minimize panel"><span class="daily-output-action-icon" aria-hidden="true">_</span></button><button type="button" data-compare-close class="daily-output-panel-close" aria-label="Close Compare panel" title="Close panel"><span aria-hidden="true">x</span></button></div>
      </header><div id="taYieldCompareContent" class="daily-output-panel-content ta-compare-content">
      <div class="ta-compare-controls"><div class="ta-compare-current"><span>Report dates</span><strong data-compare-current></strong></div><label for="taYieldCompareMonth">Compare with<input type="month" id="taYieldCompareMonth" data-compare-month required></label><label for="taYieldCompareMode">Period alignment<select id="taYieldCompareMode" data-compare-mode aria-describedby="taYieldCompareScope"><option value="same-dates">Same dates in chosen month</option><option value="full-month">Full month</option></select></label><button type="button" data-compare-apply>Apply</button><button type="button" data-compare-export disabled title="Export Compare tables and graphs, plus the currently open LOOKUP with all affected job records" aria-describedby="taYieldCompareExportStatus">Export Excel</button></div>
      <p id="taYieldCompareExportStatus" class="ta-compare-export-status" data-compare-export-status role="status" aria-live="polite"></p>
      <p id="taYieldCompareScope" class="daily-output-panel-scope" data-compare-scope></p><p class="ta-compare-range-note" data-compare-notes></p><p class="ta-compare-status" data-compare-status role="status" aria-live="polite"></p>
      <div class="ta-compare-chart-card"><div class="ta-compare-chart-heading"><strong>Compare</strong><span></span></div><div class="ta-compare-chart" data-compare-chart></div><div class="ta-compare-footer"><span><i class="ta-compare-positive"></i>Green (+)</span><span><i class="ta-compare-negative"></i>Red (−)</span><span>Change in percentage points</span><span>N/A = no yield in one or both periods</span></div><div class="ta-compare-tooltip" data-compare-tooltip role="tooltip" hidden></div></div>
      <div data-compare-summary></div>
      <section id="taYieldCompareDetail" class="ta-compare-detail" data-compare-detail aria-labelledby="taYieldCompareDetailHeading" hidden><div class="ta-compare-detail-header"><h3 id="taYieldCompareDetailHeading" tabindex="-1" data-compare-detail-heading></h3><button type="button" data-compare-detail-close>Close LOOKUP</button></div><div data-compare-detail-body></div><div class="ta-compare-detail-pagination"><button type="button" data-compare-detail-previous>Previous 50 job records</button><button type="button" data-compare-detail-next>Next 50 job records</button><button type="button" data-compare-detail-retry hidden>Retry LOOKUP</button></div></section>
      </div><span class="daily-output-resize-hint" aria-hidden="true"></span>`;
    document.body.append(panel);
    bindResize(panel, 'Compare');
    bindDrag();
    panel.addEventListener('pointerdown', bringToFront, true);
    panel.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (investigation) closeInvestigation(true); else close();
      event.stopPropagation();
    });
    query('close').addEventListener('click', () => close());
    query('minimize').addEventListener('click', minimize);
    query('maximize').addEventListener('click', maximize);
    query('export').addEventListener('click', exportExcel);
    updateExportButton();
    bindInvestigationSelection();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => { renderChart(); renderLookupCharts(); });
      observer.observe(query('chart'));
      observer.observe(query('detail'));
    }
    query('detail').hidden = true;
    query('detail-close').addEventListener('click', () => closeInvestigation(true));
    query('detail-previous').addEventListener('click', () => { if (investigation && !query('detail-previous').disabled) loadInvestigation(investigation.row, Math.max(0, investigation.offset - 50)); });
    query('detail-next').addEventListener('click', () => { if (investigation && !query('detail-next').disabled) loadInvestigation(investigation.row, investigation.offset + 50); });
    query('detail-retry').addEventListener('click', () => { if (investigation) loadInvestigation(investigation.row, investigation.offset); });
    query('apply').addEventListener('click', () => {
      if (options.getFilters) updateFilters(options.getFilters());
      load(true);
    });
    query('month').value = compareMonth;
    query('mode').value = comparisonMode;
    query('month').setAttribute('min', '1900-01');
    query('month').setAttribute('max', taYieldCompareMonths().current);
    query('current').textContent = reportRangeLabel();
    const pendingSelection = () => {
      invalidate();
      query('chart').innerHTML = '<p class="ta-compare-message">Select Apply to compare this period.</p>';
      query('apply').disabled = false;
      query('chart').setAttribute('aria-busy', 'false');
      query('tooltip').hidden = true;
    };
    query('month').addEventListener('input', () => { compareMonthExplicit = true; pendingSelection(); });
    query('mode').addEventListener('change', () => { comparisonMode = query('mode').value; pendingSelection(); });
  }

  async function load(force = false) {
    if (!enabled || !available) return;
    comparisonMode = query('mode').value;
    const month = query('month').value;
    const currentMonth = taYieldCompareMonths().current;
    query('month').setAttribute('max', currentMonth);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month < '1900-01' || month > currentMonth) {
      invalidate();
      query('chart').innerHTML = '<p class="ta-compare-message" role="alert">Choose a valid comparison month from January 1900 through the current month.</p>';
      query('chart').setAttribute('aria-busy', 'false');
      query('apply').disabled = false;
      query('tooltip').hidden = true;
      return;
    }
    compareMonth = month;
    if (comparisonMode === 'same-dates' && filters.startDate && filters.endDate && filters.startDate.slice(0, 7) !== filters.endDate.slice(0, 7)) {
      invalidate();
      query('chart').innerHTML = '<p class="ta-compare-message" role="alert">Same dates requires Report dates within one month. Choose Full month to compare a multi-month Report range.</p>';
      query('chart').setAttribute('aria-busy', 'false');
      query('apply').disabled = false;
      return;
    }
    const params = new URLSearchParams({ dataset: 'ta-yield', compareMonth, comparisonMode });
    if (filters.startDate) params.set('startDate', filters.startDate);
    if (filters.endDate) params.set('endDate', filters.endDate);
    if (filters.product) params.set('product', filters.product);
    ['serie', 'pn'].forEach((key) => (filters[key] || []).forEach((value) => params.append(key, value)));
    const key = `${params}|${filters.dataMode || ''}|${taYieldCompareToday()}`;
    if (!force && key === lastKey) return;
    closeInvestigation();
    applied = undefined;
    updateExportButton();
    query('summary').innerHTML = '';
    query('notes').textContent = '';
    lastKey = key;
    const token = ++sequence;
    query('apply').disabled = true;
    query('chart').setAttribute('aria-busy', 'true');
    query('chart').innerHTML = '<p class="ta-compare-message" role="status">Loading comparison…</p>';
    query('status').textContent = 'Loading comparison.';
    query('current').textContent = reportRangeLabel();
    query('scope').textContent = `${reportRangeLabel()} − ${compareMonth}`;
    query('tooltip').hidden = true;
    try {
      const data = await request(`/api/ta-yield-compare?${params}`);
      if (token !== sequence || !enabled || !available) return;
      query('current').textContent = `${data.currentRange.startDate} to ${data.currentRange.endDate}`;
      query('scope').textContent = `${data.currentRange.startDate} to ${data.currentRange.endDate} − ${data.compareMonth} (${data.compareRange.startDate} to ${data.compareRange.endDate})`;
      query('notes').textContent = (data.rangeNotes || []).join(' ');
      const appliedParams = new URLSearchParams(params);
      appliedParams.set('startDate', data.currentRange.startDate);
      appliedParams.set('endDate', data.currentRange.endDate);
      appliedParams.set('compareMonth', data.compareMonth);
      applied = { params: appliedParams.toString(), rows: data.rows || [], currentRange: data.currentRange, compareRange: data.compareRange };
      updateExportButton();
      renderChart(true);
      query('summary').innerHTML = taYieldCompareAnalysisTable(data.rows || [], escapeHtml, data);
      query('status').textContent = `Compare loaded: ${taYieldComparePeriods(data).current} minus ${taYieldComparePeriods(data).compare}. ${(data.rows || []).length} yield categories. Select a bar or LOOKUP button for staged detail.`;
    } catch (error) {
      if (token !== sequence || !enabled || !available) return;
      lastKey = '';
      query('chart').innerHTML = `<p class="ta-compare-message" role="alert">${escapeHtml(error?.message || 'Could not load comparison.')} Select Apply to retry.</p>`;
    } finally {
      if (token === sequence) {
        query('apply').disabled = false;
        query('chart').setAttribute('aria-busy', 'false');
      }
    }
  }

  function updateFilters(nextFilters = {}) {
    filters = { startDate: nextFilters.startDate || '', endDate: nextFilters.endDate || '',
      product: nextFilters.product || '', serie: [...(nextFilters.serie || [])].sort(), pn: [...(nextFilters.pn || [])].sort(), dataMode: nextFilters.dataMode || '' };
    if (!compareMonthExplicit) {
      compareMonth = defaultComparisonMonth();
      if (panel) query('month').value = compareMonth;
    }
    if (panel) query('current').textContent = reportRangeLabel();
  }

  function syncFilters(nextFilters = {}) {
    const previous = JSON.stringify(filters);
    updateFilters(nextFilters);
    if (JSON.stringify(filters) === previous) return;
    invalidate();
    if (!panel) return;
    query('scope').textContent = `${reportRangeLabel()} / Compare with ${query('month').value}`;
    query('chart').innerHTML = '<p class="ta-compare-message">Report selection changed. Select Apply to compare.</p>';
    query('chart').setAttribute('aria-busy', 'false');
    query('apply').disabled = false;
    query('tooltip').hidden = true;
  }

  updateToggle();
  return {
    get enabled() { return enabled; },
    toggle() {
      if (!available) return;
      if (enabled) { close(); return; }
      if (options.getFilters) updateFilters(options.getFilters());
      enabled = true;
      ensurePanel();
      panel.hidden = false;
      bringToFront();
      updateToggle();
      query('month').focus();
      load();
    },
    setAvailable(value) {
      available = Boolean(value);
      if (!available) close(false);
      updateToggle();
    },
    refresh(nextFilters = {}, force = false) {
      updateFilters(nextFilters);
      return load(force);
    },
    syncFilters
  };
};
