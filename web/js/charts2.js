/* Second set of chart primitives: dose-response curves, scatter with
   nearest-point hover, waterfall, volcano. Same house rules as charts.js. */
import {
  el, h, fmt, fmtP, hoverable, showTip, moveTip, hideTip, legend,
} from './charts.js';
import { normCdf } from './data.js';

/** Fitted probit viability curve, verified against the release's own IC values:
 *  viability(c) = Phi(intercept + beta * log10 c). */
export function viability(conc, intercept, beta) {
  return normCdf(intercept + beta * Math.log10(conc));
}

/**
 * Dose-response panel.
 * series: [{label, color, intercept, beta, points:[[conc, viabilityPct]], auc}]
 */
export function doseCurve(parent, series, opts = {}) {
  const {
    width = 320, height = 210, conc = [0.0137, 10], title = '',
    shadeAuc = false, showPoints = true, compact = false,
  } = opts;
  const m = { top: 12, right: 10, bottom: compact ? 30 : 40, left: 40 };
  const innerW = width - m.left - m.right, innerH = height - m.top - m.bottom;
  const svg = el('svg', {
    width: '100%', style: `max-width:${width}px`,
    viewBox: `0 0 ${width} ${height}`, role: 'img',
  }, parent);
  const g = el('g', { transform: `translate(${m.left},${m.top})` }, svg);

  const x = d3.scaleLog().domain(conc).range([0, innerW]).clamp(true);
  const y = d3.scaleLinear().domain([0, 120]).range([innerH, 0]);

  for (const t of [0, 25, 50, 75, 100]) {
    el('line', { x1: 0, x2: innerW, y1: y(t), y2: y(t), class: 'gridline' }, g);
    el('text', { x: -7, y: y(t) + 3.5, 'text-anchor': 'end', class: 'axis-label' }, g)
      .textContent = `${t}`;
  }
  el('line', { x1: 0, x2: innerW, y1: innerH, y2: innerH, class: 'baseline' }, g);
  // decade ticks only — d3's log ticks pack in minor steps that collide at this width
  const decades = [];
  for (let k = Math.ceil(Math.log10(conc[0])); k <= Math.floor(Math.log10(conc[1])); k++) {
    decades.push(10 ** k);
  }
  for (const t of decades) {
    el('text', { x: x(t), y: innerH + 14, 'text-anchor': 'middle', class: 'axis-label' }, g)
      .textContent = t >= 1 ? `${t}` : `${t}`.replace(/^0\./, '.');
  }
  // anchor the ends so the tested range is always readable
  for (const [t, anchor] of [[conc[0], 'start'], [conc[1], 'end']]) {
    if (decades.some((d) => Math.abs(Math.log10(d / t)) < 0.28)) continue;
    el('text', {
      x: x(t), y: innerH + 14, 'text-anchor': anchor, class: 'axis-label', 'fill-opacity': 0.75,
    }, g).textContent = t >= 1 ? `${t}` : `${t}`.replace(/^0\./, '.').replace(/0+$/, '');
  }
  if (!compact) {
    el('text', {
      x: innerW / 2, y: innerH + 32, 'text-anchor': 'middle', class: 'axis-title',
    }, g).textContent = 'Concentration (µM, log scale)';
    el('text', {
      transform: `translate(-30,${innerH / 2}) rotate(-90)`, 'text-anchor': 'middle',
      class: 'axis-title',
    }, g).textContent = 'Viability (%)';
  }
  if (title) {
    el('text', { x: 0, y: -3, class: 'mark-label' }, g).textContent = title;
  }

  const lo = Math.log10(conc[0]), hi = Math.log10(conc[1]);
  for (const s of series) {
    if (s.intercept == null || s.beta == null) continue;
    const pts = [];
    for (let i = 0; i <= 60; i++) {
      const c = 10 ** (lo + (hi - lo) * (i / 60));
      pts.push([x(c), y(viability(c, s.intercept, s.beta) * 100)]);
    }
    if (shadeAuc && series.length === 1) {
      // the shaded region IS the AUC the tables quote
      const area = `M${pts[0][0]},${y(0)} ` + pts.map((p) => `L${p[0]},${p[1]}`).join(' ')
        + ` L${pts[pts.length - 1][0]},${y(0)} Z`;
      el('path', { d: area, fill: s.color, 'fill-opacity': 0.10 }, g);
    }
    el('path', {
      d: `M${pts.map((p) => p.join(',')).join(' L')}`,
      fill: 'none', stroke: s.color, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }, g);
    if (showPoints && s.points) {
      for (const [c, v] of s.points) {
        if (c < conc[0] * 0.9 || c > conc[1] * 1.1) continue;
        el('circle', {
          cx: x(c), cy: y(Math.max(0, Math.min(120, v))), r: 3.2,
          fill: s.color, stroke: 'var(--surface-1)', 'stroke-width': 1.5,
          'fill-opacity': 0.9,
        }, g);
      }
    }
  }

  const overlay = el('rect', { x: 0, y: 0, width: innerW, height: innerH, class: 'hit' }, g);
  const cross = el('line', {
    x1: 0, x2: 0, y1: 0, y2: innerH, stroke: 'var(--axis)', 'stroke-width': 1, opacity: 0,
  }, g);
  overlay.addEventListener('pointermove', (e) => {
    const bb = overlay.getBoundingClientRect();
    const px = (e.clientX - bb.left) / bb.width * innerW;
    const c = x.invert(px);
    cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('opacity', 1);
    showTip(e, `${c < 1 ? c.toFixed(3) : c.toFixed(2)} µM`, series
      .filter((s) => s.intercept != null)
      .map((s) => ({
        value: `${(viability(c, s.intercept, s.beta) * 100).toFixed(0)}%`,
        label: `${s.label} viability`, color: s.color,
      })));
  });
  overlay.addEventListener('pointerleave', () => { cross.setAttribute('opacity', 0); hideTip(); });
  return svg;
}

