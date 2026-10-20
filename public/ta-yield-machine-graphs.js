window.createTaYieldMachineGraphs = function createTaYieldMachineGraphs({ request, renderChart } = {}) {
  const shelf = document.createElement('section');
  shelf.className = 'ta-machine-comparisons';
  shelf.setAttribute('aria-label', 'Machine comparison graphs');
  shelf.hidden = true;
  const cards = new Set();
  const maxGraphs = 4;
  const boundButtons = new WeakSet();
  let button;
  let host;
  let analysis;
  let generation = 0;
  let count = 0;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function begin() {
    generation += 1;
    analysis = null;
    syncAddButton();
    return generation;
  }
  function canAdd() {
    return cards.size < maxGraphs && Boolean(analysis?.chart.isConnected && analysis.chart.querySelector('svg'));
  }
  function syncAddButton() {
    if (!button) return;
    button.disabled = !canAdd();
    button.title = cards.size >= maxGraphs ? 'Maximum 4 added graphs. Remove a graph to add another.' : '';
  }
  function staticChart(chart, display) {
    let source = chart;
    if (chart.querySelector('svg[data-machine-chart-enhanced]') && renderChart && display.rows?.length) {
      const selected = new Set(display.machines || display.rows.map((row) => row.machineName));
      const rendered = renderChart(display.rows.filter((row) => selected.has(row.machineName)), display.order || 'machine-date', display.totalMachines);
      source = element('div', 'ta-machine-chart-wrap');
      if (typeof rendered === 'string') source.innerHTML = rendered;
      else if (rendered) source.append(rendered);
    }
    const copy = source.cloneNode(true);
    copy.querySelectorAll('details, label, button, input, select, .ta-machine-tooltip, .ta-machine-point-tooltip').forEach((node) => node.remove());
    [copy, ...copy.querySelectorAll('*')].forEach((node) => {
      [...node.attributes].forEach(({ name }) => {
        if (name === 'id' || name.startsWith('on') || ['aria-controls', 'aria-labelledby', 'aria-describedby'].includes(name)) node.removeAttribute(name);
      });
    });
    return copy;
  }
  function fill(select, values, placeholder, selected = select.value) {
    const choices = values.map((value) => Array.isArray(value) ? value : [value, value]);
    select.replaceChildren(...[[placeholder, ''], ...choices].map(([label, value]) => {
      const option = element('option', '', label); option.value = value; return option;
    }));
    select.value = choices.some(([, value]) => value === selected) ? selected : '';
  }

  function createCard(scope, chart, display) {
    const card = element('article', 'ta-machine-comparison-card');
    const id = ++count;
    card.setAttribute('data-machine-graph-id', String(id));
    const header = element('header', 'ta-machine-comparison-header');
    const remove = element('button', 'ta-machine-comparison-remove', 'Remove');
    remove.type = 'button'; remove.setAttribute('aria-label', `Remove Graph ${id}`);
    header.append(element('h3', '', `Graph ${id}`), remove);
    const filters = element('div', 'ta-machine-comparison-filters');
    const status = element('p', 'ta-machine-comparison-status'); status.setAttribute('role', 'status');
    const content = element('div', 'ta-machine-comparison-chart'); content.append(staticChart(chart, display));
    const controls = {};
    let rows = (display.rows || []).map((row) => ({ ...row }));
    let totalMachines = Number(display.totalMachines) || 0;
    let selectedMachines = new Set(display.machines || rows.map((row) => row.machineName));
    let processRevision = 0;
    let defectRevision = 0;
    let resultRevision = 0;
    let loadingOptions = false;
    let loadingResult = false;
    let dirty = false;
    let preferredProcess = scope.process;
    let preferredDefect = `${scope.defectType}|${scope.defect}`;
    const state = { card };
    const current = () => cards.has(state);
    function field(name, label, type, value) {
      const wrapper = element('label', '', label);
      const control = element(type === 'date' ? 'input' : 'select');
      control.setAttribute('data-machine-filter', name);
      if (type === 'date') control.type = 'date';
      control.value = value || '';
      controls[name] = control; wrapper.append(control); filters.append(wrapper); return control;
    }
    field('startDate', 'Start date', 'date', scope.startDate);
    field('endDate', 'End date', 'date', scope.endDate);
    fill(field('serie', 'Series', 'select'), scope.serie ? [scope.serie] : [], 'All series', scope.serie);
    fill(field('process', 'Process', 'select'), [scope.process], 'Select process', scope.process);
    fill(field('pn', 'Part number', 'select'), scope.pn ? [scope.pn] : [], 'All part numbers', scope.pn);
    const initialDefect = `${scope.defectType}|${scope.defect}`;
    fill(field('defect', 'Defect view', 'select'), [[scope.defect, initialDefect]], 'Select defect view', initialDefect);
    fill(field('groupBy', 'Group by', 'select'), [['Day', 'day'], ['Week', 'week'], ['Month', 'month']], 'Select grouping', scope.groupBy || 'day');
    fill(field('order', 'Order', 'select'), [['Machine / Date', 'machine-date'], ['Date / Machine', 'date-machine']], 'Select order', display.order === 'date-machine' ? 'date-machine' : 'machine-date');
    const actions = element('div', 'ta-machine-comparison-actions');
    const analyze = element('button', 'ta-machine-comparison-analyze', 'Analyze'); analyze.type = 'button';
    const picker = element('details', 'ta-machine-picker');
    const summary = element('summary', 'ta-machine-picker-trigger'); const machineChoices = element('div', 'ta-machine-picker-options');
    const machineMenu = element('div', 'ta-machine-picker-menu'); machineMenu.setAttribute('role', 'group'); machineMenu.setAttribute('aria-label', 'Filter displayed machines');
    machineMenu.append(machineChoices); picker.append(summary, machineMenu); actions.append(analyze, picker); filters.append(actions);
    card.append(header, filters, status, content);

    function enableAnalyze() { analyze.disabled = loadingOptions || loadingResult || !controls.process.value || !controls.defect.value; }
    function clearResult(message) {
      resultRevision += 1; loadingResult = false; dirty = true; rows = []; content.replaceChildren();
      status.textContent = message || 'Filters changed. Click Analyze to update this graph.';
      analyze.textContent = 'Analyze'; populateMachines(); enableAnalyze();
    }
    function draw() {
      content.replaceChildren();
      const visible = rows.filter((row) => selectedMachines.has(row.machineName));
      if (!visible.length) { status.textContent = rows.length ? 'Select at least one machine.' : 'Click Analyze to update this graph.'; return; }
      const rendered = renderChart?.(visible, controls.order.value, totalMachines);
      if (typeof rendered === 'string') content.innerHTML = rendered;
      else if (rendered) content.append(rendered);
      content.querySelectorAll('.ta-machine-order').forEach((node) => node.remove());
      status.textContent = '';
    }
    function populateMachines() {
      const names = [...new Set(rows.map((row) => row.machineName))].sort();
      machineChoices.replaceChildren();
      names.forEach((name) => {
        const label = element('label'); const checkbox = element('input'); checkbox.type = 'checkbox';
        checkbox.checked = selectedMachines.has(name); checkbox.setAttribute('data-machine-name', name);
        checkbox.addEventListener('change', () => {
          selectedMachines = new Set(checkbox.checked ? [...selectedMachines, name] : [...selectedMachines].filter((value) => value !== name));
          updateMachineCount(); draw();
        });
        label.append(checkbox, element('span', '', name)); machineChoices.append(label);
      });
      updateMachineCount();
      picker.hidden = !names.length;
    }
    function updateMachineCount() { summary.textContent = `Machines (${selectedMachines.size} selected)`; }
    function params() {
      const values = new URLSearchParams({ dataset: 'ta-yield', startDate: controls.startDate.value, endDate: controls.endDate.value });
      if (controls.serie.value) values.set('serie', controls.serie.value);
      if (controls.pn.value) values.set('pn', controls.pn.value);
      return values;
    }
    function datesValid() {
      const valid = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
      return valid(controls.startDate.value) && valid(controls.endDate.value) && controls.startDate.value <= controls.endDate.value;
    }
    async function loadDefects(selected = preferredDefect) {
      const revision = ++defectRevision;
      const process = controls.process.value;
      fill(controls.defect, [], process ? 'Loading defect views...' : 'Select process first'); controls.defect.disabled = true;
      loadingOptions = Boolean(process); enableAnalyze();
      if (!process || !current()) return;
      const query = params(); query.set('process', process);
      try {
        const data = await request(`/api/ta-yield-machine-options?${query}`);
        if (!current() || revision !== defectRevision) return;
        const values = [...(data.codes || []).map((value) => [`Code: ${value}`, `code|${value}`]), ...(data.categories || []).map((value) => [`Category: ${value}`, `category|${value}`])];
        fill(controls.defect, values, values.length ? 'Select defect view' : 'No defect views available', selected);
        preferredDefect = controls.defect.value;
        controls.defect.disabled = !values.length;
        if (!controls.defect.value && !dirty) clearResult('Select a defect view, then click Analyze.');
        if (!values.length) clearResult('No defect views are available for these TA Yield lots.');
      } catch (error) {
        if (!current() || revision !== defectRevision) return;
        fill(controls.defect, [], 'Unable to load defect views'); clearResult(`Unable to load defect views: ${error.message}`);
      } finally { if (current() && revision === defectRevision) { loadingOptions = false; enableAnalyze(); } }
    }
    async function loadProcesses() {
      const revision = ++processRevision; defectRevision += 1;
      const selected = controls.process.value || preferredProcess; const defect = controls.defect.value || preferredDefect;
      fill(controls.process, [], 'Loading processes...'); controls.process.disabled = true;
      fill(controls.defect, [], 'Select process first'); controls.defect.disabled = true;
      loadingOptions = true; enableAnalyze();
      if (!datesValid()) { loadingOptions = false; clearResult('Select a valid start and end date.'); return; }
      try {
        const data = await request(`/api/ta-yield-machine-processes?${params()}`);
        if (!current() || revision !== processRevision) return;
        const values = [...new Set((data.processes || []).filter((value) => typeof value === 'string' && value))];
        fill(controls.process, values, values.length ? 'Select process' : 'No processes available', selected);
        preferredProcess = controls.process.value;
        controls.process.disabled = !values.length; loadingOptions = false;
        if (!controls.process.value) { preferredDefect = ''; clearResult(values.length ? 'Select a process and defect view, then click Analyze.' : 'No processes were found for these eligible TA Yield lots.'); return; }
        await loadDefects(defect);
      } catch (error) {
        if (!current() || revision !== processRevision) return;
        fill(controls.process, [], 'Unable to load processes'); clearResult(`Unable to load processes: ${error.message}`);
      } finally { if (current() && revision === processRevision) { loadingOptions = false; enableAnalyze(); } }
    }
    async function loadLotFilters() {
      const revision = processRevision;
      try {
        const data = await request('/api/options?dataset=ta-yield');
        if (!current()) return;
        const previousSerie = controls.serie.value; const previousPn = controls.pn.value;
        fill(controls.serie, data.serie || [], 'All series'); fill(controls.pn, data.pn || [], 'All part numbers');
        const changed = previousSerie !== controls.serie.value || previousPn !== controls.pn.value;
        if (changed) clearResult();
        if (changed || revision === processRevision) await loadProcesses();
      } catch (error) {
        if (!current() || revision !== processRevision) return;
        loadingOptions = false; controls.process.disabled = true; controls.defect.disabled = true;
        fill(controls.process, [], 'Unable to load processes'); fill(controls.defect, [], 'Unable to load defect views');
        clearResult(`Unable to load TA Yield filters: ${error.message}`);
      }
    }
    async function runAnalysis() {
      if (!current() || loadingOptions || loadingResult || !controls.process.value || !controls.defect.value) return;
      if (!datesValid()) { clearResult('Select a valid start and end date.'); return; }
      const revision = ++resultRevision;
      loadingResult = true; analyze.textContent = 'Loading...'; enableAnalyze(); content.replaceChildren(); status.textContent = 'Loading Machine analysis...';
      const query = params(); const [defectType, ...defectParts] = controls.defect.value.split('|');
      query.set('process', controls.process.value); query.set('machine', '__ALL__'); query.set('defectType', defectType); query.set('defect', defectParts.join('|')); query.set('groupBy', controls.groupBy.value);
      try {
        const data = await request(`/api/ta-yield-machine?${query}`);
        if (!current() || revision !== resultRevision) return;
        rows = (data.rows || []).map((row) => ({ ...row })); totalMachines = Number(data.totalMachines) || 0;
        selectedMachines = new Set(rows.map((row) => row.machineName)); dirty = false; populateMachines();
        if (rows.length) draw(); else { content.replaceChildren(); status.textContent = 'No matching TA Yield defects were found for this selection.'; }
      } catch (error) {
        if (!current() || revision !== resultRevision) return;
        rows = []; content.replaceChildren(); populateMachines(); status.textContent = `Unable to load Machine analysis: ${error.message}`;
      } finally { if (current() && revision === resultRevision) { loadingResult = false; analyze.textContent = 'Analyze'; enableAnalyze(); } }
    }
    ['startDate', 'endDate', 'serie', 'pn'].forEach((name) => controls[name].addEventListener('change', () => { clearResult(); populateMachines(); return loadProcesses(); }));
    controls.process.addEventListener('change', () => { preferredProcess = controls.process.value; clearResult(); populateMachines(); return loadDefects(); });
    ['defect', 'groupBy'].forEach((name) => controls[name].addEventListener('change', () => { if (name === 'defect') preferredDefect = controls.defect.value; clearResult(); populateMachines(); }));
    controls.order.addEventListener('change', () => { if (rows.length) draw(); });
    analyze.addEventListener('click', runAnalysis);
    remove.addEventListener('click', () => {
      cards.delete(state); card.remove(); shelf.hidden = !shelf.children.length;
      syncAddButton();
      const target = shelf.querySelector('.ta-machine-comparison-remove') || (button?.isConnected && !button.disabled ? button : host); target?.focus?.();
    });
    cards.add(state); populateMachines(); enableAnalyze();
    if (request) void loadLotFilters();
    return card;
  }
  function add() {
    if (!canAdd()) return false;
    shelf.append(createCard(analysis.scope, analysis.chart, analysis.displayed())); shelf.hidden = false; syncAddButton(); return true;
  }
  return {
    begin, add,
    isCurrent: (token) => token === generation,
    attach(view, nextButton) {
      begin(); host = view; host.tabIndex = -1; button = nextButton; syncAddButton();
      if (!boundButtons.has(button)) { button.addEventListener('click', add); boundButtons.add(button); }
      view.append(shelf, button);
    },
    setAnalysis(token, scope, chart, displayed = () => ({})) {
      if (token !== generation || !chart.isConnected || !chart.querySelector('svg')) return false;
      analysis = { scope: { ...scope }, chart, displayed }; syncAddButton(); return true;
    },
    reset() { begin(); cards.clear(); shelf.replaceChildren(); shelf.hidden = true; count = 0; syncAddButton(); }
  };
};
