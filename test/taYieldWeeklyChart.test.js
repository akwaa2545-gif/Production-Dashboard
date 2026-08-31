import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const taYieldTargetResolver = (targets) => {
  const app = read('public/app.js');
  const start = app.indexOf('const taChartGroup');
  const end = app.indexOf('let currentConfig');
  return new Function('taYieldTargets', `${app.slice(start, end)}\nreturn taYieldTargetFor;`)(targets);
};

describe('TA yield tendency', () => {

  it('splits total yield and defect charts with one Day, Week, or Month interval control', () => {
    const html = read('public/index.html');
    const app = read('public/app.js');

    expect(html).toContain('id="taYieldChart"');
    expect(app).toContain('id="taYieldInterval"');
    expect(app).toContain('id="taYieldTrendSeries"');
    expect(app).toContain('id="taYieldTrendPartNumber"');
    expect(app).toContain('Filter only the Yield and defect tendency charts by part number.');
    expect(app).toContain('const selectedTrendScope =');
    expect(app).toContain('P/N: ${taYieldTrendPartNumber}');
    expect(app).toContain('function bindTaYieldTrendTooltips(holder)');
    expect(app).toContain('ta-yield-trend-tooltip');
    expect(app).toContain('groupRows.flatMap((row) => row.partNumbers || [])');
    expect(app).toContain("!taYieldTrendPartNumbers.includes(taYieldTrendPartNumber)");
    expect(app).toContain("tendencyParams.set('trendPn', taYieldTrendPartNumber)");
    expect(app).toContain("const dailyColumnCount = taYieldInterval === 'day' ? Math.max(31, buckets.length) : buckets.length;");
    expect(app).toContain('taYieldDayChartViewportStyle');
    expect(app).toContain('id="taYieldYieldChart"');
    expect(app).toContain('id="taYieldDefectChart"');
    expect(app).toContain('function renderTaYieldTendencyCharts(');
    expect(app).toContain('/api/ta-yield-tendency?${tendencyParams}');
    expect(app).toContain('const displayedDefectRates = buckets.map');
    expect(app).toContain('function renderTaYieldTargetParameters()');
    expect(app).toContain('/api/ta-yield-targets');
    expect(app).toContain('id="taYieldTargetPeriod"');
    expect(app).toContain('id="taYieldTargetForm"');
    expect(app).toContain('class="parameter-form ta-yield-target-form"');
    expect(read('public/styles.css')).toContain('.ta-yield-target-form{grid-template-columns:minmax(220px,2fr) repeat(2,minmax(160px,1fr)) 130px}');
    expect(app).toContain('data-ta-yield-target-tab="current"');
    expect(app).toContain('data-ta-yield-target-tab="upcoming"');
    expect(app).toContain('data-ta-yield-target-tab="history"');
    expect(app).toContain('id="taYieldTargetSearch"');
    expect(app).toContain('class="ta-yield-target-group"');
    expect(read('public/styles.css')).toContain('.ta-yield-target-tabs');
    expect(app).toContain("const currentPeriod = bangkokToday().slice(0, 7);");
    expect(app).toContain("taYieldTargetTab === 'history' ? right.period.localeCompare(left.period)");
    expect(app).toContain("['ArrowLeft', 'ArrowRight', 'Home', 'End']");
    expect(app).toContain('const yieldColumns = buckets.map(');
    expect(app).toContain("' below-target'");
    expect(app).toContain('function taYieldTargetPeriod(');
    expect(app).toContain('function taYieldTargetFor(');
    expect(app).toContain('taYieldTargets[shortTaSeries(serie)]?.[period]');
    expect(app).not.toContain('preferSeries = false');
    expect(app).toContain('Target scope');
    expect(app).toContain('Target</span>');
    expect(app).toContain('class="target-line"');
    expect(app).toContain('taYieldTrendSeries = byId(\'taYieldTrendSeries\').value');
    expect(app).toContain('taYieldTargetFor(taYieldTrendSeries, row.month)');
    expect(app).toContain('requestAnimationFrame(scrollTaYieldTendencyToLatest)');
    expect(app).toContain("#taYieldYieldChart .sc-yield-chart-scroll, #taYieldDefectChart .sc-yield-chart-scroll");
    expect(app).toContain('viewport.scrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth)');
    expect(app).toContain('class="ta-yield-column-value"');
    expect(app).toContain('${bars}${defectTotalLabels}${labels}');
    expect(app).toContain('groups.reduce((total, group) => total + Math.max(0, row.input ? (row.groups[group] || 0) / row.input * 100 : 0), 0)');
    expect(app).toContain('const displayedDefectRates = buckets.map');
    expect(app).toContain('Math.max(...displayedDefectRates)');
    expect(app).toContain('async function latestTaYieldStagingDate(todayString)');
    expect(app).toContain("request('/api/staging-status')");
    expect(app).toContain('const initialEndDate = isTaYield ? await latestTaYieldStagingDate(todayString) : todayString;');
    expect(app).toContain("if (isTaYield && selectedDataset() !== 'ta-yield') return;");
  });

  it('does not render the removed TA weekly tendency panel', () => {
    const html = read('public/index.html');
    const app = read('public/app.js');

    expect(html).toContain('id="taYieldWeeklySection"');
    expect(app).toContain('weeklySection?.remove()');
    expect(app).not.toContain('insertBefore(weeklySection, tendencySection)');
  });

  it('does not fetch removed weekly data and lets TA charts use the full dashboard width', () => {
    const app = read('public/app.js');
    const styles = read('public/styles.css');

    expect(app).not.toContain("request(`/api/ta-yield-weekly?${params}`)");
    expect(app).not.toContain('renderTaYieldWeeklyChart(weeklyRows)');
    expect(styles).toContain('#taYieldSection{max-width:none;margin-inline:0}');
  });

  it('centers TA charts that fit and prevents summary cards from overflowing the viewport', () => {
    const styles = read('public/styles.css');

    expect(styles).toContain('#taYieldGroupYieldCharts{grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr));width:100%}');
    expect(styles).toContain('#taYieldSection{min-width:0;inline-size:100%;max-inline-size:100%;overflow-x:clip}');
    expect(styles).toContain('#taYieldSection{grid-template-columns:minmax(0,1fr)}#taYieldSection>*{min-width:0;max-width:100%}');
    expect(styles).toContain('.app-tabs{max-width:100%;overflow-x:auto;overscroll-behavior-x:contain}');
    expect(styles).toContain('@media(max-width:1220px){.page-header{margin-inline:-28px;padding-inline:28px}}');
    expect(styles).toContain('@media(max-width:800px){.page-header{margin-inline:-16px;padding-inline:16px}}');
    expect(styles).toContain('#taYieldSection .sc-yield-summary{grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr))}');
    expect(styles).not.toContain('@container (min-width: 760px) { .ta-yield-tendency-panel .sc-yield-chart-scroll { display: flex; justify-content: center; } }');
    expect(read('public/app.js')).toContain('width:clamp(${width}px, 100%, 1280px); min-width:${width}px; max-width:none; margin-inline:auto');
  });

  it('centers the TA Yield Line chart with the same fit-or-scroll behavior as Column view', () => {
    const app = read('public/app.js');
    expect(app).toContain("chart.style.width = `clamp(${width}px, 100%, 1280px)`");
    expect(app).toContain("chart.style.minWidth = `${width}px`");
    expect(app).toContain('const left = 54; const right = 54;');
    expect(app).toContain('const left = 52; const right = 52;');
  });

  it('shows an accessible tooltip for points in the TA Yield Line view', () => {
    const app = read('public/app.js');

    expect(app).toContain('class="ta-yield-line-point"');
    expect(app).toContain('tabindex="0"');
    expect(app).toContain('.ta-yield-tendency-panel .ta-yield-line-point');
    expect(app).toContain("mark.addEventListener('focus', show)");
    expect(app).toContain("mark.addEventListener('blur'");
  });

  it('shows TA yield columns and targets without the green Yield line', () => {
    const app = read('public/app.js');
    const start = app.indexOf("byId('taYieldYieldChart').innerHTML");
    const mainChart = app.slice(start, app.indexOf('if (taYieldTrendChartType', start));

    expect(mainChart).not.toContain('yield-line-key');
    expect(mainChart).not.toContain('<polyline class="yield-line"');
    expect(mainChart).not.toContain('${yieldDots}');
  });

  it('uses the saved target for the selected TA series', () => {
    const app = read('public/app.js');
    const targetLookup = app.slice(app.indexOf('function taYieldTargetFor'), app.indexOf('let currentConfig'));
    const tendencyTargetBlock = app.slice(app.indexOf('const targetsByBucket'), app.indexOf('const valuesForScale'));

    expect(targetLookup).toContain('taYieldTargets[shortTaSeries(serie)]?.[period]');
    expect(tendencyTargetBlock).toContain('taYieldTargetFor(taYieldTrendSeries, row.month)');
  });

  it('falls back to a product-group target for raw Standard Production lines', () => {
    const targetFor = taYieldTargetResolver({
      'Standard Production': { '2026-08': 94.5 }
    });

    expect(targetFor('Ta NEO Capacitor PSG series A3 case', '2026-08-24')).toBe(94.5);
  });

  it('keeps Total Yield and Total Target visible above ordinary Line-view series', () => {
    const app = read('public/app.js');
    const lineRenderer = app.slice(app.indexOf('function renderTaYieldMultiSeriesChart'), app.indexOf('const alignTaYieldTrendCharts'));

    expect(lineRenderer).toContain('const regularPlot = series.map');
    expect(lineRenderer).toContain('class="ta-yield-total-line"');
    expect(lineRenderer).toContain('class="ta-yield-total-target-line"');
    expect(lineRenderer).toContain('${regularPlot}${totalPlot}${targetPlot}');
    expect(lineRenderer).toContain('const targetLegend = target.some(Number.isFinite)');
    expect(lineRenderer).toContain("${marks(target, '#f15a24', targetLabel, 4)}");
    expect(lineRenderer).toContain("const totalPlot = isTotal ?");
    expect(lineRenderer).toContain("const totalLegend = isTotal ?");
  });

  it('renders the product-group trend beneath the main Total yield and Defect rate charts', () => {
    const app = read('public/app.js');
    const styles = read('public/styles.css');

    expect(app).toContain("setAttribute('aria-labelledby', 'taYieldGroupTrendTitle')");
    expect(app).toContain("renderTaYieldGroupTendencyCharts(groupRows");
    expect(app).toContain("const productGroupOrder = ['Standard Production', 'Facedown', 'GPS']");
    expect(app).toContain('productGroupOrder.map(chart).join(\'\')');
    const productGroupRenderer = app.slice(app.indexOf('function renderTaYieldGroupTendencyCharts'), app.indexOf('function renderTaYieldTendencyCharts'));
    expect(productGroupRenderer).not.toContain('style="min-width:${width}px"');
    expect(app).toContain('function bindTaYieldGroupTrendTooltips(holder)');
    expect(app).toContain('class="ta-yield-group-tooltip"');
    expect(app).toContain('bindTaYieldGroupTrendTooltips(holder);');
    expect(styles).toContain('#taYieldGroupYieldCharts .sc-yield-chart-scroll{overflow:hidden}');
    expect(styles).toContain('#taYieldGroupYieldCharts .sc-yield-chart-scroll svg{width:100%;min-width:0;height:250px}');
    expect(app).toContain('const width = 520; const height = 250;');
    expect(app).toContain("const labelStep = Math.max(1, Math.ceil(buckets.length / 12));");
    expect(styles).toContain('#taYieldGroupYieldCharts{grid-template-columns:repeat(3,minmax(0,1fr))}');
    expect(styles).toContain('#taYieldGroupYieldCharts .sc-yield-chart-scroll svg{width:100%;min-width:0;height:250px}');
    expect(styles).toContain('.ta-yield-group-tooltip');
  });

  it('keeps every TA trend filter directly visible in the heading without constraining the dashboard width', () => {
    const app = read('public/app.js');
    const styles = read('public/styles.css');

    expect(app).toContain("holder.querySelector('.table-heading').append(chartTypeLabel)");
    expect(styles).toMatch(/#taYieldChart\s*>\s*\.table-heading\s*\{[^}]*justify-content:\s*flex-start/);
    expect(styles).toContain('#taYieldSection{max-width:none;margin-inline:0}');
  });

  it('shows accessible chart skeletons while TA tendency filters refresh', () => {
    const app = read('public/app.js');
    const styles = read('public/styles.css');

    expect(app).toContain('function renderTaYieldTendencySkeleton()');
    expect(app).toContain('class="ta-yield-chart-skeleton"');
    expect(app).toContain('aria-busy="true"');
    expect(app).toContain('if (isTaYield) renderTaYieldTendencySkeleton();');
    expect(app).toContain('function renderTaYieldTendencyLoadError(message)');
    expect(app).toContain('if (isTaYield) renderTaYieldTendencyLoadError(error.message);');
    expect(styles).toContain('.ta-yield-chart-skeleton');
    expect(styles).toContain('@keyframes ta-yield-skeleton-shimmer');
  });
});
