import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const helpers = app.slice(app.indexOf('const scYieldTargetSettingsKey'), app.indexOf('let pnSearchTimer'));
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function harness(settings = {}, { remote = false, loaded = false, period = '2026-09', request = vi.fn() } = {}) {
  const nodes = Object.fromEntries(['scYieldTargetPeriod', 'scYieldTargetParameters', 'scYieldTargetStatus', 'startDate', 'endDate'].map((id) => [id, { value: id === 'scYieldTargetPeriod' ? period : '2026-06-01', innerHTML: '', textContent: '', disabled: false, setAttribute: vi.fn(), removeAttribute: vi.fn(), querySelectorAll: vi.fn(() => []) }]));
  const storage = { getItem: () => JSON.stringify(settings), setItem: vi.fn(), removeItem: vi.fn() };
  const api = new Function('localStorage', 'byId', 'escapeHtml', 'request', 'renderScYield', 'latestScYieldData', 'bangkokToday', 'selectedDataset', `${helpers}\nscYieldTargetStorageRemote = ${remote}; scYieldTargetSettingsLoaded = ${loaded}; return { render: renderScYieldTargetParameters, target: scYieldTargetFor, save: typeof saveScYieldTarget === 'function' ? saveScYieldTarget : undefined, settings: () => scYieldTargetSettings };`)(storage, (id) => nodes[id], escapeHtml, request, vi.fn(), [], () => '2026-09-16', () => 'yield');
  return { ...api, nodes, request, storage };
}

const rows = [{ line: 'A', month: '2026-06', input: 100, defect: 10, groups: [] }, { line: 'B', month: '2026-06', input: 300, defect: 30, groups: [] }];
const targetInput = (value, serie = 'Total', period = '2026-09') => ({ value, dataset: { scYieldTargetSerie: serie, scYieldTargetMonth: period }, disabled: false, setCustomValidity: vi.fn(), reportValidity: vi.fn() });

describe('SC Yield target parameters', () => {
  it('renders Total first even without yield data, and includes previously saved series', async () => {
    const h = harness({ Saved: { '2026-09': 92 }, Total: { '2026-09': 96 } });
    await h.render([]);
    expect(h.nodes.scYieldTargetParameters.innerHTML).toContain('data-sc-yield-target-serie="Total"');
    expect(h.nodes.scYieldTargetParameters.innerHTML).toContain('data-sc-yield-target-serie="Saved"');
    expect(h.nodes.scYieldTargetParameters.innerHTML.indexOf('data-sc-yield-target-serie="Total"')).toBeLessThan(h.nodes.scYieldTargetParameters.innerHTML.indexOf('data-sc-yield-target-serie="Saved"'));
    expect(h.nodes.scYieldTargetParameters.innerHTML).not.toContain('scYieldTargetSave');
  });

  it('edits only its selected month independently of the dashboard range', async () => {
    const h = harness({ Total: { '2026-09': 96, '2026-10': 97 } });
    await h.render(rows);
    expect(h.nodes.scYieldTargetParameters.innerHTML).toContain('data-sc-yield-target-month="2026-09"');
    expect(h.nodes.scYieldTargetParameters.innerHTML).not.toContain('data-sc-yield-target-month="2026-06"');
    expect(h.nodes.scYieldTargetParameters.innerHTML).toContain('value="96"');
    h.nodes.scYieldTargetPeriod.value = '2026-10';
    await h.render(rows);
    expect(h.nodes.scYieldTargetParameters.innerHTML).toContain('value="97"');
    expect(h.nodes.startDate.value).toBe('2026-06-01');
    expect(h.nodes.endDate.value).toBe('2026-06-01');
  });

  it('loads persisted targets before rendering when parameters are opened first', async () => {
    const request = vi.fn().mockResolvedValue([{ serie: 'Total', period: '2026-09', target: 93 }]);
    const h = harness({}, { remote: true, request });
    await h.render([]);
    expect(request).toHaveBeenCalledWith('/api/sc-yield-targets');
    expect(h.nodes.scYieldTargetParameters.innerHTML).toContain('value="93"');
  });

  it('defaults its month to the current Bangkok month when not selected', async () => {
    const h = harness({}, { period: '' });
    await h.render([]);
    expect(h.nodes.scYieldTargetPeriod.value).toBe('2026-09');
  });

  it('escapes series names before placing them in labels and input attributes', async () => {
    const h = harness({ 'SC "<test>"': { '2026-09': 92 } });
    await h.render([]);
    expect(h.nodes.scYieldTargetParameters.innerHTML).toContain('SC &quot;&lt;test&gt;&quot;');
    expect(h.nodes.scYieldTargetParameters.innerHTML).not.toContain('<test>');
  });

  it.each([null, undefined, '', ' ', -1, 101, 'no', false, []])('omits invalid target %j', (value) => {
    expect(harness({ Total: { '2026-09': value } }).target('Total', '2026-09')).toBeUndefined();
  });

  it('keeps zero and boundaries, without inheriting another scope or month', () => {
    const h = harness({ Total: { '2026-09': 0, '2026-10': 100 }, A: { '2026-09': 88 } });
    expect(h.target('Total', '2026-09')).toBe(0);
    expect(h.target('Total', '2026-10')).toBe(100);
    expect(h.target('B', '2026-09')).toBeUndefined();
    expect(h.target('A', '2026-10')).toBeUndefined();
  });
});

