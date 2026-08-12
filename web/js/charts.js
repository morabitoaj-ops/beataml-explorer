/* Reusable chart primitives.
   House rules enforced here: thin marks (bars capped at 24px), 4px rounded
   data-end square at the baseline, 2px lines, >=8px markers with a 2px surface
   ring, solid hairline grid, a hover layer on every mark, and a table-view twin
   so no value is gated behind a tooltip. */

const SVG = 'http://www.w3.org/2000/svg';
export const el = (tag, attrs = {}, parent = null) => {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
};
export const h = (tag, attrs = {}, parent = null) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') n.textContent = v;            // untrusted labels never go through innerHTML
    else if (k === 'html') n.innerHTML = v;         // only ever called with literals in this file
    else if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v != null) n.setAttribute(k, v);
  }
  if (parent) parent.appendChild(n);
  return n;
};

/* ------------------------------------------------------------------ tooltip */
const tip = () => document.getElementById('tooltip');

export function showTip(evt, title, rows = []) {
  const t = tip();
  t.textContent = '';
  if (title) h('div', { class: 'tt-title', text: title }, t);
  for (const r of rows) {
    const row = h('div', { class: 'tt-row' }, t);
    if (r.color) {
      const k = h('span', { class: 'tt-key' }, row);
      k.style.background = r.color;
    }
    h('span', { class: 'tt-val', text: r.value }, row);
    if (r.label) h('span', { text: r.label }, row);
  }
  t.classList.add('on');
  moveTip(evt);
}
export function moveTip(evt) {
  const t = tip();
  const pad = 14;
  const w = t.offsetWidth, hgt = t.offsetHeight;
  let x = evt.clientX + pad, y = evt.clientY + pad;
  if (x + w > window.innerWidth - 8) x = evt.clientX - w - pad;
  if (y + hgt > window.innerHeight - 8) y = evt.clientY - hgt - pad;
  t.style.left = `${Math.max(4, x)}px`;
  t.style.top = `${Math.max(4, y)}px`;
}
export function hideTip() { tip().classList.remove('on'); }

/** Attach the standard hover/focus behaviour to a mark. */
export function hoverable(node, title, rows, onClick) {
  node.addEventListener('pointerenter', (e) => showTip(e, title, rows()));
  node.addEventListener('pointermove', moveTip);
  node.addEventListener('pointerleave', hideTip);
  if (onClick) {
    node.style.cursor = 'pointer';
    node.addEventListener('click', onClick);
  }
  return node;
}

/* -------------------------------------------------------------- geometry */
/** Bar path with a rounded data-end and a square baseline end. */
export function barPath(x, y, w, hgt, r, dir) {
  r = Math.max(0, Math.min(r, dir === 'right' || dir === 'left' ? w : hgt));
  if (dir === 'right') {
    return `M${x},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + hgt - r} Q${x + w},${y + hgt} ${x + w - r},${y + hgt} H${x} Z`;
  }
  if (dir === 'up') {
    return `M${x},${y + hgt} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + hgt} Z`;
  }
  if (dir === 'left') {
    return `M${x + w},${y} H${x + r} Q${x},${y} ${x},${y + r} V${y + hgt - r} Q${x},${y + hgt} ${x + r},${y + hgt} H${x + w} Z`;
  }
  return `M${x},${y} h${w} v${hgt} h${-w} Z`;
}

export const fmt = (v, d = 0) =>
  v == null || Number.isNaN(v) ? '—' : Number(v).toLocaleString(undefined, {
    minimumFractionDigits: d, maximumFractionDigits: d,
  });

/** For exact p/q values (computed by the ETL with scipy). */
export const fmtP = (p) => {
  if (p == null) return '—';
  if (p === 0) return '<1e-300';
  if (p < 0.001) return p.toExponential(1);
  return p.toFixed(3);
};

