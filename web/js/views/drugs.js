/* Drug response — what works across the cohort, and what predicts it. */
import {
  db, selection, auc, mannWhitney, quantile,
} from '../data.js';
import {
  h, el, fmt, fmtP, fmtPapprox, legend, tableView, hoverable, boxPlot, heatmap,
  divScale, rampLegend, showTip, hideTip,
} from '../charts.js';
import { scatter, waterfall } from '../charts2.js';
import { drugCard } from '../drugcard.js';
import { tabIntro } from '../tabintro.js';

let familyFilter = '';
let selectedDrug = null;
let markerKey = 'FLT3-ITD';

/** Dot-and-range plot: median AUC as a position, IQR as a rule.
 *  Position encoding, so a "shorter bar" is never mistaken for "better". */
function dotRange(parent, rows, opts = {}) {
  const { width = 620, rowH = 20, labelW = 210, onClick = null, domain = [0, 290] } = opts;
  const right = 58;
  const height = rows.length * rowH + 30;
  const svg = el('svg', { width: '100%', style: `max-width:${width}px`, viewBox: `0 0 ${width} ${height}`, role: 'img' }, parent);
  const x = d3.scaleLinear().domain(domain).range([labelW, width - right]);

  for (const t of x.ticks(6)) {
    el('line', { x1: x(t), x2: x(t), y1: 16, y2: rows.length * rowH + 16, class: 'gridline' }, svg);
    el('text', { x: x(t), y: 11, 'text-anchor': 'middle', class: 'axis-label' }, svg).textContent = fmt(t);
  }
  el('text', {
    x: (x(domain[0]) + x(domain[1])) / 2, y: height - 3, 'text-anchor': 'middle', class: 'axis-title',
  }, svg).textContent = 'AUC — lower means the sample was more sensitive';

  rows.forEach((r, i) => {
    const y = i * rowH + 16 + rowH / 2;
    el('text', { x: labelW - 9, y: y + 3.5, 'text-anchor': 'end', class: 'axis-label' }, svg)
      .textContent = r.drug.length > 30 ? `${r.drug.slice(0, 29)}…` : r.drug;
    el('line', {
      x1: x(r.q1), x2: x(r.q3), y1: y, y2: y,
      stroke: 'var(--axis)', 'stroke-width': 2, 'stroke-linecap': 'round',
    }, svg);
    el('circle', {
      cx: x(r.med), cy: y, r: 4.5, fill: 'var(--series-1)',
      stroke: 'var(--surface-1)', 'stroke-width': 2,
    }, svg);
    el('text', { x: width - right + 7, y: y + 3.5, class: 'mark-label' }, svg)
      .textContent = fmt(r.med, 0);
    const hit = el('rect', { x: 0, y: i * rowH + 16, width, height: rowH, class: 'hit' }, svg);
    hoverable(hit, r.drug, () => [
      { value: fmt(r.med, 1), label: 'median AUC', color: 'var(--series-1)' },
      { value: `${fmt(r.q1, 1)} – ${fmt(r.q3, 1)}`, label: 'interquartile range' },
      { value: fmt(r.n), label: 'patients screened in this slice' },
      { value: r.family, label: 'target family' },
    ], onClick ? () => onClick(r) : null);
  });
  return svg;
}

function markerCarriers(key) {
  if (key === 'FLT3-ITD') return new Set(db.patients.filter((p) => p.flt3itd === true).map((p) => p.id));
  if (key === 'NPM1 (clinical)') return new Set(db.patients.filter((p) => p.npm1c === true).map((p) => p.id));
  if (key === 'TP53 (clinical)') return new Set(db.patients.filter((p) => p.tp53c === true).map((p) => p.id));
  return db.mutByGene.get(key) || new Set();
}

