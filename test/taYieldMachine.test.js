import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mapTaYieldMachineEvents } from '../src/taYieldMapping.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('TA Yield Machine tab', () => {
  it('aggregates eligible-lot defects by LotStartLog date, machine, and selected yield category', () => {
    const rows = [
      { lotNo: '6H01N00001', occuredOn: '2026-08-01T03:00:00.000Z', machineName: 'AN-01' },
      { lotNo: '6H01N00001', occuredOn: '2026-08-01T03:00:00.000Z', machineName: ' AN-01 ' },
      { lotNo: '6H01N00002', occuredOn: '2026-08-01T05:00:00.000Z', machineName: 'AN-01' },
      { lotNo: '6H01N00003', occuredOn: '2026-08-01T05:00:00.000Z', machineName: 'AN-02' }
    ];
    const lots = [
      { lotNo: '6H01N00001', modes: [{ mode: '1304_Welding_Def', category: 'Inproc Dw', quantity: 12 }, { mode: '1815_ESR_Def', category: 'ESR', quantity: 4 }] },
      { lotNo: '6H01N00002', modes: [{ mode: '1304_Welding_Def', category: 'Inproc Dw', quantity: 3 }] }
    ];

    expect(mapTaYieldMachineEvents(rows, lots, { type: 'category', value: 'Inproc Dw' })).toEqual({
      linkedModes: ['1304_Welding_Def'],
      rows: [{ date: '2026-08-01', machineName: 'AN-01', mode: '1304_Welding_Def', quantity: 15, lotCount: 2 }]
    });
    expect(mapTaYieldMachineEvents(rows, lots, { type: 'category', value: 'Inproc Dw' }, 'month')).toEqual({
      linkedModes: ['1304_Welding_Def'],
      rows: [{ date: '2026-08', machineName: 'AN-01', mode: '1304_Welding_Def', quantity: 15, lotCount: 2 }]
    });
  });

  it('provides a TA-only Machine tab with dependent process and machine filters', () => {
    const html = read('public/index.html');
    const app = read('public/app.js');

    expect(html).toContain('id="taYieldMachineTab"');
    expect(html).toContain('data-view="ta-yield-machine"');
    expect(app).toContain('function ensureTaYieldMachineView()');
    expect(app).toContain('function renderTaYieldMachineView()');
    expect(app).toContain('1.1stAnodization');
    expect(app).toContain('2.Welding');
    expect(app).toContain('3.Ei');
    expect(app).toContain('id="taMachineGroupBy"');
    expect(app).toContain('id="taMachineSerie"');
    expect(app).toContain('id="taMachinePartNumber"');
    expect(app).toContain("request('/api/options?dataset=ta-yield')");
    expect(app).toContain("params.set('serie', selectedSerie)");
    expect(app).toContain("params.set('pn', selectedPartNumber)");
    expect(app.indexOf('id="taMachineProcess"')).toBeLessThan(app.indexOf('id="taMachinePartNumber"'));
    expect(app).toContain('<option value="day">Day</option>');
    expect(app).toContain('<option value="week">Week</option>');
    expect(app).toContain('<option value="month">Month</option>');
    expect(app).toContain("groupBy: 'day'");
    expect(app).toContain('function renderTaMachineGroupByControl()');
    expect(app).toContain("querySelector('.ta-machine-chart-summary')");
    expect(app).toContain('groupBy: selectedGroupBy');
    expect(app).toContain('/api/ta-yield-machine-options?');
    expect(app).toContain('/api/ta-yield-machine?');
    expect(app).toContain('Defect share (%)');
    expect(app).toContain('percentage(row.quantity).toFixed(1)');
    expect(app).toContain('Date → Machine');
    expect(app).toContain('Machine → Date');
    expect(app).toContain('function machineDateLines(rows, order = \'machine-date\')');
    expect(app).toContain('ta-machine-line-order');
    expect(app).toContain('ta-machine-group-divider');
    expect(app).not.toContain('ta-machine-group-label');
    expect(app).not.toContain('ta-machine-point-value');
    expect(app).toContain('.ta-machine-date-machine-chart circle');
    expect(app).toContain('ta-machine-point-tooltip');
    expect(app).toContain('enableMachinePointTooltips');
    expect(app).toContain('const width = 1440;');
    expect(app).toContain('const groupStep = Math.max(1, Math.ceil(groupStarts.length / 12));');
    expect(app).toContain('const visibleGroupStarts = groupStarts.filter((_, index) => index % groupStep === 0 || index === groupStarts.length - 1);');
    expect(app).toContain("const groupLabel = (point) => order === 'machine-date' ? point.machineName : point.date.slice(5);");
    expect(app).toContain('const labels = labelStarts.map(({ point, index }) =>');
    expect(app).toContain('preserveAspectRatio="none"');
    expect(app).toContain('scroll.clientWidth + scroll.scrollLeft - tooltip.offsetWidth - 8');
    expect(app).not.toContain("chart.style.setProperty('width', `${width}px`, 'important')");
  });

  it('uses the available dashboard width for the Machine workspace and chart card', () => {
    const styles = read('public/styles.css');
    expect(styles).toContain('#taYieldMachineView { max-width: none; width: 100%; }');
    expect(styles).toContain('#taYieldMachineView .ta-machine-chart-wrap { width: 100%; box-sizing: border-box; }');
    expect(styles).toContain('.ta-machine-line-scroll{position:relative;overflow:hidden}');
    expect(styles).toContain('.ta-machine-date-machine-chart{width:100%!important;height:440px!important;min-width:0}');
    expect(styles).toContain('.ta-machine-line-series circle { cursor: help; transition: r .15s ease; }');
    expect(styles).not.toContain('.ta-machine-line-series circle { stroke: #fff;');
  });

  it('shows matching-machine coverage when more than two machines match the selected filters', () => {
    const app = read('public/app.js');

    expect(app).toContain('data.totalMachines');
    expect(app).toContain('matching machines');
  });

  it('shows every machine label vertically when the chart is ordered Machine to Date', () => {
    const app = read('public/app.js');

    expect(app).toContain("const labelStarts = order === 'machine-date' ? groupStarts : visibleGroupStarts;");
    expect(app).toContain('labelStarts.map(({ point, index }) =>');
    expect(app).toContain('transform="rotate(-90 ${x(index)} ${height - 16})"');
    expect(app).toContain('ta-machine-vertical-label');
  });

  it('provides a compact checkbox picker for the Machine-tab-only filter', () => {
    const app = read('public/app.js');

    expect(app).toContain('class="ta-machine-picker-trigger"');
    expect(app).toContain('type="checkbox"');
    expect(app).toContain('data-ta-machine-option');
    expect(app).toContain('function renderTaMachineSelectionControl()');
    expect(app).toContain('taYieldMachineSelectedMachines');
    expect(app).toContain('taYieldMachineRows.filter');
  });
});