/** For p/q values computed in the browser from the normal approximation, whose
 *  accuracy floor is ~1e-7. Reporting "2e-23" from it would be false precision. */
export const fmtPapprox = (p) => {
  if (p == null) return '—';
  if (p < 1e-7) return '<1e-7';
  if (p < 0.001) return p.toExponential(1);
  return p.toFixed(3);
};

export const BAR_MAX = 24;

/** 1 -> "1st", 32 -> "32nd", 13 -> "13th". */
export function ordinal(n) {
  const v = Math.round(n);
  const s = ['th', 'st', 'nd', 'rd'];
  const m = v % 100;
  return `${v}${s[(m - 20) % 10] || s[m] || s[0]}`;
}

/* --------------------------------------------------------------- legend */
export function legend(parent, items, kind = 'swatch') {
  const wrap = h('div', { class: 'legend' }, parent);
  for (const it of items) {
    const i = h('span', { class: 'item' }, wrap);
    const sw = h('span', { class: kind === 'line' ? 'linekey' : 'swatch' }, i);
    sw.style.background = it.color;
    h('span', { text: it.label }, i);
  }
  return wrap;
}

/* ----------------------------------------------------------- table view */
/** Table-view twin. columns: [{key,label,fmt?,align?}] */
export function tableView(parent, columns, rows, { open = false, label = 'table' } = {}) {
  const wrap = h('div', {}, parent);
  const btn = h('button', {
    class: 'toggle-table', type: 'button',
    text: open ? `Hide ${label}` : `Show ${label}`,
  }, wrap);
  const box = h('div', { class: 'tablewrap' }, wrap);
  box.hidden = !open;
  btn.addEventListener('click', () => {
    box.hidden = !box.hidden;
    btn.textContent = box.hidden ? `Show ${label}` : `Hide ${label}`;
  });

  let sortKey = null, sortDir = -1;
  const table = h('table', { class: 'data' }, box);
  const thead = h('thead', {}, table);
  const tr = h('tr', {}, thead);
  for (const c of columns) {
    const th = h('th', { text: c.label, scope: 'col' }, tr);
    th.addEventListener('click', () => {
      if (sortKey === c.key) sortDir = -sortDir; else { sortKey = c.key; sortDir = -1; }
      draw();
    });
  }
  const tbody = h('tbody', {}, table);

  function draw() {
    tbody.textContent = '';
    let data = rows.slice();
    if (sortKey) {
      data.sort((a, b) => {
        const x = a[sortKey], y = b[sortKey];
        if (x == null) return 1;
        if (y == null) return -1;
        return (typeof x === 'number' && typeof y === 'number') ? (x - y) * sortDir
          : String(x).localeCompare(String(y)) * sortDir;
      });
    }
    for (const r of data) {
      const row = h('tr', {}, tbody);
      for (const c of columns) {
        const v = r[c.key];
        h('td', { text: c.fmt ? c.fmt(v, r) : (v == null ? '—' : String(v)) }, row);
      }
    }
  }
  draw();
  return wrap;
}

/* --------------------------------------------------------- axis helpers */
export function yGrid(g, scale, w, ticks = 5, fmtFn = fmt) {
  for (const t of scale.ticks(ticks)) {
    const y = scale(t);
    el('line', { x1: 0, x2: w, y1: y, y2: y, class: 'gridline' }, g);
    el('text', {
      x: -8, y: y + 3.5, 'text-anchor': 'end', class: 'axis-label',
    }, g).textContent = fmtFn(t);
  }
}

export function xAxis(g, scale, y, ticks = 6, fmtFn = fmt) {
  el('line', { x1: scale.range()[0], x2: scale.range()[1], y1: y, y2: y, class: 'baseline' }, g);
  for (const t of scale.ticks(ticks)) {
    el('text', {
      x: scale(t), y: y + 15, 'text-anchor': 'middle', class: 'axis-label',
    }, g).textContent = fmtFn(t);
  }
}

/* --------------------------------------------------------------- charts */