/** Scatter with a quadtree nearest-point hover layer (dense-safe). */
export function scatter(parent, points, opts = {}) {
  const {
    width = 520, height = 360, xLabel = '', yLabel = '', r = 3.4,
    onClick = null, tip = null, trend = false, xLog = false,
  } = opts;
  const m = { top: 14, right: 14, bottom: 44, left: 52 };
  const innerW = width - m.left - m.right, innerH = height - m.top - m.bottom;
  const svg = el('svg', {
    width: '100%', style: `max-width:${width}px`,
    viewBox: `0 0 ${width} ${height}`, role: 'img',
  }, parent);
  const g = el('g', { transform: `translate(${m.left},${m.top})` }, svg);

  const pts = points.filter((p) => p.x != null && p.y != null
    && Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!pts.length) {
    h('div', { class: 'empty', text: 'No overlapping data for this pair.' }, parent);
    return svg;
  }
  const x = (xLog ? d3.scaleLog() : d3.scaleLinear())
    .domain(d3.extent(pts, (p) => p.x)).nice().range([0, innerW]);
  const y = d3.scaleLinear().domain(d3.extent(pts, (p) => p.y)).nice().range([innerH, 0]);

  for (const t of y.ticks(5)) {
    el('line', { x1: 0, x2: innerW, y1: y(t), y2: y(t), class: 'gridline' }, g);
    el('text', { x: -8, y: y(t) + 3.5, 'text-anchor': 'end', class: 'axis-label' }, g)
      .textContent = fmt(t, Math.abs(t) < 10 ? 1 : 0);
  }
  el('line', { x1: 0, x2: innerW, y1: innerH, y2: innerH, class: 'baseline' }, g);
  for (const t of x.ticks(6)) {
    el('text', { x: x(t), y: innerH + 15, 'text-anchor': 'middle', class: 'axis-label' }, g)
      .textContent = fmt(t, Math.abs(t) < 10 ? 1 : 0);
  }
  if (xLabel) {
    el('text', {
      x: innerW / 2, y: innerH + 35, 'text-anchor': 'middle', class: 'axis-title',
    }, g).textContent = xLabel;
  }
  if (yLabel) {
    el('text', {
      transform: `translate(-38,${innerH / 2}) rotate(-90)`, 'text-anchor': 'middle',
      class: 'axis-title',
    }, g).textContent = yLabel;
  }

  if (trend) {
    // least-squares line, drawn recessive: it guides the eye, it is not the data
    const n = pts.length;
    const mx = d3.mean(pts, (p) => p.x), my = d3.mean(pts, (p) => p.y);
    let num = 0, den = 0;
    for (const p of pts) { num += (p.x - mx) * (p.y - my); den += (p.x - mx) ** 2; }
    if (den > 0) {
      const b = num / den, a = my - b * mx;
      const [x0, x1] = x.domain();
      el('line', {
        x1: x(x0), y1: y(a + b * x0), x2: x(x1), y2: y(a + b * x1),
        stroke: 'var(--text-muted)', 'stroke-width': 1.5, 'stroke-opacity': 0.7,
      }, g);
    }
  }

  for (const p of pts) {
    el('circle', {
      cx: x(p.x), cy: y(p.y), r, fill: p.color || 'var(--series-1)',
      'fill-opacity': p.opacity ?? 0.75,
      stroke: 'var(--surface-1)', 'stroke-width': 1.2,
    }, g);
  }

  // nearest-point hover — the pointer only has to be closest, not dead-centre
  const qt = d3.quadtree().x((p) => x(p.x)).y((p) => y(p.y)).addAll(pts);
  const halo = el('circle', {
    r: r + 3.5, fill: 'none', stroke: 'var(--text-primary)', 'stroke-width': 1.5, opacity: 0,
  }, g);
  const overlay = el('rect', { x: 0, y: 0, width: innerW, height: innerH, class: 'hit' }, g);
  let hovered = null;
  overlay.addEventListener('pointermove', (e) => {
    const bb = overlay.getBoundingClientRect();
    const px = (e.clientX - bb.left) / bb.width * innerW;
    const py = (e.clientY - bb.top) / bb.height * innerH;
    const p = qt.find(px, py, 40);
    hovered = p || null;
    if (!p) { halo.setAttribute('opacity', 0); hideTip(); return; }
    halo.setAttribute('cx', x(p.x)); halo.setAttribute('cy', y(p.y));
    halo.setAttribute('opacity', 1);
    showTip(e, p.title || '', tip ? tip(p) : [
      { value: fmt(p.x, 2), label: xLabel, color: p.color },
      { value: fmt(p.y, 2), label: yLabel },
    ]);
  });
  overlay.addEventListener('pointerleave', () => { halo.setAttribute('opacity', 0); hideTip(); });
  if (onClick) {
    overlay.style.cursor = 'pointer';
    overlay.addEventListener('click', () => { if (hovered) onClick(hovered); });
  }
  return svg;
}

