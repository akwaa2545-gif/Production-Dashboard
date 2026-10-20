(() => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
  let chartSequence = 0;

  function validRange(range) {
    if (!Number.isFinite(range?.start) || !Number.isFinite(range?.end) || range.end <= range.start) return { start: 0, end: 1 };
    const span = Math.min(1, range.end - range.start);
    const start = clamp(range.start, 0, 1 - span);
    return { start, end: start + span };
  }

  function zoomRange(range, factor, anchor = .5, minSpan = .1) {
    const current = validRange(range);
    if (!Number.isFinite(factor) || factor <= 0) return current;
    const fraction = Number.isFinite(anchor) ? clamp(anchor, 0, 1) : .5;
    const minimum = Number.isFinite(minSpan) ? clamp(minSpan, Number.EPSILON, 1) : .1;
    const span = current.end - current.start;
    const nextSpan = clamp(span / factor, minimum, 1);
    const start = clamp(current.start + span * fraction - nextSpan * fraction, 0, 1 - nextSpan);
    return { start, end: start + nextSpan };
  }

  function panRange(range, delta) {
    const current = validRange(range);
    if (!Number.isFinite(delta)) return current;
    const span = current.end - current.start;
    const start = clamp(current.start + delta, 0, 1 - span);
    return { start, end: start + span };
  }

  function svgElement(document, name, attributes = {}) {
    const node = document.createElementNS(SVG_NS, name);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
    return node;
  }

  function geometryFor(node) {
    const attributes = ['x', 'cx', 'x1', 'x2', 'width'].reduce((values, key) => {
      const value = node.getAttribute(key);
      return value !== null && Number.isFinite(Number(value)) ? { ...values, [key]: Number(value) } : values;
    }, {});
    const points = node.getAttribute('points');
    const rotation = (node.getAttribute('transform') || '').match(/^rotate\(\s*([-\d.]+)[,\s]+([-\d.]+)[,\s]+([-\d.]+)\s*\)$/);
    const isText = node.tagName.toLowerCase() === 'text';
    const measuredText = isText ? node.getComputedTextLength?.() : 0;
    return {
      node, attributes, points: points ? points.trim().split(/[\s,]+/).map(Number) : null,
      originalTabindex: node.getAttribute('tabindex'), originalAriaHidden: node.getAttribute('aria-hidden'),
      textWidth: isText ? measuredText > 0 ? measuredText : (node.textContent || '').length * 6 : 0,
      textAnchor: node.getAttribute('text-anchor') || 'start', originalY: Number(node.getAttribute('y') ?? node.getAttribute('cy')),
      textHeight: isText ? Number.parseFloat(globalThis.getComputedStyle?.(node)?.fontSize) || 11 : 0,
      rotation: rotation ? rotation.slice(1).map(Number) : null
    };
  }

  function prepareChart(config, count, document, clipId) {
    const svg = config.container?.querySelector('svg');
    if (!svg) return null;
    const viewport = svg.parentElement;
    svg.dataset.chartEnhanced = 'true';
    viewport.classList.add('ta-chart-interactive');
    const dimensions = (svg.getAttribute('viewBox') || '').trim().split(/\s+/).map(Number);
    const width = dimensions[2] || 860;
    const height = dimensions[3] || 250;
    const gridSelector = config.gridSelector || '.gridline';
    const grid = svg.querySelector(gridSelector);
    const left = Number(grid?.getAttribute('x1')) || 54;
    const right = Number(grid?.getAttribute('x2')) || width - 54;
    const fixed = [];
    const moving = [];
    const defs = svgElement(document, 'defs');
    const clip = svgElement(document, 'clipPath', { id: clipId });
    const clipRect = svgElement(document, 'rect', { x: left, y: 0, width: right - left, height });
    const plot = svgElement(document, 'g', { 'clip-path': `url(#${clipId})`, class: 'ta-chart-plot' });
    const labelClipRect = config.labelSelector ? svgElement(document, 'rect', { x: 0, y: 0, width, height }) : null;
    const labelPlot = config.labelSelector ? svgElement(document, 'g', { 'clip-path': `url(#${clipId}-labels)` }) : null;
    clip.append(clipRect);
    defs.append(clip);
    if (labelClipRect) {
      const labelClip = svgElement(document, 'clipPath', { id: `${clipId}-labels` });
      labelClip.append(labelClipRect);
      defs.append(labelClip);
    }
    [...svg.children].forEach((node) => {
      const tag = node.tagName.toLowerCase();
      const x = Number(node.getAttribute('x'));
      const axisText = tag === 'text' && (node.classList.contains('axis-title') || x < left || x > right);
      const fullLine = tag === 'line' && Number(node.getAttribute('x1')) === left && Number(node.getAttribute('x2')) === right;
      const fixedGroup = tag === 'g' && (config.fixedGroupSelector ? node.matches(config.fixedGroupSelector) : node.querySelector(gridSelector));
      if (tag === 'defs' || tag === 'title' || tag === 'desc') return;
      if (axisText || fullLine || node.matches(gridSelector) || fixedGroup) fixed.push(...[node, ...node.querySelectorAll('rect,text,circle,line,polyline,polygon')].map(geometryFor));
      else { (labelPlot && node.matches(config.labelSelector) ? labelPlot : plot).append(node); moving.push(node); }
    });
    svg.append(defs, plot);
    if (labelPlot) svg.append(labelPlot);
    const records = associateLabelDecorations(moving.flatMap((node) => [node, ...node.querySelectorAll('rect,text,circle,line,polyline,polygon')].map((element) => ({ ...geometryFor(element), footerLabel: Boolean(config.labelSelector && element.matches(config.labelSelector)) }))));
    const endpointFactor = config.positioning === 'endpoints' ? Math.max(0, count - 1) / count : 1;
    const endpointOffset = config.positioning === 'endpoints' ? .5 / count : 0;
    svg.setAttribute('preserveAspectRatio', config.preserveAspectRatio || 'xMinYMid meet');
    viewport.setAttribute('tabindex', '0');
    viewport.setAttribute('role', 'group');
    viewport.setAttribute('aria-label', `${svg.getAttribute('aria-label') || 'Chart'}. Scroll to zoom. Drag to move. Use plus, minus, arrow keys or Home.`);
    viewport.style.width = '100%';
    svg.style.width = '100%';
    svg.style.minWidth = '0';
    svg.style.maxWidth = 'none';
    return { svg, viewport, width, coordinateWidth: width, height, left, right, fixed, records, clipRect, labelClipRect, endpointFactor, endpointOffset, plotWidth: right - left };
  }

  function updateGeometry(chart, range) {
    const measured = chart.viewport.clientWidth || chart.viewport.getBoundingClientRect().width;
    if (!measured || measured <= chart.left + 24) return;
    const coordinateWidth = Math.min(measured, chart.width);
    const plotWidth = Math.max(24, coordinateWidth - chart.left - (chart.width - chart.right));
    const right = chart.left + plotWidth;
    const span = range.end - range.start;
    const mapX = (x) => chart.left + (((x - chart.left) / (chart.right - chart.left) * chart.endpointFactor + chart.endpointOffset - range.start) / span) * plotWidth;
    const scale = plotWidth / (chart.right - chart.left) * chart.endpointFactor / span;
    chart.plotWidth = plotWidth;
    chart.coordinateWidth = coordinateWidth;
    chart.svg.setAttribute('viewBox', `0 0 ${coordinateWidth} ${chart.height}`);
    chart.svg.dataset.chartStart = String(range.start);
    chart.svg.dataset.chartEnd = String(range.end);
    chart.clipRect.setAttribute('width', String(plotWidth));
    chart.labelClipRect?.setAttribute('width', String(coordinateWidth));
    chart.fixed.forEach(({ node, attributes }) => {
      if ('x1' in attributes) { node.setAttribute('x1', String(chart.left)); node.setAttribute('x2', String(right)); }
      if ('x' in attributes) node.setAttribute('x', String(attributes.x >= chart.right ? right + attributes.x - chart.right : attributes.x));
    });
    const labels = visibleTextLabels(chart.records, mapX, chart);
    chart.records.forEach((record) => updateMark(record, mapX, scale, chart, labels));
    chart.viewport.dataset.chartZoomed = String(span < .99999);
  }

  function updateMark(record, mapX, scale, chart, labels) {
    const { node, attributes, points } = record;
    const backdrop = node.classList.contains('ta-yield-column-value-backdrop');
    Object.entries(attributes).forEach(([key, value]) => {
      const next = key === 'width' ? backdrop ? value : value * scale : backdrop && key === 'x' ? mapX(value + attributes.width / 2) - attributes.width / 2 : mapX(value);
      node.setAttribute(key, String(next));
    });
    if (points) node.setAttribute('points', points.map((value, index) => index % 2 === 0 ? mapX(value) : value).join(' '));
    if (record.rotation) node.setAttribute('transform', `rotate(${record.rotation[0]} ${mapX(record.rotation[1])} ${record.rotation[2]})`);
    const isValue = backdrop || node.classList.contains('ta-yield-column-value');
    const isSeries = node.classList.contains('ta-yield-series-column-label') || node.classList.contains('ta-yield-series-label-swatch');
    let labelVisible = labels.get(record.companionLabel || node) !== false;
    if (backdrop) {
      const center = mapX(attributes.x + attributes.width / 2);
      labelVisible = labelVisible && center - attributes.width / 2 >= chart.left + 2 && center + attributes.width / 2 <= chart.left + chart.plotWidth - 2;
    }
    if (isValue || isSeries || node.tagName.toLowerCase() === 'text') node.style.visibility = labelVisible ? '' : 'hidden';
    updateMarkFocus(record, mapX, chart);
  }

  function textBounds({ attributes, textWidth, textHeight, textAnchor, originalY, rotation }, mapX) {
    const position = mapX(attributes.x);
    const offset = textAnchor === 'middle' ? textWidth / 2 : textAnchor === 'end' ? textWidth : 0;
    const bounds = { left: position - offset, right: position - offset + textWidth, top: originalY - textHeight, bottom: originalY + 2 };
    if (!rotation) return bounds;
    const angle = rotation[0] * Math.PI / 180;
    const pivotX = mapX(rotation[1]); const pivotY = rotation[2];
    const corners = [[bounds.left, bounds.top], [bounds.right, bounds.top], [bounds.left, bounds.bottom], [bounds.right, bounds.bottom]].map(([x, y]) => [pivotX + (x - pivotX) * Math.cos(angle) - (y - pivotY) * Math.sin(angle), pivotY + (x - pivotX) * Math.sin(angle) + (y - pivotY) * Math.cos(angle)]);
    return { left: Math.min(...corners.map(([x]) => x)), right: Math.max(...corners.map(([x]) => x)), top: Math.min(...corners.map(([, y]) => y)), bottom: Math.max(...corners.map(([, y]) => y)) };
  }

  function associateLabelDecorations(records) {
    const text = records.filter(({ node }) => node.tagName.toLowerCase() === 'text');
    return records.map((record) => {
      const backdrop = record.node.classList.contains('ta-yield-column-value-backdrop');
      const swatch = record.node.classList.contains('ta-yield-series-label-swatch');
      if (!backdrop && !swatch) return record;
      const x = backdrop ? record.attributes.x + record.attributes.width / 2 : record.attributes.cx + 6;
      const y = record.originalY + (backdrop ? 12 : 3);
      return { ...record, companionLabel: text.find((label) => Math.abs(label.attributes.x - x) < .01 && Math.abs(label.originalY - y) < .01)?.node };
    });
  }

  function visibleTextLabels(records, mapX, chart) {
    const accepted = [];
    const labels = new Map();
    records.filter(({ node }) => node.tagName.toLowerCase() === 'text').forEach((record) => {
      const bounds = textBounds(record, mapX);
      const fits = record.footerLabel
        ? bounds.left >= 8 && bounds.right <= chart.coordinateWidth - 8
        : bounds.left >= chart.left + 2 && bounds.right <= chart.left + chart.plotWidth - 2;
      const overlaps = accepted.some((other) => bounds.left < other.right + 2 && bounds.right + 2 > other.left && bounds.top < other.bottom && bounds.bottom > other.top);
      const visible = fits && !overlaps;
      labels.set(record.node, visible);
      if (visible) accepted.push(bounds);
    });
    return labels;
  }

  function pointerX(chart, clientX) {
    const bounds = chart.svg.getBoundingClientRect();
    return (clientX - bounds.left) * chart.coordinateWidth / (bounds.width || chart.coordinateWidth);
  }

  function updateMarkFocus({ node, attributes, originalTabindex, originalAriaHidden }, mapX, chart) {
    if (originalTabindex === null) return;
    const position = mapX(attributes.cx ?? attributes.x);
    const visible = position >= chart.left && position <= chart.left + chart.plotWidth;
    node.setAttribute('tabindex', visible ? originalTabindex : '-1');
    if (!visible) {
      if (node.ownerDocument.activeElement === node) chart.viewport.focus({ preventScroll: true });
      node.setAttribute('aria-hidden', 'true');
    } else if (originalAriaHidden === null) node.removeAttribute('aria-hidden');
    else node.setAttribute('aria-hidden', originalAriaHidden);
  }

  function buildToolbar(holder, document, id, toolbarBefore) {
    const toolbar = document.createElement('div');
    toolbar.className = 'ta-yield-chart-navigation';
    toolbar.setAttribute('role', 'group');
    toolbar.setAttribute('aria-label', 'Chart navigation');
    const buttons = [['zoom-out', '−', 'Zoom out'], ['zoom-in', '+', 'Zoom in'], ['reset', 'Reset', 'Reset chart view']].map(([action, text, label]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.chartAction = action;
      button.textContent = text;
      button.setAttribute('aria-label', label);
      button.title = label;
      toolbar.append(button);
      return button;
    });
    const output = document.createElement('output');
    output.className = 'ta-yield-chart-range';
    output.setAttribute('aria-live', 'polite');
    output.setAttribute('aria-atomic', 'true');
    const help = document.createElement('span');
    help.className = 'ta-yield-chart-help';
    help.id = `${id}-help`;
    help.textContent = 'Scroll to zoom · Drag to move';
    toolbar.append(output, help);
    holder.insertBefore(toolbar, toolbarBefore || holder.querySelector('.ta-yield-tendency-panel'));
    return { toolbar, buttons, output, help };
  }

  function create({ holder, charts = [], periods = [], interval = 'period', scopeKey = '', initialState, toolbarBefore, tooltipSelector = '.ta-yield-trend-tooltip' } = {}) {
    const document = holder.ownerDocument || globalThis.document;
    const count = Math.max(1, periods.length);
    const minSpan = Math.min(1, 2 / count);
    const id = `ta-chart-${++chartSequence}`;
    let range = initialState?.scopeKey === scopeKey ? zoomRange(validRange(initialState), 1, .5, minSpan) : { start: 0, end: 1 };
    let destroyed = false;
    let pending = null;
    let drag = null;
    const cleanups = [];
    const requestFrame = globalThis.requestAnimationFrame || ((callback) => globalThis.setTimeout(callback, 16));
    const cancelFrame = globalThis.cancelAnimationFrame || globalThis.clearTimeout;
    const prepared = charts.map((chart, index) => prepareChart(chart, count, document, `${id}-${index}`)).filter(Boolean);
    const controls = buildToolbar(holder, document, id, toolbarBefore);
    const listen = (node, type, listener, options) => { node.addEventListener(type, listener, options); cleanups.push(() => node.removeEventListener(type, listener, options)); };
    const hideTooltips = () => holder.querySelectorAll(tooltipSelector).forEach((tooltip) => { tooltip.hidden = true; });
    function draw() {
      pending = null;
      if (destroyed) return;
      prepared.forEach((chart) => updateGeometry(chart, range));
      const first = clamp(Math.floor(range.start * count + 1e-8), 0, count - 1);
      const last = clamp(Math.ceil(range.end * count - 1e-8) - 1, first, count - 1);
      const label = (period) => String(period?.label ?? period?.month ?? period ?? '');
      const unit = `${interval}${last > first ? 's' : ''}`;
      controls.output.textContent = periods.length ? `${label(periods[first])}${last !== first ? ` – ${label(periods[last])}` : ''} · ${last - first + 1} / ${count} ${unit}` : 'No periods';
      const span = range.end - range.start;
      controls.buttons[0].disabled = span >= 1 - 1e-8;
      controls.buttons[1].disabled = span <= minSpan + 1e-8;
      controls.buttons[2].disabled = span >= 1 - 1e-8;
    }
    function schedule() { if (!destroyed && pending === null) pending = requestFrame(draw); }
    function apply(next) { if (destroyed) return; range = next; hideTooltips(); schedule(); }
    const zoom = (factor, anchor = .5) => apply(zoomRange(range, factor, anchor, minSpan));
    const pan = (delta) => apply(panRange(range, delta));
    const reset = () => apply({ start: 0, end: 1 });
    function finishDrag() {
      if (!drag) return;
      const { chart, pointerId } = drag;
      drag = null;
      chart.viewport.classList.remove('is-dragging');
      holder.classList.remove('ta-chart-is-dragging');
      hideTooltips();
      if (chart.viewport.hasPointerCapture?.(pointerId)) chart.viewport.releasePointerCapture(pointerId);
    }
    function bindChart(chart) {
      const viewport = chart.viewport;
      viewport.setAttribute('aria-describedby', controls.help.id);
      listen(viewport, 'wheel', (event) => {
        if (!Number.isFinite(event.deltaY) || !event.deltaY) return;
        const anchor = clamp((pointerX(chart, event.clientX) - chart.left) / chart.plotWidth, 0, 1);
        const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 300 : 1);
        event.preventDefault();
        zoom(Math.exp(clamp(-delta * .002, -.7, .7)), anchor);
      }, { passive: false });
      listen(viewport, 'pointerdown', (event) => {
        if (event.button !== 0 || event.isPrimary === false || drag) return;
        const x = pointerX(chart, event.clientX);
        if (x < chart.left || x > chart.left + chart.plotWidth) return;
        drag = { chart, pointerId: event.pointerId, x: event.clientX, y: event.clientY, range: { ...range }, active: false };
      });
      listen(viewport, 'pointermove', (event) => {
        if (!drag || drag.pointerId !== event.pointerId || drag.chart !== chart) return;
        const dx = event.clientX - drag.x;
        if (!drag.active) {
          if (Math.abs(dx) < 4 || Math.abs(dx) < Math.abs(event.clientY - drag.y)) return;
          drag = { ...drag, active: true };
          viewport.setPointerCapture?.(event.pointerId);
          viewport.classList.add('is-dragging');
          holder.classList.add('ta-chart-is-dragging');
        }
        event.preventDefault();
        const chartDx = pointerX(chart, event.clientX) - pointerX(chart, drag.x);
        apply(panRange(drag.range, -chartDx / chart.plotWidth * (drag.range.end - drag.range.start)));
      });
      ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((type) => listen(viewport, type, (event) => { if (drag?.pointerId === event.pointerId) finishDrag(); }));
      listen(viewport, 'pointerleave', () => { if (drag && !drag.active) finishDrag(); });
      listen(viewport, 'keydown', (event) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const actions = { '+': () => zoom(1.5), '=': () => zoom(1.5), '-': () => zoom(1 / 1.5), '_': () => zoom(1 / 1.5), ArrowLeft: () => pan(-(range.end - range.start) * .2), ArrowRight: () => pan((range.end - range.start) * .2), Home: reset, '0': reset };
        if (actions[event.key]) { event.preventDefault(); actions[event.key](); }
      });
    }
    prepared.forEach(bindChart);
    controls.buttons.forEach((button) => listen(button, 'click', () => {
      if (button.dataset.chartAction === 'zoom-in') zoom(1.5);
      else if (button.dataset.chartAction === 'zoom-out') zoom(1 / 1.5);
      else reset();
    }));
    if (typeof globalThis.ResizeObserver === 'function') {
      const observer = new globalThis.ResizeObserver(schedule);
      prepared.forEach(({ viewport }) => observer.observe(viewport));
      cleanups.push(() => observer.disconnect());
    } else if (globalThis.addEventListener) listen(globalThis, 'resize', schedule);
    draw();
    return {
      snapshot: () => ({ scopeKey, ...range }), zoom, pan, reset,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        finishDrag();
        cleanups.forEach((cleanup) => cleanup());
        if (pending !== null) cancelFrame(pending);
        pending = null;
        controls.toolbar.remove();
      }
    };
  }

  globalThis.TaYieldChartInteractions = { zoomRange, panRange, create };
})();