/** Horizontal bar chart, one series (one colour for every bar). */
export function barChartH(parent, data, opts = {}) {
  const {
    width = 420, rowH = 22, labelW = 96, valueFmt = (v) => fmt(v),
    color = 'var(--series-1)', onClick = null, unit = '', highlight = null,
  } = opts;
  const m = { top: 6, right: 54, bottom: 6, left: labelW };
  const innerW = Math.max(80, width - m.left - m.right);
  const height = data.length * rowH + m.top + m.bottom;
  const svg = el('svg', { width: '100%', style: `max-width:${width}px`, viewBox: `0 0 ${width} ${height}`, role: 'img' }, parent);
  const g = el('g', { transform: `translate(${m.left},${m.top})` }, svg);
  const max = Math.max(1, ...data.map((d) => d.value));
  const x = d3.scaleLinear().domain([0, max]).range([0, innerW]);
  const barH = Math.min(BAR_MAX, rowH - 8);

  data.forEach((d, i) => {
    const y = i * rowH + (rowH - barH) / 2;
    const w = Math.max(1, x(d.value));
    const isHi = highlight && highlight(d);
    const path = el('path', {
      d: barPath(0, y, w, barH, 4, 'right'),
      fill: isHi === false ? 'var(--text-muted)' : color,
      'fill-opacity': isHi === false ? 0.35 : 1,
    }, g);
    el('text', {
      x: -8, y: y + barH / 2 + 3.7, 'text-anchor': 'end', class: 'axis-label',
    }, g).textContent = d.label;
    el('text', {
      x: w + 7, y: y + barH / 2 + 3.7, class: 'mark-label',
    }, g).textContent = valueFmt(d.value, d);

    // hit target spans the whole row, not just the painted bar
    const hit = el('rect', { x: -m.left, y: i * rowH, width: width, height: rowH, class: 'hit' }, g);
    hoverable(hit, d.label, () => [
      { value: valueFmt(d.value, d) + (unit ? ` ${unit}` : ''), label: d.sub || '', color },
    ], onClick ? () => onClick(d) : null);
  });
  return svg;
}

/** Histogram of a numeric array. */
export function histogram(parent, values, opts = {}) {
  const {
    width = 420, height = 190, bins = 20, color = 'var(--series-1)',
    xLabel = '', valueFmt = (v) => fmt(v), domain = null,
  } = opts;
  const m = { top: 10, right: 12, bottom: 34, left: 42 };
  const innerW = width - m.left - m.right, innerH = height - m.top - m.bottom;
  const svg = el('svg', { width: '100%', style: `max-width:${width}px`, viewBox: `0 0 ${width} ${height}`, role: 'img' }, parent);
  const g = el('g', { transform: `translate(${m.left},${m.top})` }, svg);
  const vals = values.filter((v) => v != null && !Number.isNaN(v));
  if (!vals.length) return svg;

  const x = d3.scaleLinear().domain(domain || d3.extent(vals)).nice(bins).range([0, innerW]);
  const binner = d3.bin().domain(x.domain()).thresholds(x.ticks(bins));
  const data = binner(vals);
  const y = d3.scaleLinear().domain([0, d3.max(data, (d) => d.length)]).nice().range([innerH, 0]);

  yGrid(g, y, innerW, 4);
  xAxis(g, x, innerH, 6, valueFmt);
  if (xLabel) {
    el('text', {
      x: innerW / 2, y: innerH + 30, 'text-anchor': 'middle', class: 'axis-title',
    }, g).textContent = xLabel;
  }

  for (const b of data) {
    const bw = Math.max(1, x(b.x1) - x(b.x0) - 2); // 2px surface gap between columns
    const bh = innerH - y(b.length);
    if (bh <= 0) continue;
    el('path', {
      d: barPath(x(b.x0) + 1, y(b.length), bw, bh, 4, 'up'), fill: color,
    }, g);
    const hit = el('rect', { x: x(b.x0), y: 0, width: Math.max(2, x(b.x1) - x(b.x0)), height: innerH, class: 'hit' }, g);
    hoverable(hit, `${valueFmt(b.x0)} – ${valueFmt(b.x1)}`, () => [
      { value: fmt(b.length), label: b.length === 1 ? 'patient' : 'patients', color },
    ]);
  }
  return svg;
}