/** Waterfall: every patient as one thin bar, ranked. */
export function waterfall(parent, rows, opts = {}) {
  const {
    width = 640, height = 250, yLabel = '', baseline = null,
    onClick = null, legendItems = null,
  } = opts;
  const m = { top: 14, right: 12, bottom: 34, left: 52 };
  const innerW = width - m.left - m.right, innerH = height - m.top - m.bottom;
  const svg = el('svg', {
    width: '100%', style: `max-width:${width}px`,
    viewBox: `0 0 ${width} ${height}`, role: 'img',
  }, parent);
  const g = el('g', { transform: `translate(${m.left},${m.top})` }, svg);

  const base = baseline ?? d3.median(rows, (d) => d.value);
  const ext = d3.extent(rows, (d) => d.value);
  const y = d3.scaleLinear().domain([Math.min(ext[0], base), Math.max(ext[1], base)])
    .nice().range([innerH, 0]);
  const bw = innerW / rows.length;

  for (const t of y.ticks(5)) {
    el('line', { x1: 0, x2: innerW, y1: y(t), y2: y(t), class: 'gridline' }, g);
    el('text', { x: -8, y: y(t) + 3.5, 'text-anchor': 'end', class: 'axis-label' }, g)
      .textContent = fmt(t);
  }
  rows.forEach((d, i) => {
    const top = Math.min(y(d.value), y(base)), bot = Math.max(y(d.value), y(base));
    el('rect', {
      x: i * bw, y: top, width: Math.max(0.7, bw - 0.3), height: Math.max(0.7, bot - top),
      fill: d.color || 'var(--series-1)',
    }, g);
  });
  el('line', {
    x1: 0, x2: innerW, y1: y(base), y2: y(base), stroke: 'var(--axis)', 'stroke-width': 1,
  }, g);
  // anchored left: the right-hand end of a waterfall is where the tall bars are
  el('text', { x: 2, y: y(base) - 5, class: 'mark-label' }, g)
    .textContent = `cohort median ${fmt(base, 0)}`;
  el('text', {
    transform: `translate(-38,${innerH / 2}) rotate(-90)`, 'text-anchor': 'middle',
    class: 'axis-title',
  }, g).textContent = yLabel;
  el('text', {
    x: innerW / 2, y: innerH + 26, 'text-anchor': 'middle', class: 'axis-title',
  }, g).textContent = `${rows.length} patients, most sensitive → most resistant`;

  const overlay = el('rect', { x: 0, y: 0, width: innerW, height: innerH, class: 'hit' }, g);
  overlay.addEventListener('pointermove', (e) => {
    const bb = overlay.getBoundingClientRect();
    const i = Math.floor((e.clientX - bb.left) / bb.width * rows.length);
    const d = rows[Math.max(0, Math.min(rows.length - 1, i))];
    if (!d) return;
    showTip(e, d.title || `Patient ${d.id}`, d.rows ? d.rows() : [
      { value: fmt(d.value, 1), label: yLabel, color: d.color },
    ]);
  });
  overlay.addEventListener('pointerleave', hideTip);
  if (onClick) {
    overlay.style.cursor = 'pointer';
    overlay.addEventListener('click', (e) => {
      const bb = overlay.getBoundingClientRect();
      const i = Math.floor((e.clientX - bb.left) / bb.width * rows.length);
      const d = rows[Math.max(0, Math.min(rows.length - 1, i))];
      if (d) onClick(d);
    });
  }
  if (legendItems) legend(parent, legendItems);
  return svg;
}