describe('SC Yield target autosave', () => {
  it('retains the pending value and disabled state after switching away and back to the month', async () => {
    let finish;
    const h = harness({ Total: { '2026-09': 91 } }, { remote: true, loaded: true, request: vi.fn(() => new Promise((resolve) => { finish = resolve; })) });
    const pending = h.save(targetInput('96'));
    h.nodes.scYieldTargetPeriod.value = '2026-10';
    await h.render([]);
    h.nodes.scYieldTargetPeriod.value = '2026-09';
    await h.render([]);
    const inputMarkup = h.nodes.scYieldTargetParameters.innerHTML.match(/<input\b[^>]*data-sc-yield-target-serie="Total"[^>]*>/)[0];
    finish({});
    await pending;
    expect(inputMarkup).toContain('value="96"');
    expect(inputMarkup).toMatch(/\sdisabled(?:\s|=|\/?>)/);
  });

  it.each([true, false])('syncs only the remounted matching editor after save success=%s', async (success) => {
    let finish;
    const h = harness({ Total: { '2026-09': 91 } }, { remote: true, loaded: true, request: vi.fn(() => new Promise((resolve, reject) => { finish = success ? resolve : reject; })) });
    const pending = h.save(targetInput('96'));
    const remounted = { ...targetInput('96'), disabled: true };
    const otherMonth = targetInput('88', 'Total', '2026-10');
    const otherScope = { ...targetInput('87', 'A'), disabled: true };
    h.nodes.scYieldTargetParameters.querySelectorAll.mockReturnValue([remounted, otherMonth, otherScope]);
    finish(success ? {} : new Error('Save failed'));
    await pending;
    expect(remounted.disabled).toBe(false);
    expect(Number(remounted.value)).toBe(success ? 96 : 91);
    expect(otherMonth.value).toBe('88');
    expect(otherMonth.disabled).toBe(false);
    expect(otherScope.value).toBe('87');
    expect(otherScope.disabled).toBe(true);
  });

  it('does not send a second save for the same scope/month while it is pending', async () => {
    const complete = [];
    const h = harness({}, { remote: true, loaded: true, request: vi.fn(() => new Promise((resolve) => { complete.push(resolve); })) });
    const first = h.save(targetInput('96'));
    const duplicate = h.save(targetInput('97'));
    const requestCount = h.request.mock.calls.length;
    complete.forEach((resolve) => resolve({}));
    await Promise.all([first, duplicate]);
    expect(requestCount).toBe(1);
    expect(h.target('Total', '2026-09')).toBe(96);
  });

  it('PUTs the exact scope/month, disables the input while pending, and updates only after success', async () => {
    let finish;
    const request = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const h = harness({ Total: { '2026-09': 91 } }, { remote: true, request });
    const input = targetInput('96');
    const pending = h.save(input);
    expect(input.disabled).toBe(true);
    expect(h.target('Total', '2026-09')).toBe(91);
    expect(request).toHaveBeenCalledWith('/api/sc-yield-targets', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ serie: 'Total', period: '2026-09', target: 96 }) }));
    finish({});
    await pending;
    expect(input.disabled).toBe(false);
    expect(h.target('Total', '2026-09')).toBe(96);
    expect(h.nodes.scYieldTargetStatus.textContent).toMatch(/saved/i);
  });

  it('clearing a field DELETEs only that exact saved month', async () => {
    const h = harness({ Total: { '2026-09': 91, '2026-10': 95 } }, { remote: true, request: vi.fn().mockResolvedValue({}) });
    await h.save(targetInput(''));
    const [url, options] = h.request.mock.calls[0];
    expect(new URL(url, 'http://local').searchParams.get('serie')).toBe('Total');
    expect(new URL(url, 'http://local').searchParams.get('period')).toBe('2026-09');
    expect(options.method).toBe('DELETE');
    expect(h.target('Total', '2026-09')).toBeUndefined();
    expect(h.target('Total', '2026-10')).toBe(95);
  });

  it('retains old settings and reports server failure', async () => {
    const h = harness({ Total: { '2026-09': 91 } }, { remote: true, request: vi.fn().mockRejectedValue(new Error('Save failed')) });
    const input = targetInput('96');
    await h.save(input);
    expect(h.target('Total', '2026-09')).toBe(91);
    expect(input.disabled).toBe(false);
    expect(h.nodes.scYieldTargetStatus.textContent).toMatch(/failed/i);
  });

  it('keeps both edits when independent saves finish out of order', async () => {
    const complete = [];
    const request = vi.fn(() => new Promise((resolve) => { complete.push(resolve); }));
    const h = harness({}, { remote: true, request });
    const first = h.save(targetInput('95', 'Total'));
    const second = h.save(targetInput('89', 'A'));
    complete[1]({});
    await second;
    complete[0]({});
    await first;
    expect(h.target('Total', '2026-09')).toBe(95);
    expect(h.target('A', '2026-09')).toBe(89);
  });

  it.each([['-1', 'Total', '2026-09'], ['101', 'Total', '2026-09'], ['bad', 'Total', '2026-09'], ['95', '', '2026-09'], ['95', 'Total', '2026-13']])('rejects invalid target/series/month %s %s %s before persistence', async (value, serie, period) => {
    const h = harness({}, { remote: true });
    const input = targetInput(value, serie, period);
    await h.save(input);
    expect(h.request).not.toHaveBeenCalled();
    expect(input.reportValidity).toHaveBeenCalled();
  });

  it.each(['0', '100'])('saves the valid boundary %s to local storage in local mode', async (value) => {
    const h = harness();
    await h.save(targetInput(value));
    expect(h.target('Total', '2026-09')).toBe(Number(value));
    expect(h.storage.setItem).toHaveBeenCalledWith('onemes-sc-yield-target-settings-v1', expect.any(String));
    expect(h.request).not.toHaveBeenCalled();
  });
});

