(() => {
  'use strict';

  const document = globalThis.document;
  const charts = new Map();
  let observer = null;
  let disposed = false;
  let sequence = 0;

  function chartPeriods(svg) {
    const points = [...svg.querySelectorAll('circle')].sort((a, b) => Number(a.getAttribute('cx')) - Number(b.getAttribute('cx')));
    const positions = new Set();
    return points.flatMap((point) => {
      const position = Number(point.getAttribute('cx'));
      if (positions.has(position)) return [];
      positions.add(position);
      const title = point.querySelector('title')?.textContent || '';
      return [title.split('·').slice(0, 2).map((part) => part.trim()).join(' · ') || String(positions.size)];
    });
  }

  function attach(svg) {
    if (charts.has(svg) || svg.dataset.machineChartEnhanced) return;
    const viewport = svg.parentElement;
    const holder = viewport?.parentElement;
    if (!holder) return;
    const periods = chartPeriods(svg);
    svg.querySelectorAll('circle').forEach((point) => {
      if (!point.hasAttribute('tabindex')) point.setAttribute('tabindex', '0');
    });
    svg.dataset.machineChartEnhanced = 'true';
    holder.classList.add('machine-chart-explorer');
    const controller = globalThis.TaYieldChartInteractions.create({
      holder,
      charts: [{ container: viewport, positioning: 'endpoints', gridSelector: '.ta-machine-grid', labelSelector: '.ta-machine-date-label', preserveAspectRatio: 'none' }],
      periods, interval: 'point', scopeKey: `machine-chart-${++sequence}`,
      toolbarBefore: viewport, tooltipSelector: '.ta-machine-point-tooltip'
    });
    charts.set(svg, { controller, holder });
  }

  function scan() {
    if (disposed || !globalThis.TaYieldChartInteractions) return;
    charts.forEach(({ controller, holder }, svg) => {
      if (svg.isConnected) return;
      controller.destroy();
      charts.delete(svg);
      if (![...charts.values()].some((chart) => chart.holder === holder)) holder.classList.remove('machine-chart-explorer');
    });
    document.querySelectorAll('.ta-machine-date-machine-chart').forEach(attach);
  }

  function start() {
    if (disposed) return;
    scan();
    if (typeof globalThis.MutationObserver !== 'function') return;
    observer = new globalThis.MutationObserver(scan);
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    observer?.disconnect();
    document.removeEventListener('DOMContentLoaded', start);
    charts.forEach(({ controller, holder }) => {
      controller.destroy();
      holder.classList.remove('machine-chart-explorer');
    });
    charts.clear();
  }

  globalThis.TaMachineChartInteractions = { scan, dispose };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