/** Kaplan–Meier step curves, one line per stratum. */
export function kmChart(parent, series, opts = {}) {
  const { width = 560, height = 300, xMaxDays = null } = opts;
  const m = { top: 10, right: 16, bottom: 42, left: 46 };
  const innerW = width - m.left - m.right, innerH = height - m.top - m.bottom;
  const svg = el('svg', { width: '100%', style: `max-width:${width}px`, viewBox: `0 0 ${width} ${height}`, role: 'img' }, parent);
  const g = el('g', { transform: `translate(${m.left},${m.top})` }, svg);

  const maxT = xMaxDays || d3.max(series, (s) => d3.max(s.curve, (p) => p.t)) || 1;
  const x = d3.scaleLinear().domain([0, maxT / 365.25]).nice().range([0, innerW]);
  const y = d3.scaleLinear().domain([0, 1]).range([innerH, 0]);

  yGrid(g, y, innerW, 5, (v) => `${Math.round(v * 100)}%`);
  xAxis(g, x, innerH, 6, (v) => fmt(v, 0));
  el('text', {
    x: innerW / 2, y: innerH + 34, 'text-anchor': 'middle', class: 'axis-title',
  }, g).textContent = 'Years from specimen collection';
  el('text', {
    transform: `translate(-34,${innerH / 2}) rotate(-90)`, 'text-anchor': 'middle', class: 'axis-title',
  }, g).textContent = 'Overall survival';

  for (const s of series) {
    let d = '';
    let prev = 1;
    for (const pt of s.curve) {
      const px = x(pt.t / 365.25);
      d += d === '' ? `M0,${y(1)}` : ` L${px},${y(prev)}`;
      d += ` L${px},${y(pt.s)}`;
      prev = pt.s;
    }
    const last = s.curve[s.curve.length - 1];
    if (last) d += ` L${x(maxT / 365.25)},${y(last.s)}`;
    el('path', {
      d, fill: 'none', stroke: s.color, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }, g);
  }

  // crosshair: one readout listing every stratum at that x
  const cross = el('line', {
    x1: 0, x2: 0, y1: 0, y2: innerH, stroke: 'var(--axis)', 'stroke-width': 1, opacity: 0,
  }, g);
  const overlay = el('rect', { x: 0, y: 0, width: innerW, height: innerH, class: 'hit' }, g);
  overlay.addEventListener('pointermove', (e) => {
    const bb = overlay.getBoundingClientRect();
    const px = (e.clientX - bb.left) / bb.width * innerW;
    const years = x.invert(px);
    const days = years * 365.25;
    cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('opacity', 1);
    const rows = series.map((s) => {
      let sv = 1;
      for (const pt of s.curve) { if (pt.t <= days) sv = pt.s; else break; }
      const atRisk = s.rows.filter((r) => r.time >= days).length;
      return { value: `${(sv * 100).toFixed(0)}%`, label: `${s.label} · ${atRisk} at risk`, color: s.color };
    });
    showTip(e, `${years.toFixed(1)} years`, rows);
  });
  overlay.addEventListener('pointerleave', () => { cross.setAttribute('opacity', 0); hideTip(); });
  return svg;
}

