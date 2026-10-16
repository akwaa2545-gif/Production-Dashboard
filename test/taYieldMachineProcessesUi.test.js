import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const escapeHtml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
function harness(state = {}) {
  const elements = Object.fromEntries(['Process', 'Defect', 'Apply', 'Link', 'StartDate', 'EndDate', 'Serie', 'PartNumber'].map((name) => [`taMachine${name}`, { value: '', disabled: false, innerHTML: '', textContent: '' }]));
  Object.assign(elements.taMachineStartDate, { value: '2026-09-01' });
  Object.assign(elements.taMachineEndDate, { value: '2026-10-16' });
  Object.assign(elements.taMachineSerie, { value: 'TA-A' });
  Object.assign(elements.taMachinePartNumber, { value: 'PN&1' });
  const calls = [];
  const pending = [];
  const request = (url) => { calls.push(url); return new Promise((resolve, reject) => pending.push({ resolve, reject })); };
  const start = app.indexOf('function taYieldMachineFilterParams()');
  const end = app.indexOf('async function renderTaYieldMachineView()', start);
  const create = new Function('byId', 'request', 'escapeHtml', 'initialState', `let taYieldMachineState = initialState; ${app.slice(start, end)}; return { loader: createTaYieldMachineFilterLoader(), state: () => taYieldMachineState };`);
  const result = create((id) => elements[id], request, escapeHtml, state);
  return { ...result, elements, calls, pending };
}

describe('TA Machine dynamic process filters', () => {
  it('loads raw processes for the current Machine range and TA Yield lot filters, escaping options', async () => {
    const h = harness();
    const loading = h.loader.loadProcesses();
    const url = new URL(h.calls[0], 'http://localhost');
    expect(url.pathname).toBe('/api/ta-yield-machine-processes');
    expect(Object.fromEntries(url.searchParams)).toEqual({ dataset: 'ta-yield', startDate: '2026-09-01', endDate: '2026-10-16', serie: 'TA-A', pn: 'PN&1' });
    h.pending[0].resolve({ processes: ['Molding', 'Dip "A" <B>'] });
    await loading;
    expect(h.elements.taMachineProcess.innerHTML).toContain('Molding');
    expect(h.elements.taMachineProcess.innerHTML).toContain('Dip &quot;A&quot; &lt;B&gt;');
    expect(h.elements.taMachineProcess.disabled).toBe(false);
    expect(h.elements.taMachineApply.disabled).toBe(true);
    expect(h.calls).toHaveLength(1);
  });

  it('restores legacy selections only when their exact process is available and retains lot filters', async () => {
    const h = harness({ process: '2.Welding', serie: 'TA-A', pn: 'PN&1', defectType: 'category', defect: 'SH' });
    const loading = h.loader.loadProcesses();
    h.pending[0].resolve({ processes: ['Welding', '2ndAnodization'] });
    await Promise.resolve();
    expect(h.elements.taMachineProcess.value).toBe('Welding');
    expect(h.calls[1]).toContain('/api/ta-yield-machine-options?');
    h.pending[1].resolve({ codes: [], categories: ['SH'] });
    await loading;
    expect(h.state()).toMatchObject({ process: 'Welding', serie: 'TA-A', pn: 'PN&1', defect: 'SH' });
    expect(h.elements.taMachineDefect.value).toBe('category|SH');
    expect(h.elements.taMachineApply.disabled).toBe(false);
  });

  it('clears stale process and defect selections for an empty list or failed reload', async () => {
    const h = harness({ process: 'Molding', defectType: 'code', defect: 'A' });
    const empty = h.loader.loadProcesses();
    h.pending[0].resolve({ processes: [] });
    await empty;
    expect(h.state()).toMatchObject({ process: '', defectType: '', defect: '' });
    expect(h.elements.taMachineProcess.disabled).toBe(true);
    expect(h.elements.taMachineApply.disabled).toBe(true);
    expect(h.elements.taMachineLink.textContent).toMatch(/No processes/);
    const failed = h.loader.loadProcesses();
    h.pending[1].reject(new Error('network unavailable'));
    await failed;
    expect(h.elements.taMachineProcess.disabled).toBe(true);
    expect(h.elements.taMachineDefect.value).toBe('');
    expect(h.elements.taMachineLink.textContent).toContain('network unavailable');
    expect(h.calls).toHaveLength(2);
  });

  it('does not restore a missing selected process or reuse a defect from it', async () => {
    const h = harness({ process: '1.1stAnodization', defectType: 'category', defect: 'SH' });
    const loading = h.loader.loadProcesses();
    h.pending[0].resolve({ processes: ['2ndAnodization', 'Molding'] });
    await loading;
    expect(h.elements.taMachineProcess.value).toBe('');
    expect(h.elements.taMachineDefect.value).toBe('');
    expect(h.state()).toMatchObject({ process: '', defectType: '', defect: '' });
    expect(h.calls).toHaveLength(1);
  });

  it('keeps a stale defect response from enabling analysis after the process changes', async () => {
    const h = harness({ process: 'Welding', defectType: 'category', defect: 'SH' });
    h.elements.taMachineProcess.value = 'Welding';
    const older = h.loader.loadDefects();
    h.elements.taMachineProcess.value = '';
    await h.loader.loadDefects();
    h.pending[0].resolve({ codes: [], categories: ['SH'] });
    await older;
    expect(h.elements.taMachineDefect.disabled).toBe(true);
    expect(h.elements.taMachineDefect.value).toBe('');
    expect(h.elements.taMachineApply.disabled).toBe(true);
  });

  it('ignores older requests and results from a replaced render', async () => {
    const h = harness();
    const older = h.loader.loadProcesses();
    const newer = h.loader.loadProcesses();
    h.pending[1].resolve({ processes: ['Molding'] });
    await newer;
    h.pending[0].resolve({ processes: ['Welding'] });
    await older;
    expect(h.elements.taMachineProcess.innerHTML).toContain('Molding');
    expect(h.elements.taMachineProcess.innerHTML).not.toContain('Welding');
    const replaced = h.loader.loadProcesses();
    h.elements.taMachineProcess = { value: 'Fresh', innerHTML: 'Fresh render', disabled: false };
    h.pending[2].resolve({ processes: ['Stale'] });
    await replaced;
    expect(h.elements.taMachineProcess.innerHTML).toBe('Fresh render');
  });
});