describe('SC Yield Total target calculations', () => {
  it.each([[96, '93.8%'], [0, '-'], [undefined, '-']])('shows Total achievement against its saved target %j', (target, expected) => {
    const block = app.slice(app.indexOf('function renderScYieldArSummary'), app.indexOf('function renderScYield(rows'));
    const holder = { innerHTML: '', hidden: false };
    const render = new Function('byId', 'escapeHtml', 'scYieldTargetFor', `${block}\nreturn renderScYieldArSummary;`)(() => holder, escapeHtml, harness({ A: { '2026-06': 80 }, B: { '2026-06': 84 } }).target);
    render([{ month: '2026-06', yield: 90, target }], rows);
    const totalCard = holder.innerHTML.split('<strong>Total</strong>')[1].split('</div>')[0];
    expect(totalCard).toContain('<em>Yield result</em><b>90.0%</b>');
    expect(totalCard).toContain(`<em>Achievement rate</em><b>${expected}</b>`);
  });

  it.each([96, 0, undefined])('uses the saved Total monthly target %j without changing actual yield', (target) => {
    const start = app.indexOf('  const rates = byMonth.map', app.indexOf('function renderScYield('));
    const block = app.slice(start, app.indexOf('  if (!rates.some', start));
    const targetFor = harness({ Total: { '2026-06': target }, A: { '2026-06': 80 }, B: { '2026-06': 84 } }).target;
    const calculate = new Function('byMonth', 'rows', 'groups', 'scYieldTargetFor', `${block}\nreturn rates;`);
    const actual = calculate([{ month: '2026-06', input: 400, defect: 40, groups: {} }], rows, [], targetFor);
    expect(actual[0].target).toBe(target);
    expect(actual[0].yield).toBe(90);
  });

  it.each(['Total', 'A'])('uses the selected %s scope target in tendency buckets', (scope) => {
    const start = app.indexOf('  const buckets = bucketNames.map', app.indexOf('function renderScYieldTendencyCharts'));
    const block = app.slice(start, app.indexOf('  if (!buckets.some', start));
    const targetFor = harness({ Total: { '2026-06': 96 }, A: { '2026-06': 80 }, B: { '2026-06': 84 } }).target;
    const calculate = new Function('bucketNames', 'trendRows', 'scYieldTargetFor', 'taYieldTargetPeriod', 'scYieldTrendSeries', `${block}\nreturn buckets;`);
    const actual = calculate(['2026-06'], scope === 'Total' ? rows : [rows[0]], targetFor, (month) => month, scope);
    expect(actual[0].target).toBe(scope === 'Total' ? 96 : 80);
    expect(actual[0].yield).toBe(90);
  });
});