/** Box plot with a jittered strip, one box per group. */
export function boxPlot(parent, groups, opts = {}) {
  const {
    width = 520, height = 300, yLabel = '', color = 'var(--series-1)',
    yDomain = null, invertBetter = false,
  } = opts;
  const m = { top: 12, right: 14, bottom: 52, left: 52 };
  const innerW = width - m.left - m.right, innerH = height - m.top - m.bottom;
  const svg = el('svg', { width: '100%', style: `max-width:${width}px`, viewBox: `0 0 ${width} ${height}`, role: 'img' }, parent);
  const g = el('g', { transform: `translate(${m.left},${m.top})` }, svg);

  const all = groups.flatMap((gr) => gr.values);
  if (!all.length) return svg;
  const y = d3.scaleLinear().domain(yDomain || d3.extent(all)).nice().range([innerH, 0]);
  const xb = d3.scaleBand().domain(groups.map((gr) => gr.label)).range([0, innerW]).padding(0.45);

  yGrid(g, y, innerW, 5);
  el('line', { x1: 0, x2: innerW, y1: innerH, y2: innerH, class: 'baseline' }, g);
  if (yLabel) {
    el('text', {
      transform: `translate(-38,${innerH / 2}) rotate(-90)`, 'text-anchor': 'middle', class: 'axis-title',
    }, g).textContent = yLabel;
  }

  const bw = Math.min(BAR_MAX * 2, xb.bandwidth());
  groups.forEach((gr) => {
    const cx = xb(gr.label) + xb.bandwidth() / 2;
    const v = gr.values.slice().sort((a, b) => a - b);
    if (!v.length) return;
    const q = (p) => {
      const pos = (v.length - 1) * p, lo = Math.floor(pos), hi = Math.ceil(pos);
      return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (pos - lo);
    };
    const q1 = q(0.25), med = q(0.5), q3 = q(0.75);
    const iqr = q3 - q1;
    const lo = Math.max(v[0], q1 - 1.5 * iqr), hi = Math.min(v[v.length - 1], q3 + 1.5 * iqr);

    // jittered points first, so the box reads on top
    const seed = gr.label.length * 97;
    v.forEach((val, i) => {
      const jitter = ((Math.sin(seed + i * 12.9898) * 43758.5453) % 1) * (bw * 0.62);
      el('circle', {
        cx: cx + jitter - bw * 0.31, cy: y(val), r: 1.9,
        fill: 'var(--text-muted)', 'fill-opacity': 0.34,
      }, g);
    });

    el('line', { x1: cx, x2: cx, y1: y(hi), y2: y(lo), stroke: 'var(--axis)', 'stroke-width': 1 }, g);
    el('rect', {
      x: cx - bw / 2, y: y(q3), width: bw, height: Math.max(1, y(q1) - y(q3)),
      fill: color, 'fill-opacity': 0.16, stroke: color, 'stroke-width': 1.5, rx: 3,
    }, g);
    el('line', {
      x1: cx - bw / 2, x2: cx + bw / 2, y1: y(med), y2: y(med),
      stroke: color, 'stroke-width': 2.5, 'stroke-linecap': 'round',
    }, g);

    el('text', {
      x: cx, y: innerH + 17, 'text-anchor': 'middle', class: 'axis-label',
    }, g).textContent = gr.label;
    el('text', {
      x: cx, y: innerH + 31, 'text-anchor': 'middle', class: 'axis-label',
    }, g).textContent = `n=${v.length}`;
    el('text', {
      x: cx, y: Math.max(9, y(hi) - 7), 'text-anchor': 'middle', class: 'mark-label',
    }, g).textContent = fmt(med, 1);

    const hit = el('rect', {
      x: xb(gr.label), y: 0, width: xb.bandwidth(), height: innerH, class: 'hit',
    }, g);
    hoverable(hit, gr.label, () => [
      { value: fmt(med, 1), label: 'median' + (invertBetter ? ' (lower = more sensitive)' : ''), color },
      { value: `${fmt(q1, 1)} – ${fmt(q3, 1)}`, label: 'IQR' },
      { value: fmt(v.length), label: 'patients' },
    ]);
  });
  return svg;
}