export function render(root) {
  root.textContent = '';
  tabIntro(root, 'drugs');
  const sel = selection();
  const ids = sel.map((p) => p.id).filter((id) => db.drugPtIndex.has(id));

  if (!ids.length) {
    h('div', { class: 'empty', text: 'No patient in the current slice has a drug screen.' }, root);
    return;
  }

  // per-drug summary recomputed over the current slice
  const families = [...new Set(db.drug.drugs.map((d) => d.family).filter(Boolean))].sort();
  const summary = [];
  for (const d of db.drug.drugs) {
    if (familyFilter && d.family !== familyFilter) continue;
    const vals = [];
    for (const id of ids) { const v = auc(id, d.name); if (v != null) vals.push(v); }
    if (vals.length < 5) continue;
    vals.sort((a, b) => a - b);
    summary.push({
      drug: d.name, family: d.family || '—', n: vals.length,
      med: quantile(vals, 0.5), q1: quantile(vals, 0.25), q3: quantile(vals, 0.75),
      min: vals[0], max: vals[vals.length - 1],
    });
  }
  summary.sort((a, b) => a.med - b.med);
  if (selectedDrug == null || !summary.some((s) => s.drug === selectedDrug)) {
    selectedDrug = summary.length ? summary[0].drug : null;
  }

  // ------------------------------------------------------ ranked inhibitors
  {
    const c = h('div', { class: 'card' }, root);
    const head = h('div', { style: 'display:flex;gap:12px;align-items:baseline;flex-wrap:wrap' }, c);
    h('h3', { text: 'Which drugs killed the most cancer cells', style: 'margin:0' }, head);
    h('span', { style: 'flex:1' }, head);
    h('span', { class: 'hint', style: 'margin:0', text: 'Target family' }, head);
    const fsel = h('select', { style: 'font:inherit;font-size:12px;padding:3px 6px;border-radius:6px;border:1px solid var(--border);background:var(--plane);color:var(--text-primary)' }, head);
    h('option', { value: '', text: 'All families' }, fsel);
    for (const f of families) {
      const o = h('option', { value: f, text: f }, fsel);
      if (f === familyFilter) o.selected = true;
    }
    fsel.addEventListener('change', () => { familyFilter = fsel.value; render(root); });

    h('p', {
      class: 'hint',
      text: `Across ${ids.length} patients. The dot is the typical result; the grey line shows how much patients varied. Further LEFT means the drug worked better. Click a row to study it below.`,
    }, c);

    const shown = summary.slice(0, 25);
    if (!shown.length) h('div', { class: 'empty', text: 'No inhibitor has ≥5 screened patients in this slice.' }, c);
    else {
      dotRange(c, shown, {
        onClick: (r) => { selectedDrug = r.drug; render(root); },
      });
      h('p', { class: 'hint', style: 'margin-top:4px', text: `Showing the 25 most sensitive of ${summary.length} inhibitors. Full list in the table.` }, c);
    }

    tableView(c, [
      { key: 'drug', label: 'Inhibitor' },
      { key: 'family', label: 'Target family' },
      { key: 'n', label: 'Patients' },
      { key: 'med', label: 'Median AUC', fmt: (v) => fmt(v, 1) },
      { key: 'q1', label: 'Q1', fmt: (v) => fmt(v, 1) },
      { key: 'q3', label: 'Q3', fmt: (v) => fmt(v, 1) },
      { key: 'min', label: 'Min', fmt: (v) => fmt(v, 1) },
      { key: 'max', label: 'Max', fmt: (v) => fmt(v, 1) },
    ], summary, { label: 'all inhibitors' });
  }

  const g2 = h('div', { class: 'grid c2', style: 'margin-top:14px' }, root);

  // ---------------------------------------------- drug split by a marker
  {
    const c = h('div', { class: 'card' }, g2);
    h('h3', { text: 'Does a broken gene change the result?' }, c);
    const head = h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0 10px' }, c);

    const dsel = h('select', { style: 'font:inherit;font-size:12.5px;padding:4px 7px;border-radius:6px;border:1px solid var(--border);background:var(--plane);color:var(--text-primary);max-width:250px' }, head);
    for (const s of summary) {
      const o = h('option', { value: s.drug, text: s.drug }, dsel);
      if (s.drug === selectedDrug) o.selected = true;
    }
    dsel.addEventListener('change', () => { selectedDrug = dsel.value; render(root); });

    h('span', { class: 'hint', style: 'margin:0', text: 'split by' }, head);
    const msel = h('select', { style: 'font:inherit;font-size:12.5px;padding:4px 7px;border-radius:6px;border:1px solid var(--border);background:var(--plane);color:var(--text-primary)' }, head);
    const markers = ['FLT3-ITD', 'NPM1 (clinical)', 'TP53 (clinical)', 'ELN 2017 risk', ...db.topGenes.slice(0, 25)];
    for (const m of markers) {
      const o = h('option', { value: m, text: m }, msel);
      if (m === markerKey) o.selected = true;
    }
    msel.addEventListener('change', () => { markerKey = msel.value; render(root); });

    if (!selectedDrug) {
      h('div', { class: 'empty', text: 'Select an inhibitor.' }, c);
    } else if (markerKey === 'ELN 2017 risk') {
      const order = ['Favorable', 'Intermediate', 'Adverse'];
      const groups = order.map((lvl) => ({
        label: lvl,
        values: sel.filter((p) => p.eln === lvl).map((p) => auc(p.id, selectedDrug)).filter((v) => v != null),
      })).filter((g) => g.values.length >= 3);
      if (groups.length < 2) h('div', { class: 'empty', text: 'Not enough patients per risk group in this slice.' }, c);
      else {
        boxPlot(c, groups, { yLabel: `AUC — ${selectedDrug}`, invertBetter: true });
        h('p', { class: 'hint', text: 'Lower box = more sensitive. Points are individual patients.' }, c);
        tableView(c, [
          { key: 'label', label: 'Risk group' }, { key: 'n', label: 'Patients' },
          { key: 'med', label: 'Median AUC', fmt: (v) => fmt(v, 1) },
        ], groups.map((g) => {
          const v = g.values.slice().sort((a, b) => a - b);
          return { label: g.label, n: v.length, med: quantile(v, 0.5) };
        }));
      }
    } else {
      const carriers = markerCarriers(markerKey);
      const pos = [], neg = [];
      for (const p of sel) {
        const v = auc(p.id, selectedDrug);
        if (v == null) continue;
        (carriers.has(p.id) ? pos : neg).push(v);
      }
      if (pos.length < 3 || neg.length < 3) {
        h('div', { class: 'empty', text: `Too few patients to split ${selectedDrug} by ${markerKey} in this slice.` }, c);
      } else {
        boxPlot(c, [
          { label: `${markerKey} mutated`, values: pos },
          { label: 'Wild type', values: neg },
        ], { yLabel: `AUC — ${selectedDrug}`, invertBetter: true });
        const mw = mannWhitney(pos, neg);
        const medPos = quantile(pos.slice().sort((a, b) => a - b), 0.5);
        const medNeg = quantile(neg.slice().sort((a, b) => a - b), 0.5);
        const dir = medPos < medNeg ? 'more sensitive' : 'less sensitive';
        h('p', {
          class: 'hint',
          text: `Mutated samples are ${dir} (median AUC ${fmt(medPos, 1)} vs ${fmt(medNeg, 1)}). `
            + `Mann–Whitney p = ${fmtPapprox(mw.p)}, computed on the current slice and unadjusted for multiple testing.`,
        }, c);
        tableView(c, [
          { key: 'group', label: 'Group' }, { key: 'n', label: 'Patients' },
          { key: 'med', label: 'Median AUC', fmt: (v) => fmt(v, 1) },
        ], [
          { group: `${markerKey} mutated`, n: pos.length, med: medPos },
          { group: 'Wild type', n: neg.length, med: medNeg },
        ]);
      }
    }
  }

  // ------------------------------------------------- association table
  {
    const c = h('div', { class: 'card' }, g2);
    h('h3', { text: 'Strongest gene-and-drug links found' }, c);
    h('p', {
      class: 'hint',
      text: 'Mann–Whitney tests across the full cohort, Benjamini–Hochberg adjusted. Negative Δ means mutated samples were more sensitive. Click a row to load it above.',
    }, c);
    const sig = db.drug.assoc.filter((a) => a.q < 0.05);
    const top = sig.slice(0, 14);

    const list = h('div', {}, c);
    for (const a of top) {
      const row = h('div', {
        style: 'display:flex;gap:10px;align-items:baseline;padding:5px 0;border-bottom:1px solid var(--grid);cursor:pointer',
      }, list);
      row.addEventListener('click', () => {
        selectedDrug = a.drug;
        markerKey = a.marker;
        render(root);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
      const dot = h('span', {}, row);
      dot.style.cssText = `width:8px;height:8px;border-radius:50%;flex:none;background:${a.delta < 0 ? 'var(--series-1)' : 'var(--series-2)'}`;
      h('b', { text: a.marker, style: 'min-width:96px;font-size:12.5px' }, row);
      h('span', { style: 'flex:1;font-size:12.5px', text: a.drug }, row);
      h('span', {
        class: 'hint', style: 'margin:0',
        text: `Δ ${a.delta > 0 ? '+' : ''}${a.delta}  ·  q ${fmtP(a.q)}`,
      }, row);
    }
    legend(c, [
      { label: 'Mutated more sensitive', color: 'var(--series-1)' },
      { label: 'Mutated more resistant', color: 'var(--series-2)' },
    ]);

    tableView(c, [
      { key: 'marker', label: 'Marker' },
      { key: 'drug', label: 'Inhibitor' },
      { key: 'nPos', label: 'n mutated' },
      { key: 'nNeg', label: 'n wild type' },
      { key: 'medPos', label: 'Median AUC (mut)', fmt: (v) => fmt(v, 1) },
      { key: 'medNeg', label: 'Median AUC (wt)', fmt: (v) => fmt(v, 1) },
      { key: 'delta', label: 'Δ median', fmt: (v) => (v > 0 ? `+${fmt(v, 1)}` : fmt(v, 1)) },
      { key: 'q', label: 'q', fmt: (v) => fmtP(v) },
    ], db.drug.assoc, { label: `all ${db.drug.assoc.length} tests (${sig.length} at q<0.05)` });
  }

  // ---------------------------------------------- reference card for the pick
  if (selectedDrug) {
    const c = h('div', { class: 'card', style: 'margin-top:14px' }, root);
    c.style.borderLeft = '3px solid var(--series-1)';
    h('h3', { text: 'About this drug' }, c);
    drugCard(c, selectedDrug);
  }

  const g3 = h('div', { class: 'grid c2', style: 'margin-top:14px' }, root);

  // ------------------------------------------------------------- waterfall
  {
    const c = h('div', { class: 'card' }, g3);
    h('h3', { text: `Per-patient response — ${selectedDrug || ''}` }, c);
    h('p', {
      class: 'hint',
      text: `Every screened patient as one bar, ranked. Bars are coloured by ${markerKey} status, so if the `
        + 'marker explained response the colours would separate top from bottom. Click a bar to open that patient.',
    }, c);
    if (!selectedDrug) {
      h('div', { class: 'empty', text: 'Select an inhibitor above.' }, c);
    } else {
      const carriers = markerCarriers(markerKey);
      const rows = [];
      for (const p of sel) {
        const v = auc(p.id, selectedDrug);
        if (v == null) continue;
        const mut = carriers.has(p.id);
        rows.push({
          id: p.id, value: v, mut,
          color: mut ? 'var(--series-2)' : 'var(--series-1)',
          title: `Patient ${p.id}`,
          rows: () => [
            { value: fmt(v, 1), label: `AUC — ${selectedDrug}`, color: mut ? 'var(--series-2)' : 'var(--series-1)' },
            { value: mut ? 'mutated' : 'wild type', label: markerKey },
            { value: p.eln || '—', label: 'ELN 2017' },
          ],
        });
      }
      rows.sort((a, b) => a.value - b.value);
      if (!rows.length) {
        h('div', { class: 'empty', text: 'No screened patients for this inhibitor in the slice.' }, c);
      } else {
        waterfall(c, rows, {
          width: 560, height: 260, yLabel: `AUC — ${selectedDrug}`,
          onClick: (d) => window.dispatchEvent(new CustomEvent('goto-patient', { detail: d.id })),
          legendItems: [
            { label: `${markerKey} mutated`, color: 'var(--series-2)' },
            { label: 'Wild type', color: 'var(--series-1)' },
          ],
        });
        tableView(c, [
          { key: 'id', label: 'Patient' },
          { key: 'value', label: 'AUC', fmt: (v) => fmt(v, 1) },
          { key: 'status', label: markerKey },
        ], rows.map((r) => ({ id: r.id, value: r.value, status: r.mut ? 'mutated' : 'wild type' })),
        { label: `all ${rows.length} patients` });
      }
    }
  }

  // --------------------------------------------------------------- volcano
  {
    const c = h('div', { class: 'card' }, g3);
    h('h3', { text: 'Every test on one chart' }, c);
    h('p', {
      class: 'hint',
      text: 'Every marker × inhibitor test in the cohort. Left = mutated samples more sensitive, right = more '
        + 'resistant, higher = more significant. Click a point to load that pair above.',
    }, c);
    const pts = db.drug.assoc.map((a) => ({
      x: a.delta,
      y: -Math.log10(Math.max(a.q, 1e-300)),
      a,
      color: a.q >= 0.05 ? 'var(--text-muted)'
        : a.delta < 0 ? 'var(--series-1)' : 'var(--series-2)',
      opacity: a.q >= 0.05 ? 0.3 : 0.8,
      title: `${a.marker} × ${a.drug}`,
    }));
    scatter(c, pts, {
      width: 520, height: 340, r: 3.2,
      xLabel: 'Δ median AUC (mutated − wild type)',
      yLabel: '−log10 q',
      onClick: (pt) => { selectedDrug = pt.a.drug; markerKey = pt.a.marker; render(root); window.scrollTo({ top: 0, behavior: 'smooth' }); },
      tip: (pt) => [
        { value: `${pt.a.delta > 0 ? '+' : ''}${pt.a.delta}`, label: 'Δ median AUC', color: pt.color },
        { value: fmtP(pt.a.q), label: 'q (BH-adjusted)' },
        { value: `${pt.a.nPos} / ${pt.a.nNeg}`, label: 'mutated / wild type' },
        { value: pt.a.q < 0.05 ? (pt.a.delta < 0 ? 'more sensitive' : 'more resistant') : 'not significant', label: '' },
      ],
    });
    legend(c, [
      { label: 'Mutated more sensitive (q<0.05)', color: 'var(--series-1)' },
      { label: 'Mutated more resistant (q<0.05)', color: 'var(--series-2)' },
      { label: 'Not significant', color: 'var(--text-muted)' },
    ]);
  }

  // ------------------------------------------------ drug-drug correlation
  {
    const c = h('div', { class: 'card' }, root);
    c.style.marginTop = '14px';
    h('h3', { text: 'Which drugs behave alike' }, c);
    h('p', {
      class: 'hint',
      text: 'Spearman correlation of AUC across patients, on the 121 inhibitors screened in ≥200 patients (full cohort). '
        + 'Blocks of red are drugs that tend to work on the same samples — usually the same target family.',
    }, c);

    const names = db.drug.corrDrugs;
    const M = db.drug.corr;
    // order by hierarchical-ish seriation: greedily chain nearest neighbours
    const n = names.length;
    const used = new Set([0]);
    const order = [0];
    while (order.length < n) {
      const last = order[order.length - 1];
      let best = -1, bestV = -Infinity;
      for (let j = 0; j < n; j++) {
        if (used.has(j)) continue;
        const v = M[last][j];
        if (v != null && v > bestV) { bestV = v; best = j; }
      }
      if (best === -1) { for (let j = 0; j < n; j++) if (!used.has(j)) { best = j; break; } }
      used.add(best); order.push(best);
    }
    const ord = order.map((i) => names[i]);
    const idx = new Map(ord.map((nm, i) => [nm, names.indexOf(nm)]));
    const scale = divScale(1);

    const box = h('div', { class: 'scroll-x' }, c);
    heatmap(box, {
      rows: ord, cols: ord, cell: 9, rowLabelW: 168, colLabelH: 168,
      scale,
      value: (r, cc) => M[idx.get(r)][idx.get(cc)],
      title: (r, cc) => `${r} × ${cc}`,
      rowsFmt: (v) => `ρ ${v.toFixed(2)}`,
    });

    const lgw = h('div', { style: 'display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-top:6px' }, c);
    rampLegend(lgw, scale, [-1, 1], '', (v) => v.toFixed(1));
    h('span', { class: 'hint', style: 'margin:0', text: 'Spearman ρ · anti-correlated ← → correlated' }, lgw);

    // most correlated pairs, as a readable table
    const pairs = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (M[i][j] != null) pairs.push({ a: names[i], b: names[j], rho: M[i][j] });
      }
    }
    pairs.sort((x, y) => y.rho - x.rho);
    tableView(c, [
      { key: 'a', label: 'Inhibitor A' }, { key: 'b', label: 'Inhibitor B' },
      { key: 'rho', label: 'Spearman ρ', fmt: (v) => v.toFixed(3) },
    ], pairs, { label: `all ${fmt(pairs.length)} inhibitor pairs` });
  }
}