/** Diverging or sequential heat-cell matrix. */
export function heatmap(parent, opts) {
  const {
    rows, cols, value, cell = 15, rowLabelW = 84, colLabelH = 96,
    scale, title = (r, c, v) => `${r} × ${c}`, rowsFmt = (v) => fmt(v, 2),
    onClick = null, maxWidth = null,
  } = opts;
  const width = rowLabelW + cols.length * cell + 12;
  const height = colLabelH + rows.length * cell + 8;
  const svg = el('svg', {
    width: maxWidth ? Math.min(width, maxWidth) : width, class: 'wide',
    viewBox: `0 0 ${width} ${height}`, role: 'img',
  }, parent);
  const g = el('g', { transform: `translate(${rowLabelW},${colLabelH})` }, svg);

  cols.forEach((c, j) => {
    el('text', {
      transform: `translate(${j * cell + cell / 2},${-6}) rotate(-90)`,
      class: 'axis-label', 'text-anchor': 'start',
    }, g).textContent = c;
  });
  rows.forEach((r, i) => {
    el('text', {
      x: -7, y: i * cell + cell / 2 + 3.5, 'text-anchor': 'end', class: 'axis-label',
    }, g).textContent = r;
  });

  rows.forEach((r, i) => {
    cols.forEach((c, j) => {
      const v = value(r, c, i, j);
      const node = el('rect', {
        x: j * cell + 1, y: i * cell + 1, width: cell - 2, height: cell - 2, rx: 2,
        fill: v == null ? 'var(--wash)' : scale(v),
      }, g);
      hoverable(node, title(r, c, v), () => [{ value: v == null ? '—' : rowsFmt(v, r, c) }],
        onClick ? () => onClick(r, c, v) : null);
    });
  });
  return svg;
}

/** Colour ramp legend for a continuous scale. */
export function rampLegend(parent, scale, domain, label, fmtFn = (v) => fmt(v, 0)) {
  const w = 190, hgt = 34;
  const svg = el('svg', { width: w, height: hgt, viewBox: `0 0 ${w} ${hgt}` }, parent);
  const id = `ramp-${Math.random().toString(36).slice(2, 9)}`;
  const defs = el('defs', {}, svg);
  const lg = el('linearGradient', { id, x1: '0%', x2: '100%' }, defs);
  for (let i = 0; i <= 10; i++) {
    const t = domain[0] + (domain[1] - domain[0]) * (i / 10);
    el('stop', { offset: `${i * 10}%`, 'stop-color': scale(t) }, lg);
  }
  el('rect', { x: 0, y: 4, width: w, height: 9, rx: 2, fill: `url(#${id})` }, svg);
  el('text', { x: 0, y: 26, class: 'axis-label' }, svg).textContent = fmtFn(domain[0]);
  el('text', { x: w, y: 26, 'text-anchor': 'end', class: 'axis-label' }, svg).textContent = fmtFn(domain[1]);
  if (label) {
    el('text', { x: w / 2, y: 26, 'text-anchor': 'middle', class: 'axis-label' }, svg).textContent = label;
  }
  return svg;
}

/* --------------------------------------------------------------- scales */
export const SEQ = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7',
  '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];

export function seqScale(domain) {
  return d3.scaleLinear().domain(
    SEQ.map((_, i) => domain[0] + (domain[1] - domain[0]) * (i / (SEQ.length - 1))),
  ).range(SEQ).clamp(true).interpolate(d3.interpolateRgb);
}

export function divScale(max) {
  const mid = getComputedStyle(document.documentElement).getPropertyValue('--div-mid').trim() || '#f0efec';
  const neg = getComputedStyle(document.documentElement).getPropertyValue('--div-neg').trim() || '#2a78d6';
  const pos = getComputedStyle(document.documentElement).getPropertyValue('--div-pos').trim() || '#e34948';
  return d3.scaleLinear().domain([-max, 0, max]).range([neg, mid, pos]).clamp(true);
}
